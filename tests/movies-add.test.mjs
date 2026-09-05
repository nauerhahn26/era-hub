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
// NO KEY, NO NETWORK. Nothing here looks a title up (T5.3), and the poster
// fetch this file also covers (T5.2) reaches only the fake web served below:
// every seam the hub owns — ERA_POSTER_PAGE_URL, ERA_TMDB_URL,
// ERA_TMDB_IMG_URL, ERA_AI_URL, ERA_ELEVEN_URL — is pointed at loopback before
// the hub starts, and TMDB_API_KEY is set EXPLICITLY on every spawn so a real
// key sitting in the developer's shell can never ride along.
//
// Where the bytes land matters (Gap 1): the add writes into the family's DRIVE
// content folder, never <DATA>, and the mirror carries it to this device's
// shelf, which is what the recipe is generated from. That is why every poster
// case below ends at GET /movies/posters/<slug>.jpg — the path
// moviesRecipe() joins as "movies/" + t.poster (server.js), not the path the
// writer happened to spell.
//
// Port 8437 (this suite's own; 8377-8436 are held by siblings and live hubs).
// The fake web takes an ephemeral port: it stands in for the whole internet,
// so it is never something another suite could be holding.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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

// ------------------------------------------------------------- the fake web
//
// One server standing in for every site at once: the hub's page seam swaps the
// ORIGIN of whatever deep link a test pastes, so "netflix.com/gb/title/…" is
// fetched from here and a fixture can never escape to the real Netflix. A path
// this server does not know is a 404 — which is exactly the "no poster to be
// had" case every URL-paste test above depends on.
let web = null, WEB = "";
let tmdbCalls = [];
// A real JPEG's first bytes and last two, with padding in between: enough for
// the hub's "is this actually a picture" check and for an <img> to be handed
// something that is not an HTML error page.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
                            Buffer.alloc(600, 0x42), Buffer.from([0xff, 0xd9])]);
const html = (res, body) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};
function fakeWeb(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  // a page with art: a RELATIVE og:image carrying an &amp; entity, which is
  // what streaming sites actually serve
  if (p === "/gb/title/paddington")
    return html(res, '<html><head><meta charset="utf-8">' +
      '<meta property="og:image" content="/art/paddington.jpg?w=500&amp;h=750">' +
      "<title>Paddington</title></head><body></body></html>");
  // a page with no og:image at all
  if (p === "/gb/title/stick-man")
    return html(res, "<html><head><title>Stick Man</title></head><body></body></html>");
  // a page whose og:image is not a picture
  if (p === "/gb/title/the-tiger-who-came-to-tea")
    return html(res, '<html><head><meta property="og:image" content="/art/oops.html">' +
      "</head><body></body></html>");
  if (p === "/art/paddington.jpg") {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    return res.end(JPEG);
  }
  if (p === "/art/oops.html") return html(res, "<html>not a poster</html>");
  if (p === "/tmdb/search/movie" || p === "/tmdb/search/tv") {
    tmdbCalls.push({ path: p, key: u.searchParams.get("api_key"),
                     query: u.searchParams.get("query"),
                     year: u.searchParams.get("primary_release_year") });
    const q = u.searchParams.get("query") || "";
    const results = /stick man/i.test(q)
      ? [{ id: 1, title: "Stick Man", release_date: "2015-12-25", poster_path: null },
         { id: 2, title: "Stick Man", release_date: "2015-12-25", poster_path: "/stick.jpg" }]
      : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ results }));
  }
  if (p === "/tmdb-img/stick.jpg") {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    return res.end(JPEG);
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("no such page");
}

async function startHub(extraEnv = {}) {
  DATA = fs.mkdtempSync(path.join(TMP, "data-"));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_DRIVE_LOCAL_ROOTS: ROOT,
           // belt and braces: a sync fans out to the clothing build, and that
           // build must never be able to reach a provider from a test box.
           ERA_AI_URL: "http://127.0.0.1:9/never",
           ERA_ELEVEN_URL: "http://127.0.0.1:9/never",
           // the poster seams: the whole internet is the fake server above, and
           // TMDB is off unless a case turns it on with a key of its own.
           ERA_POSTER_PAGE_URL: WEB,
           ERA_TMDB_URL: WEB + "/tmdb",
           ERA_TMDB_IMG_URL: WEB + "/tmdb-img",
           TMDB_API_KEY: "", ...extraEnv },
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
  web = http.createServer(fakeWeb);
  await new Promise(r => web.listen(0, "127.0.0.1", r));
  WEB = `http://127.0.0.1:${web.address().port}`;
  await startHub();
});
after(async () => {
  await stopHub();
  if (web) await new Promise(r => web.close(r));
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
                        kind: "movie", rank: 1, pending: false, mirrored: true,
                        // this link's page is not one the fake web knows, so
                        // there was no art to be had and the tile goes up bare
                        poster: null, attribution: null });

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
                                     kind: "movie", rank: 2, pending: false, mirrored: true,
                                     poster: null, attribution: null });
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
                                     kind: "movie", rank: 1, pending: false, mirrored: true,
                                     poster: null, attribution: null });
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
                                     rank: 3, pending: true, mirrored: true,
                                     poster: null, attribution: null });
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

// ---------------------------------------------------------------- the poster
//
// T5.2. A film tile Ellie can read is a picture; the words under it are for the
// grown-up. The art comes from the page the parent pasted (`og:image`) or, when
// the family has typed a TMDB key, from TMDB — and when it comes from NEITHER
// the add still succeeds and the tile still draws. Every case ends at
// GET /movies/posters/<slug>.jpg, because "movies/" + t.poster is the join the
// recipe makes and a poster the jail will not serve is a broken tile.

test("a poster on the pasted page becomes the tile's art, on the shelf and in the recipe", async () => {
  const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/paddington" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.poster, "posters/paddington.jpg", "the path the recipe joins, not a file name");
  assert.equal(j.attribution, null, "the page's own art owes TMDB nothing");

  const t = catalog().titles.find(x => x.id === "paddington");
  assert.equal(t.poster, "posters/paddington.jpg");
  assert.equal(t.posterFrom, "og", "where the art came from rides with the entry");
  const file = path.join(MOVIES, "posters", "paddington.jpg");
  assert.ok(fs.readFileSync(file).equals(JPEG), "the bytes the page served, unchanged");
  assert.deepEqual(fs.readdirSync(path.join(MOVIES, "posters")).filter(n => n.endsWith(".tmp")), [],
                   "written atomically, no litter for Drive to mirror");
  assert.equal(catalog().attribution, undefined, "and no credit claimed that was not earned");

  // the shelf the board is generated from, and the door that serves it
  assert.ok(fs.existsSync(path.join(DATA, "movies", "posters", "paddington.jpg")),
            "the mirror carried the poster, not just the catalog");
  const img = await fetch(`${BASE}/movies/posters/paddington.jpg`);
  assert.equal(img.status, 200, "the /movies/ jail really serves it");
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));

  const { rec } = await recipe();
  const cell = rec.boards[0].buttons.find(b => b.titleId === "paddington");
  assert.equal(cell.image, "movies/posters/paddington.jpg",
               "exactly the URL the jail answered above");
});

test("a page with no og:image and no key leaves the tile bare, and it still draws", async () => {
  const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/stick-man" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.poster, null, "no art to be had, and that is not a failure");
  assert.equal(j.attribution, null);
  assert.equal(catalog().titles.find(x => x.id === "stick-man").poster, null);
  assert.equal(fs.existsSync(path.join(MOVIES, "posters", "stick-man.jpg")), false);

  const { rec } = await recipe();
  const cell = rec.boards.flatMap(b => b.buttons).find(b => b.titleId === "stick-man");
  assert.ok(cell, "the title is on the board");
  assert.equal(cell.image, undefined, "with a label and no picture");
});

test("an og:image that is not a picture is refused, and nothing is saved", async () => {
  const r = await post("/movies/add", {
    url: "https://www.netflix.com/gb/title/the-tiger-who-came-to-tea",
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).poster, null, "an HTML error page is not a poster");
  assert.equal(catalog().titles.find(x => x.id === "the-tiger-who-came-to-tea").poster, null);
  assert.equal(fs.existsSync(path.join(MOVIES, "posters", "the-tiger-who-came-to-tea.jpg")), false,
               "and no half-picture was left where a poster goes");
});

test("with a TMDB key the fallback finds the art, and the add carries TMDB's credit", async () => {
  await stopHub();
  await startHub({ TMDB_API_KEY: "not-a-real-key" });
  assert.equal((await post("/integrations/drive/localfolder", { folderPath: INSIDE })).status, 204);
  tmdbCalls = [];

  // the same link as before: its page still has no og:image, so only the key is
  // new — and the title keeps the tile Ellie already knows
  const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/stick-man" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.rank, 6, "a re-add stays where it was");
  assert.equal(j.poster, "posters/stick-man.jpg");
  assert.match(j.attribution, /TMDB/,
               "the credit comes back with the add, for the sheet to print");
  assert.match(j.attribution, /not endorsed or certified by TMDB/,
               "in TMDB's own required words (era-family/tools/fetch-posters.mjs)");

  assert.equal(tmdbCalls.length, 1, "one search, no shotgun");
  assert.deepEqual(tmdbCalls[0], { path: "/tmdb/search/movie", key: "not-a-real-key",
                                   query: "Stick Man", year: null },
                   "a film is searched as a film, with the key the family configured");

  const c = catalog();
  assert.equal(c.attribution, j.attribution,
               "and it is written beside the catalog it belongs to, not into a log");
  const t = c.titles.find(x => x.id === "stick-man");
  assert.equal(t.poster, "posters/stick-man.jpg");
  assert.equal(t.posterFrom, "tmdb");
  assert.ok(fs.readFileSync(path.join(MOVIES, "posters", "stick-man.jpg")).equals(JPEG),
            "the second result's art: a hit with no poster_path is passed over, not saved empty");

  const img = await fetch(`${BASE}/movies/posters/stick-man.jpg`);
  assert.equal(img.status, 200);
  const { rec } = await recipe();
  assert.equal(rec.boards.flatMap(b => b.buttons).find(b => b.titleId === "stick-man").image,
               "movies/posters/stick-man.jpg");
});

test("a title TMDB has never heard of is added anyway, bare", async () => {
  tmdbCalls = [];
  const r = await post("/movies/add", { url: "https://www.netflix.com/gb/title/room-on-the-broom" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.poster, null);
  assert.equal(j.attribution, null, "nothing of TMDB's was used, so nothing is credited");
  assert.equal(tmdbCalls.length, 1, "it did ask");
  assert.equal(tmdbCalls[0].query, "Room On The Broom");
  const { rec } = await recipe();
  assert.ok(rec.boards.flatMap(b => b.buttons).some(b => b.titleId === "room-on-the-broom"),
            "and the tile is on the board regardless");
});
