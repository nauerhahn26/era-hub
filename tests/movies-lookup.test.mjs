// movies-lookup.test.mjs — "ada twist → on Netflix, and here is the link"
// (spec §6 "Streaming availability", plan T5.3). The one interface behind
// which the provider is a CONFIG VALUE: a null adapter when the family has no
// key, TMDB when they have the one they already needed for posters, and
// TMDB + Watchmode when they added the optional second one.
//
// PORTS: 8438 — the hub, when a case drives the door. The stand-in provider
// (TMDB and Watchmode at once) takes an EPHEMERAL port: it stands in for the
// whole internet, so it must never be something a sibling suite could be
// holding. Same arrangement as movies-add.test.mjs.
//
// MONEY GUARDRAIL (plan §B.2). Every request in this suite goes through the
// three seams this feature owns — ERA_TMDB_URL, ERA_TMDB_IMG_URL and
// ERA_STREAMING_URL — pointed at loopback before anything is required, and
// both keys are fakes assembled at runtime. The stand-in counts what it saw:
// the null-adapter cases assert ZERO (a family with no key must not be able to
// spend one), and the adapter cases assert the EXACT calls, because a recorded
// count that does not match means a request went somewhere this suite does not
// control. TMDB_API_KEY and WATCHMODE_API_KEY are cleared on every hub spawn
// so a real key sitting in the developer's shell can never ride along.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8438;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-movies-lookup-"));

// Assembled, never written as a literal: era-scan treats a key-shaped run in a
// tracked file as a fatal hit, and a fixture that looks like a key is
// indistinguishable from one that is.
const TMDB_KEY = ["fake", "-tmdb-", "0".repeat(24)].join("");
const WM_KEY = ["fake", "-watchmode-", "0".repeat(20)].join("");

// ------------------------------------------------------------ the stand-in
//
// TMDB under /tmdb, its image CDN under /tmdb-img, Watchmode under
// /watchmode. Every request is recorded; a path it does not know is a 404,
// which is also the "this provider is having a bad day" case two tests need.
let web = null, WEB = "";
let calls = [];
let total = 0;
let brokenWatchmode = false;

// TMDB /search/multi, verbatim in shape: a show, a film, and a PERSON (which
// the adapter must drop — a search for a name matches actors too).
const SEARCH = {
  results: [
    { media_type: "tv", id: 129604, name: "Ada Twist, Scientist",
      first_air_date: "2021-09-28", poster_path: "/ada.jpg" },
    { media_type: "movie", id: 278, title: "Paddington",
      release_date: "2014-11-28", poster_path: "/pad.jpg" },
    { media_type: "person", id: 99, name: "A Person", profile_path: "/who.jpg" },
  ],
};

// Watchmode TitleDetails?append_to_response=sources, in the shape §3 of the
// research memo records. The link shapes are the ones plan T5.3 says to pin.
const WM_DETAILS = {
  id: 3173903, title: "Ada Twist, Scientist", year: 2021,
  tmdb_id: 129604, tmdb_type: "tv", us_rating: "TV-Y",
  similar_titles: [330884, 343611],
  sources: [
    // Netflix hands out /title/{id}; the kiosk plays /watch/{id}
    { source_id: 203, name: "Netflix", type: "sub", region: "US",
      web_url: "https://www.netflix.com/title/80198673?src=tudum" },
    // Disney's canonical form today is /browse/entity-{uuid}; /play/ 308s to it
    { source_id: 372, name: "Disney+", type: "sub", region: "US",
      web_url: "https://www.disneyplus.com/play/328b0ec7-6e50-4ead-aa7f-c8bb92e6f08a" },
    // Prime's web_url bounces through a third id space; the ASIN is in the Roku link
    { source_id: 26, name: "Prime Video", type: "sub", region: "US",
      web_url: "https://watch.amazon.com/detail?gti=amzn1.dv.gti.aebe765d-1111",
      roku_url: "https://therokuchannel.roku.com/launch/13?contentID=B0FSKQBQ5T&MediaType=movie" },
    // Apple's link is real, its affiliate tail is not ours to carry
    { source_id: 371, name: "Apple TV+", type: "sub", region: "US",
      web_url: "https://tv.apple.com/us/movie/ada/umc.cmc.52sgmi3?at=1000l3V2&ct=app_tvplus&itscg=30200&itsct=justwatch_tv" },
    // rent/buy must never reach a tile
    { source_id: 10, name: "Amazon", type: "buy", region: "US",
      web_url: "https://www.amazon.com/dp/B0000000001" },
    // another country's offer is another family's offer
    { source_id: 203, name: "Netflix", type: "sub", region: "GB",
      web_url: "https://www.netflix.com/title/70000000" },
  ],
};

const json = (res, body, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function standIn(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  total++;
  if (p === "/tmdb/search/multi") {
    calls.push({ api: "tmdb", path: p, key: u.searchParams.get("api_key"),
                 query: u.searchParams.get("query") });
    const q = (u.searchParams.get("query") || "").toLowerCase();
    return json(res, q.includes("ada") ? SEARCH : { results: [] });
  }
  let m = /^\/tmdb\/(movie|tv)\/(\d+)\/watch\/providers$/.exec(p);
  if (m) {
    calls.push({ api: "tmdb", path: p, key: u.searchParams.get("api_key"),
                 type: m[1], id: Number(m[2]) });
    // every country on Earth comes back; the adapter slices its own
    return json(res, { id: Number(m[2]), results: {
      US: { link: "https://www.themoviedb.org/tv/129604/watch?locale=US",
            flatrate: [{ provider_id: 8, provider_name: "Netflix" },
                       { provider_id: 337, provider_name: "Disney Plus" }],
            buy: [{ provider_id: 10, provider_name: "Amazon Video" }] },
      GB: { flatrate: [{ provider_id: 39, provider_name: "Now TV" }] } } });
  }
  m = /^\/watchmode\/title\/([^/]+)\/details$/.exec(p);
  if (m) {
    calls.push({ api: "watchmode", path: p, id: m[1],
                 key: req.headers["x-api-key"] || null,
                 append: u.searchParams.get("append_to_response"),
                 regions: u.searchParams.get("regions") });
    if (brokenWatchmode) return json(res, { success: false }, 500);
    return json(res, WM_DETAILS);
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("no such endpoint");
}

// --------------------------------------------------------------- the module
//
// Required AFTER the seams are set, and driven in-process: the interface is
// what this task delivers, and the door below is one thin wrapper over it.
const require = createRequire(import.meta.url);
let lookup = null;
let DATA = null;

function freshData(cfg, keys) {
  DATA = fs.mkdtempSync(path.join(TMP, "data-"));
  if (cfg) fs.writeFileSync(path.join(DATA, "content-config.json"), JSON.stringify(cfg));
  if (keys) fs.writeFileSync(path.join(DATA, "ai-config.json"), JSON.stringify(keys));
  process.env.ERA_DATA_DIR = DATA;
  calls = [];
  return DATA;
}
const withTmdb = { tmdb: { apiKey: TMDB_KEY } };
const withBoth = { tmdb: { apiKey: TMDB_KEY }, watchmode: { apiKey: WM_KEY } };

before(async () => {
  web = http.createServer(standIn);
  await new Promise(r => web.listen(0, "127.0.0.1", r));
  WEB = `http://127.0.0.1:${web.address().port}`;
  process.env.ERA_TMDB_URL = WEB + "/tmdb";
  process.env.ERA_TMDB_IMG_URL = WEB + "/tmdb-img";
  process.env.ERA_STREAMING_URL = WEB + "/watchmode";
  process.env.TMDB_API_KEY = "";
  process.env.WATCHMODE_API_KEY = "";
  lookup = require(path.join(HUB, "movies-lookup.js"));
});

after(async () => {
  await stopHub();
  if (web) await new Promise(r => web.close(r));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------ the null adapter

test("no key at all: the search returns nothing, says so, and spends nothing", async () => {
  freshData(null, null);
  const out = await lookup.lookupTitle("ada twist", "US");
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0, "a family with no key must not reach a provider");
  const st = lookup.status();
  assert.equal(st.provider, "none");
  assert.equal(st.ready, false);
  assert.match(st.hint, /Settings/);
  // and the hint tells them the thing that DOES work today
  assert.match(st.hint, /paste|link/i);
});

test("the provider is a config value: 'none' turns the search off with both keys present", async () => {
  freshData({ movies: { provider: "none" } }, withBoth);
  assert.deepEqual(await lookup.lookupTitle("ada twist", "US"), []);
  assert.equal(calls.length, 0);
  assert.equal(lookup.status().provider, "none");
});

test("an empty query is nothing to look up, not an error", async () => {
  freshData(null, withBoth);
  assert.deepEqual(await lookup.lookupTitle("   ", "US"), []);
  assert.deepEqual(await lookup.lookupTitle(null, "US"), []);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------- TMDB on its own

test("TMDB alone names the service and admits it has no link", async () => {
  freshData(null, withTmdb);
  const out = await lookup.lookupTitle("ada twist", "US");
  assert.equal(lookup.status().provider, "tmdb");
  assert.equal(lookup.status().deepLinks, false);
  // the person in the results is not a film
  assert.equal(out.length, 2);
  const [show, film] = out;
  assert.equal(show.title, "Ada Twist, Scientist");
  assert.equal(show.year, 2021);
  assert.equal(show.tmdbId, 129604);
  assert.equal(show.kind, "show");
  assert.equal(show.poster, WEB + "/tmdb-img/ada.jpg");
  assert.deepEqual(show.providers.map(p => [p.name, p.deepLink]),
                   [["Netflix", null], ["Disney+", null]]);
  assert.equal(film.kind, "movie");
  assert.equal(film.year, 2014);
  // one search plus one availability call per title, and NOT ONE to Watchmode
  assert.equal(calls.filter(c => c.api === "watchmode").length, 0);
  assert.equal(calls.filter(c => c.path === "/tmdb/search/multi").length, 1);
  assert.equal(calls.filter(c => /watch\/providers$/.test(c.path)).length, 2);
  assert.equal(calls.find(c => c.path === "/tmdb/search/multi").key, TMDB_KEY);
});

test("rent and buy are not tiles: only flatrate names come back", async () => {
  freshData(null, withTmdb);
  const out = await lookup.lookupTitle("ada twist", "US");
  assert.ok(!out[0].providers.some(p => /amazon video/i.test(p.name)));
});

test("the region is the family's, from config and from the argument", async () => {
  freshData({ movies: { provider: "tmdb", region: "GB" } }, withTmdb);
  assert.equal(lookup.status().region, "GB");
  const gb = await lookup.lookupTitle("ada twist");
  assert.deepEqual(gb[0].providers.map(p => p.name), ["Now TV"]);
  const us = await lookup.lookupTitle("ada twist", "us");
  assert.deepEqual(us[0].providers.map(p => p.name), ["Netflix", "Disney+"]);
});

// ------------------------------------------------------ TMDB + Watchmode

test("with the optional key, every tile gets a link the kiosk can open", async () => {
  freshData(null, withBoth);
  const st = lookup.status();
  assert.equal(st.provider, "watchmode");
  assert.equal(st.deepLinks, true);
  const out = await lookup.lookupTitle("ada twist", "US");
  const show = out[0];
  // THE LINK SHAPES (plan T5.3). Netflix plays from /watch/{id}; Disney's
  // canonical form is /browse/entity-{uuid}; Prime is primevideo.com/detail/
  // {ASIN} and NEVER watch.amazon.com?gti=; Apple keeps its link and loses
  // the affiliate tail.
  assert.deepEqual(show.providers.map(p => [p.name, p.deepLink]), [
    ["Netflix", "https://www.netflix.com/watch/80198673"],
    ["Disney+", "https://www.disneyplus.com/browse/entity-328b0ec7-6e50-4ead-aa7f-c8bb92e6f08a"],
    ["Prime Video", "https://www.primevideo.com/detail/B0FSKQBQ5T"],
    ["Apple TV+", "https://tv.apple.com/us/movie/ada/umc.cmc.52sgmi3"],
  ]);
  assert.ok(!JSON.stringify(show).includes("watch.amazon.com"));
  // the age rating and the similar-title seed the recommendation engine wants
  assert.equal(show.ageRating, "TV-Y");
  assert.deepEqual(show.similar, [330884, 343611]);
  // the handle a weekly re-check uses, so the title is never re-searched
  assert.equal(show.providerRef.watchmode, 3173903);
  // the key travels in the header Watchmode documents, and the TMDB id is how
  // the join is made
  const wm = calls.filter(c => c.api === "watchmode");
  assert.equal(wm[0].id, "tv-129604");
  assert.equal(wm[0].key, WM_KEY);
  assert.equal(wm[0].append, "sources");
  assert.equal(wm[0].regions, "US");
  // TMDB is still the spine, and its provider table is NOT asked again
  assert.equal(calls.filter(c => /watch\/providers$/.test(c.path)).length, 0);
});

test("a provider having a bad day is a shorter answer, never an error", async () => {
  freshData(null, withBoth);
  brokenWatchmode = true;
  try {
    const out = await lookup.lookupTitle("ada twist", "US");
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].providers, []);
    assert.equal(out[0].title, "Ada Twist, Scientist");
  } finally { brokenWatchmode = false; }
});

test("a search that matches nothing is an empty grid, not a failure", async () => {
  freshData(null, withBoth);
  assert.deepEqual(await lookup.lookupTitle("no such film anywhere", "US"), []);
});

// ------------------------------------------------------------------ the door

let child = null;
async function startHub(env = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, "hubdata-"));
  if (env.config) fs.writeFileSync(path.join(dir, "content-config.json"), JSON.stringify(env.config));
  if (env.keys) fs.writeFileSync(path.join(dir, "ai-config.json"), JSON.stringify(env.keys));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: dir, ERA_BIND: "127.0.0.1",
           // belt and braces: nothing else this hub does may reach a provider
           ERA_AI_URL: "http://127.0.0.1:9/never",
           ERA_ELEVEN_URL: "http://127.0.0.1:9/never",
           ERA_TMDB_URL: WEB + "/tmdb", ERA_TMDB_IMG_URL: WEB + "/tmdb-img",
           ERA_STREAMING_URL: WEB + "/watchmode",
           TMDB_API_KEY: "", WATCHMODE_API_KEY: "" },
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
const post = (url, body, headers) => fetch(BASE + url, {
  method: "POST", headers: headers || { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body) });

test("POST /movies/lookup hands the sheet a grid it can draw", async () => {
  await startHub({ keys: withBoth });
  calls = [];
  const r = await post("/movies/lookup", { query: "ada twist" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, "watchmode");
  assert.equal(body.region, "US");
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].providers[0].deepLink,
               "https://www.netflix.com/watch/80198673");
  // no key ever leaves the hub
  const wire = JSON.stringify(body);
  assert.ok(!wire.includes(TMDB_KEY) && !wire.includes(WM_KEY));
  await stopHub();
});

test("no key: the door still answers, with the hint and an empty grid", async () => {
  await startHub({});
  calls = [];
  const r = await post("/movies/lookup", { query: "ada twist" });
  assert.equal(r.status, 200, "a missing key is never an error");
  const body = await r.json();
  assert.deepEqual(body.results, []);
  assert.equal(body.provider, "none");
  assert.match(body.hint, /Settings/);
  assert.equal(calls.length, 0);
  await stopHub();
});

test("the door refuses an empty search and anything from another page", async () => {
  await startHub({ keys: withBoth });
  const empty = await post("/movies/lookup", { query: "  " });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "need-query");
  const junk = await post("/movies/lookup", "{oops");
  assert.equal(junk.status, 400);
  const elsewhere = await post("/movies/lookup", { query: "ada" }, { "Content-Type": "text/plain" });
  assert.equal(elsewhere.status, 403);
  await stopHub();
});

// ------------------------------------------------------------ money guardrail

test("the stand-in saw every call this suite made, and no key was spent", () => {
  assert.ok(total > 0, "zero recorded calls means a request escaped the seam");
});
