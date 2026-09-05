// content-providers.js — step 2 of the book builder (spec §4.2): the printed
// page in, the printed WORDS out. One vision call per page under the
// transcription policy, straight into .build/text.json.
//
// This file holds three things and nothing else:
//
//   1. THE POLICY, as TWO NAMED PASSES (`transcribe` and `second-opinion`) with
//      the config naming which wording each one sends. The bake-off measured the
//      pair ASYMMETRICALLY — the transcriber under v2, its partner under v3 —
//      and this hub sends exactly that: both wordings are ported verbatim from
//      tools/ocr-bakeoff/lib/prompts.mjs and asserted against it byte for byte,
//      so the pair decorrelates by WORDING as well as by model, the way the
//      numbers were taken. Changing a word invalidates the bake-off's numbers.
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
//      is spent it PAUSES the book until the allowance is expected back — the
//      429's own RetryInfo, else midnight in California where a free key's day
//      is counted, never this computer's midnight ("the pause", below). The job
//      stays claimed, the state stays "transcribing", and status says "waiting
//      for tomorrow's quota" (spec §7 risks). A free key builds a book over
//      several days; it must never look like a failure.
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
const imprint = require("./content-imprint.js");
const { aiRoles } = require("./ai-config.js");

// ---------------------------------------------------------------- the policy

// TWO NAMED PASSES, TWO WORDINGS (E3, 9/4; the gap below CLOSED by L7, 9/4).
//
// WHAT THE BAKE-OFF MEASURED. Its pair was measured ASYMMETRICALLY: the
// transcriber (gemini-3.1-flash-lite) read under the older v2 wording and its
// partner (gemini-3.5-flash-lite) under v3, because a shared wording correlates
// two models' mistakes as surely as a shared model does — and because v3 is not
// an upgrade, it is a TRADE (README "v3 is not an upgrade - it is a trade":
// scored like for like against the same amended reference, 3.1 reads better
// under v2, 3.5 reads better under v3). The 89.2% auto-publish,
// zero-silent-error number the whole decision rests on is a number about THIS
// pair asked THOSE two ways, and the decision memo says so in as many words:
// "the transcriber runs v2; v3 is used only as the decorrelating partner
// prompt".
//
// THE KNOWN GAP IS CLOSED (L7, 9/4). For a day this file could only prove v3, so
// both passes sent it and the pair decorrelated by MODEL alone. v2's exact text
// has since been RECOVERED — the harness file as it stood in a worktree snapshot
// taken at 07:11, inside the 06:33–07:26 window the private cache's 3,120 v2
// records span, differing from v3 in nothing but PROMPT_VERSION and rules 5 and
// 6, exactly as v3's changelog says it should. It now lives in the harness as a
// second exported wording (`transcribePromptV2()`), so this hub PORTS it, and the
// suite asserts both wordings against that file byte for byte. The port is a copy
// rather than a require() because the harness is ESM and the hub's Windows floor
// is Node 18, where require(esm) does not exist (plan §A3); a test can import it,
// and does.
//
// Why "port, never paraphrase" is written this hard: the wording that shipped
// here before the recovery was a hand-reconstruction, and it was wrong in a way
// that mattered — it put "or signs" into rule 5 from a changelog sentence that
// describes an early draft of V3 — which made the transcriber's request a THIRD
// wording nobody had ever measured, sent under the name of one that was.
//
// And whatever is pinned: NEVER "upgrade both" in one move. Bumping one pass to
// the other's version, or a future v4 to both, quietly re-runs the pair as one
// measurement nobody has made. If the re-validation (tools/ocr-bakeoff/README.md,
// due 2027-03) says a new wording wins, add it below and re-pin ONE pass at a
// time, with the re-run's numbers to say which.

// The v3 policy, ported verbatim from tools/ocr-bakeoff/lib/prompts.mjs
// (POLICY there). One string, because a wording is one thing: the suite
// asserts it against that file byte for byte, and a re-run that changes a
// word there fails this hub's tests rather than drifting past them.
const POLICY_V3 = `You are transcribing one photographed page of a printed children's picture book so it can be read aloud by a speech synthesiser. A single wrong word is a failure. Follow these rules exactly.

1. VERBATIM PRINTED TEXT ONLY. Transcribe the words exactly as printed. Never modernise, localise or correct spelling (British spelling stays British). Never add, expand or paraphrase words that are not printed. Do not translate.
2. READING ORDER follows the visual and narrative flow of the page, not raw top-to-bottom geometry. For rhyming verse use rhyme and metre as an ordering signal across columns, panels and speech bubbles, so the text reads coherently start to finish.
3. ELLIPSES: render any printed ellipsis, including a spaced ". . .", as three dots "...". Keep leading or trailing ellipses that are used as page-turn continuations.
4. QUOTES: transcribe quotation marks exactly as printed, even when they are unbalanced on this page (a speech may continue across pages).
5. JUNK REMOVAL: drop text that belongs to the illustration rather than the story - decorative lettering painted on objects such as boat hulls, barcodes, printed page numbers, publisher furniture, and misread glyphs (for example a stray "99" that is really a quotation mark). BUT lettering that is PART OF THE STORY is story text and MUST be transcribed, in its place in reading order, even when it is hand-lettered or drawn into the art: words a character writes, reads, holds up or paints - a sign, a blackboard, a banner, a letter shown to the reader. If the words carry the story's meaning, they belong in "text". Publisher furniture is still dropped, always: running heads (the title or chapter repeated in the margin or the art), printed page numbers, ISBN and barcode lines, imprint, publisher and printer lines, and price stickers.
6. COVERS: if this page is a cover, transcribe the printed title, author and illustrator with the casing exactly as printed. Do not invent a byline that is not printed. ORDER ON A COVER IS FIXED, because a cover has no narrative flow: transcribe the printed blocks strictly TOP TO BOTTOM in the order they appear on the page. On many picture books the author and illustrator names are printed ABOVE the title - when they are, they come first. Do not promote the title to the front, and do not group the names with a byline at the end. Anything added to this particular copy is NOT part of the book and must be ignored entirely: handwritten inscriptions, gift dedications, an owner's name written or printed on a label, library stamps, and stickers of any kind. Only text PRINTED as part of the cover is transcribed, top to bottom as printed.
7. If the page has no printed story text at all (a full-bleed illustration, an endpaper), return an empty string for "text".
8. LINE AND STANZA BREAKS: use a single newline between printed lines of verse and a blank line between stanzas or separate text blocks. Do not re-wrap prose.
9. FLAG, DO NOT GUESS: list in "uncertain" every word you are not fully confident about (obscured, blurred, cut off, or ambiguous). Still put your best reading in "text"; the list is for human review.`;

// The v2 policy, ported verbatim from the same file (POLICY_V2 there). This is
// the wording the TRANSCRIBER was measured under, and the only thing that
// separates it from v3 is rules 5 and 6: v2 drops all lettering painted into the
// art (signs included), and says nothing about what a gift inscription on our own
// copy is. That difference is the point - v3 is a TRADE, not an upgrade, and
// 3.1-flash-lite reads better under this one.
const POLICY_V2 = `You are transcribing one photographed page of a printed children's picture book so it can be read aloud by a speech synthesiser. A single wrong word is a failure. Follow these rules exactly.

1. VERBATIM PRINTED TEXT ONLY. Transcribe the words exactly as printed. Never modernise, localise or correct spelling (British spelling stays British). Never add, expand or paraphrase words that are not printed. Do not translate.
2. READING ORDER follows the visual and narrative flow of the page, not raw top-to-bottom geometry. For rhyming verse use rhyme and metre as an ordering signal across columns, panels and speech bubbles, so the text reads coherently start to finish.
3. ELLIPSES: render any printed ellipsis, including a spaced ". . .", as three dots "...". Keep leading or trailing ellipses that are used as page-turn continuations.
4. QUOTES: transcribe quotation marks exactly as printed, even when they are unbalanced on this page (a speech may continue across pages).
5. JUNK REMOVAL: drop text that belongs to the illustration rather than the story - lettering painted on objects such as boat hulls or signs, barcodes, printed page numbers, publisher furniture, and misread glyphs (for example a stray "99" that is really a quotation mark).
6. COVERS: if this page is a cover, transcribe the printed title, author and illustrator with the casing exactly as printed. Do not invent a byline that is not printed. ORDER ON A COVER IS FIXED, because a cover has no narrative flow: transcribe the printed blocks strictly TOP TO BOTTOM in the order they appear on the page. On many picture books the author and illustrator names are printed ABOVE the title - when they are, they come first. Do not promote the title to the front, and do not group the names with a byline at the end.
7. If the page has no printed story text at all (a full-bleed illustration, an endpaper), return an empty string for "text".
8. LINE AND STANZA BREAKS: use a single newline between printed lines of verse and a blank line between stanzas or separate text blocks. Do not re-wrap prose.
9. FLAG, DO NOT GUESS: list in "uncertain" every word you are not fully confident about (obscured, blurred, cut off, or ambiguous). Still put your best reading in "text"; the list is for human review.`;

// The shape of the answer, the same for every wording there has ever been
// (the harness's changelog: OUTPUT_CONTRACT is byte-identical across v2 and v3).
const OUTPUT_CONTRACT = `Reply with a single JSON object and nothing else - no prose, no markdown code fence:
{"text": "<the full page transcription>", "uncertain": ["<word>", ...]}
Use "uncertain": [] when you are confident about every word.`;

// Version id -> the exact string a model is sent. Both entries are the harness's
// own, and the suite asserts each one against it byte for byte.
const PROMPT_TEXT = {
  v2: POLICY_V2 + "\n\n" + OUTPUT_CONTRACT,
  v3: POLICY_V3 + "\n\n" + OUTPUT_CONTRACT,
};

// The two PASSES, and the version each one is pinned to. The pass name is what
// the rest of this file asks for, so no call site can pick a wording by
// accident — and re-pinning one pass is one line here, not an edit in five
// places. The pinning below is the measured configuration itself: `transcribe`
// asks under v2 because that is how the bake-off asked the transcriber, and
// `second-opinion` under v3 because a shared wording correlates two models'
// mistakes as surely as a shared model does.
const PASSES = ["transcribe", "second-opinion"];
const DEFAULT_PROMPTS = { "transcribe": "v2", "second-opinion": "v3" };

// The first pass's wording, for a caller that has no config to hand (and the
// name the older tests know it by).
const TRANSCRIBE_PROMPT = PROMPT_TEXT[DEFAULT_PROMPTS.transcribe];

// Which wording this pass sends, under this config. An unknown version is not a
// wordless page: the pinned default stands.
function promptFor(config, pass) {
  const pinned = (config && config.transcribe && config.transcribe.prompts) || DEFAULT_PROMPTS;
  return PROMPT_TEXT[pinned[pass]] || PROMPT_TEXT[DEFAULT_PROMPTS[pass]] || TRANSCRIBE_PROMPT;
}

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
//   prompts       which WORDING each pass sends, by name: {"transcribe": "v3",
//                 "second-opinion": "v3"} today, because v3 is the only wording
//                 this repo holds (the KNOWN GAP under "the policy" above). The
//                 asymmetry the bake-off measured is the point of this field —
//                 re-pin ONE pass at a time, with a re-run's numbers, and never
//                 "upgrade both".
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
    prompts: DEFAULT_PROMPTS,
  },
};

function loadConfig(dataDir) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dataDir || "", CONFIG_FILE), "utf8")); } catch {}
  const t = (raw && typeof raw.transcribe === "object" && raw.transcribe) || {};
  // `prompts` is copied, never shared: DEFAULTS is one object the whole process
  // reads, and a config file must not be able to edit it.
  const out = { transcribe: { ...DEFAULTS.transcribe, prompts: { ...DEFAULT_PROMPTS } } };
  for (const k of Object.keys(DEFAULTS.transcribe)) {
    if (k === "prompts") continue;
    if (t[k] !== undefined && t[k] !== null) out.transcribe[k] = t[k];
  }
  // Merged PER PASS, and only for a version this hub actually holds: a file that
  // re-pins one pass must not silently un-pin the other (that is how a pair
  // becomes two models reading the same words), and a typo must not send a page
  // an empty prompt.
  const p = (t.prompts && typeof t.prompts === "object") ? t.prompts : {};
  for (const pass of PASSES) if (PROMPT_TEXT[p[pass]]) out.transcribe.prompts[pass] = p[pass];
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
//
// AND THE MEMO IS ONLY WRITTEN WHEN THE RE-SHAPED CALL IS ACCEPTED. A 400
// INVALID_ARGUMENT is not proof that the knob was the problem: a corrupt photo,
// a page too big to send, a field Google stopped taking all come back the same
// way, and the live body says only "Request contains an invalid argument" —
// there is nothing in it to read. Adopting the new shape on the strength of the
// refusal alone re-pinned the transcriber's request for the whole process the
// first time ANY page was refused for ANY reason, and the model quietly stopped
// being sent the request its accuracy was measured under. Getting it wrong now
// costs one extra call on the page that was refused, and nothing after it.
const THINKING_OFF = { thinkingBudget: 0 };             // 2.x, 3.1: no thinking at all
const THINKING_MINIMAL = { thinkingLevel: "minimal" };  // 3.5+: the least it will do
const thinkingShape = new Map();                        // model id -> the shape it ACCEPTED
function thinkingFor(model) { return thinkingShape.get(model) || THINKING_OFF; }
// A model that refused the shape we sent may want the other one. Re-shapes THIS
// call only and returns true when there was another shape left to try, i.e. the
// call is worth re-sending. Nothing is remembered here — see callModel.
function retune(body) {
  const gen = body.generationConfig;
  if (!gen || gen.thinkingConfig === THINKING_MINIMAL) return false;
  gen.thinkingConfig = THINKING_MINIMAL;
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
  let last = "", retry = null, retuned = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 3000));
    let r;
    try {
      r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs || TIMEOUT_MS) });
    } catch (e) { last = store.redact(e.message); continue; }
    if (r.ok) {
      // ACCEPTED — so now we know what this model takes, and every later call
      // in this process starts in that shape (see the thinking knob above).
      if (retuned) thinkingShape.set(model, THINKING_MINIMAL);
      const parsed = parseModelJson(extract(await r.json()));
      return { text: parsed.text, uncertain: parsed.uncertain, parseError: parsed.parseError, model };
    }
    // The WHOLE body first, for every question we ask of it — the 429's
    // RetryInfo lives past the 160 characters the log keeps (F6), and so does
    // the "status": "INVALID_ARGUMENT" that Google puts LAST in the envelope
    // once its message names the offending field. Only then the short, redacted
    // line we may write down. Nothing but the delay is taken from it.
    const raw = await r.text().catch(() => "");
    if (r.status === 429) retry = soonest(retry, quotaHint(raw));
    last = r.status + " " + store.redact(raw.slice(0, 160));
    if (r.status === 401 || r.status === 403)
      throw new Error("permanent: the AI provider did not accept that key (" + r.status +
                      ") — check the key in Settings");
    // The thinking knob, refused. Re-shaped and sent again WITHOUT spending an
    // attempt: the two attempts exist for a provider that is throttling, and
    // this is a provider that is answering — it is telling us the request is the
    // wrong shape. retune() gives up after one re-shape, so this cannot spin.
    if (r.status === 400 && provider === "google" && /INVALID_ARGUMENT/.test(raw) &&
        retune(body)) { retuned = true; attempt--; continue; }
    if (r.status === 429) break;                     // no point retrying a spent allowance
    if (r.status < 500) break;                       // 400/404: try the next model
  }
  const err = new Error("ai(" + provider + "/" + model + ") " + last);
  // Carried, never logged: when this rung asked us to come back, and whether it
  // was the DAY that ran out. The pause is seeded from both (F6).
  if (retry) err.retryAfter = retry;
  throw err;
}

// ---------------------------------------------------------------- one page

// transcribePage({imagePath, policy, cfg}) -> {text, uncertain[], model}
//
// The interface the whole step is written against (plan T2.6). Optional extras:
//   models  the rungs to try (default: the provider's ladder)
//   spent   a Set of model ids whose daily allowance is gone — shared across a
//           whole book, so page two never knocks on a door page one found shut
//   policy  the wording to send (default: this config's `transcribe` pass —
//           never the other pass's, so a caller that forgets cannot be the one
//           that accidentally asks both models the same question)
// Throws with `.quota = true` when every rung is spent: that is a PAUSE, not a
// failure, and transcribeBook turns it into one.
async function transcribePage(o) {
  const cfg = o.cfg || {};
  const prompt = o.policy || promptFor(o.config, "transcribe");
  const spent = o.spent instanceof Set ? o.spent : new Set();
  const all = o.models || ladderFor(cfg, o.config);
  const list = all.filter(m => !spent.has(m));
  if (!list.length) {
    const e = new Error("every model's daily allowance is spent");
    e.quota = true;
    throw e;
  }
  let lastErr = "", retry = null;
  for (const model of list) {
    try {
      return await callModel({ imagePath: o.imagePath, prompt, cfg, model, timeoutMs: o.timeoutMs });
    } catch (e) {
      lastErr = e.message;
      if (isPermanent(e.message)) throw e;           // a bad key refuses every rung
      if (isQuota(e.message)) spent.add(model);
      retry = soonest(retry, e.retryAfter);
      console.error("[content] transcribe " + model + ": " + e.message);
    }
  }
  const err = new Error(lastErr || "no model answered");
  if (all.every(m => spent.has(m))) err.quota = true;
  if (retry) err.retryAfter = retry;                 // when the ladder said to come back
  throw err;
}

// ------------------------------------------------------------- the pause

// WHEN DOES A SPENT ALLOWANCE COME BACK? (F6, 9/4.) This used to be a local
// calendar DAY, and it was wrong twice over on this family's hardware:
//
//   * Google's free tier resets at midnight AMERICA/LOS_ANGELES, which is where
//     the allowance is counted. A hub running on UTC — every QA box, and any
//     machine whose clock is not Californian — woke at its own 00:00, five in
//     the afternoon in California, collected a fresh 429 and paused itself for
//     a WHOLE EXTRA DAY. A book that should have finished overnight took three.
//   * A 429 is not always the day being over. The free tier also limits
//     requests per MINUTE, and a book that pauses until tomorrow over a
//     forty-seven second throttle has thrown the whole evening away.
//
// So the pause is a MOMENT, and it is seeded from the best answer available:
//
//   1. the 429's own google.rpc.RetryInfo.retryDelay ("47s") — but ONLY when
//      the QuotaFailure beside it does not say the DAY is what ran out. Google
//      sends a few seconds' delay for both limits, and taking it at face value
//      on a per-day 429 woke the book seconds later to be refused again, all
//      day: about forty-eight wakes, five refused requests each, and a job.json
//      and log.jsonl rewrite INSIDE the family's Drive folder every time, for
//      Drive to re-upload and re-mirror to every device. The QuotaFailure names
//      which limit it is (quotaId "…PerDay…"), so there is nothing to guess.
//   2. the next midnight in America/Los_Angeles, computed through Intl's own
//      time-zone data (no npm, no offset table, and correct across both DST
//      changes — the offset is 7 hours in summer and 8 in winter). This is the
//      answer for a spent DAY, and the delay is only a floor under it.
//   3. the old local-day rule, if this Node has no zone data to compute (2)
//      with. Wrong by hours on a UTC box, but never wrong by a day the way a
//      pause that failed to be written at all would be.
//
// Everything downstream (job.json's pausedUntil, /content/status, the scan)
// goes through pauseHolds(), which still understands the "YYYY-MM-DD" a hub
// older than this wrote — a family updating mid-book must not have its paused
// book either wake early or sleep for ever.
function dayOf(now) {
  const d = new Date(now == null ? Date.now() : now);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function tomorrow(now) { return dayOf((now == null ? Date.now() : now) + 24 * 60 * 60 * 1000); }

// Where Google counts a free key's day.
const QUOTA_TZ = "America/Los_Angeles";
// A retryDelay longer than this is not a daily allowance coming back, it is a
// misread body: fall through to the midnight rule rather than park a book for
// a week on one number nobody can see.
const MAX_RETRY_MS = 26 * 60 * 60 * 1000;

// The wall clock in `tz` at instant `t`, as numbers. Intl is the only thing in
// Node that knows when California last changed its clocks.
function zoneParts(t, tz) {
  const out = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}
// How far `tz` is from UTC at that instant, in ms (negative west of Greenwich).
function zoneOffset(t, tz) {
  const p = zoneParts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
// The instant of the next 00:00:00 in `tz`. Computed twice on purpose: the
// offset at the boundary is not always the offset now (the night the clocks
// change), and the second pass is the one that lands on the real midnight.
function nextZoneMidnight(t, zone) {
  const tz = zone || QUOTA_TZ;
  const p = zoneParts(t, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day + 1);
  return wall - zoneOffset(wall - zoneOffset(t, tz), tz);
}

// The moment a paused book may knock again, as an ISO timestamp. `retry` is a
// hint from the 429 itself — {ms, perDay} — and a bare number is still read as
// the delay it used to be. A per-day refusal takes the midnight rule with the
// delay only as a floor under it; anything else (a per-minute throttle, or a
// 429 that names no limit) is over when the delay says it is.
function pausedUntilFor(now, retry, perDayFlag) {
  const t = now == null ? Date.now() : now;
  const hint = retry && typeof retry === "object" ? retry : { ms: retry, perDay: !!perDayFlag };
  const ms = hint.ms;
  const floor = Number.isFinite(ms) && ms > 0 && ms <= MAX_RETRY_MS ? t + ms : null;
  if (floor != null && !hint.perDay) return new Date(floor).toISOString();
  const notBefore = (at) => new Date(floor == null ? at : Math.max(at, floor)).toISOString();
  try {
    const at = nextZoneMidnight(t, QUOTA_TZ);
    if (Number.isFinite(at) && at > t) return notBefore(at);
  } catch (e) {
    console.error("[content] no time-zone data for " + QUOTA_TZ + " (" + e.message +
                  ") - falling back to this computer's own midnight");
  }
  const d = new Date(t);
  return notBefore(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
}

// Is a recorded pause still running? Understands BOTH shapes: a timestamp (what
// this hub writes) and the bare "YYYY-MM-DD" a hub older than F6 wrote, which
// meant "not before tomorrow, local time".
function pauseHolds(until, now) {
  if (until == null || until === "") return false;
  const t = now == null ? Date.now() : now;
  if (typeof until === "number") return until > t;
  const s = String(until);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s > dayOf(t);
  const at = Date.parse(s);
  return Number.isFinite(at) ? at > t : false;
}

// The 429's own answer to "when may I ask again?", in ms. The body is read
// WHOLE and before any truncation: the RetryInfo detail sits at the end of a
// body several hundred characters long, and the 160 characters we keep for the
// log cut it clean off.
function retryAfterMs(raw) {
  if (raw == null) return null;
  const s = String(raw);
  let details = null;
  try {
    const j = JSON.parse(s);
    if (j && j.error && Array.isArray(j.error.details)) details = j.error.details;
  } catch {}
  const seconds = (v) => {
    const m = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(String(v == null ? "" : v));
    return m ? Math.round(Number(m[1]) * 1000) : null;
  };
  for (const d of details || []) if (d && d.retryDelay != null) {
    const ms = seconds(d.retryDelay);
    if (ms != null) return ms;
  }
  // A body that is not the JSON we expected still usually SAYS it, and a
  // provider's exact envelope is not something to bet a day of a book on.
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(s);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

// Which limit was hit. The google.rpc.QuotaFailure beside the RetryInfo names
// it — quotaId "GenerateRequestsPerDayPerProjectPerModel-FreeTier" — and the
// difference is a book that sleeps for forty-seven seconds against one that
// sleeps until California's midnight. Read WHOLE, like the delay: this detail
// sits at the front of the envelope, but a body that is not quite the JSON we
// expect still says the word.
function perDayQuota(raw) {
  if (raw == null) return false;
  const s = String(raw);
  try {
    const j = JSON.parse(s);
    const details = (j && j.error && Array.isArray(j.error.details)) ? j.error.details : [];
    for (const d of details) for (const v of (d && Array.isArray(d.violations) ? d.violations : []))
      if (v && /PerDay/i.test(String(v.quotaId || ""))) return true;
    if (details.length) return false;
  } catch {}
  return /"quotaId"\s*:\s*"[^"]*PerDay/i.test(s);
}

// Everything a 429's body has to say about when to come back: {ms, perDay}.
const quotaHint = (raw) => ({ ms: retryAfterMs(raw), perDay: perDayQuota(raw) });

// WHOSE ALLOWANCE THIS BOOK IS WAITING ON (T6b.1). The pause has to name a
// provider now, because ElevenLabs can pause a book too and the two are mended
// in different places. The vision card's own answer, defaulted the way
// callModel defaults it — a card holding something this hub does not know reads
// as the free Google tier everywhere else, and must here too.
const providerOf = (cfg) => (cfg && PROVIDERS[cfg.provider] ? cfg.provider : "google");

// The EARLIEST of the hints a run collected: when the ladder is spent, the
// first rung to come back is the one that decides when the book wakes — and it
// brings its own answer to "was that the whole day?" with it.
function soonest(a, b) {
  if (!b || !Number.isFinite(b.ms) || b.ms <= 0) return a;
  if (!a || !Number.isFinite(a.ms) || a.ms <= 0) return b;
  return b.ms < a.ms ? b : a;
}

// ---------------------------------------------------------------- one book

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
//   opts.job      the job as read from job.json, for its pausedUntil moment
//   opts.now      pinned clock (tests)
//
// Returns {transcribed, reused, escalated, pages, calls, errors} on a normal
// run, {hold:"no-ai-key"} when there is no key to spend, and
// {hold:"quota", provider, pausedUntil, note} when the ladder is spent —
// pausedUntil is the ISO moment the allowance is expected back (see "the pause"
// above) and `provider` is whose allowance it was, for the card that has to
// tell the family where credit is added (T6b.1).
// Throws only for a permanent refusal — content-worker.js turns that into a
// failed job with the provider's own words, and never retries it.
async function transcribeBook(dir, opts) {
  const o = opts || {};
  const cfg = o.cfg || (o.dataDir ? aiRoles(o.dataDir).vision : null);
  const config = o.config || loadConfig(o.dataDir);
  const log = (msg) => store.appendLog(dir, "transcribe", msg, { now: o.now });

  if (!cfg || !cfg.apiKey) {
    // A hold, not a failure: the parent has not added a key yet, and the book
    // waits in the folder exactly as they left it.
    log("no AI key yet - add one in Settings and the book will read itself");
    return { hold: "no-ai-key", transcribed: 0, reused: 0, escalated: 0, pages: [], calls: 0, errors: [] };
  }
  // Already told "not yet". Asking again costs a request to hear the same
  // thing, and on a free key that request is a page we could have read once the
  // allowance is back. The recorded moment is echoed back exactly as it was
  // written — including the plain day a hub older than F6 wrote there.
  //
  // A PAUSE BELONGS TO ONE ALLOWANCE, AND THIS STEP SPENDS ONLY ONE OF THEM
  // (review 9/5). Since T6b the voice can park a book too, and ElevenLabs' month
  // is four weeks long — so a pause taken at face value here would stop the
  // reader dead for a month over characters it never sends, and "Read the photos
  // again" would read nothing and tell the family it worked. A pause with no
  // name on it is older than T6b and could only ever have been this step's own.
  const paused = o.job && o.job.pausedUntil;
  const mine = !o.job || !o.job.pausedProvider || o.job.pausedProvider === providerOf(cfg);
  if (mine && pauseHolds(paused, o.now))
    return { hold: "quota", pausedUntil: paused, note: o.job.pausedNote || QUOTA_NOTE,
             // Whoever wrote this pause said whose it was; re-holding on it must
             // not rename it (a book paused on the VOICE that is asked to
             // transcribe would otherwise start blaming Google).
             provider: o.job.pausedProvider || providerOf(cfg),
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
  // Did the walk get all the way to the end of the book? Only then may the
  // final write prune (see the bottom of this function). A quota pause leaves
  // this true on purpose: every page it skipped was skipped AFTER the pages
  // that already had words were carried into `out`, so nothing is lost.
  let walked = true;
  let retry = null;                                 // when the spent ladder asked us back, and whether the DAY is what ran out

  // THE ORDER text.json ALREADY HAS IS THE BOOK'S ORDER, because a grown-up may
  // have dragged the pages about on the review page (spec §5) and a re-read must
  // not shuffle the book back to the order the camera happened to number the
  // photos in. Pages this pass already knew about keep their places; anything
  // new lands after them, by index — which for a first pass (nothing known) is
  // exactly the plain index sort this used to do.
  const was = new Map([...had.keys()].map((index, at) => [index, at]));
  const place = (p) => (was.has(p.index) ? was.get(p.index) : was.size + p.index);
  const inOrder = (list) => list.slice().sort((a, b) => place(a) - place(b) || a.index - b.index);

  // AFTER EVERY PAGE, not once at the end (L3, e2e 9/4). A book on a throttled
  // free key is hours long, and until this the whole pass lived in memory: the
  // parent's card said "0 read" the entire time, and a worker that died in the
  // middle — a reboot, a hub restart, the allowance running out — took every
  // page it had already bought with it. tmp + rename (store.writeText), so a
  // reader only ever sees a whole file; and the pages this walk has not
  // REACHED yet are written alongside the ones it has decided, because a
  // re-read of one page (`only`) walks past text somebody already paid for and
  // must never be the reason it is gone.
  const save = () => {
    const seen = new Set(out.map(p => p.index));
    const rest = [...had.values()].filter(p => !seen.has(p.index));
    store.writeText(dir, { pages: inOrder(out.concat(rest)) });
  };
  // One line per thinking re-shape (L4). The memo itself is a measurement — it
  // is only ever set when the re-shaped call was ACCEPTED (see callModel) — so
  // a new name in this map is a model that has just told us, for the life of
  // this process, which shape it takes. Said out loud once, on the page it
  // happened on, so the ledger can be read without the request bodies.
  const shaped = new Set(thinkingShape.keys());
  const sayRetunes = () => {
    for (const model of thinkingShape.keys()) {
      if (shaped.has(model)) continue;
      shaped.add(model);
      log(model + ": re-shaped the thinking knob to " + Object.keys(THINKING_MINIMAL)[0]);
    }
  };

  for (const page of pages) {
    const before = transcribed;
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
      // has already found shut. The `transcribe` wording, which is the one the
      // transcriber's accuracy was measured under.
      const first = await transcribePage({ imagePath, cfg, config, spent,
                                           policy: promptFor(config, "transcribe") });
      calls++;
      // THE PUBLISHER IS NOT THE BOOK (E5, 9/4). Every reading is stripped of
      // its imprint lines the moment it arrives — BEFORE the agreement
      // comparison and before anything is stored — because the furniture is
      // the one part of a page the two models were never going to agree about
      // (an ISBN is thirteen digits of chances to differ) and because a reader
      // would say it out loud. The prompt asks for the same thing and the
      // bake-off watched every wording fail to get it; content-imprint.js is
      // the rule rather than the request. `stripped` is the count for the
      // reading that ENDS UP ON THE PAGE — the number that explains the missing
      // lines to a parent — and it goes in the log, never in text.json.
      const firstRead = imprint.strip(first.text);
      let text = firstRead.text, unsure = first.uncertain.slice(), note = null;
      let stripped = firstRead.removed;
      // WHO READ THIS PAGE (F7). `readBy` is whichever rung produced the words
      // that end up on the page — the transcriber usually, the partner when the
      // transcriber's allowance ran out mid-book, the decider when there was a
      // disagreement and something to settle it. It is not always the model the
      // config names, and a review page that assumes it is tells the parent a
      // model read a page it never saw.
      let readBy = first.model, checkedBy = null, agreed = null;

      // The optional second opinion (spec §4.2). Two cheap rungs read the page;
      // if a listener could tell their readings apart, a stronger model decides
      // and the page is flagged either way.
      // A second or third opinion that cannot be bought is never allowed to
      // cost the reading we already have: the page keeps it, flagged, and the
      // spent rung is remembered for the rest of the book. Only a refused key
      // (which refuses everything) escapes.
      if (agree) {
        // A DIFFERENT MODEL — and, when there is a second wording to ask it
        // under, a different question. The partner is a second opinion only as
        // far as it can be wrong independently, and two models reading the same
        // page from the same words are wrong together more often than the
        // bake-off's 89.2% assumes; asking each pass by NAME is what keeps the
        // wordings re-pinnable one at a time (see "the policy" above, where
        // both names currently resolve to v3 and why).
        const secondPolicy = promptFor(config, "second-opinion");
        const second = ladderFor(cfg, config).filter(m => !spent.has(m) && m !== first.model);
        let b = null, bText = null, unchecked = null;
        if (!second.length) unchecked = "no second model was left to ask";
        else {
          try {
            b = await transcribePage({ imagePath, cfg, config, spent, models: [second[0]], policy: secondPolicy });
            calls++;
            // Stripped on arrival, like the first reading: the two are compared
            // on the words the book is made of and on nothing else.
            bText = imprint.strip(b.text).text;
          }
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
          // A MARK ON THE PAGE, and it names no word — because nobody was unsure
          // of one. The review page highlights a flag's `word` wherever it finds
          // it in the page's own text, so a whole-page mark that borrowed the
          // word channel (it used to carry the literal string "page") promised a
          // parent a doubtful word, highlighted nothing, and counted itself in
          // "N words the AI was unsure of" — 30 of them on a 30-page book the
          // day the partner rung was down. `word: null` is the whole-page
          // channel; content.js counts it as a page and the review page shows
          // the note.
          unsure.push({ word: null, reason: note });
        } else if (normalizeLoose(bText) !== normalizeLoose(text)) {
          checkedBy = b.model; agreed = false;
          const word = firstDivergence(text, bText);
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
            // The decider is a CHECKER, so it is asked the checker's question:
            // it arrives after a reading made under the other wording, and
            // sending it the transcriber's own words would tilt it towards the
            // reading it is here to weigh.
            try { c = await transcribePage({ imagePath, cfg, config, spent, models: [strong[0]], policy: secondPolicy }); calls++; }
            catch (e) {
              if (isPermanent(e.message)) throw e;
              log("page " + page.index + ": no decider (" + store.redact(e.message) + ")");
            }
          }
          if (c) {
            escalated++;
            const cRead = imprint.strip(c.text);
            text = cRead.text; stripped = cRead.removed;
            unsure = c.uncertain.slice(); readBy = c.model;
            note = "two models read this page differently; " + c.model + " decided";
          } else {
            // Nothing left to break the tie: keep the first reading and say
            // so. A flagged page still publishes (ruling 9/4).
            note = "two models read this page differently and there was no third to ask";
          }
          // The word they parted company on, when there is one to point at; a
          // whole-page mark when there is not (see `word: null` above).
          unsure.push({ word: word || null, reason: note });
        } else { checkedBy = b.model; agreed = true; }
      }

      // A flag is either a WORD the model was unsure of (the model's own
      // `uncertain` list, and the word two readings parted company on) or a
      // mark on the WHOLE PAGE, which names no word: `word` is null there, and
      // every reader of this list has to expect it.
      const flags = unsure.map(u => typeof u === "string"
        ? { word: u, reason: FLAG_UNSURE }
        : { word: u.word == null ? null : u.word, reason: u.reason });
      out.push({ index: page.index, source: page.source, text,
                 flags, cover: done ? !!done.cover : page.index === 1,
                 read: { model: readBy, checkedBy, agreed } });
      transcribed++;
      // Said out loud in the log because it is the only place it is said: a
      // parent looking at a title page that came out with two words on it (or
      // none at all) can see that the rest of it was the publisher's.
      if (stripped) log("page " + page.index + ": imprint lines removed: " + stripped);
      log("page " + page.index + ": " + text.split(/\s+/).filter(Boolean).length + " word(s)" +
          (flags.length ? ", " + flags.length + " flag(s)" : "") + (note ? " - " + note : ""));
    } catch (e) {
      const msg = store.redact(e && e.message ? e.message : String(e));
      if (e && e.quota) {
        // Not an error. The book keeps the pages it already has and waits.
        quota = true;
        retry = soonest(retry, e.retryAfter);
        log("every model's daily allowance is spent - " + QUOTA_NOTE);
        continue;
      }
      errors.push(msg);
      log("page " + page.index + " failed: " + msg);
      if (isPermanent(msg)) { permanent = msg; walked = false; break; }
      if (done) { out.push(done); reused++; }
    } finally {
      // SAID ON EVERY WAY OUT OF THE PAGE, not just the happy one. The memo is
      // remembered for the life of the process and the next pass seeds `shaped`
      // from it, so a line skipped here is a re-shape that is never written down
      // by anybody: a model that re-shaped on the page that then 429'd (the
      // free-tier path this exists for) or on the page that met a refused key
      // used to change the request the transcriber's accuracy was measured
      // under, silently, for the whole run and every run after it.
      sayRetunes();
    }
    // The page is on disk before the next one is asked for.
    if (transcribed > before) save();
  }

  // The last word, and the only one that may PRUNE: a page whose photo has gone
  // is dropped here — but ONLY where the walk actually reached the end of the
  // book. A permanent refusal part-way through breaks out of the loop, and the
  // pages BELOW it were never looked at: pruning to what the walk happened to
  // hold would delete text somebody already paid for (a mid-book gap left by
  // yesterday's transient failure, or a re-read of one early page), and the
  // half-way writes deliberately keep everything they have not reached for
  // exactly that reason. So the unreached pages come through here too.
  const seen = new Set(out.map(p => p.index));
  const rest = walked ? [] : [...had.values()].filter(p => !seen.has(p.index));
  const all = inOrder(out.concat(rest));
  if (all.length) store.writeText(dir, { pages: all });

  if (permanent) throw new Error(permanent);
  const res = { transcribed, reused, escalated, pages: all, calls, errors };
  if (quota) {
    res.hold = "quota";
    res.provider = providerOf(cfg);
    res.pausedUntil = pausedUntilFor(o.now, retry);
    res.note = QUOTA_NOTE;
  }
  return res;
}

module.exports = {
  PROMPT_TEXT, DEFAULT_PROMPTS, PASSES, TRANSCRIBE_PROMPT, promptFor,
  PROVIDERS, DEFAULTS, CONFIG_FILE,
  QUOTA_NOTE, TIMEOUT_MS, MAX_TOKENS, QUOTA_TZ,
  aiBase, baseFor, loadConfig, ladderFor, parseModelJson, normalizeLoose, firstDivergence,
  dayOf, tomorrow, pagesOf,
  retryAfterMs, nextZoneMidnight, pausedUntilFor, pauseHolds,
  callModel, transcribePage, transcribeBook,
};
