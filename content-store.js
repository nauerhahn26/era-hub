// content-store.js — the three files a content job owns inside a book folder,
// and the atomic write every catalogue in the suite goes through.
//
//   books/<Title>/.build/job.json    the claim + the state machine
//   books/<Title>/.build/text.json   page order + transcribed text + flags
//   books/<Title>/.build/log.jsonl   one {t, step, msg} line per step
//
// Why one module: a book is built IN PLACE inside the family's Drive folder,
// so the same three files are read and written by the hub worker, by a second
// device's hub, and by Claude Code in power mode (spec §2, "text.json is the
// interop point"). If any two of those wrote a slightly different shape the
// book would build half-way and stop. Everything here is pure + synchronous;
// there is no network and no key anywhere in this file.
//
// Two laws it enforces for everyone else:
//   1. NOTHING is written in place. writeAtomic() writes <name>.tmp and
//      renames, so Google Drive for Windows never mirrors a half-written
//      manifest to the other device (spec §2 "written LAST (tmp + rename)").
//   2. NO KEY EVER REACHES DISK. Every string that goes into job.json's error
//      list or into log.jsonl runs through redact() first — a provider error
//      body loves to echo the request URL back at you, key query param and all.
"use strict";
const fs = require("fs");
const path = require("path");

const BUILD_DIR = ".build";

// inbox → transcribing → reviewing → narrating → published → animating → done,
// with `failed` reachable from anywhere (spec §2 "Claim"). Two amendments the
// spec's prose implies but its arrow diagram does not spell out:
//   published → done   animation is optional; with no fal key the job is over
//                      the moment the manifest lands.
//   failed → <any>     a failed job is re-runnable: it resumes at the step it
//                      fell over on, and its errors are kept.
const STATES = ["inbox", "transcribing", "reviewing", "narrating", "published", "animating", "done", "failed"];
const LEGAL = {
  inbox:        ["transcribing", "failed"],
  transcribing: ["reviewing", "failed"],
  reviewing:    ["narrating", "failed"],
  narrating:    ["published", "failed"],
  published:    ["animating", "done", "failed"],
  animating:    ["done", "failed"],
  done:         ["failed"],
  failed:       STATES.filter(s => s !== "failed"),
};

// A book's state is the name of the step it still OWES, so this map is the one
// place the walk is written down. Three readers: content-worker.js builds its
// step table from it, /content/status names the owed step for the Settings
// card, and POST /content/run validates {step} against it. A state that owes
// nothing (published with no fal key, done, failed) is simply absent.
const STEP_OWED = {
  inbox: "ingest",
  transcribing: "transcribe",
  reviewing: "narrate",
  narrating: "publish",
};
// The OPTIONAL steps: real steps of the pipeline that no state owes, so the
// walk never selects one and the half-hourly scan can never reach one. Animation
// is the whole list, and its absence from STEP_OWED above is the whole of "off
// by default" (spec §4 step 5): it costs dollars and is only ever run by name,
// which is to say only by a parent pressing a button that quotes it first.
// POST /content/run still has to accept the name, so STEP_NAMES carries it.
const STEP_ANIMATE = "animate";
const STEP_OPTIONAL = [STEP_ANIMATE];
const STEP_NAMES = Object.values(STEP_OWED).concat(STEP_OPTIONAL);

function stepOwed(state) { return STEP_OWED[state] || null; }

// Which state's work a job is actually waiting on. Normally its own; a job that
// fell over transiently owes the step it fell over ON, because content-store
// keeps `failedFrom` and "failed" is not a dead end. A PERMANENT failure — a key
// the provider refused, the "permanent:" convention content-narrate.js and
// content-providers.js both use — owes nothing: re-running it every half hour
// would only spend the family's allowance on the same refusal. Returns null for
// that case, and for a job that has finished.
function owedState(job) {
  if (!job) return null;
  if (job.state !== "failed") return job.state;
  const last = (job.errors || [])[job.errors.length - 1];
  if (last && /^permanent:/.test(String(last.msg || ""))) return null;
  return job.failedFrom || "inbox";
}

function buildDir(dir) { return path.join(dir, BUILD_DIR); }
function jobPath(dir)  { return path.join(buildDir(dir), "job.json"); }
function textPath(dir) { return path.join(buildDir(dir), "text.json"); }
function logPath(dir)  { return path.join(buildDir(dir), "log.jsonl"); }

function iso(now) {
  if (typeof now === "string") return now;                    // tests pin the clock
  return new Date(now == null ? Date.now() : now).toISOString();
}

// ---------------------------------------------------------------- redaction

// Ordered: the name=value forms run first so the log keeps the parameter name
// (a "?key=[redacted]" is far more useful to a parent-facing error than a bare
// [redacted]), then the provider prefixes, then the bare-hex catch-all.
const REDACTIONS = [
  // key=…, api_key: …, token=…, xi-api-key: … — in a URL, a header or prose
  [/((?:api[-_]?key|access[-_]?token|auth[-_]?token|xi-api-key|apikey|key|token|secret|password)\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, "$1[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],              // anthropic
  [/\bsk[-_][A-Za-z0-9]{16,}/g, "[redacted]"],                // openai, elevenlabs
  [/\bAIza[A-Za-z0-9_-]{10,}/g, "[redacted]"],                // google, the older form
  // Google, the form AI Studio issues TODAY — and the one the Settings card
  // tells families to paste ("AQ.... or AIza..."). Without this rule a bare
  // occurrence in a provider's error body lands in log.jsonl and job.json,
  // files that live inside the family's Drive folder and mirror to every device.
  [/\bAQ\.[A-Za-z0-9._~+/=-]{16,}/g, "[redacted]"],           // google, AI Studio
  [/\bfal[-_][A-Za-z0-9_-]{8,}/g, "[redacted]"],              // fal
  // fal's "<uuid>:<secret>" pair
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9]{8,}/g, "[redacted]"],
  // a bare 32+ hex run is what an older ElevenLabs key looks like. Yes, this
  // also eats a sha256 someone logs — a hash in a build log is worth less than
  // a leaked key is expensive.
  [/\b[0-9a-f]{32,}\b/g, "[redacted]"],
];

function redact(s) {
  let out = String(s == null ? "" : s);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

// --------------------------------------------------------------- atomic write

// "manifest.json" -> "manifest.tmp" (spec §2 names it that way). One writer per
// book folder at a time — the claim in job.json is what guarantees that.
function tmpPathFor(file) {
  const ext = path.extname(file);
  return path.join(path.dirname(file), path.basename(file, ext) + ".tmp");
}

// Objects are stringified (2-space, trailing newline) so a parent who opens
// text.json on their phone sees something readable; strings and Buffers go
// through untouched. Returns the target path.
function writeAtomic(file, data) {
  const buf = Buffer.isBuffer(data) ? data
    : Buffer.from(typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", "utf8");
  const tmp = tmpPathFor(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (e) {
    // The target keeps whatever it had: we never opened it. Sweep the tmp so a
    // failed run does not leave litter for Drive to mirror.
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return file;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ------------------------------------------------------------------ text.json

// {pages:[{index, source, text, flags:[{word, reason}], cover, edited}]}. Strict
// about the four fields the rest of the pipeline reads, forgiving about the two
// it can default — a hand-written text.json from power mode usually omits both.
//
// `edited` means "a grown-up typed these words themselves" (content.savePage,
// the review page's inline field). One reader: "Read the photos again" keeps an
// edited page's words and re-reads the rest (spec §5, plan T3.4), so without it
// a parent's own corrections would be thrown away by the button next to them.
// A page the transcriber reads is written without it — it is the model's
// reading again, not the parent's.
function normalizeText(obj) {
  const src = obj && typeof obj === "object" ? obj : {};
  const pages = src.pages == null ? [] : src.pages;
  if (!Array.isArray(pages)) throw new Error("text.json: pages must be an array");
  return {
    pages: pages.map((p, i) => {
      const at = "text.json: page " + i;
      if (!p || typeof p !== "object") throw new Error(at + " must be an object");
      if (!Number.isInteger(p.index) || p.index < 0) throw new Error(at + ": index must be a non-negative integer");
      if (typeof p.source !== "string" || !p.source) throw new Error(at + ": source must be a non-empty string");
      if (typeof p.text !== "string") throw new Error(at + ": text must be a string");
      const flags = p.flags == null ? [] : p.flags;
      if (!Array.isArray(flags)) throw new Error(at + ": flags must be an array");
      const out = {
        index: p.index,
        source: p.source,
        text: p.text,
        // A flag is one of two things, and the difference is the `word`:
        //   {word: "mattress", reason} a WORD on this page to come and look at
        //   {word: null, reason}       a mark on the WHOLE PAGE — nobody could
        //                              check it, and no word is in doubt
        // The whole-page mark MUST say why (a mark with no word and no reason
        // is nothing a parent could act on), and it may never borrow the word
        // channel: a flag whose word was the literal string "page" was rendered
        // by the review page as a highlight over any page that used the word.
        flags: flags.map((f) => {
          if (!f || typeof f !== "object") throw new Error(at + ": every flag is an object");
          const reason = typeof f.reason === "string" ? f.reason : "";
          if (f.word == null || f.word === "") {
            if (!reason) throw new Error(at + ": a flag with no word must say why");
            return { word: null, reason };
          }
          if (typeof f.word !== "string") throw new Error(at + ": a flag's word must be a string");
          return { word: f.word, reason };
        }),
        cover: !!p.cover,
        edited: !!p.edited,
      };
      // WHO READ THIS PAGE, and who checked them (F7). OPTIONAL, and defaulted
      // AWAY rather than to a shape: every text.json written before this has
      // none, so does every page a parent typed by hand in power mode, and a
      // reader that never asked for it must see exactly the object it saw
      // before. A `read` that names no model is not provenance, so it is
      // dropped rather than thrown at anybody — a hand-edited file is a thing
      // to be forgiving about (this is the same rule flags/cover follow).
      //   model      the rung whose words these are - NOT always the configured
      //              transcriber (a spent allowance hands the page to the
      //              partner, a disagreement hands it to the decider)
      //   checkedBy  the second model that read it, or null when nobody could
      //   agreed     true/false when it was checked, null when it was not
      const r = p.read;
      if (r && typeof r === "object" && !Array.isArray(r) && typeof r.model === "string" && r.model) {
        out.read = {
          model: r.model,
          checkedBy: typeof r.checkedBy === "string" && r.checkedBy ? r.checkedBy : null,
          agreed: typeof r.agreed === "boolean" ? r.agreed : null,
        };
      }
      return out;
    }),
  };
}

function readText(dir) {
  const raw = readJson(textPath(dir));
  return raw == null ? null : normalizeText(raw);
}

function writeText(dir, obj) {
  const norm = normalizeText(obj);
  writeAtomic(textPath(dir), norm);
  return norm;
}

// ------------------------------------------------------------------- job.json

// {state, claimedBy, startedAt, heartbeat, steps{}, errors[]} — the claim shape
// content.js writes and every hub instance reads (spec §2 "Claim").
function newJob(opts) {
  const o = opts || {};
  const t = iso(o.now);
  const state = o.state == null ? "inbox" : o.state;
  if (!STATES.includes(state)) throw new Error("job.json: unknown state " + state);
  return {
    state,
    claimedBy: o.claimedBy == null ? null : String(o.claimedBy),
    startedAt: t,
    heartbeat: t,
    // The state a job is born in is a step it has entered, so `steps` is a
    // complete record of the walk without the caller having to seed it.
    steps: { [state]: { at: t } },
    errors: [],
  };
}

function canTransition(from, to) {
  return !!(LEGAL[from] && LEGAL[from].includes(to));
}

// Returns a NEW job — callers hold the old one while they decide whether the
// step really finished, so mutating in place would lie to them.
// Re-entering the SAME state is not a transition and not an error: it is the
// heartbeat refresh a resumed step does (a takeover after a stale claim re-runs
// the step it is already in).
function transition(job, next, opts) {
  const o = opts || {};
  const t = iso(o.now);
  const from = job && job.state;
  if (!STATES.includes(next)) throw new Error("job.json: unknown state " + next);
  if (!STATES.includes(from)) throw new Error("job.json: unknown state " + from);
  if (from === next) return { ...job, heartbeat: t };
  if (!canTransition(from, next)) throw new Error("job.json: illegal transition " + from + " -> " + next);
  const out = {
    ...job,
    state: next,
    heartbeat: t,
    steps: { ...(job.steps || {}), [next]: { at: t } },
    errors: (job.errors || []).slice(),
  };
  if (o.claimedBy != null) out.claimedBy = String(o.claimedBy);
  return out;
}

// Fall over, keeping every earlier error (a book that failed twice for two
// different reasons is the one a parent needs to see the history of) and
// remembering the step to resume at.
function fail(job, msg, opts) {
  const o = opts || {};
  const t = iso(o.now);
  const from = job && job.state;
  const out = transition({ ...job, state: from === "failed" ? (job.failedFrom || "inbox") : from }, "failed", { now: t });
  out.failedFrom = from === "failed" ? (job.failedFrom || "inbox") : from;
  out.errors = (job.errors || []).concat([{ t, state: out.failedFrom, msg: redact(msg) }]);
  return out;
}

// Keep what a step could not do, WITHOUT calling the book failed. A step that
// read nine pages of ten and lost the tenth to a 500 has not fallen over — it
// still owes that page — but the reason has to survive somewhere a parent can
// be told about it, or the book silently publishes wordless and nothing in
// /content/status or the Settings card ever says why (content-worker.js walks
// this in). The state and the claim are untouched; only the history grows.
// Capped, because this appends on every retry and job.json mirrors to Drive.
const KEEP_ERRORS = 20;
function noteErrors(job, msgs, opts) {
  const o = opts || {};
  const t = iso(o.now);
  const add = (Array.isArray(msgs) ? msgs : [msgs])
    .filter(m => m != null && String(m).trim())
    .map(m => ({ t, state: job.state, msg: redact(String(m)) }));
  if (!add.length) return job;
  return { ...job, errors: (job.errors || []).concat(add).slice(-KEEP_ERRORS) };
}

// WHAT THE FAMILY WAS ACTUALLY BILLED. A book's cost cannot be worked out from
// what is on its pages: a page a grown-up corrected and had read again was
// bought twice and sits on disk once, so the Settings card said 4614 characters
// while ElevenLabs had been sent 4986 (L5, the 16-page live run of 9/4). Only
// the step doing the spending knows, and only while it spends it — so it says
// so here, one charge at a time, and content.js adds the ledger up instead of
// the pages.
//
// Deliberately COUNTERS and not a list of purchases: job.json lives inside the
// family's Drive folder and every byte of it is re-uploaded to every device on
// every write, and a book re-narrated a page at a time over a week would grow
// an unbounded array there. Two numbers per step keep the file the size it is
// and still answer the only question a parent asks ("what has this cost me?").
// The unit is the step's own — characters for narrate, CLIPS for animate — and
// is never mixed between steps.
//
// Returns a NEW job, like transition() and noteErrors(): a caller still holding
// the old one must not see it move under them. A charge that is not a positive
// number is not a charge and is ignored rather than thrown at anybody — a
// ledger must never be the reason a book stops building.
function addSpend(job, step, chars) {
  const n = Number(chars);
  if (!job || !Number.isFinite(n) || n <= 0) return job;
  const prev = (job.spent && typeof job.spent === "object" && job.spent[step]) || null;
  return {
    ...job,
    spent: {
      ...(job.spent && typeof job.spent === "object" ? job.spent : {}),
      [step]: {
        chars: (Number(prev && prev.chars) || 0) + n,
        calls: (Number(prev && prev.calls) || 0) + 1,
      },
    },
  };
}

// THE PAUSE, LIFTED. Written here rather than in the two files that do it
// because the fields are this file's shape and there are now two lifters: a
// step that finished (the allowance came back on its own) and a parent pressing
// "Try again now" after adding credit (content.js runStep, T6b.1). A job with
// half a pause left on it — a `held` with no `pausedUntil`, a provider naming an
// allowance that is no longer out — is a card that keeps telling the family to
// wait for something that already happened.
//
// Returns a NEW job, like transition() and addSpend(): a caller still holding
// the old one must not see it move under them.
function unpause(job) {
  const out = { ...job };
  delete out.pausedUntil; delete out.pausedNote; delete out.pausedProvider; delete out.held;
  return out;
}

function readJob(dir) {
  const raw = readJson(jobPath(dir));
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

function writeJob(dir, job) {
  if (!job || !STATES.includes(job.state)) throw new Error("job.json: unknown state " + (job && job.state));
  // Belt and braces: the errors list is the one field a provider message can
  // reach, and it is written by half a dozen call sites.
  const safe = { ...job, errors: (job.errors || []).map(e => ({ ...e, msg: redact(e && e.msg) })) };
  writeAtomic(jobPath(dir), safe);
  return safe;
}

// ------------------------------------------------------------------ log.jsonl

// Exactly {t, step, msg}, one JSON object per line, both strings redacted.
// Never throws: a build that cannot write its log must still finish the book
// (same law as pool.js's append — history is nice-to-have, the artefact is not).
// Returns the line written, or null if the log was unwritable.
function appendLog(dir, step, msg, opts) {
  const o = opts || {};
  const line = { t: iso(o.now), step: redact(step), msg: redact(msg) };
  try {
    fs.mkdirSync(buildDir(dir), { recursive: true });
    fs.appendFileSync(logPath(dir), JSON.stringify(line) + "\n");
  } catch (e) {
    console.error("[content-store] log append failed: " + e.message);
    return null;
  }
  return line;
}

// Torn last line tolerated: Drive can mirror a log mid-append.
function readLog(dir) {
  let raw;
  try { raw = fs.readFileSync(logPath(dir), "utf8"); } catch { return []; }
  const out = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

module.exports = {
  BUILD_DIR, STATES, LEGAL, STEP_OWED, STEP_ANIMATE, STEP_OPTIONAL, STEP_NAMES,
  stepOwed, owedState,
  buildDir, jobPath, textPath, logPath, tmpPathFor,
  writeAtomic, readJson, redact,
  normalizeText, readText, writeText,
  newJob, canTransition, transition, fail, noteErrors, addSpend, unpause, readJob, writeJob,
  appendLog, readLog,
};
