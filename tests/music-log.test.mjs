// music-log.test.mjs — the songs board's usage order (spec 2026-10-31): how a
// pick is scored, how the five sections are ordered, and how scores travel
// between devices through the shared content folder the way clothing picks do
// (clothing-log.js). Pure modules, a throwaway temp tree, no hub, no network.
// Every song here is synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { foldScores, openMusicLog, poolMusicEvents } = require("../music-log.js");
const { sectionOrders, SECTIONS } = require("../music-sections.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-music-log-"));
const at = (s) => "2026-10-31T10:00:" + String(s).padStart(2, "0") + ".000Z";
const ev = (s, song, action, extra = {}) => ({ t: at(s), song, action, ...extra });

// ---- scoring -----------------------------------------------------------------

test("a partial pick scores 1 and a full pick scores 3, each pick once", () => {
  const scores = foldScores([
    ev(1, "alpha", "play"),                      // partial: the clip ran out or she left
    ev(2, "beta", "play"), ev(3, "beta", "full"), // Full song authorized during the pick
    ev(4, "beta", "full"),                        // a second "full" in the same pick: still 3
    ev(5, "gamma", "play"), ev(6, "gamma", "done"), // ended naturally while capped
    ev(7, "delta", "full", { fresh: true }),      // Full song from silence: a full pick
  ]);
  assert.equal(scores.get("alpha"), 1);
  assert.equal(scores.get("beta"), 3);
  assert.equal(scores.get("gamma"), 3);
  assert.equal(scores.get("delta"), 3);
});

test("every pick counts: replays and Full song from silence after a Stop are new picks", () => {
  const scores = foldScores([
    ev(1, "alpha", "play"), ev(2, "alpha", "play"),           // grid door, then a hero replay
    ev(3, "alpha", "full", { fresh: true }),                    // Full song after a Stop
  ]);
  assert.equal(scores.get("alpha"), 1 + 1 + 3);
});

test("old history (no fresh flag): a play then a full for the same song before the next pick is full", () => {
  const scores = foldScores([
    ev(1, "alpha", "play"), ev(2, "alpha", "end"), ev(3, "alpha", "full"), // clip ran out, then Full song
    ev(4, "beta", "play"), ev(5, "beta", "end"),                         // an old "end" is ambiguous: partial
    ev(6, "gamma", "full"),                                              // full with no play before it: a full pick
    ev(7, "alpha", "play"), ev(8, "beta", "full"),                       // a full for ANOTHER song is its own pick
  ]);
  assert.equal(scores.get("alpha"), 3 + 1);
  assert.equal(scores.get("beta"), 1 + 3);
  assert.equal(scores.get("gamma"), 3);
});

test("a natural end only finishes the pick it belongs to", () => {
  const scores = foldScores([ev(1, "alpha", "play"), ev(2, "beta", "done")]);
  assert.equal(scores.get("alpha"), 1);
  assert.equal(scores.has("beta"), false, "a done with no pick of its own scores nothing");
});

test("events are folded in time order, whatever order they arrive in", () => {
  const scores = foldScores([ev(3, "alpha", "full"), ev(1, "alpha", "play")]);
  assert.equal(scores.get("alpha"), 3);
});

// ---- sections ----------------------------------------------------------------

const song = (id, extra = {}) => ({ id, rank: 0, addedMs: 0, ...extra });

test("the rail's five sections, in order", () => {
  assert.deepEqual(SECTIONS.map(s => s.label), ["Favorites", "New", "Top hits", "Disney", "All"]);
});

test("section membership and order follow the spec's table", () => {
  const songs = [
    song("old-hit", { rank: 1, addedMs: 1000, category: "top-hits" }),
    song("new-hit", { rank: 2, addedMs: 5000, category: "top-hits" }),
    song("princess", { rank: 3, addedMs: 3000, category: "disney" }),
    song("lullaby", { rank: 4, addedMs: 4000 }),
    song("unplayed", { rank: 5, addedMs: 2000 }),
  ];
  const scores = new Map([["old-hit", 6], ["princess", 6], ["lullaby", 1]]);
  const o = sectionOrders(songs, scores);
  // ties break newest added first (princess 3000 beats old-hit 1000)
  assert.deepEqual(o.fav, ["princess", "old-hit", "lullaby"], "score above zero only, high first");
  assert.deepEqual(o.new, ["new-hit", "lullaby", "princess", "unplayed", "old-hit"], "newest added first");
  assert.deepEqual(o["top-hits"], ["old-hit", "new-hit"]);
  assert.deepEqual(o.disney, ["princess"]);
  assert.deepEqual(o.all, ["princess", "old-hit", "lullaby", "new-hit", "unplayed"]);
});

test("score ties with the same added time fall back to the old manifest rank", () => {
  const o = sectionOrders([song("b", { rank: 2 }), song("a", { rank: 1 }), song("c", { rank: 3 })], new Map());
  assert.deepEqual(o.all, ["a", "b", "c"]);
  assert.deepEqual(o.fav, [], "nothing played: Favorites is empty");
});

// ---- the shared play log -----------------------------------------------------

function tree(name) {
  const root = path.join(TMP, name);
  const data = path.join(root, "data"), drive = path.join(root, "drive"), poolRoot = path.join(data, "pool");
  fs.mkdirSync(path.join(drive, "music"), { recursive: true });
  fs.mkdirSync(path.join(poolRoot, "events", "dev-a"), { recursive: true });
  return { data, drive, poolRoot };
}
const poolLine = (o) => JSON.stringify({ device: "dev-a", ...o }) + "\n";

test("own lines go to the Drive folder; the score reads the local pool for this device", () => {
  const { data, drive, poolRoot } = tree("own");
  fs.writeFileSync(path.join(poolRoot, "events", "dev-a", "2026-10-30.jsonl"),
    poolLine({ t: at(1), kind: "music-play", songId: "alpha" }) +
    poolLine({ t: at(2), kind: "music-full", songId: "alpha" }) +
    poolLine({ t: at(3), kind: "outfit-select", combo: ["x"] }) +
    "{torn");
  const log = openMusicLog({ dataDir: data, poolRoot, driveFolder: drive, deviceId: "dev-a" });
  assert.equal(log.scores().get("alpha"), 3, "old pool history counts on this device");

  assert.equal(log.record({ song: "beta", action: "play" }), true);
  const own = path.join(drive, "music", ".era", "plays", "dev-a");
  const legacy = fs.readFileSync(path.join(own, "legacy.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(legacy.map(l => [l.song, l.action]), [["alpha", "play"], ["alpha", "full"]],
    "the first shared write carries this device's old history once");
  const dated = fs.readdirSync(own).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
  assert.equal(dated.length, 1, "today's own lines in a dated file");
  const line = JSON.parse(fs.readFileSync(path.join(own, dated[0]), "utf8").trim());
  assert.equal(line.song, "beta"); assert.equal(line.action, "play"); assert.ok(line.t);

  // a second write never repeats the backfill
  fs.appendFileSync(path.join(poolRoot, "events", "dev-a", "2026-10-31.jsonl"),
    poolLine({ t: at(9), kind: "music-play", songId: "beta" }));
  log.record({ song: "beta", action: "done" });
  assert.equal(fs.readFileSync(path.join(own, "legacy.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.ok(!fs.existsSync(path.join(data, "music", ".era")), "nothing written into the mirror's destination");
});

test("other devices' lines arrive through the mirror; own lines coming back are skipped", () => {
  const { data, drive, poolRoot } = tree("merge");
  fs.writeFileSync(path.join(poolRoot, "events", "dev-a", "2026-10-31.jsonl"),
    poolLine({ t: at(1), kind: "music-play", songId: "alpha" }));
  const mirrored = path.join(data, "music", ".era", "plays");
  fs.mkdirSync(path.join(mirrored, "dev-b"), { recursive: true });
  fs.mkdirSync(path.join(mirrored, "dev-a"), { recursive: true });
  fs.writeFileSync(path.join(mirrored, "dev-b", "legacy.jsonl"),
    JSON.stringify({ t: at(1), song: "alpha", action: "play" }) + "\n" +
    JSON.stringify({ t: at(2), song: "alpha", action: "full" }) + "\n");
  fs.writeFileSync(path.join(mirrored, "dev-b", "2026-10-31.jsonl"),
    JSON.stringify({ t: at(5), song: "beta", action: "play" }) + "\n{\"t\":\"2026");   // torn last line
  fs.writeFileSync(path.join(mirrored, "dev-b", "2026-10-31.jsonl.part"),
    JSON.stringify({ t: at(6), song: "beta", action: "play" }) + "\n");               // a syncer leftover
  fs.writeFileSync(path.join(mirrored, "dev-a", "2026-10-31.jsonl"),
    JSON.stringify({ t: at(1), song: "alpha", action: "play" }) + "\n");               // own line, mirrored back
  const log = openMusicLog({ dataDir: data, poolRoot, driveFolder: drive, deviceId: "dev-a" });
  const s = log.scores();
  assert.equal(s.get("alpha"), 1 + 3, "own pick (pool) + the other device's full pick");
  assert.equal(s.get("beta"), 1, "torn lines and .part files are skipped");
});

test("nothing ever throws: no Drive folder, no music/ folder, a read-only mount", () => {
  const { data, drive, poolRoot } = tree("degrade");
  const none = openMusicLog({ dataDir: data, poolRoot, driveFolder: null, deviceId: "dev-a" });
  assert.equal(none.record({ song: "alpha", action: "play" }), false, "no folder: local only");
  const noMusic = path.join(TMP, "degrade", "empty-drive");
  fs.mkdirSync(noMusic, { recursive: true });
  const bare = openMusicLog({ dataDir: data, poolRoot, driveFolder: noMusic, deviceId: "dev-a" });
  assert.equal(bare.record({ song: "alpha", action: "play" }), false);
  assert.ok(!fs.existsSync(path.join(noMusic, "music")), "an own write never creates <folder>/music");
  // a file where the .era directory should be: the write fails, and says false
  fs.writeFileSync(path.join(drive, "music", ".era"), "not a directory");
  const blocked = openMusicLog({ dataDir: data, poolRoot, driveFolder: drive, deviceId: "dev-a" });
  assert.equal(blocked.record({ song: "alpha", action: "play" }), false);
  assert.ok(blocked.scores() instanceof Map, "scores still answer");
  const nothing = openMusicLog({ dataDir: path.join(TMP, "missing"), poolRoot: path.join(TMP, "missing-pool"),
    driveFolder: null, deviceId: "dev-a" });
  assert.equal(nothing.scores().size, 0);
});

test("only score lines are shared, and only with a valid song id", () => {
  const { data, drive, poolRoot } = tree("valid");
  const log = openMusicLog({ dataDir: data, poolRoot, driveFolder: drive, deviceId: "dev-a" });
  assert.equal(log.record({ song: "alpha", action: "stop" }), false, "stop changes no score");
  assert.equal(log.record({ song: "alpha", action: "clip" }), false, "the clip running out changes no score");
  assert.equal(log.record({ song: "../evil", action: "play" }), false);
  assert.equal(log.record({ song: "alpha", action: "full", fresh: true }), true);
});

test("poolMusicEvents reads only this device's music lines", () => {
  const { poolRoot } = tree("pool");
  fs.mkdirSync(path.join(poolRoot, "events", "dev-b"), { recursive: true });
  fs.writeFileSync(path.join(poolRoot, "events", "dev-a", "2026-10-31.jsonl"),
    poolLine({ t: at(1), kind: "music-play", songId: "alpha" }) +
    poolLine({ t: at(2), kind: "music-full", songId: "alpha", fresh: true }));
  fs.writeFileSync(path.join(poolRoot, "events", "dev-b", "2026-10-31.jsonl"),
    JSON.stringify({ t: at(1), device: "dev-b", kind: "music-play", songId: "beta" }) + "\n");
  assert.deepEqual(poolMusicEvents(poolRoot, "dev-a").map(e => [e.song, e.action, !!e.fresh]),
    [["alpha", "play", false], ["alpha", "full", true]]);
});

test("the installed payload carries both new modules (server.js requires them)", () => {
  const payload = fs.readFileSync(new URL("../tools/build-payload.sh", import.meta.url), "utf8");
  for (const name of ["music-log.js", "music-sections.js"]) assert.ok(payload.includes('"$HUB/' + name + '"'), name);
});
