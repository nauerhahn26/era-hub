// movies-add.test.mjs — POST /movies/add: the board strip's "+ Add" for films
// and shows (spec §6 Movies, plan T5.1). Drives the REAL server.js from
// outside, because the one thing this feature has to prove is not that a file
// was written but that THE BOARD DRAWS IT.
//
// That is Gap 3 of the plan's preflight: the design's catalog shape
// ({title, year, link, provider, ...}) is NOT the shape moviesRecipe() reads
// (it filters on `id`, `kind` and `launch.url` and sorts on `tier`/`rank`), so
// a writer built from the spec alone would have silently dropped every title it
// added — the add "works", and nothing appears. Every case below therefore ends
// at /recipes/movies.json, not at catalog.json.
//
// NO KEY, NO NETWORK. This task is the URL-paste path only: nothing here looks
// a title up (T5.3) or fetches a poster (T5.2), so the hub is spawned with the
// provider seams pointed at a dead loopback port and no request leaves the box.
//
// Where the bytes land matters (Gap 1): the add writes into the family's DRIVE
// content folder, never <DATA>, and the mirror carries it to this device's
// shelf, which is what the recipe is generated from.
//
// Port 8437 (this suite's own; 8377-8436 are held by siblings and live hubs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8437;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-movies-add-"));
const ROOT = path.join(TMP, "My Drive");                // the named mount
const INSIDE = path.join(ROOT, "New ERA Content");      // what the family picks
const MOVIES = path.join(INSIDE, "movies");             // where the add must write
let child = null;
let DATA = null;

async function startHub(extraEnv = {}) {
  DATA = fs.mkdtempSync(path.join(TMP, "data-"));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_DRIVE_LOCAL_ROOTS: ROOT,
           // belt and braces: a sync fans out to the clothing build, and that
           // build must never be able to reach a provider from a test box.
           ERA_AI_URL: "http://127.0.0.1:9/never",
           ERA_ELEVEN_URL: "http://127.0.0.1:9/never", ...extraEnv },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}
async function stopHub() {
  if (!child) return;
  const c = child; child = null;
  const gone = new Promise(r => c.once("exit", r));
  c.kill("SIGKILL");
  await gone;
}

const post = (url, body) => fetch(BASE + url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
function catalog() {
  return JSON.parse(fs.readFileSync(path.join(MOVIES, "catalog.json"), "utf8"));
}
async function recipe() {
  const r = await fetch(`${BASE}/recipes/movies.json`, { cache: "no-store" });
  assert.equal(r.status, 200);
  return { rec: await r.json(), etag: r.headers.get("etag") };
}
function btnAt(board, row, col) {
  return board.buttons.find(b => b.row === row && b.col === col) || null;
}

before(async () => {
  fs.mkdirSync(INSIDE, { recursive: true });
  await startHub();
});
after(async () => {
  await stopHub();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ------------------------------------------------------ before a folder exists

test("with no Drive folder chosen the add says so instead of writing to <DATA>", async () => {
  const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/the-gruffalo" });
  assert.equal(r.status, 409, "a refusal the sheet can render, not a crash");
  const j = await r.json();
  assert.equal(j.error, "needs-local-drive");
  assert.ok(typeof j.message === "string" && j.message.length > 10, "in words a parent can act on");
  assert.equal(fs.existsSync(path.join(DATA, "movies", "catalog.json")), false,
               "and nothing was written to this device's shelf");
});

// ------------------------------------------------------------------ refusals

test("a body the sheet could not have meant is refused, and no catalog is created", async () => {
  assert.equal((await post("/integrations/drive/localfolder", { folderPath: INSIDE })).status, 204);
  const link = "https://www.netflix.com/gb/title/the-gruffalo";
  const cases = [
    [{}, "need-url-or-title"],
    [{ url: "" }, "need-url-or-title"],
    [{ url: "   " }, "need-url-or-title"],
    [{ url: "not a link" }, "bad-url"],
    [{ url: "javascript:alert(1)" }, "bad-url"],
    [{ url: link, id: "../evil" }, "bad-id"],
    [{ url: link, id: "The Gruffalo" }, "bad-id"],
    [{ url: link, id: "" }, "bad-id"],
    [{ url: link, id: "x".repeat(65) }, "bad-id"],
    [{ url: link, kind: "cartoon" }, "bad-kind"],
    // a link with nothing human in it: netflix numbers its titles, so there is
    // no name to put on a tile and the sheet must ask for one rather than
    // labelling Ellie's board "Title 81002370".
    [{ url: "https://www.netflix.com/watch/81002370" }, "need-title"],
  ];
  for (const [body, error] of cases) {
    const r = await post("/movies/add", body);
    assert.equal(r.status, 400, `refused: ${JSON.stringify(body)}`);
    const j = await r.json();
    assert.equal(j.error, error, `refused: ${JSON.stringify(body)}`);
    assert.ok(typeof j.message === "string" && j.message.length > 10,
              "with something the sheet can show a parent");
  }
  assert.equal(fs.existsSync(path.join(MOVIES, "catalog.json")), false,
               "not one refusal started a catalog");
});

// ------------------------------------------------- the assertion that matters

test("a pasted link becomes a tile the board really draws (Gap 3)", async () => {
  const before = await recipe();
  assert.equal(before.rec.boards[0].buttons.length, 0,
               "an empty shelf draws an empty grid (D57b: the msgbar door is the exit)");

  const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/the-gruffalo" });
  assert.equal(r.status, 200, "one small file and a mirror: the sheet waits for it");
  const j = await r.json();
  assert.deepEqual(j, { ok: true, id: "the-gruffalo", title: "The Gruffalo",
                        kind: "movie", rank: 1, pending: false, mirrored: true });

  // the entry, in the shape moviesRecipe() reads — not the shape the spec drew
  const c = catalog();
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.titles.length, 1);
  assert.deepEqual(c.titles[0], {
    id: "the-gruffalo", kind: "movie", title: "The Gruffalo", say: "The Gruffalo",
    service: "netflix", tier: "core", rank: 1, poster: null,
    launch: { url: "https://www.netflix.com/gb/title/the-gruffalo" },
    addedBy: "url",
  });
  assert.equal(fs.existsSync(path.join(MOVIES, "catalog.tmp")), false,
               "written atomically, no litter for Drive to mirror");

  const after = await recipe();
  assert.notEqual(after.etag, before.etag,
                  "the ETag moved, so a board holding a 304 cache refetches");
  const p1 = after.rec.boards[0];
  assert.deepEqual(btnAt(p1, 1, 2), { type: "movie", label: "The Gruffalo",
    titleId: "the-gruffalo", service: "netflix",
    url: "https://www.netflix.com/gb/title/the-gruffalo", row: 1, col: 2 },
    "the first core cell, exact cell contract (no poster yet: T5.2)");
  assert.equal(after.rec.meta.pendingCount, 0);
  // board design rules are law, add or no add
  assert.equal(btnAt(p1, 2, 2), null, "centre rest cell stays unpinned");
  assert.equal(btnAt(p1, 2, 3), null, "centre rest cell stays unpinned");
});

test("a second title takes the next free rank and the next free cell", async () => {
  const r = await post("/movies/add", {
    url: "https://www.disneyplus.com/en-gb/movies/encanto/3xt0ZWlxJ7Fp",
    title: "Encanto", year: 2021,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: "encanto", title: "Encanto",
                                     kind: "movie", rank: 2, pending: false, mirrored: true });
  const t = catalog().titles.find(x => x.id === "encanto");
  assert.equal(t.rank, 2, "appended after the title already there");
  assert.equal(t.service, "disney", "the service comes from the link's own host");
  assert.equal(t.year, 2021, "provenance rides along with the entry");
  assert.equal(t.tier, "core");

  const { rec } = await recipe();
  const p1 = rec.boards[0];
  assert.equal(btnAt(p1, 1, 2).titleId, "the-gruffalo", "the first tile has not moved");
  assert.equal(btnAt(p1, 1, 3).titleId, "encanto");
  assert.equal(btnAt(p1, 2, 2), null, "centre rest cell stays unpinned");
  assert.equal(btnAt(p1, 2, 3), null, "centre rest cell stays unpinned");
});

test("adding the same title again rewrites it in place and keeps its tile", async () => {
  const r = await post("/movies/add", {
    url: "https://www.netflix.com/gb/title/the-gruffalo-2009", title: "The Gruffalo",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: "the-gruffalo", title: "The Gruffalo",
                                     kind: "movie", rank: 1, pending: false, mirrored: true });
  const c = catalog();
  assert.equal(c.titles.length, 2, "replaced, not doubled");
  const t = c.titles.find(x => x.id === "the-gruffalo");
  assert.equal(t.rank, 1, "a re-added title keeps the place Ellie already knows");
  assert.equal(t.launch.url, "https://www.netflix.com/gb/title/the-gruffalo-2009",
               "and the entry really was rewritten");

  const { rec } = await recipe();
  assert.equal(btnAt(rec.boards[0], 1, 2).url,
               "https://www.netflix.com/gb/title/the-gruffalo-2009",
               "the tile is where it was, pointing at the new link");
});

// --------------------------------------------------------- pending curation

test("a name with no link is written pending: counted for a grown-up, drawn nowhere", async () => {
  const r = await post("/movies/add", { title: "Ada Twist, Scientist" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: "ada-twist-scientist",
                                     title: "Ada Twist, Scientist", kind: "movie",
                                     rank: 3, pending: true, mirrored: true });
  const t = catalog().titles.find(x => x.id === "ada-twist-scientist");
  assert.deepEqual(t.launch, { url: null }, "nothing to launch yet");
  assert.equal(t.service, null, "and no service to claim it");
  assert.equal(t.addedBy, "search", "a typed name is the search path (T5.3 resolves it)");

  const { rec } = await recipe();
  assert.equal(rec.meta.pendingCount, 1, "the sheet can say one title still needs a link");
  for (const b of rec.boards)
    assert.ok(!b.buttons.some(x => x.titleId === "ada-twist-scientist"),
              "a title with no link appears nowhere on Ellie's board");
  assert.equal(btnAt(rec.boards[0], 1, 4), null, "and it did not take a cell either");
});

// ------------------------------------------------------------ the write rules

test("a catalog New ERA cannot read is refused, never rewritten", async () => {
  const file = path.join(MOVIES, "catalog.json");
  const good = fs.readFileSync(file);
  const half = '{"schemaVersion":1,"titles":[{"id":"the-gruffalo"';
  fs.writeFileSync(file, half);
  try {
    const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/the-snail-and-the-whale" });
    assert.equal(r.status, 409, "a refusal, not a one-title catalog over the family's shelf");
    const j = await r.json();
    assert.equal(j.error, "catalog-unreadable");
    assert.ok(typeof j.message === "string" && j.message.length > 10, "in words a parent can act on");
    assert.equal(fs.readFileSync(file, "utf8"), half, "the half-written file is left exactly as it was");
  } finally { fs.writeFileSync(file, good); }
});

test("a title the shelf did not take says so instead of claiming the board moved", async () => {
  const shelf = path.join(DATA, "movies", "catalog.json");
  fs.rmSync(shelf, { force: true });
  fs.mkdirSync(shelf, { recursive: true });   // a landing spot the copy cannot use
  try {
    const r = await post("/movies/add", { url: "https://tv.apple.com/gb/movie/the-velveteen-rabbit" });
    assert.equal(r.status, 200, "the catalog in the family's folder really was written");
    const j = await r.json();
    assert.equal(j.mirrored, false, "but the shelf did not take it, and the sheet is told so");
    assert.equal(catalog().titles.find(x => x.id === "the-velveteen-rabbit").service, "apple");
  } finally {
    fs.rmSync(shelf, { recursive: true, force: true });
    await post("/integrations/drive/sync", {});
  }
});
