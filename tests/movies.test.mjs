// movies.test.mjs — movies-board serving (movie-player P1, spec 8/29 §2).
// Spawns the REAL server.js on a TEST port with a throwaway ERA_DATA_DIR and a
// SYNTHETIC movie catalog (fake titles + 1x1 JPEG posters — never her real
// catalog; mirrors era-family tools/make-movies-fixture.mjs). Proves: the
// GENERATED /recipes/movies.json (pinned grid slots, continue tile, the
// one-discovery-per-page exploration slot incl. the comfort exclusion,
// launch-url filtering + meta.pendingCount, per-show episode pages + paging,
// "<show>-next" what-next boards, ETag/304/HEAD), POST /movie-event -> family
// pool, the /movies/ jail (images+json only — NEVER video), and the degraded
// law (no catalog -> valid EMPTY recipe with the server alive).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
    req.on("error", reject);
    req.end();
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");

const PORT = 8404;   // never live 8377; 8392/8398 books, 8393/8394 pool, 8402/8403 music
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-movies-"));
let child;

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

const U = n => ({ url: `https://example.invalid/watch/${n}` });

// The small fixture (kept in step with era-family tools/make-movies-fixture.mjs):
// one core show (one episode unharvested), two core movies, one pending movie
// (null launch -> filtered + counted), one discovery show. pendingCount = 2.
const CATALOG = {
  schemaVersion: 1,
  titles: [
    { id: "test-show-a", kind: "show", title: "Test Show A", say: "Test Show A",
      service: "netflix", tier: "core", rank: 1, poster: "test-show-a.jpg",
      seasons: [
        { n: 1, episodes: [
          { n: 1, title: "The First One", launch: U(101) },
          { n: 2, title: "The Second One", launch: U(102) },
          { n: 3, title: "The Third One", launch: U(103) } ] },
        { n: 2, episodes: [
          { n: 1, title: "The Return", launch: U(201) },
          { n: 2, title: "The Middle", launch: U(202) },
          { n: 3, title: "The Unharvested", launch: { url: null } } ] } ] },
    { id: "test-movie-one", kind: "movie", title: "Test Movie One", say: "Test Movie One",
      service: "disney", tier: "core", rank: 2, poster: "test-movie-one.jpg",
      launch: U(301) },
    { id: "test-movie-two", kind: "movie", title: "Test Movie Two", say: "Test Movie Two",
      service: "prime", tier: "core", rank: 3, owned: true, poster: null,
      launch: U(302) },
    { id: "test-pending-movie", kind: "movie", title: "Test Pending Movie",
      say: "Test Pending Movie", service: "netflix", tier: "core", rank: 4,
      poster: null, launch: { url: null } },
    { id: "test-discovery-show", kind: "show", title: "Test Discovery Show",
      say: "Test Discovery Show", service: "netflix", tier: "discovery", rank: 1,
      poster: null,
      seasons: [ { n: 1, episodes: [
        { n: 1, title: "Discovery Pilot", launch: U(401) },
        { n: 2, title: "Discovery Two", launch: U(402) } ] } ] },
  ],
};

function spawnHub(port, dataDir, extraEnv = {}) {
  return spawn("node", ["server.js", String(port)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: dataDir, ERA_BIND: "127.0.0.1", ...extraEnv },
  });
}
async function waitUp(port) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/settings`); return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

before(async () => {
  const movies = path.join(TMP, "movies");
  fs.mkdirSync(movies, { recursive: true });
  fs.writeFileSync(path.join(movies, "catalog.json"), JSON.stringify(CATALOG, null, 2));
  fs.writeFileSync(path.join(movies, "test-show-a.jpg"), JPEG);
  fs.writeFileSync(path.join(movies, "test-movie-one.jpg"), JPEG);
  fs.writeFileSync(path.join(movies, "notes.txt"), "denied extension");
  fs.writeFileSync(path.join(movies, "clip.mp4"), Buffer.alloc(64));  // must 404: no video ever
  fs.writeFileSync(path.join(TMP, "secret.json"), '{"secret":true}');
  child = spawnHub(PORT, TMP, { ERA_DEVICE_ID: "test-dev" });
  assert.ok(await waitUp(PORT), "server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); });

function btnAt(board, row, col) {
  return board.buttons.find(b => b.row === row && b.col === col) || null;
}
async function recipe(base = BASE) {
  const r = await fetch(`${base}/recipes/movies.json`);
  assert.equal(r.status, 200);
  return r.json();
}

test("GET /recipes/movies.json: grid with pinned slots — continue, core order, discovery slot, exit", async () => {
  const r = await fetch(`${BASE}/recipes/movies.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.ok(r.headers.get("etag"), "has an ETag");
  const rec = await r.json();
  assert.equal(rec.root, "movies");
  assert.equal(rec.home_label, "Movies");
  assert.deepEqual(rec.boards.map(b => b.id),
    ["movies", "test-show-a", "test-show-a-next",
     "test-discovery-show", "test-discovery-show-next"],
    "grid + a page and a what-next board per playable show");
  const p1 = rec.boards[0];
  assert.equal(p1.rows, 3); assert.equal(p1.columns, 4);

  // pinned slot 1: continue = next episode of the first ranked show (P1 rule)
  const cont = btnAt(p1, 1, 1);
  assert.deepEqual(cont, { type: "episode", label: "The First One",
    titleId: "test-show-a", service: "netflix",
    url: "https://example.invalid/watch/101", episode: { s: 1, e: 1 },
    row: 1, col: 1, mark: "next", image: "movies/test-show-a.jpg" },
    "continue tile: exact cell contract (REV4: episode cells carry the show art)");

  // core titles by rank in reading order; show tiles are doors, movies launch
  assert.deepEqual(btnAt(p1, 1, 2), { type: "show", label: "Test Show A",
    board: "test-show-a", row: 1, col: 2, image: "movies/test-show-a.jpg" },
    "show door: exact cell contract");
  assert.deepEqual(btnAt(p1, 1, 3), { type: "movie", label: "Test Movie One",
    titleId: "test-movie-one", service: "disney",
    url: "https://example.invalid/watch/301", row: 1, col: 3,
    image: "movies/test-movie-one.jpg" }, "movie tile: exact cell contract");
  const m2 = btnAt(p1, 1, 4);
  assert.equal(m2.titleId, "test-movie-two");
  assert.equal(m2.image, undefined, "no poster -> text tile (no image key)");
  assert.equal(btnAt(p1, 2, 1), null, "only 3 playable core titles");

  // the exploration slot: exactly one discovery tile, pinned at (2,4)
  const disc = btnAt(p1, 2, 4);
  assert.equal(disc.type, "show");
  assert.equal(disc.board, "test-discovery-show");
  assert.equal(p1.buttons.filter(b => b.board === "test-discovery-show").length, 1);

  // chrome (D57b): grid pages carry NO exit tile — msgbar door is the exit
  assert.ok(!p1.buttons.some(b => b.type === "exit"), "no exit tile on grid pages");
  assert.equal(btnAt(p1, 3, 4), null, "(3,4) rests in a small catalog");
  assert.equal(btnAt(p1, 3, 1), null, "no More on the only page");
  assert.equal(btnAt(p1, 2, 2), null, "center rest cell stays unpinned");
  assert.equal(btnAt(p1, 2, 3), null, "center rest cell stays unpinned");

  // launch-url filtering + curation visibility
  for (const b of rec.boards)
    assert.ok(!b.buttons.some(x => x.titleId === "test-pending-movie"),
      "null-launch movie appears nowhere");
  assert.equal(rec.meta.pendingCount, 2, "1 pending movie + 1 unharvested episode");
});

test("per-show page: episodes in season/episode order, unharvested filtered, back to grid", async () => {
  const rec = await recipe();
  const sp = rec.boards.find(b => b.id === "test-show-a");
  assert.equal(sp.name, "Test Show A");
  const back = btnAt(sp, 1, 1);
  assert.equal(back.type, "back"); assert.equal(back.glyph, "←");
  assert.equal(back.load, "movies", "back returns to the grid page holding the door");
  const cells = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4]];
  const want = [[1, 1, "The First One", 101], [1, 2, "The Second One", 102],
                [1, 3, "The Third One", 103], [2, 1, "The Return", 201],
                [2, 2, "The Middle", 202]];
  cells.forEach(([row, col], i) => {
    const [s, e, label, n] = want[i];
    assert.deepEqual(btnAt(sp, row, col), { type: "episode", label,
      titleId: "test-show-a", service: "netflix",
      url: `https://example.invalid/watch/${n}`, episode: { s, e }, row, col,
      image: "movies/test-show-a.jpg" },
      `episode s${s}e${e} at (${row},${col}), no mark`);
  });
  assert.equal(btnAt(sp, 3, 2), null, "the null-launch episode is filtered out");
  assert.equal(btnAt(sp, 3, 1), null, "5 episodes fit one page: no More");
});

test("what-next board <show>-next: next / watch-again / something else / all done", async () => {
  const rec = await recipe();
  const wn = rec.boards.find(b => b.id === "test-show-a-next");
  assert.equal(wn.name, "What next?");
  const next = btnAt(wn, 1, 2);
  assert.equal(next.mark, "next");
  assert.deepEqual(next.episode, { s: 1, e: 1 }, "v1: next = first playable (P3 seam)");
  const again = btnAt(wn, 1, 3);
  assert.equal(again.mark, "again");
  assert.deepEqual(again.episode, { s: 2, e: 2 },
    "v1: again = LAST playable episode (skips the null-launch s2e3)");
  const other = btnAt(wn, 3, 2);
  assert.equal(other.type, "control"); assert.equal(other.load, "movies");
  assert.equal(other.label, "Something else");
  const done = btnAt(wn, 3, 4);
  assert.equal(done.type, "exit"); assert.equal(done.label, "All done");
  assert.equal(wn.buttons.length, 4, "four choices, everything else rests");
});

test("movies.json ETag: 304 on If-None-Match, HEAD supported, CORS open, moves with the catalog", async () => {
  const r1 = await fetch(`${BASE}/recipes/movies.json`);
  const etag = r1.headers.get("etag");
  assert.equal(r1.headers.get("access-control-allow-origin"), "*");
  const r2 = await fetch(`${BASE}/recipes/movies.json`, { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 304);
  const rh = await fetch(`${BASE}/recipes/movies.json`, { method: "HEAD" });
  assert.equal(rh.status, 200);
  assert.equal(rh.headers.get("etag"), etag);
  assert.equal((await rh.arrayBuffer()).byteLength, 0, "HEAD has no body");
  const cp = path.join(TMP, "movies", "catalog.json");
  await new Promise(r => setTimeout(r, 20));   // ensure a distinct mtime
  fs.utimesSync(cp, new Date(), new Date());
  const r3 = await fetch(`${BASE}/recipes/movies.json`);
  assert.notEqual(r3.headers.get("etag"), etag, "catalog mtime moves the ETag");
});

test("pagination + discovery rule: 6 core/page, one discovery per page, comfort never in the slot, episode paging", async () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-movies-big-"));
  fs.mkdirSync(path.join(TMP2, "movies"), { recursive: true });
  const titles = [
    { id: "test-show-b", kind: "show", title: "Test Show B", service: "netflix",
      tier: "core", rank: 1,
      seasons: [{ n: 1, episodes: Array.from({ length: 10 }, (_, i) =>
        ({ n: i + 1, title: `Ep ${i + 1}`, launch: U(500 + i + 1) })) }] },
  ];
  for (let i = 1; i <= 8; i++)
    titles.push({ id: `test-movie-${i}`, kind: "movie", title: `Test Movie ${i}`,
                  service: "disney", tier: "core", rank: i + 1, launch: U(600 + i) });
  const oneSeason = n => [{ n: 1, episodes: [{ n: 1, title: "Pilot", launch: U(n) }] }];
  titles.push({ id: "test-disc-one", kind: "show", title: "Test Disc One",
                service: "prime", tier: "discovery", rank: 1, seasons: oneSeason(701) });
  // comfort:true -> excluded from the exploration slot, joins the CORE flow
  // instead; rank 99 seats it after the ranked core titles (page 2 tail)
  titles.push({ id: "test-comfort-show", kind: "show", title: "Test Comfort Show",
                service: "netflix", tier: "discovery", comfort: true, rank: 99,
                seasons: oneSeason(702) });
  titles.push({ id: "test-disc-two", kind: "show", title: "Test Disc Two",
                service: "disney", tier: "discovery", rank: 3, seasons: oneSeason(703) });
  fs.writeFileSync(path.join(TMP2, "movies", "catalog.json"),
    JSON.stringify({ schemaVersion: 1, titles }, null, 2));

  const PORT2 = 8406;
  const c2 = spawnHub(PORT2, TMP2);
  try {
    assert.ok(await waitUp(PORT2), "big-catalog server up");
    const rec = await recipe(`http://127.0.0.1:${PORT2}`);
    const p1 = rec.boards.find(b => b.id === "movies");
    const p2 = rec.boards.find(b => b.id === "movies-2");
    assert.ok(p1 && p2, "10 core titles -> two grid pages");
    assert.ok(!rec.boards.some(b => b.id === "movies-3"));

    // page 1: continue + ranks 1-7 + More; page 2: back + ranks 8-10 (comfort last)
    assert.equal(btnAt(p1, 1, 1).mark, "next");
    assert.equal(btnAt(p1, 1, 1).titleId, "test-show-b", "continue = first ranked show");
    assert.equal(btnAt(p1, 1, 2).board, "test-show-b");
    assert.equal(btnAt(p1, 3, 3).titleId, "test-movie-5", "rank 6 fills the last core cell");
    const more = btnAt(p1, 3, 1);
    assert.equal(more.type, "control"); assert.equal(more.symbol, "more");
    assert.equal(more.load, "movies-2");
    assert.equal(btnAt(p1, 3, 4).titleId, "test-movie-6", "rank 7 seats the corner (D57b)");
    const back = btnAt(p2, 1, 1);
    assert.equal(back.type, "back"); assert.equal(back.load, "movies");
    assert.equal(btnAt(p2, 1, 2).titleId, "test-movie-7");
    assert.equal(btnAt(p2, 1, 4).board, "test-comfort-show",
      "comfort discovery title rides the core flow instead");
    assert.equal(btnAt(p2, 3, 1), null, "no More on the last page");
    assert.ok(!p2.buttons.some(b => b.type === "exit"), "no exit tile on page 2 (D57b)");

    // exploration slot: one per page, rank order, comfort NEVER seated there
    assert.equal(btnAt(p1, 2, 4).board, "test-disc-one");
    assert.equal(btnAt(p2, 2, 4).board, "test-disc-two", "comfort skipped in the slot");
    for (const b of [p1, p2])
      assert.notEqual((btnAt(b, 2, 4) || {}).board, "test-comfort-show");

    // discovery door's Back returns to ITS grid page
    const d2 = rec.boards.find(b => b.id === "test-disc-two");
    assert.equal(btnAt(d2, 1, 1).load, "movies-2");

    // episode paging: 10 episodes -> 8 + 2 with More/Back between
    const s1 = rec.boards.find(b => b.id === "test-show-b");
    const s2 = rec.boards.find(b => b.id === "test-show-b-2");
    assert.ok(s1 && s2, "episode pages exist");
    assert.equal(btnAt(s1, 3, 4).episode.e, 8, "8 episodes on page 1 incl. the corner");
    assert.equal(btnAt(s1, 3, 1).load, "test-show-b-2");
    assert.equal(btnAt(s2, 1, 1).load, "test-show-b", "episode page 2 backs to page 1");
    assert.equal(btnAt(s2, 1, 2).episode.e, 9);
    assert.equal(btnAt(s2, 1, 3).episode.e, 10);
    assert.equal(btnAt(s2, 3, 1), null, "no More on the last episode page");

    // what-next on a 10-episode show: next = e1, again = e10 (v1 rules)
    const wn = rec.boards.find(b => b.id === "test-show-b-next");
    assert.deepEqual(btnAt(wn, 1, 2).episode, { s: 1, e: 1 });
    assert.deepEqual(btnAt(wn, 1, 3).episode, { s: 1, e: 10 });
  } finally { c2.kill("SIGKILL"); }
});

test("/movies jail: posters immutable, catalog no-cache, escapes 403, non-image/video 404", async () => {
  const img = await fetch(`${BASE}/movies/test-show-a.jpg`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal(img.headers.get("cache-control"), "max-age=86400, immutable");
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG), "bytes intact");
  const cat = await fetch(`${BASE}/movies/catalog.json`);
  assert.equal(cat.status, 200);
  assert.equal(cat.headers.get("cache-control"), "no-cache");
  for (const p of ["/movies/../secret.json", "/movies/%2e%2e/secret.json"]) {
    const r = await rawGet(PORT, p);
    assert.equal(r.status, 403, `escape blocked for ${p}`);
    assert.ok(!r.body.includes("secret"), `no leak for ${p}`);
  }
  assert.equal((await fetch(`${BASE}/movies/notes.txt`)).status, 404, "denied ext");
  assert.equal((await fetch(`${BASE}/movies/clip.mp4`)).status, 404,
    "the hub NEVER serves video, even when the file exists");
});

test("POST /movie-event: all six actions -> 204 + pool append (episode round-trips); junk -> 400", async () => {
  for (const action of ["launch", "playing", "pause", "end", "abandon", "alldone"]) {
    const body = { titleId: "test-show-a", action, service: "netflix" };
    if (action === "launch") body.episode = { s: 1, e: 2 };
    const r = await fetch(`${BASE}/movie-event`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 204, `${action} accepted`);
  }
  for (const body of [{}, { titleId: "test-show-a", action: "play", service: "netflix" },
                      { titleId: "../evil", action: "launch", service: "netflix" },
                      { titleId: "test-show-a", action: "launch" },
                      { titleId: "test-show-a", action: "launch", service: "hbo" },
                      { titleId: "test-show-a", action: "launch", service: "netflix",
                        episode: { s: "1", e: 2 } }]) {
    const r = await fetch(`${BASE}/movie-event`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, `rejected: ${JSON.stringify(body)}`);
  }
  const day = new Date().toISOString().slice(0, 10);
  const poolFile = path.join(TMP, "pool", "events", "test-dev", day + ".jsonl");
  const lines = fs.readFileSync(poolFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const kinds = lines.map(l => l.kind);
  for (const a of ["launch", "playing", "pause", "end", "abandon", "alldone"])
    assert.ok(kinds.includes("movie-" + a), `pool has movie-${a}`);
  const launch = lines.find(l => l.kind === "movie-launch");
  assert.equal(launch.titleId, "test-show-a");
  assert.equal(launch.service, "netflix");
  assert.deepEqual(launch.episode, { s: 1, e: 2 }, "episode round-trips to the pool");
});

test("LAW: no movies dir -> a VALID EMPTY recipe (all-rest grid) and the server stays alive", async () => {
  const TMP3 = fs.mkdtempSync(path.join(os.tmpdir(), "era-nomovies-"));
  const PORT3 = 8405;
  const c3 = spawnHub(PORT3, TMP3);
  try {
    assert.ok(await waitUp(PORT3), "server boots without a movies dir");
    const r = await fetch(`http://127.0.0.1:${PORT3}/recipes/movies.json`);
    assert.equal(r.status, 200, "empty recipe, not an error (all-null v0 catalog must boot)");
    const rec = await r.json();
    assert.equal(rec.root, "movies");
    assert.equal(rec.meta.pendingCount, 0);
    assert.equal(rec.boards.length, 1, "one grid page");
    const p1 = rec.boards[0];
    assert.equal(p1.id, "movies");
    assert.equal(p1.buttons.length, 0, "no tiles — all cells rest; msgbar door exits (D57b)");
    const s = await fetch(`http://127.0.0.1:${PORT3}/settings`);
    assert.equal(s.status, 200, "server alive after the degraded recipe");
  } finally { c3.kill("SIGKILL"); }
});
