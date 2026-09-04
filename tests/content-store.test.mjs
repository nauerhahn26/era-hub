// content-store.test.mjs — the three build artefacts a content job owns:
// .build/text.json (the interop point), .build/job.json (the state machine)
// and .build/log.jsonl (the human-readable trail), plus the writeAtomic()
// every catalogue writer in the suite uses.
// In-process only: no server, no port, no network, no key. (Port table: this
// suite claims none — plan §B, Gap 21.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const store = require(path.join(HUB, "content-store.js"));

// Every fake credential below is ASSEMBLED AT RUNTIME, never written out as a
// literal: era-scan (.github/era-scan.sh) treats a `sk_…` / `sk-…` run in a
// tracked file as a fatal secret-pattern hit, and it is right to — a fixture
// that looks like a key is indistinguishable from one that is.
const fake = (...parts) => parts.join("");

function book(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "era-cstore-" + tag + "-"));
  return d;
}

// ---------------------------------------------------------------- writeAtomic

test("writeAtomic writes through a .tmp and leaves none behind", () => {
  const dir = book("atomic");
  const target = path.join(dir, "manifest.json");
  store.writeAtomic(target, { hello: "world" });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { hello: "world" });
  assert.deepEqual(fs.readdirSync(dir), ["manifest.json"]);   // no manifest.tmp
});

test("writeAtomic renames rather than writing the target in place", () => {
  const dir = book("rename");
  const target = path.join(dir, "catalog.json");
  const renames = [];
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([String(a), String(b)]); return real(a, b); };
  try { store.writeAtomic(target, "{}\n"); } finally { fs.renameSync = real; }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], target);
  assert.ok(renames[0][0].endsWith(".tmp"), renames[0][0] + " should be a .tmp");
});

test("writeAtomic does not clobber the target when the write fails", () => {
  const dir = book("clobber");
  const target = path.join(dir, "manifest.json");
  fs.writeFileSync(target, '{"good":1}');
  // A DIRECTORY where the tmp file wants to go: the open throws EISDIR, and
  // the half-written state must never reach manifest.json.
  const tmp = store.tmpPathFor(target);
  fs.mkdirSync(tmp);
  assert.throws(() => store.writeAtomic(target, { bad: 2 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { good: 1 });
  fs.rmdirSync(tmp);
});

test("writeAtomic creates the parent directory and takes strings and Buffers", () => {
  const dir = book("mkdir");
  const target = path.join(dir, "a", "b", "text.json");
  store.writeAtomic(target, "raw\n");
  assert.equal(fs.readFileSync(target, "utf8"), "raw\n");
  store.writeAtomic(target, Buffer.from("buf\n"));
  assert.equal(fs.readFileSync(target, "utf8"), "buf\n");
});

// ------------------------------------------------------------------ text.json

test("text.json round-trips losslessly with flags and unicode", () => {
  const dir = book("text");
  const text = {
    pages: [
      { index: 0, source: "IMG_0001.jpg", text: "Zoë’s garden — 花 was in trouble.",
        flags: [{ word: "Zoë’s", reason: "low-confidence" }], cover: true, edited: false },
      // `edited` is "a grown-up typed these words" — the one thing that decides
      // whether "Read the photos again" keeps a page or re-reads it (spec §5),
      // so it has to survive a write and a read like every other field.
      { index: 1, source: "IMG_0002.JPG", text: "", flags: [], cover: false, edited: true },
    ],
  };
  const written = store.writeText(dir, text);
  const back = store.readText(dir);
  assert.deepEqual(back, written);
  assert.deepEqual(back, text);
  assert.equal(back.pages[0].text, "Zoë’s garden — 花 was in trouble.");
  assert.equal(back.pages[0].flags[0].word, "Zoë’s");
  // it lands where the folder contract says it does
  assert.ok(fs.existsSync(path.join(dir, ".build", "text.json")));
});

test("text.json normalises the sloppy shapes and rejects the wrong ones", () => {
  // missing flags/cover fill in; index/source/text are required
  const norm = store.normalizeText({ pages: [{ index: 2, source: "a.jpg", text: "hi" }] });
  assert.deepEqual(norm, { pages: [{ index: 2, source: "a.jpg", text: "hi",
                                     flags: [], cover: false, edited: false }] });
  assert.deepEqual(store.normalizeText({}), { pages: [] });
  assert.throws(() => store.normalizeText({ pages: [{ index: "0", source: "a.jpg", text: "" }] }), /index/);
  assert.throws(() => store.normalizeText({ pages: [{ index: 0, text: "" }] }), /source/);
  assert.throws(() => store.normalizeText({ pages: [{ index: 0, source: "a.jpg", text: 7 }] }), /text/);
  assert.throws(() => store.normalizeText({ pages: [{ index: 0, source: "a.jpg", text: "", flags: [{ reason: "x" }] }] }), /word/);
  assert.throws(() => store.normalizeText({ pages: {} }), /pages/);
});

// F7. `read` is who produced the words on this page and who checked them —
// written by the transcribe step, read by the review page. It is OPTIONAL on
// purpose: every text.json written before it, and every one a parent typed by
// hand in power mode, has none, and none of them may start failing to load.
test("a page may say who read it - and a page that does not is unchanged", () => {
  const dir = book("provenance");
  const read = { model: "a-model", checkedBy: "another-model", agreed: false };
  const back = store.writeText(dir, { pages: [
    { index: 1, source: "a.jpg", text: "hi", read },
    { index: 2, source: "b.jpg", text: "ho" },
  ] });
  assert.deepEqual(back.pages[0].read, read, "it survives a write and a read");
  assert.deepEqual(store.readText(dir).pages[0].read, read);
  assert.ok(!("read" in back.pages[1]), "a page nobody recorded a reader for grows no field");

  // nobody checked it: the two partner fields are null, never absent
  assert.deepEqual(store.normalizeText({ pages: [{ index: 1, source: "a.jpg", text: "", read: { model: "m" } }] })
    .pages[0].read, { model: "m", checkedBy: null, agreed: null });
  // …and a `read` that names no model is not provenance at all, so it is
  // defaulted away rather than thrown at a reader that never asked for it
  for (const bad of [{}, { model: "" }, { model: 7 }, "a-model", null, []])
    assert.ok(!("read" in store.normalizeText({ pages: [{ index: 1, source: "a.jpg", text: "", read: bad }] }).pages[0]),
      "a malformed read is dropped, not fatal: " + JSON.stringify(bad));
});

test("readText on a folder with no build dir is null, not a throw", () => {
  assert.equal(store.readText(book("notext")), null);
});

// ------------------------------------------------------------------- job.json

test("every legal transition is legal, and the happy chain walks end to end", () => {
  const chain = ["inbox", "transcribing", "reviewing", "narrating", "published", "animating", "done"];
  let job = store.newJob({ claimedBy: "hub-test", now: "2026-09-04T00:00:00.000Z" });
  assert.equal(job.state, "inbox");
  for (const next of chain.slice(1)) job = store.transition(job, next);
  assert.equal(job.state, "done");
  for (const s of chain) assert.ok(job.steps[s], "steps should record " + s);

  // the whole declared table, one transition at a time
  for (const [from, tos] of Object.entries(store.LEGAL)) {
    for (const to of tos) {
      assert.ok(store.canTransition(from, to), from + " -> " + to + " should be legal");
      const j = store.transition({ ...store.newJob({}), state: from }, to);
      assert.equal(j.state, to);
    }
  }
  // animation is optional: a book with no fal key finishes straight from published
  assert.ok(store.canTransition("published", "done"));
  // failed is reachable from every state, and a re-run may resume anywhere
  for (const s of store.STATES) if (s !== "failed") {
    assert.ok(store.canTransition(s, "failed"), s + " -> failed");
    assert.ok(store.canTransition("failed", s), "failed -> " + s);
  }
});

test("illegal transitions throw and leave the job untouched", () => {
  const job = store.newJob({ claimedBy: "hub-test" });
  assert.throws(() => store.transition(job, "narrating"), /inbox -> narrating/);   // skips ahead
  const pub = { ...job, state: "published" };
  assert.throws(() => store.transition(pub, "transcribing"), /published -> transcribing/); // backwards
  assert.throws(() => store.transition({ ...job, state: "done" }, "animating"), /done -> animating/);
  assert.throws(() => store.transition(job, "nonsense"), /nonsense/);
  assert.throws(() => store.transition({ ...job, state: "melting" }, "melting"), /melting/);
  assert.equal(job.state, "inbox");   // transition never mutates its input
});

test("re-entering the same state is a heartbeat, not a transition", () => {
  const job = store.newJob({ claimedBy: "hub-test", now: "2026-09-04T00:00:00.000Z" });
  const again = store.transition(job, "inbox", { now: "2026-09-04T00:05:00.000Z" });
  assert.equal(again.state, "inbox");
  assert.equal(again.heartbeat, "2026-09-04T00:05:00.000Z");
});

test("failed from mid-state keeps the prior errors and remembers where it fell", () => {
  let job = store.newJob({ claimedBy: "hub-test", now: "2026-09-04T00:00:00.000Z" });
  job = store.transition(job, "transcribing");
  job = store.fail(job, "vision 429", { now: "2026-09-04T00:01:00.000Z" });
  assert.equal(job.state, "failed");
  assert.equal(job.failedFrom, "transcribing");
  assert.equal(job.errors.length, 1);
  assert.deepEqual(job.errors[0], { t: "2026-09-04T00:01:00.000Z", state: "transcribing", msg: "vision 429" });

  // re-run, fall over again: the first error is still on the record
  job = store.transition(job, "transcribing");
  job = store.fail(job, "vision 500", { now: "2026-09-04T00:02:00.000Z" });
  assert.equal(job.errors.length, 2);
  assert.equal(job.errors[0].msg, "vision 429");
  assert.equal(job.errors[1].msg, "vision 500");
  assert.equal(job.failedFrom, "transcribing");
});

test("an error message carrying a key is redacted before it reaches job.json", () => {
  const dir = book("jobkey");
  let job = store.fail(store.newJob({}), "POST https://api/x?api_key=" + fake("AIza", "SyFAKEFAKEFAKEFAKEFAKE0123") + " failed");
  store.writeJob(dir, job);
  const raw = fs.readFileSync(store.jobPath(dir), "utf8");
  assert.ok(!raw.includes(fake("AIza", "SyFAKE")), "job.json must not carry a key: " + raw);
  assert.ok(/redacted/.test(raw));
});

test("job.json round-trips and a bad state is refused", () => {
  const dir = book("job");
  assert.equal(store.readJob(dir), null);
  const job = store.transition(store.newJob({ claimedBy: "hub-a" }), "transcribing");
  store.writeJob(dir, job);
  assert.deepEqual(store.readJob(dir), job);
  assert.ok(fs.existsSync(path.join(dir, ".build", "job.json")));
  assert.throws(() => store.writeJob(dir, { ...job, state: "melting" }), /melting/);
});

// ----------------------------------------------------------------- log.jsonl

test("log.jsonl is one {t, step, msg} object per line", () => {
  const dir = book("log");
  const line = store.appendLog(dir, "ingest", "3 pages", { now: "2026-09-04T00:00:00.000Z" });
  store.appendLog(dir, "transcribe", "page 1 of 3", { now: "2026-09-04T00:00:01.000Z" });
  assert.deepEqual(line, { t: "2026-09-04T00:00:00.000Z", step: "ingest", msg: "3 pages" });
  const raw = fs.readFileSync(store.logPath(dir), "utf8");
  assert.equal(raw.split("\n").filter(Boolean).length, 2);
  for (const l of raw.split("\n").filter(Boolean)) {
    assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ["msg", "step", "t"]);
  }
  const back = store.readLog(dir);
  assert.equal(back.length, 2);
  assert.equal(back[1].msg, "page 1 of 3");
});

test("readLog tolerates a torn last line", () => {
  const dir = book("torn");
  store.appendLog(dir, "ingest", "ok");
  fs.appendFileSync(store.logPath(dir), '{"t":"2026-09-04T00:00:0');
  const back = store.readLog(dir);
  assert.equal(back.length, 1);
  assert.equal(back[0].msg, "ok");
});

test("a log line that carries a key-looking string is redacted", () => {
  const dir = book("logkey");
  const HEX = "0123456789abcdef0123456789abcdef";
  const cases = [
    ["anthropic", "auth failed for " + fake("sk", "-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"), "-ant-api03"],
    ["openai", fake("sk", "-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII") + " rejected", "AAAABBBB"],
    ["elevenlabs", "used " + fake("sk", "_", HEX, "01234567"), HEX],
    ["google url", "GET https://generativelanguage.googleapis.com/v1/models?key=" + fake("AIza", "SyFAKE0123456789abcdefGHIJ"), "SyFAKE"],
    // The form the Settings card tells families to paste TODAY (AI Studio keys
    // start "AQ."), bare in a sentence with no `key=` in front of it to catch it.
    ["google bare", "provider said: " + fake("AQ", ".", "Ab8RN6", "0123456789abcdefGHIJ"), "Ab8RN6"],
    ["bearer", "header Bearer " + fake("abcdef0123456789abcdef"), "abcdef0123456789"],
    ["xi-api-key", "xi-api-key " + HEX, HEX],
    ["assignment", 'api_key="hunter2hunter2hunter2"', "hunter2"],
  ];
  for (const [name, msg, leak] of cases) {
    const written = store.appendLog(dir, "narrate", msg);
    assert.ok(!written.msg.includes(leak), name + ": leaked -> " + written.msg);
    assert.ok(written.msg.includes("[redacted]"), name + ": no marker -> " + written.msg);
  }
  const raw = fs.readFileSync(store.logPath(dir), "utf8");
  for (const [name, , leak] of cases) assert.ok(!raw.includes(leak), name + " leaked to disk");
  // every line still parses as JSON after redaction
  for (const l of raw.split("\n").filter(Boolean)) JSON.parse(l);
  // and the step name is redacted too
  assert.ok(!store.appendLog(dir, fake("sk", "-ant-api03-AAAABBBBCCCCDDDD"), "x").step.includes("-ant-api03"));
});

test("redact leaves ordinary build prose alone", () => {
  for (const s of [
    "wrote pages/001.jpg (2048 long edge)",
    "voice JBFqnCBsd6RMkjVDRZzb",                     // a voice id is not a key
    "book 'Tabby McTat' -> tabby-mctat, 12 pages",
    "waiting for tomorrow's quota",
    "key: none",
  ]) assert.equal(store.redact(s), s, s);
});

test("appendLog never throws, even when the log cannot be written", () => {
  const dir = book("logfail");
  fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
  fs.mkdirSync(store.logPath(dir));   // a directory where the log wants to be
  assert.equal(store.appendLog(dir, "ingest", "ok"), null);
  assert.deepEqual(store.readLog(dir), []);
});
