// this-week-recipe.test.mjs — the week package on the shelf becomes the
// "This week" board (spec 2026-10-12 §3, plan B1). Two halves:
//
//   1. in-process: this-week.js is pure, so readWeek / validate / recipe /
//      videoState / build are driven directly against a temp data dir;
//   2. over HTTP: a real hub on port 8456 (this suite's own — see the plan's
//      free-port table) serves /recipes/this-week.json, the /this-week/ media
//      jail and /this-week/status.
//
// Fixture week only: 2026-01-05, "Shadows!", fake 11-char ids. Nothing real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tw = require(path.join(HUB, "this-week.js"));
const PORT = 8456;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-this-week-"));
const WEEK = "2026-01-05";
const A = "aBcDeFgHiJk", B = "bBcDeFgHiJk", C = "cBcDeFgHiJk";

const WORDS = [
  ["shadow", "science", { glyph: "🌑" }], ["light", "science", { glyph: "💡" }],
  ["sun", "science", { glyph: "☀️" }], ["lamp", "science", { glyph: "🪔" }],
  ["dark", "describing", { glyph: "🌚" }], ["big", "describing", { glyph: "🐘" }],
  ["small", "describing", { glyph: "🐜" }], ["more", "core", { symbol: "more" }],
  ["help", "core", { symbol: "help" }], ["go", "core", { symbol: "go" }],
];
function manifest(extra = {}) {
  return {
    week_of: WEEK, title: "Shadows!", schema: 1, approved: "2026-01-02T10:00:00Z",
    topic: { science: "light and shadows", social_studies: "our special place",
             phonics: "short e", math: "make ten", hero: null },
    watch: [A, B, C].map((id, i) => ({
      id, title: "Shadow video " + (i + 1), channel: "A Channel", minutes: 5,
      why: "shows shadows", before: null,
      oembed: { title: "Shadow video " + (i + 1), author_name: "A Channel",
                thumbnail_url: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" },
    })),
    talk: WORDS.map(([w, group, g]) => ({ word: w, say: w, group, ...g })),
    play: { which: [], playit: { instrument: "shadow-puppet", q: "Tall?", answer: 0 } },
    ...extra,
  };
}
function writeWeek(dataDir, week, m, files = true) {
  const dir = path.join(dataDir, "this-week", week);
  fs.mkdirSync(dir, { recursive: true });
  if (files) {
    fs.writeFileSync(path.join(dir, A + ".mp4"), Buffer.alloc(1024, 1));
    fs.writeFileSync(path.join(dir, A + ".webp"), Buffer.alloc(64, 2));
    fs.writeFileSync(path.join(dir, B + ".mp4"), Buffer.alloc(0));
    fs.writeFileSync(path.join(dir, "claim-a.json"), JSON.stringify({ device: "x", started: 1 }));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), typeof m === "string" ? m : JSON.stringify(m));
  return dir;
}
const board = (r, id) => r.boards.find(b => b.id === id);
const at = (b, row, col) => b.buttons.filter(c => c.row === row && c.col === col);

// ---------------------------------------------------------------- in-process

const PLAY_DOOR = { type: "link", href: "/play/?w=" + WEEK, label: "Play", say: "play",
                    glyph: "🎲", row: 2, col: 2 };

// The small boards (spec 2026-10-12 §1 and §3.4, amended 2026-10-25): the root
// is the 2×3 triangle, Watch a 3×3 ring around a black centre, Talk stays 3×4.
test("root board: the 2×3 triangle — Watch [1,1] + Talk [1,3] + Play [2,2], say_on_load on the first", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  const { recipe } = tw.build(d);
  assert.equal(recipe.root, "this-week");
  const root = board(recipe, "this-week");
  assert.equal(root.rows, 2); assert.equal(root.columns, 3);
  assert.equal(root.name, "Shadows!");
  assert.equal(root.buttons.length, 3);
  assert.deepEqual(root.buttons[0], { type: "show", board: "watch", label: "Watch", say: "watch",
    glyph: "🎬", row: 1, col: 1, say_on_load: "This week: Shadows!" });
  assert.deepEqual(root.buttons[1], { type: "show", board: "talk-1", label: "Talk", say: "talk",
    glyph: "💬", row: 1, col: 3 });
  // the fixture's play holds only a playit: that alone opens the door
  assert.deepEqual(root.buttons[2], PLAY_DOOR);
  for (const [row, col] of [[1, 2], [2, 1], [2, 3]])
    assert.equal(at(root, row, col).length, 0, `[${row},${col}] stays black`);
  for (const c of root.buttons)
    assert.ok(c.row <= 2 && c.col <= 3, "every door inside the 2×3: " + JSON.stringify(c));
});

test("watch board: the 3×3 ring — Back, one ready video, two 'not here yet' in seats", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  const w = board(tw.build(d).recipe, "watch");
  assert.equal(w.rows, 3); assert.equal(w.columns, 3);
  assert.equal(w.buttons.length, 4);
  assert.deepEqual(at(w, 1, 1)[0], { label: "Back", say: "back", type: "back", glyph: "←",
    load: "this-week", row: 1, col: 1 });
  assert.deepEqual(at(w, 1, 2)[0], { type: "video", id: A, week_of: WEEK, label: "Shadow video 1",
    image: `this-week/${WEEK}/${A}.webp`, row: 1, col: 2 });
  assert.deepEqual(at(w, 1, 3)[0], { type: "word", label: "Shadow video 2", say: "not here yet",
    glyph: "⏳", row: 1, col: 3 });
  assert.deepEqual(at(w, 2, 1)[0], { type: "word", label: "Shadow video 3", say: "not here yet",
    glyph: "⏳", row: 2, col: 1 });
  assert.equal(at(w, 2, 2).length, 0, "centre stays black");
  assert.equal(at(w, 2, 3).length + at(w, 3, 1).length, 0, "unused ring seats stay black");
  for (const c of w.buttons)
    assert.ok(c.row <= 3 && c.col <= 3, "every tile inside the 3×3: " + JSON.stringify(c));
});

test("watch board: five videos fill the ring in manifest order; fewer fill in that order", () => {
  const RING = [[1, 2], [1, 3], [2, 1], [2, 3], [3, 1]];
  assert.deepEqual(tw.WATCH_SEATS, RING);
  const ids = ["aBcDeFgHiJk", "bBcDeFgHiJk", "cBcDeFgHiJk", "dBcDeFgHiJk", "eBcDeFgHiJk"];
  for (let n = 1; n <= 5; n++) {
    const m = manifest();
    m.watch = ids.slice(0, n).map((id, i) => ({ ...m.watch[0], id, title: "Shadow video " + (i + 1) }));
    const d = fs.mkdtempSync(path.join(TMP, "d-"));
    writeWeek(d, WEEK, m);
    const w = board(tw.build(d).recipe, "watch");
    assert.equal(w.rows, 3); assert.equal(w.columns, 3);
    const vids = w.buttons.filter(c => c.type !== "back");
    assert.deepEqual(vids.map(c => c.label), ids.slice(0, n).map((_, i) => "Shadow video " + (i + 1)));
    assert.deepEqual(vids.map(c => [c.row, c.col]), RING.slice(0, n), n + " videos");
    assert.equal(at(w, 2, 2).length, 0, "centre stays black with " + n);
    assert.deepEqual(at(w, 1, 1).map(c => c.type), ["back"]);
  }
});

test("talk boards: 8 words + More on talk-1, 2 words + Back and no More on talk-2", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  const r = tw.build(d).recipe;
  const t1 = board(r, "talk-1"), t2 = board(r, "talk-2");
  for (const t of [t1, t2]) { assert.equal(t.rows, 3); assert.equal(t.columns, 4); }
  const words1 = t1.buttons.filter(c => c.type === "word");
  assert.equal(words1.length, 8);
  assert.deepEqual(words1.map(c => [c.row, c.col]),
    [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]]);
  assert.deepEqual(words1[0], { type: "word", label: "shadow", say: "shadow", glyph: "🌑", row: 1, col: 2 });
  assert.deepEqual(words1[7], { type: "word", label: "more", say: "more", symbol: "more", row: 3, col: 4 });
  assert.deepEqual(at(t1, 1, 1)[0].load, "this-week");
  assert.deepEqual(at(t1, 3, 1)[0], { label: "More", type: "control", symbol: "more",
    load: "talk-2", row: 3, col: 1 });
  assert.equal(t2.buttons.filter(c => c.type === "word").length, 2);
  assert.equal(at(t2, 1, 1)[0].type, "back");
  assert.equal(at(t2, 1, 1)[0].load, "this-week");
  assert.equal(at(t2, 3, 1).length, 0, "no More on the last page");
  assert.equal(board(r, "talk-3"), undefined);
});

test("validate drops a bad item and lists it, never the page", () => {
  const m = manifest();
  m.watch.push({ ...m.watch[0], id: "not-an-id" });
  m.talk.push({ word: "both", say: "both", group: "core", glyph: "🌑", symbol: "more" });
  m.talk.push({ word: "x", say: "x", group: "nope", glyph: "🌑" });
  m.talk.push({ word: "waytoolongforaword", say: "w", group: "core", glyph: "🌑" });
  m.talk.push({ word: "notemoji", say: "n", group: "core", glyph: "ab" });
  const out = tw.validate(m);
  assert.equal(out.manifest.watch.length, 3);
  assert.equal(out.manifest.talk.length, 10);
  assert.equal(out.dropped.length, 5);
  assert.ok(out.dropped.some(x => /not-an-id/.test(JSON.stringify(x))));
  const bad = { ...manifest() }; bad.watch[1] = { ...bad.watch[1], minutes: 40 };
  assert.equal(tw.validate(bad).manifest.watch.length, 2);
  assert.throws(() => tw.validate({ ...manifest(), pages: [] }));
  assert.throws(() => tw.validate({ ...manifest(), cover: "x.jpg" }));
  const noTalk = manifest(); delete noTalk.talk;
  assert.throws(() => tw.validate(noTalk));
});

test("videoState: ready needs bytes; thumbnail ext is the first present", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  const dir = writeWeek(d, WEEK, manifest());
  assert.deepEqual(tw.videoState(dir, A), { ready: true, ext: "webp", size: 1024 });
  assert.equal(tw.videoState(dir, B).ready, false);
  assert.equal(tw.videoState(dir, C).ready, false);
  assert.equal(tw.videoState(dir, C).ext, null);
});

test("ETag changes when the zero-byte mp4 gains bytes, stable otherwise", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  const dir = writeWeek(d, WEEK, manifest());
  const e1 = tw.build(d).etag, e2 = tw.build(d).etag;
  assert.equal(e1, e2);
  assert.match(e1, /^"\d+-\d+-[0-9a-f]+-r3"$/);
  assert.equal(tw.THIS_WEEK_REV, 3);
  fs.writeFileSync(path.join(dir, B + ".mp4"), Buffer.alloc(512, 1));
  const e3 = tw.build(d).etag;
  assert.notEqual(e3, e1);
  const v = at(board(tw.build(d).recipe, "watch"), 1, 3)[0];
  assert.equal(v.type, "video");
});

test("two week folders: the newest wins; an unparseable newer one is skipped", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  writeWeek(d, "2026-01-12", manifest({ week_of: "2026-01-12", title: "Next!" }), false);
  assert.equal(tw.readWeek(d).week_of, "2026-01-12");
  writeWeek(d, "2026-01-19", "{not json", false);
  assert.equal(tw.readWeek(d).week_of, "2026-01-12");
  fs.mkdirSync(path.join(d, "this-week", ".tmp"), { recursive: true });
  assert.equal(tw.readWeek(d).week_of, "2026-01-12");
});

test("no folder: root-only valid 2×3 board, etag none-r3", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  assert.equal(tw.readWeek(d), null);
  const out = tw.build(d);
  assert.equal(out.etag, '"none-r3"');
  assert.equal(out.recipe.root, "this-week");
  assert.deepEqual(out.recipe.boards.map(b => b.id), ["this-week"]);
  assert.equal(out.recipe.boards[0].rows, 2); assert.equal(out.recipe.boards[0].columns, 3);
  assert.deepEqual(out.recipe.boards[0].buttons, []);
  assert.deepEqual(tw.emptyRecipe().boards[0], { id: "this-week", name: "This week", rows: 2, columns: 3,
                                                  buttons: [] });
});

test("a manifest with pages is refused: err etag, root-only", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest({ pages: [] }));
  const out = tw.build(d);
  assert.match(out.etag, /^"err-\d+"$/);
  assert.deepEqual(out.recipe.boards.map(b => b.id), ["this-week"]);
});

// ------------------------------------------------- Play (spec 2026-10-12 §5.6)

const ch = (label, glyph, right, sound) => {
  const c = { label, glyph };
  if (sound !== undefined) c.sound = sound;
  c.right = right ? true : null;
  return c;
};
const which = (id, skill, q, choices) => ({ id, skill, q, choices });
function fullPlay() {
  return {
    which: [
      which("w1", "true-false", "A shadow is light. Yes or no?",
        [ch("no", "👎", true), ch("yes", "👍", false)]),   // listed no-first, kept as listed
      which("w2", "compare", "Which shadow is bigger?", [ch("tree", "🌳", true), ch("ant", "🐜", false)]),
      which("w3", "predict", "What makes a shadow?",
        [ch("light", "💡", true, "bell-high"), ch("water", "💧", false), ch("sound", "🔔", false)]),
      which("w4", "count", "How many lamps?", [ch("two", "🪔", true), ch("five", "🖐️", false)]),
      which("w5", "add", "One sun and one moon make?", [ch("two", "✌️", true), ch("three", "🌟", false)]),
      which("w6", "rhyme", "What rhymes with sun?", [ch("fun", "🎉", true), ch("cat", "🐱", false)]),
      which("w7", "decode", "Which word says bed?", [ch("bed", "🛏️", true), ch("bad", "😠", false)]),
      which("w8", "sequence", "What comes first?", [ch("lamp on", "💡", true), ch("shadow", "🌑", false)]),
      which("w9", "cause", "Why is it dark at night?", [ch("no sun", "🌙", true), ch("rain", "🌧️", false)]),
    ],
    sort: { bins: [{ label: "makes light", glyph: "💡" }, { label: "no light", glyph: "🌑" }],
            skill: "classify",
            items: [{ label: "sun", glyph: "☀️", bin: 0 }, { label: "lamp", glyph: "🪔", bin: 0 },
                    { label: "rock", glyph: "🪨", bin: 1 }, { label: "book", glyph: "📕", bin: 1 }] },
    playit: { instrument: "harmonica", q: "Which hole makes the lowest note?", answer: 0 },
  };
}
const BEFORE = which("b1", "predict", "Will the shadow be big or small?",
  [ch("big", "🐘", true, "drum-low"), ch("small", "🐜", false, "drum-high")]);
function fullManifest() {
  const m = manifest({ play: fullPlay() });
  m.watch[0] = { ...m.watch[0], before: BEFORE };
  return m;
}

test("play.json: a full week validates whole, the root has the Play door", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, fullManifest());
  const pj = tw.playJson(d, WEEK);
  assert.deepEqual(Object.keys(pj).sort(), ["before", "dropped", "play", "title", "week_of"]);
  assert.equal(pj.week_of, WEEK);
  assert.equal(pj.title, "Shadows!");
  assert.deepEqual(pj.dropped, []);
  assert.deepEqual(pj.play, fullPlay());
  assert.equal(pj.play.which[0].choices[0].label, "no", "the hub keeps manifest order; seating is the page's");
  assert.deepEqual(pj.before, { [A]: BEFORE });
  const root = board(tw.build(d).recipe, "this-week");
  assert.deepEqual(at(root, 2, 2), [PLAY_DOOR]);
  // validatePlay is the same answer without the disk
  const v = tw.validatePlay(fullManifest());
  assert.deepEqual(v, { play: fullPlay(), before: { [A]: BEFORE }, dropped: [] });
});

test("play.json: each malformed item is dropped with a reason, the page intact", () => {
  const m = fullManifest();
  const p = m.play;
  p.which.push(which("x1", "compare", "Two rights?", [ch("a", "🌳", true), ch("b", "🐜", true)]));
  p.which.push(which("x2", "compare", "Four choices?",
    [ch("a", "🌳", true), ch("b", "🐜"), ch("c", "💡"), ch("d", "🌑")]));
  p.which[2] = which("w3", "predict", "Bad glyph?", [ch("a", "ab", true), ch("b", "🐜")]);
  p.playit = { instrument: "harmonica", q: "Which hole?", answer: 10 };
  p.sort = { ...p.sort, bins: [{ label: "only", glyph: "💡" }] };
  m.watch[1] = { ...m.watch[1], before: which("b2", "predict", "No right?",
    [ch("big", "🐘"), ch("small", "🐜")]) };
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, m);
  const pj = tw.playJson(d, WEEK);
  // which: 9 + 2 pushed - the bad glyph (w3) - two rights - four choices = 8
  assert.deepEqual(pj.play.which.map(w => w.id), ["w1", "w2", "w4", "w5", "w6", "w7", "w8", "w9"]);
  assert.equal(pj.play.sort, null);
  assert.equal(pj.play.playit, null);
  assert.deepEqual(pj.before, { [A]: BEFORE });
  const why = (field, test) => pj.dropped.find(x => x.field === field && test(x));
  assert.ok(why("play.which", x => x.index === 9 && /right/.test(x.why)), "two rights");
  assert.ok(why("play.which", x => x.index === 10 && /choices/.test(x.why)), "four choices");
  assert.ok(why("play.which", x => x.index === 2 && /glyph/.test(x.why)), "bad glyph");
  assert.ok(why("play.playit", x => /answer/.test(x.why)), "answer 10");
  assert.ok(why("play.sort", x => /bins/.test(x.why)), "one bin");
  assert.ok(why("before", x => x.id === B && /right/.test(x.why)), "before with no right");
  assert.equal(pj.dropped.length, 6);
  for (const x of pj.dropped) assert.ok(typeof x.why === "string" && x.why, JSON.stringify(x));
  // the board is untouched: watch + talk as before, Play still opens on the which left
  const r = tw.build(d).recipe;
  assert.equal(board(r, "watch").buttons.length, 4);
  assert.equal(board(r, "talk-1").buttons.filter(c => c.type === "word").length, 8);
  assert.deepEqual(at(board(r, "this-week"), 2, 2), [PLAY_DOOR]);
});

test("validatePlay: the rest of the schema's rules, one item at a time", () => {
  const one = (mut) => { const m = fullManifest(); mut(m.play, m); return tw.validatePlay(m); };
  const W = (o) => one(p => { p.which = [o]; });
  const good = fullPlay().which[1];
  assert.equal(W(good).play.which.length, 1);
  assert.equal(W({ ...good, id: "" }).play.which.length, 0, "empty id");
  assert.equal(W({ ...good, skill: "spelling" }).play.which.length, 0, "skill outside the twelve");
  assert.equal(W({ ...good, q: "" }).play.which.length, 0, "empty q");
  assert.equal(W({ ...good, q: "x".repeat(161) }).play.which.length, 0, "q over 160");
  assert.equal(W({ ...good, q: "x".repeat(160) }).play.which.length, 1, "q at 160");
  assert.equal(W({ ...good, choices: [ch("a", "🌳", true)] }).play.which.length, 0, "one choice");
  assert.equal(W({ ...good, choices: [ch("", "🌳", true), ch("b", "🐜")] }).play.which.length, 0, "empty label");
  assert.equal(W({ ...good, choices: [ch("x".repeat(41), "🌳", true), ch("b", "🐜")] }).play.which.length, 0,
    "label over 40");
  assert.equal(W({ ...good, choices: [ch("a", "🌳", true, 7), ch("b", "🐜")] }).play.which.length, 0,
    "sound not a string");
  assert.equal(W({ ...good, choices: [ch("a", "🌳", true, null), ch("b", "🐜")] }).play.which.length, 1,
    "sound null is absent");
  assert.equal(W({ ...good, choices: [ch("a", "🌳", true, "no-such-voice"), ch("b", "🐜")] })
    .play.which.length, 1, "an unknown sound name is the page's to ignore");
  assert.equal(W({ ...good, choices: [ch("a", "🌳"), ch("b", "🐜")] }).play.which.length, 0, "no right");
  assert.equal(W(null).play.which.length, 0, "not an object");
  const dup = one(p => { p.which = [good, { ...good }]; });
  assert.equal(dup.play.which.length, 1);
  assert.match(dup.dropped[0].why, /duplicate/);
  const eleven = one(p => { p.which = Array.from({ length: 11 }, (_, i) => ({ ...good, id: "w" + i })); });
  assert.equal(eleven.play.which.length, 10);
  assert.equal(eleven.dropped.length, 1);
  // sort
  const S = (mut) => one(p => mut(p.sort)).play.sort;
  assert.notEqual(S(() => {}), null);
  assert.equal(S(s => { s.bins.push({ label: "third", glyph: "🌳" }); }), null, "three bins");
  assert.equal(S(s => { s.bins[0].glyph = "ab"; }), null, "bin glyph");
  assert.equal(S(s => { s.bins[1].label = ""; }), null, "bin label");
  assert.equal(S(s => { s.items = s.items.slice(0, 3); }), null, "three items");
  assert.equal(S(s => { while (s.items.length < 11) s.items.push({ label: "x", glyph: "🪨", bin: 1 }); }), null,
    "eleven items");
  assert.equal(S(s => { s.items[0].bin = 2; }), null, "bin 2");
  assert.equal(S(s => { s.items[0].bin = "0"; }), null, "bin a string");
  assert.equal(S(s => { s.items[0].glyph = "rock"; }), null, "item glyph");
  assert.equal(S(s => { s.items[0].label = ""; }), null, "item label");
  assert.equal(S(s => { s.skill = "spelling"; }), null, "sort skill");
  // playit: positions 10, 10, 2, 2
  const P = (o) => one(p => { p.playit = o; }).play.playit;
  for (const [instrument, n] of [["harmonica", 10], ["xylophone", 10], ["string-telephone", 2], ["shadow-puppet", 2]]) {
    assert.notEqual(P({ instrument, q: "Which?", answer: n - 1 }), null, instrument + " " + (n - 1));
    assert.equal(P({ instrument, q: "Which?", answer: n }), null, instrument + " " + n);
  }
  assert.equal(P({ instrument: "harmonica", q: "Which?", answer: -1 }), null, "negative");
  assert.equal(P({ instrument: "harmonica", q: "Which?", answer: 1.5 }), null, "not an integer");
  assert.equal(P({ instrument: "harmonica", q: "Which?", answer: "0" }), null, "a string");
  assert.equal(P({ instrument: "kazoo", q: "Which?", answer: 0 }), null, "unknown instrument");
  assert.equal(P({ instrument: "harmonica", q: "", answer: 0 }), null, "empty q");
  // before: absent and null are not drops; a bad one is
  const nb = one((p, m) => { m.watch[0] = { ...m.watch[0], before: null }; });
  assert.deepEqual(nb.before, {}); assert.deepEqual(nb.dropped, []);
  const ab = one((p, m) => { delete m.watch[0].before; });
  assert.deepEqual(ab.before, {}); assert.deepEqual(ab.dropped, []);
});

test("no play: no door, play.json carries empty engines; all-invalid play: no door either", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  const m = manifest(); delete m.play;
  writeWeek(d, WEEK, m);
  const pj = tw.playJson(d, WEEK);
  assert.deepEqual(pj.play, { which: [], sort: null, playit: null });
  assert.deepEqual(pj.before, {});
  assert.deepEqual(pj.dropped, []);
  const root = board(tw.build(d).recipe, "this-week");
  assert.equal(root.buttons.length, 2);
  assert.deepEqual(root.buttons.map(c => [c.label, c.row, c.col]), [["Watch", 1, 1], ["Talk", 1, 3]]);
  assert.equal(at(root, 2, 2).length, 0, "the seat stays black");
  const d2 = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d2, WEEK, manifest({ play: { which: [which("x", "nope", "?", [])], sort: { bins: [] },
                                          playit: { instrument: "kazoo", q: "?", answer: 0 } } }));
  assert.equal(at(board(tw.build(d2).recipe, "this-week"), 2, 2).length, 0);
  assert.equal(tw.playJson(d2, WEEK).dropped.length, 3);
  const d3 = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d3, WEEK, manifest({ play: null }));
  assert.deepEqual(tw.playJson(d3, WEEK).play, { which: [], sort: null, playit: null });
});

test("playJson: null for no such week, a bad week string, a broken manifest", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  writeWeek(d, "2026-01-19", "{not json", false);
  writeWeek(d, "2026-01-26", manifest({ pages: [] }), false);
  assert.equal(tw.playJson(d, "2026-01-12"), null);
  assert.equal(tw.playJson(d, "../x"), null);
  assert.equal(tw.playJson(d, "2026-01-19"), null);
  assert.equal(tw.playJson(d, "2026-01-26"), null);
  assert.notEqual(tw.playJson(d, WEEK), null, "an older week than the newest is still served");
});

// ---------------------------------------------------------------- over HTTP

let child = null;
const HDATA = path.join(TMP, "hub-data");
before(async () => {
  writeWeek(HDATA, WEEK, manifest());
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: HDATA, ERA_BIND: "127.0.0.1",
           ERA_DRIVE_LOCAL_ROOTS: path.join(TMP, "no-roots"),
           ERA_PACK_ROOT: path.join(TMP, "no-packs"),
           ERA_AI_URL: "http://127.0.0.1:9/never",
           ERA_WEATHER_URL: "http://127.0.0.1:9/never",
           ERA_GEO_URL: "http://127.0.0.1:9/never",
           ERA_UPDATE_URL: "http://127.0.0.1:9/never" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(async () => {
  if (child) { const c = child; child = null; const gone = new Promise(r => c.once("exit", r)); c.kill("SIGKILL"); await gone; }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// raw request: fetch() would normalise a ".." away before it ever left
function raw(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, headers }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject); r.end();
  });
}

test("HTTP: recipe 200 + ETag, 304 on If-None-Match, unknown recipe 404", async () => {
  const r = await fetch(`${BASE}/recipes/this-week.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const etag = r.headers.get("etag");
  assert.match(etag, /-r3"$/);
  const body = await r.json();
  assert.equal(body.root, "this-week");
  assert.equal(board(body, "watch").buttons.filter(c => c.type === "video").length, 1);
  const r2 = await fetch(`${BASE}/recipes/this-week.json`, { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 304);
  const h = await fetch(`${BASE}/recipes/this-week.json`, { method: "HEAD" });
  assert.equal(h.status, 200);
  assert.equal((await fetch(`${BASE}/recipes/nope.json`)).status, 404);
});

test("HTTP: the media jail — range 206, '..' refused, claims hidden", async () => {
  const r = await fetch(`${BASE}/this-week/${WEEK}/${A}.mp4`, { headers: { Range: "bytes=0-99" } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  const img = await fetch(`${BASE}/this-week/${WEEK}/${A}.webp`);
  assert.equal(img.status, 200);
  const man = await fetch(`${BASE}/this-week/${WEEK}/manifest.json`);
  assert.equal(man.status, 200);
  assert.equal(await raw(`/this-week/${WEEK}/../../app-settings.json`), 403);
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/claim-a.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/CLAIM-a.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/x.exe`)).status, 404);
});

test("HTTP: /this-week/status reads the files", async () => {
  const r = await fetch(`${BASE}/this-week/status`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const s = await r.json();
  assert.equal(s.week_of, WEEK);
  assert.equal(s.switch, true);
  assert.deepEqual(s.pack, { id: "media-tools", installed: false });
  assert.equal(s.folder, false);
  assert.equal(s.running, null);
  assert.equal(s.videos[A].state, "ready");
  assert.equal(s.videos[B].state, "coming");
  assert.equal(s.videos[C].state, "coming");
});

test("HTTP: /this-week/<w>/play.json — no-store, 404 unknown week, 400 bad w", async () => {
  const r = await fetch(`${BASE}/this-week/${WEEK}/play.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type"), /application\/json/);
  const pj = await r.json();
  assert.equal(pj.week_of, WEEK);
  assert.equal(pj.title, "Shadows!");
  assert.deepEqual(pj.play, { which: [], sort: null,
    playit: { instrument: "shadow-puppet", q: "Tall?", answer: 0 } });
  assert.deepEqual(pj.before, {});
  assert.deepEqual(pj.dropped, []);
  assert.equal((await fetch(`${BASE}/this-week/2026-01-12/play.json`)).status, 404);
  assert.equal(await raw(`/this-week/../x/play.json`), 400);
  assert.equal(await raw(`/this-week/..%2Fx/play.json`), 400);
  assert.equal(await raw(`/this-week/nope/play.json`), 400);
  // the jail's own files are unchanged beside it
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/manifest.json`)).status, 200);
});
