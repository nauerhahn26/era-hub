// content-providers.js — step 2 of the book builder (spec §4.2): the printed
// page in, the printed WORDS out. One vision call per page under the
// transcription policy, straight into .build/text.json.
//
// This file holds three things and nothing else:
//
//   1. THE POLICY. TRANSCRIBE_PROMPT is a verbatim port of the prompt the OCR
//      bake-off measured every candidate against
//      (tools/ocr-bakeoff/lib/prompts.mjs, PROMPT_VERSION v3 — ported, not
//      required: that harness is ESM and the hub's Windows floor is Node 18,
//      where require(esm) does not exist, plan §A3). Changing a word here
//      invalidates the bake-off's numbers, so bump PROMPT_VERSION when you do
//      and say why in the changelog there.
//   2. THE LADDER. Three adapters (google / anthropic / openai) in the exact
//      request shape clothing-worker.js already proved on the family's own
//      keys, with its two hard-won rules kept intact:
//        * a 429 retires THAT MODEL, not the day. Google's free allowance is
//          counted PER MODEL PER DAY, so a rung that is spent leaves the next
//          rung a fresh allowance of its own and the book keeps going (dad 9/2:
//          the sticky model 429'd after 7 photos and the old "one 429 = day
//          over" rule left 12 photos and three untouched models on the table).
//          No number is written here on purpose: nothing in this file reads a
//          quota, the ceiling is Google's to change (the 9/4 live run was told
//          500/day for gemini-3.1-flash-lite, where an older note here said 20),
//          and the ladder needs only the 429 itself to do the right thing.
//        * 401/403 is "permanent:" — a refused key will refuse every page, so
//          stop and tell the family instead of burning the ladder.
//      Base URL comes from ERA_AI_URL, read FRESH on every call, so no test
//      can ever reach a real provider on the family's key.
//   3. THE STEP. transcribeBook() walks the pages, and when the whole ladder
//      is spent it PAUSES the book until tomorrow — job stays claimed, state
//      stays "transcribing", status says "waiting for tomorrow's quota"
//      (spec §7 risks). A free key builds a book over several days; it must
//      never look like a failure.
//
// WHICH provider, WHICH model and WHETHER a second opinion is bought are
// CONFIG, not code: DEFAULTS below, overridden by <DATA>/content-config.json.
// The bake-off (tools/ocr-bakeoff/README.md) is re-runnable in six months and
// its decision is adopted into DEFAULTS by T2.6a — models and prices drift,
// and a default that lives in one object is one edit rather than a rewrite.
//
// THE DECISION, dated 2026-09-04 (the memo itself is private — it quotes the
// pages — and lives in era-family, never in this repo): read a page with
// `gemini-3.1-flash-lite`, ask `gemini-3.5-flash-lite` the same question, and
// publish the page when the two agree; show the parent the ones they read
// differently. Both are free-tier AI Studio models, so the whole policy costs
// a family nothing. It is the only configuration the bake-off measured that
// met the accuracy bar, and the reason is decorrelation: the chosen
// transcriber never flags a word as doubtful — not once, on any page it got
// wrong — so a SECOND, DIFFERENT model is the entire safety net. Two runs of
// the same model agree with each other and are wrong together, so do not
// "simplify" the pair into one model asked twice. Re-run the bake-off (its
// README) before changing any of this; the next re-validation is due 2027-03.
//
// No key is ever logged, written to job.json, or put in a returned message:
// every string that leaves here goes through content-store's redact() first.
"use strict";
const fs = require("fs");
const path = require("path");
const store = require("./content-store.js");
const { aiRoles } = require("./ai-config.js");

// ---------------------------------------------------------------- the policy

// Ported verbatim from tools/ocr-bakeoff/lib/prompts.mjs @ v3. The rules are
// numbered there and the reasons each one exists (a cover has no narrative
// order; a character's hand-lettered sign IS story text) are in that file's
// changelog, which is the evidence trail for why the words are these words.
const PROMPT_VERSION = "v3";

// KNOWN GAP, left open by T2.6a on purpose (it is code, not config, and this
// task changed only defaults): the bake-off's pairing asks the transcriber and
// its partner the question in TWO DIFFERENT WORDINGS — the partner's v3 and
// the transcriber's older v2 — because a shared wording correlates their
// mistakes as surely as a shared model does. Both passes here send v3. The
// pair still catches more than one pass alone, which is why it is on; it is
// not yet the pairing that was measured at its best. Closing this means two
// NAMED, PINNED prompts (`transcribe` = v2, `second-opinion` = v3) and a
// config field naming which each pass sends — and then never "upgrading both".

const POLICY = `You are transcribing one photographed page of a printed children's picture book so it can be read aloud by a speech synthesiser. A single wrong word is a failure. Follow these rules exactly.

1. VERBATIM PRINTED TEXT ONLY. Transcribe the words exactly as printed. Never modernise, localise or correct spelling (British spelling stays British). Never add, expand or paraphrase words that are not printed. Do not translate.
2. READING ORDER follows the visual and narrative flow of the page, not raw top-to-bottom geometry. For rhyming verse use rhyme and metre as an ordering signal across columns, panels and speech bubbles, so the text reads coherently start to finish.
3. ELLIPSES: render any printed ellipsis, including a spaced ". . .", as three dots "...". Keep leading or trailing ellipses that are used as page-turn continuations.
4. QUOTES: transcribe quotation marks exactly as printed, even when they are unbalanced on this page (a speech may continue across pages).
5. JUNK REMOVAL: drop text that belongs to the illustration rather than the story - decorative lettering painted on objects such as boat hulls, barcodes, printed page numbers, publisher furniture, and misread glyphs (for example a stray "99" that is really a quotation mark). BUT lettering that is PART OF THE STORY is story text and MUST be transcribed, in its place in reading order, even when it is hand-lettered or drawn into the art: words a character writes, reads, holds up or paints - a sign, a blackboard, a banner, a letter shown to the reader. If the words carry the story's meaning, they belong in "text". Publisher furniture is still dropped, always: running heads (the title or chapter repeated in the margin or the art), printed page numbers, ISBN and barcode lines, imprint, publisher and printer lines, and price stickers.
6. COVERS: if this page is a cover, transcribe the printed title, author and illustrator with the casing exactly as printed. Do not invent a byline that is not printed. ORDER ON A COVER IS FIXED, because a cover has no narrative flow: transcribe the printed blocks strictly TOP TO BOTTOM in the order they appear on the page. On many picture books the author and illustrator names are printed ABOVE the title - when they are, they come first. Do not promote the title to the front, and do not group the names with a byline at the end. Anything added to this particular copy is NOT part of the book and must be ignored entirely: handwritten inscriptions, gift dedications, an owner's name written or printed on a label, library stamps, and stickers of any kind. Only text PRINTED as part of the cover is transcribed, top to bottom as printed.
7. If the page has no printed story text at all (a full-bleed illustration, an endpaper), return an empty string for "text".
8. LINE AND STANZA BREAKS: use a single newline between printed lines of verse and a blank line between stanzas or separate text blocks. Do not re-wrap prose.
9. FLAG, DO NOT GUESS: list in "uncertain" every word you are not fully confident about (obscured, blurred, cut off, or ambiguous). Still put your best reading in "text"; the list is for human review.`;

const OUTPUT_CONTRACT = `Reply with a single JSON object and nothing else - no prose, no markdown code fence:
{"text": "<the full page transcription>", "uncertain": ["<word>", ...]}
Use "uncertain": [] when you are confident about every word.`;

const TRANSCRIBE_PROMPT = POLICY + "\n\n" + OUTPUT_CONTRACT;

// ---------------------------------------------------------------- the ladder

// The same three providers and the same model ids clothing-worker.js:33-47
// spends the family's key on, for one reason: those ids are the ones VERIFIED
// to answer for accounts created now (a hardcoded id 404s for new accounts; a
// -latest alias can be rate-limited for hours while a sibling answers
// instantly — both seen live on the family's own free key, QA 9/1-9/2). Keep
// the two lists in step, EXCEPT for google's order: T2.6a re-ordered it from
// the bake-off, which measures reading accuracy rather than the "cheapest that
// can see" the Clothing Picker needs.
//
// google's first two rungs are the bake-off's pick and its partner, in that
// order, because the agreement pass takes rung one and rung two. The rest are
// fallbacks for the day one of them is retired — they are the ids verified to
// answer, not ids the bake-off ranked. Anything bigger Google offers is capped
// on a free key at a book or so a day, or (the Pro tier) refused outright, so a
// family cannot fall back to a stronger model: the two lites are the free field.
const PROVIDERS = {
  anthropic: { base: "https://api.anthropic.com",
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"] },
  openai: { base: "https://api.openai.com",
    models: ["gpt-5-mini", "gpt-4o-mini"] },
  google: { base: "https://generativelanguage.googleapis.com",
    models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite",
             "gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview"] },
};

// A page is a sentence or two of print. Two minutes is generous for that and
// still short enough that a wedged provider does not hold the worker.
const TIMEOUT_MS = 120000;
// Verse and a cover byline both fit easily; the ceiling only exists so a model
// that starts hallucinating a novel stops costing money.
const MAX_TOKENS = 4096;

function aiBase() { return process.env.ERA_AI_URL || null; }
function baseFor(provider) { return aiBase() || (PROVIDERS[provider] || PROVIDERS.google).base; }

// ---------------------------------------------------------------- the config

// <DATA>/content-config.json. Every field here is a value the bake-off can
// change without touching a line of code (spec §7 "Provider drift").
//
//   provider      the provider the bake-off chose, and the one `model` belongs
//                 to. It never overrides the family's vision card — there is
//                 exactly one vision key and a config file must not be able to
//                 point it at a host it cannot authenticate to — it GUARDS it:
//                 a card holding an OpenAI key reads books on OpenAI's own
//                 ladder and is never asked for a model by that name.
//   model         the transcriber. It leads the ladder, and the rest of the
//                 provider's rungs follow, so a model that has since been
//                 retired still falls through to one that answers.
//   agreementPass true = the page is read twice, by the transcriber and by the
//                 next rung (the partner), and only published unflagged when
//                 the two readings agree. Costs one extra free call per page.
//   escalateTo    the model a disagreement is handed to, which then pre-fills
//                 the parent's answer. null = ask NOBODY: keep the
//                 transcriber's reading and flag the page for the parent. That
//                 is the free default, because the only adjudicator the
//                 bake-off measured needs a paid key; a family that adds one
//                 names it here. A flagged page publishes either way (ruling
//                 9/4) — the flag is a "come and look", never a hold.
//
// T2.6a: set 2026-09-04 from the OCR bake-off's decision memo (private, in
// era-family — the chosen names only, never a measurement, never a page).
// Re-run instructions and the six-month re-validation: tools/ocr-bakeoff/README.md.
const CONFIG_FILE = "content-config.json";
const DEFAULTS = {
  transcribe: {
    provider: "google",
    model: "gemini-3.1-flash-lite",
    agreementPass: true,
    escalateTo: null,
  },
};

function loadConfig(dataDir) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dataDir || "", CONFIG_FILE), "utf8")); } catch {}
  const t = (raw && typeof raw.transcribe === "object" && raw.transcribe) || {};
  const out = { transcribe: { ...DEFAULTS.transcribe } };
  for (const k of Object.keys(DEFAULTS.transcribe)) if (t[k] !== undefined && t[k] !== null) out.transcribe[k] = t[k];
  return out;
}

// The rungs to try, in order, for this key. A configured model leads; the rest
// of the provider's list follows, so a model the bake-off picked that has since
// been retired still falls through to something that answers.
//
// A model id only means anything on the provider it belongs to, so the named
// model leads only when the config's provider IS the key's provider. Without
// that check, a family whose card holds an OpenAI key would ask OpenAI for a
// Gemini once per page, every page, and be refused every time before the
// ladder saved them.
function ladderFor(cfg, config) {
  const name = cfg && PROVIDERS[cfg.provider] ? cfg.provider : "google";
  const p = PROVIDERS[name];
  const t = (config && config.transcribe) || {};
  const want = (!t.provider || t.provider === name) ? t.model : null;
  if (!want) return p.models.slice();
  return [want, ...p.models.filter(m => m !== want)];
}

// --------------------------------------------------------------- the parsing

// Ported from tools/ocr-bakeoff/lib/providers/util.mjs (parseModelJson), which
// is the same salvage clothing-worker.js:509 does in one line, plus the two
// cases 2,900 recorded bake-off calls actually produced: a ```json fence, and a
// chatty sentence in front of the object. A reply we cannot parse is kept whole
// as `text` rather than thrown away — a page of right words with a parse flag
// beats a blank page.
function parseModelJson(raw) {
  const fallback = (t) => ({ text: String(t == null ? "" : t).trim(), uncertain: [], parseError: true });
  if (raw == null) return fallback("");
  let s = String(raw).trim();
  if (!s) return { text: "", uncertain: [], parseError: false };
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const tryParse = (candidate) => {
    try {
      const o = JSON.parse(candidate);
      if (o && typeof o === "object" && !Array.isArray(o) && typeof o.text === "string")
        return { text: o.text, uncertain: Array.isArray(o.uncertain) ? o.uncertain.map(String) : [], parseError: false };
    } catch {}
    return null;
  };
  let hit = tryParse(s);
  if (hit) return hit;
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first !== -1 && last > first) { hit = tryParse(s.slice(first, last + 1)); if (hit) return hit; }
  return fallback(s);
}

// Two readings "agree" when a listener could not tell them apart: case,
// punctuation and dash typography folded away. Ported from the bake-off's
// normalizeLoose (tools/ocr-bakeoff/lib/score.mjs) — the same fold its WER
// numbers were computed under, so "agreement" here means what it meant there.
// An intra-word dash JOINS ("pussy-cat" == "pussycat"); every other dash and
// every other mark is dropped.
function normalizeLoose(t) {
  if (t == null) return "";
  let s = String(t).normalize("NFKC");
  s = s.replace(/[‘’‚‛′]/g, "'");
  s = s.replace(/[“”„‟″]/g, '"');
  s = s.replace(/[‐-―−]/g, "-");
  s = s.replace(/…/g, "...").replace(/\.\s\.\s\./g, "...").replace(/\.{3,}/g, "...");
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s'\-]/gu, " ");
  s = s.replace(/(^|[^\p{L}\p{N}])['\-]+/gu, "$1");
  s = s.replace(/['\-]+(?![\p{L}\p{N}])/gu, "");
  s = s.replace(/(?<=[\p{L}\p{N}])-+(?=[\p{L}\p{N}])/gu, "");
  return s.replace(/\s+/g, " ").trim();
}

const looseWords = (t) => { const s = normalizeLoose(t); return s === "" ? [] : s.split(" "); };

// The first word where two readings part company — what the review page puts
// its finger on. "" when one side simply ran out (then the page itself is the
// flag).
function firstDivergence(a, b) {
  const x = looseWords(a), y = looseWords(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] || y[i] || "";
  return "";
}

// ---------------------------------------------------------------- one call

const isQuota = (msg) => /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(String(msg));
const isPermanent = (msg) => /^permanent:/.test(String(msg));

// THE THINKING KNOB IS NOT THE SAME SHAPE ON EVERY GEMINI. Thinking off is what
// stops a transcription spending its whole token budget deliberating over a
// picture book (QA 9/1), but the field that turns it off changed with the
// generation: gemini-3.1 takes the numeric {thinkingBudget:0} the bake-off
// measured the transcriber under, while gemini-3.5 replaced it with a LEVEL and
// answers the budget with a flat 400 "Request contains an invalid argument".
// Sent blind, that 400 is not a model that reads worse — it is a rung that never
// answers at all, and it is the very rung the agreement pass buys its second
// opinion from (e2e 9/4: all three pages of the first real book published
// unchecked because gemini-3.5-flash-lite 400'd on every one of them).
//
// Nothing here guesses at Google's version numbering — the next change of shape
// would break it again in the same silent way. The FIRST refusal teaches this
// process, once per model id, and every call after it is sent the shape that
// model actually takes. So the transcriber keeps the exact request its accuracy
// was measured under for as long as that request is accepted, which is what
// keeps the bake-off's numbers numbers about this hub.
const THINKING_OFF = { thinkingBudget: 0 };             // 2.x, 3.1: no thinking at all
const THINKING_MINIMAL = { thinkingLevel: "minimal" };  // 3.5+: the least it will do
const thinkingShape = new Map();                        // model id -> the shape it accepted
function thinkingFor(model) { return thinkingShape.get(model) || THINKING_OFF; }
// A model that refused the shape we sent has told us which one it wants. Returns
// true when there is another shape left to try, i.e. the call is worth re-sending.
function retune(model, body) {
  if (thinkingShape.get(model) === THINKING_MINIMAL) return false;
  thinkingShape.set(model, THINKING_MINIMAL);
  body.generationConfig.thinkingConfig = THINKING_MINIMAL;
  return true;
}

// One provider call for one page. The three request shapes are
// clothing-worker.js:455-541's, unchanged apart from the prompt and the token
// ceiling, so a family whose key already names garments can already read books.
// Throws "permanent: …" for a refusal retrying cannot fix; every other failure
// is a plain Error the ladder may walk past.
async function callModel(o) {
  const cfg = o.cfg || {};
  const provider = PROVIDERS[cfg.provider] ? cfg.provider : "google";
  const model = o.model;
  const prompt = o.prompt || TRANSCRIBE_PROMPT;
  const b64 = fs.readFileSync(o.imagePath).toString("base64");
  const base = baseFor(provider);
  let url, headers, body, extract;
  if (provider === "openai") {
    url = base + "/v1/chat/completions";
    headers = { "Authorization": "Bearer " + cfg.apiKey, "content-type": "application/json" };
    body = { model, max_completion_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
        { type: "text", text: prompt } ] }] };
    extract = (j) => j.choices[0].message.content;
  } else if (provider === "google") {
    // The key travels as a header, not as the ?key= query parameter the API
    // also accepts: a URL ends up in error bodies and logs, and this one is
    // the family's.
    url = base + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
    headers = { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" };
    body = { contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: b64 } },
        { text: prompt } ] }],
      // Thinking off and temperature 0: reading a page is transcription, not
      // reasoning, and a -latest alias that resolves to a thinking model burns
      // the whole token budget deliberating over a picture book (QA 9/1).
      // WHICH shape turns it off is the model's to say — see thinkingFor().
      generationConfig: { temperature: 0, responseMimeType: "application/json",
        maxOutputTokens: MAX_TOKENS, thinkingConfig: thinkingFor(model) } };
    extract = (j) => (j.candidates[0].content.parts || []).map(x => x.text || "").join("");
  } else {
    url = base + "/v1/messages";
    headers = { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    body = { model, max_tokens: MAX_TOKENS, temperature: 0,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: prompt } ] }] };
    extract = (j) => (j.content || []).map(c => c.text || "").join("");
  }
  // Providers throttle (Google 503 "high demand" hit EVERY call on the free
  // tier, QA 9/1) and a whole book must not die on a transient. One quick
  // retry, then the ladder's next rung.
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 3000));
    let r;
    try {
      r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs || TIMEOUT_MS) });
    } catch (e) { last = store.redact(e.message); continue; }
    if (r.ok) {
      const parsed = parseModelJson(extract(await r.json()));
      return { text: parsed.text, uncertain: parsed.uncertain, parseError: parsed.parseError, model };
    }
    last = r.status + " " + store.redact((await r.text().catch(() => "")).slice(0, 160));
    if (r.status === 401 || r.status === 403)
      throw new Error("permanent: the AI provider did not accept that key (" + r.status +
                      ") — check the key in Settings");
    // The thinking knob, refused. Re-shaped and sent again WITHOUT spending an
    // attempt: the two attempts exist for a provider that is throttling, and
    // this is a provider that is answering — it is telling us the request is the
    // wrong shape. retune() gives up after one re-shape, so this cannot spin.
    if (r.status === 400 && provider === "google" && /INVALID_ARGUMENT/.test(last) &&
        retune(model, body)) { attempt--; continue; }
    if (r.status === 429) break;                     // no point retrying a spent allowance
    if (r.status < 500) break;                       // 400/404: try the next model
  }
  throw new Error("ai(" + provider + "/" + model + ") " + last);
}

// ---------------------------------------------------------------- one page

// transcribePage({imagePath, policy, cfg}) -> {text, uncertain[], model}
//
// The interface the whole step is written against (plan T2.6). Optional extras:
//   models  the rungs to try (default: the provider's ladder)
//   spent   a Set of model ids whose daily allowance is gone — shared across a
//           whole book, so page two never knocks on a door page one found shut
// Throws with `.quota = true` when every rung is spent: that is a PAUSE, not a
// failure, and transcribeBook turns it into one.
async function transcribePage(o) {
  const cfg = o.cfg || {};
  const prompt = o.policy || TRANSCRIBE_PROMPT;
  const spent = o.spent instanceof Set ? o.spent : new Set();
  const all = o.models || ladderFor(cfg, o.config);
  const list = all.filter(m => !spent.has(m));
  if (!list.length) {
    const e = new Error("every model's daily allowance is spent");
    e.quota = true;
    throw e;
  }
  let lastErr = "";
  for (const model of list) {
    try {
      return await callModel({ imagePath: o.imagePath, prompt, cfg, model, timeoutMs: o.timeoutMs });
    } catch (e) {
      lastErr = e.message;
      if (isPermanent(e.message)) throw e;           // a bad key refuses every rung
      if (isQuota(e.message)) spent.add(model);
      console.error("[content] transcribe " + model + ": " + e.message);
    }
  }
  const err = new Error(lastErr || "no model answered");
  if (all.every(m => spent.has(m))) err.quota = true;
  throw err;
}

// ---------------------------------------------------------------- one book

// "Paused until" is a DAY, not a timestamp: free-tier allowances reset on a
// day boundary, and a book that waits an extra hour costs nobody anything
// while a book that asks an hour early spends a request to be told no.
function dayOf(now) {
  const d = new Date(now == null ? Date.now() : now);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function tomorrow(now) { return dayOf((now == null ? Date.now() : now) + 24 * 60 * 60 * 1000); }

// What Settings and the board splash say while a free key waits (spec §7).
const QUOTA_NOTE = "waiting for tomorrow's quota";

const FLAG_UNSURE = "the model was not sure of this word";

// Where the pages come from: ingest's own record if it is there (it knows
// which original each page was made from), else the pages/ directory itself —
// a folder built by an older hub, or by hand in power mode, still transcribes.
function pagesOf(dir) {
  const rec = store.readJson(path.join(store.buildDir(dir), "ingest.json"));
  if (rec && Array.isArray(rec.pages) && rec.pages.length)
    return rec.pages.filter(p => p && Number.isInteger(p.index) && p.image)
      .map(p => ({ index: p.index, source: p.source || p.image, image: p.image }));
  let names = [];
  try { names = fs.readdirSync(path.join(dir, "pages")).filter(f => /^\d{3}\.jpg$/i.test(f)).sort(); } catch {}
  return names.map(n => ({ index: Number(n.slice(0, 3)), source: "pages/" + n, image: "pages/" + n }));
}

// transcribeBook(dir, opts) — read every page of `dir` that has no text yet.
//
//   opts.dataDir  <DATA>, for the vision card and content-config.json
//   opts.cfg      {provider, apiKey} — for a caller that already has it
//   opts.config   an already-loaded content config (skips the read)
//   opts.only     [index, …] pay again for exactly these pages
//   opts.job      the job as read from job.json, for its pausedUntil day
//   opts.now      pinned clock (tests)
//
// Returns {transcribed, reused, escalated, pages, calls, errors} on a normal
// run, {hold:"no-ai-key"} when there is no key to spend, and
// {hold:"quota", pausedUntil, note} when the ladder is spent for the day.
// Throws only for a permanent refusal — content-worker.js turns that into a
// failed job with the provider's own words, and never retries it.
async function transcribeBook(dir, opts) {
  const o = opts || {};
  const cfg = o.cfg || (o.dataDir ? aiRoles(o.dataDir).vision : null);
  const config = o.config || loadConfig(o.dataDir);
  const log = (msg) => store.appendLog(dir, "transcribe", msg, { now: o.now });
  const today = dayOf(o.now);

  if (!cfg || !cfg.apiKey) {
    // A hold, not a failure: the parent has not added a key yet, and the book
    // waits in the folder exactly as they left it.
    log("no AI key yet - add one in Settings and the book will read itself");
    return { hold: "no-ai-key", transcribed: 0, reused: 0, escalated: 0, pages: [], calls: 0, errors: [] };
  }
  // Already told "not today". Asking again costs a request to hear the same
  // thing, and on a free key that request is a page we could have read
  // tomorrow.
  const paused = o.job && o.job.pausedUntil;
  if (paused && paused > today)
    return { hold: "quota", pausedUntil: paused, note: QUOTA_NOTE,
             transcribed: 0, reused: 0, escalated: 0, pages: [], calls: 0, errors: [] };

  const pages = pagesOf(dir);
  if (!pages.length) return { hold: "no-pages", transcribed: 0, reused: 0, escalated: 0, pages: [], calls: 0, errors: [] };

  const only = Array.isArray(o.only) ? new Set(o.only) : null;
  const had = new Map(((store.readText(dir) || { pages: [] }).pages).map(p => [p.index, p]));
  const spent = new Set();
  const agree = !!config.transcribe.agreementPass;
  const out = [];
  const errors = [];
  let transcribed = 0, reused = 0, escalated = 0, calls = 0, quota = false, permanent = null;

  for (const page of pages) {
    // A page that already has text is DONE — including a page a parent typed
    // themselves in power mode, and including a page the model correctly read
    // as wordless. text.json is the interop point; we do not overwrite it.
    const done = had.get(page.index);
    const forced = !!only && only.has(page.index);
    if (done && !forced) { out.push(done); reused++; continue; }
    if (only && !forced) { if (done) { out.push(done); reused++; } continue; }
    if (quota) continue;                              // the day is over; leave the rest for tomorrow

    const imagePath = path.join(dir, page.image);
    try {
      // No `models`: transcribePage walks the whole ladder minus what this book
      // has already found shut.
      const first = await transcribePage({ imagePath, cfg, config, spent });
      calls++;
      let text = first.text, unsure = first.uncertain.slice(), note = null;

      // The optional second opinion (spec §4.2). Two cheap rungs read the page;
      // if a listener could tell their readings apart, a stronger model decides
      // and the page is flagged either way.
      // A second or third opinion that cannot be bought is never allowed to
      // cost the reading we already have: the page keeps it, flagged, and the
      // spent rung is remembered for the rest of the book. Only a refused key
      // (which refuses everything) escapes.
      if (agree) {
        const second = ladderFor(cfg, config).filter(m => !spent.has(m) && m !== first.model);
        let b = null, unchecked = null;
        if (!second.length) unchecked = "no second model was left to ask";
        else {
          try { b = await transcribePage({ imagePath, cfg, config, spent, models: [second[0]] }); calls++; }
          catch (e) {
            if (isPermanent(e.message)) throw e;
            unchecked = store.redact(e.message);
          }
        }
        // NOBODY CHECKED THIS PAGE. The second model IS the safety net — the
        // decision memo's whole reason for buying a pair is that the chosen
        // transcriber never flags its own mistakes — so a page that could not be
        // checked must not come out looking like a page that was checked and
        // agreed. It publishes either way (the ruling of 9/4 stands); it just
        // goes to the parent with a mark on it. When the partner rung is down
        // this marks EVERY page of the book, and that is the intended signal:
        // the book was read once, not twice, and it says so.
        // Until this, the only trace was a line in log.jsonl: on 9/4 the partner
        // rung 400'd on every page of a real book and job.json, /content/status
        // and the Settings card all said the book had nothing to review.
        if (unchecked) {
          log("page " + page.index + ": no second opinion (" + unchecked + ")");
          note = "no second model checked this page";
          unsure.push({ word: "page", reason: note });
        } else if (normalizeLoose(b.text) !== normalizeLoose(text)) {
          const word = firstDivergence(text, b.text);
          // Only a CONFIGURED adjudicator decides (spec §4.2: "the strongest
          // configured model"). With none — the free default — the
          // transcriber's reading stands and the page goes to the parent.
          // The bake-off measured a paid adjudicator, and a parent; it never
          // measured a third model of the same free family, and two models
          // from one family are wrong together often enough that a guess
          // overwriting a good reading is worse than no guess. The page is
          // flagged for a human either way.
          const strongId = config.transcribe.escalateTo;
          const strong = strongId && !spent.has(strongId) ? [strongId] : [];
          let c = null;
          if (strong.length) {
            try { c = await transcribePage({ imagePath, cfg, config, spent, models: [strong[0]] }); calls++; }
            catch (e) {
              if (isPermanent(e.message)) throw e;
              log("page " + page.index + ": no decider (" + store.redact(e.message) + ")");
            }
          }
          if (c) {
            escalated++;
            text = c.text; unsure = c.uncertain.slice();
            note = "two models read this page differently; " + c.model + " decided";
          } else {
            // Nothing left to break the tie: keep the first reading and say
            // so. A flagged page still publishes (ruling 9/4).
            note = "two models read this page differently and there was no third to ask";
          }
          unsure.push({ word: word || "page", reason: note });
        }
      }

      const flags = unsure.map(u => typeof u === "string"
        ? { word: u, reason: FLAG_UNSURE }
        : { word: u.word, reason: u.reason });
      out.push({ index: page.index, source: page.source, text,
                 flags, cover: done ? !!done.cover : page.index === 1 });
      transcribed++;
      log("page " + page.index + ": " + text.split(/\s+/).filter(Boolean).length + " word(s)" +
          (flags.length ? ", " + flags.length + " flag(s)" : "") + (note ? " - " + note : ""));
    } catch (e) {
      const msg = store.redact(e && e.message ? e.message : String(e));
      if (e && e.quota) {
        // Not an error. The book keeps the pages it already has and waits.
        quota = true;
        log("every model's daily allowance is spent - " + QUOTA_NOTE);
        continue;
      }
      errors.push(msg);
      log("page " + page.index + " failed: " + msg);
      if (isPermanent(msg)) { permanent = msg; break; }
      if (done) { out.push(done); reused++; }
    }
  }

  // Written before we throw or pause: half a book of text is progress a free
  // key paid for, and tomorrow's run must not buy it again.
  //
  // THE ORDER text.json ALREADY HAS IS THE BOOK'S ORDER, because a grown-up may
  // have dragged the pages about on the review page (spec §5) and a re-read must
  // not shuffle the book back to the order the camera happened to number the
  // photos in. Pages this pass already knew about keep their places; anything
  // new lands after them, by index — which for a first pass (nothing known) is
  // exactly the plain index sort this used to do.
  const was = new Map([...had.keys()].map((index, at) => [index, at]));
  const place = (p) => (was.has(p.index) ? was.get(p.index) : was.size + p.index);
  out.sort((a, b) => place(a) - place(b) || a.index - b.index);
  if (out.length) store.writeText(dir, { pages: out });

  if (permanent) throw new Error(permanent);
  const res = { transcribed, reused, escalated, pages: out, calls, errors };
  if (quota) { res.hold = "quota"; res.pausedUntil = tomorrow(o.now); res.note = QUOTA_NOTE; }
  return res;
}

module.exports = {
  PROMPT_VERSION, TRANSCRIBE_PROMPT, PROVIDERS, DEFAULTS, CONFIG_FILE,
  QUOTA_NOTE, TIMEOUT_MS, MAX_TOKENS,
  aiBase, baseFor, loadConfig, ladderFor, parseModelJson, normalizeLoose, firstDivergence,
  dayOf, tomorrow, pagesOf,
  callModel, transcribePage, transcribeBook,
};
