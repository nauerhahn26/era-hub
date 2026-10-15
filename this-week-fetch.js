// this-week-fetch.js — the download rail (spec 2026-10-12 §3.2, plan B3).
//
// The week package names 3-5 YouTube videos by id. The board never touches
// YouTube (D56 amended): ONE hub whose switch is on downloads each video once,
// with the media-tools yt-dlp, into the family's Drive week folder — and every
// device gets it from there through the mirror.
//
// The refusal ladder, in this order, every tick:
//   switch-off    this device's Settings say no (downloadWeekVideos === false)
//   pack-missing  no media-tools yt-dlp on this device
//   no-folder     no local Drive folder, or no this-week/<week_of> in it
//   claimed       another device's claim-<id>.json is under 30 minutes old
//   too-long      the lookup says over 15 minutes
//   not-mp4       the download came back in another container
//   failed        yt-dlp failed, or left nothing / zero bytes (retried hourly)
// The first three apply to every video still missing; the rest are per video.
//
// Laws (music-add.js's, and the same reasons):
//   - argv arrays only, never a shell string; the url is always the full
//     https://www.youtube.com/watch?v=<id> (an id may start with "-", and a bare
//     one would read as a flag).
//   - no ffmpeg: "-f b[...]" asks for a file that already has picture and
//     sound; never -x, --remux-video, --merge-output-format, --convert-*.
//   - the only writes into the Drive folder are the claim and the finished
//     files, each through drive.atomically (a .part sibling, then a rename).
//   - one job at a time, ever: a tick while a pass runs answers "busy".
//   - every message a parent can read is this file's own sentence; yt-dlp's
//     words go to the console only.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const drive = require("./drive.js");
const packs = require("./packs.js");
const thisWeek = require("./this-week.js");

const PACK = "media-tools";
const KILL_MS = 20 * 60 * 1000;          // a stuck download must not hold the slot for ever
const CLAIM_FRESH_MS = 30 * 60 * 1000;   // another device's claim younger than this is respected
const RETRY_MS = 60 * 60 * 1000;         // a failed id is tried again at most once an hour
const MAX_SECONDS = 900;                 // 15 minutes (schema: minutes 1-15)
const FORMAT = "b[ext=mp4][height<=720]/b[ext=mp4]/18";
const THUMB_EXT = [".webp", ".jpg", ".jpeg", ".png"];
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const SAY = {
  "switch-off": "This device is set not to download the week's videos.",
  "pack-missing": "The media tools are not installed on this device, so it cannot download the week's videos.",
  "no-folder": "This device has no family Drive folder with this week in it, so there is nowhere to save the videos.",
  "claimed": "Another device is downloading this video right now.",
  "too-long": "This video is longer than 15 minutes, so it was not downloaded.",
  "not-mp4": "This video did not come as an MP4, so it cannot play here.",
  "zero": "The download finished but left no video, so it will be tried again later.",
  "unreadable": "Could not make sense of what came back for this video. It will be tried again later.",
};
// yt-dlp's last stderr line -> one sentence for a parent (music-add.js PLAIN,
// most specific first). Anything unrecognised gets the last sentence.
const PLAIN = [
  [/Sign in to confirm you.re not a bot|confirm your age|login required/i,
   "YouTube would not let this device fetch that video. It will be tried again later."],
  [/blocked it in your country|available in your country|not available from your location|use a VPN or a proxy/i,
   "That video cannot be played in your country."],
  [/Video unavailable|Private video|This video is not available|removed/i,
   "That video is not available any more."],
  [/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|Unable to download|network|offline/i,
   "This device could not reach the internet to fetch it. It will be tried again later."],
  [/timed out|took too long/i,
   "That took too long to download. It will be tried again later."],
];
const PLAIN_LAST = "This video could not be downloaded. It will be tried again later.";
function plainly(raw) {
  const s = String(raw == null ? "" : raw);
  for (const [re, sentence] of PLAIN) if (re.test(s)) return sentence;
  return PLAIN_LAST;
}
// A refusal that already is the sentence (music-add.js OwnWords).
class OwnWords extends Error {
  constructor(state, message) { super(message || SAY[state]); this.state = state; }
}

let DATA = null, DEVICE_ID = "unknown", POOL = null, readSwitch = () => true;
let running = null;      // {id, phase} of the job in flight
let passing = false;     // a pass (one or more jobs, in order) is under way
const videos = {};       // id -> {state, height?, error?, at}

function init({ dataDir, deviceId, pool, settingsReader } = {}) {
  DATA = dataDir;
  if (deviceId) DEVICE_ID = String(deviceId);
  POOL = pool || null;
  if (typeof settingsReader === "function") readSwitch = settingsReader;
}

// music-add.js tool(): ERA_YTDLP stands in for the pack; ERA_PACK_ROOT moves it.
function packRoot() { return process.env.ERA_PACK_ROOT || __dirname; }
function tool() {
  const root = packRoot();
  const t = packs.ytDlp(root);
  if (process.env.ERA_YTDLP) return { bin: process.env.ERA_YTDLP, args: t.args };
  if (!packs.packInstalled(root, PACK)) return null;
  return t;
}

function run(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) { resolve({ code: -1, stdout: "", stderr: String(e.message) }); return; }
    let stdout = "", stderr = "", killed = false;
    child.stdout.on("data", d => { if (stdout.length < 2e7) stdout += d; });
    child.stderr.on("data", d => { if (stderr.length < 2e5) stderr += d; });
    child.on("error", e => { stderr += e.message; });
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, KILL_MS);
    timer.unref();
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
  });
}
const lastLine = (r) => r.killed ? "took too long"
  : (String(r.stderr || "").split("\n").map(s => s.trim()).filter(Boolean).pop() || "exit " + r.code);

const urlOf = (id) => "https://www.youtube.com/watch?v=" + id;
const sizeOf = (p) => { try { const s = fs.statSync(p); return s.isFile() ? s.size : 0; } catch { return 0; } };

// The height "b[ext=mp4][height<=720]/b[ext=mp4]/18" will pick, read from the
// lookup: the tallest mp4 with picture AND sound at or under 720, then any
// such mp4, then format 18; failing all of that, the top-level height.
function heightOf(j) {
  const f = Array.isArray(j.formats) ? j.formats : [];
  const both = f.filter(x => x && x.ext === "mp4" && x.acodec && x.acodec !== "none" &&
                             x.vcodec && x.vcodec !== "none" && Number.isFinite(x.height));
  const tallest = (list) => list.reduce((m, x) => (m == null || x.height > m ? x.height : m), null);
  const h = tallest(both.filter(x => x.height <= 720)) ?? tallest(both) ??
            (f.find(x => x && x.format_id === "18") || {}).height;
  if (Number.isFinite(h)) return h;
  return Number.isFinite(j.height) ? j.height : undefined;
}

// Another device's claim, still fresh? The newer of `started` and the file's
// mtime counts (a claim Drive just brought down reads as fresh — the safe side).
function claimedByOther(claimPath, now) {
  let st;
  try { st = fs.statSync(claimPath); } catch { return false; }
  let c = {};
  try { c = JSON.parse(fs.readFileSync(claimPath, "utf8")) || {}; } catch {}
  if (c.device === DEVICE_ID) return false;             // our own, left by a crash
  const started = Date.parse(c.started);
  const at = Math.max(st.mtimeMs, Number.isFinite(started) ? started : 0);
  return now - at < CLAIM_FRESH_MS;
}

function set(id, state, extra = {}) {
  videos[id] = { state, ...extra, at: Date.now() };
}

// One video, start to finish. Throws OwnWords on any refusal.
async function job(t, week_of, weekDir, id) {
  const claim = path.join(weekDir, "claim-" + id + ".json");
  const tmp = path.join(DATA, "this-week", ".tmp", id);
  const t0 = Date.now();
  running = { id, phase: "looking it up" };
  drive.atomically(claim, (p) => fs.writeFileSync(p, JSON.stringify({ device: DEVICE_ID, started: new Date().toISOString() })));
  try {
    const lk = await run(t.bin, [...t.args, "--no-playlist", "--no-warnings",
                                 "--skip-download", "--dump-single-json", urlOf(id)]);
    if (lk.code !== 0) throw new OwnWords("failed", plainly(lastLine(lk)), lastLine(lk));
    let j;
    try { j = JSON.parse(lk.stdout); } catch { throw new OwnWords("failed", SAY.unreadable); }
    if (!j || typeof j !== "object") throw new OwnWords("failed", SAY.unreadable);
    if (Number(j.duration) > MAX_SECONDS) throw new OwnWords("too-long");
    const height = heightOf(j);

    running.phase = "downloading";
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const dl = await run(t.bin, [...t.args, "--no-playlist", "--no-warnings", "--no-progress",
      "--retries", "3", "-f", FORMAT, "--write-thumbnail",
      "-o", path.join(tmp, id + ".%(ext)s"), urlOf(id)]);
    if (dl.code !== 0) {
      console.error("[this-week] " + id + ": " + lastLine(dl));
      throw new OwnWords("failed", plainly(lastLine(dl)));
    }
    const mp4 = path.join(tmp, id + ".mp4");
    if (sizeOf(mp4) === 0) {
      let names = [];
      try { names = fs.readdirSync(tmp); } catch {}
      const other = names.some(n => n.startsWith(id + ".") && !n.endsWith(".part") &&
                                    !THUMB_EXT.includes(path.extname(n).toLowerCase()) && sizeOf(path.join(tmp, n)) > 0);
      throw new OwnWords(other ? "not-mp4" : "failed", other ? SAY["not-mp4"] : SAY.zero);
    }
    const thumb = THUMB_EXT.find(e => sizeOf(path.join(tmp, id + e)) > 0);

    running.phase = "saving";
    // the picture first, the video last: a ready mp4 is the "here" signal
    if (thumb) drive.atomically(path.join(weekDir, id + thumb), (p) => fs.copyFileSync(path.join(tmp, id + thumb), p));
    drive.atomically(path.join(weekDir, id + ".mp4"), (p) => fs.copyFileSync(mp4, p));
    const m = drive.mirrorWeek(week_of) || {};
    if (m.error || m.blocked) console.error("[this-week] " + id + " saved but not mirrored: " + (m.error || m.blocked));
    set(id, "ready", height !== undefined ? { height } : {});
    if (POOL) try { POOL.append("this-week-fetch", { id, state: "ready", height, ms: Date.now() - t0 }); } catch {}
  } catch (e) {
    const state = e instanceof OwnWords ? e.state : "failed";
    const message = e instanceof OwnWords ? e.message : PLAIN_LAST;
    if (!(e instanceof OwnWords)) console.error("[this-week] " + id + ": " + e.message);
    set(id, state, { error: message });
    if (POOL) try { POOL.append("this-week-fetch", { id, state, ms: Date.now() - t0 }); } catch {}
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(claim, { force: true }); } catch {}
    running = null;
  }
}

async function pass() {
  const week = (() => { try { return thisWeek.build(DATA).week; } catch { return null; } })();
  if (!week) return;
  const ids = (week.manifest.watch || []).map(v => v.id).filter(id => ID_RE.test(id));
  const folder = drive.localFolder();
  const weekDir = folder ? path.join(folder, "this-week", week.week_of) : null;
  const readyInDrive = (id) => weekDir && sizeOf(path.join(weekDir, id + ".mp4")) > 0;
  const missing = ids.filter(id => !readyInDrive(id));
  const all = (state) => { for (const id of missing) set(id, state, { error: SAY[state] }); };

  if (!readSwitch()) return all("switch-off");
  const t = tool();
  if (!t) return all("pack-missing");
  let hasDir = false;
  try { hasDir = !!weekDir && fs.statSync(weekDir).isDirectory(); } catch {}
  if (!hasDir) return all("no-folder");

  // another device finished one and the ten-minute mirror has not brought it yet
  const local = path.join(DATA, "this-week", week.week_of);
  if (ids.some(id => readyInDrive(id) && sizeOf(path.join(local, id + ".mp4")) === 0)) drive.mirrorWeek(week.week_of);
  for (const id of ids) if (readyInDrive(id) && videos[id] && videos[id].state !== "ready") delete videos[id];

  for (const id of missing) {
    if (!readSwitch()) { set(id, "switch-off", { error: SAY["switch-off"] }); continue; }
    const v = videos[id];
    if (v && v.state !== "claimed" && Date.now() - v.at < RETRY_MS &&
        ["failed", "too-long", "not-mp4"].includes(v.state)) continue;   // at most once an hour
    if (claimedByOther(path.join(weekDir, "claim-" + id + ".json"), Date.now())) {
      set(id, "claimed", { error: SAY.claimed });
      continue;
    }
    try { await job(t, week.week_of, weekDir, id); }
    catch (e) { set(id, "failed", { error: PLAIN_LAST }); console.error("[this-week] " + id + ": " + e.message); }
  }
}

// One pass at a time. Returns {tick:"busy"} while one runs, else
// {tick:"started", done} where done settles when the pass is over.
function tick(reason) {
  if (!DATA) return { tick: "not-started" };
  if (passing) return { tick: "busy" };
  passing = true;
  const done = pass()
    .catch(e => console.error("[this-week] tick (" + reason + "): " + e.message))
    .finally(() => { passing = false; running = null; });
  return { tick: "started", done };
}

function status() {
  const out = {};
  for (const [id, v] of Object.entries(videos)) out[id] = { ...v };
  return { running: running ? { ...running } : null, videos: out };
}

// The /this-week/status seam: the files are the truth for "ready"; otherwise
// the rail's last word on this id, or "coming".
function videoState(id, files) {
  const v = videos[id];
  if (files && files.ready) {
    const o = { state: "ready" };
    if (v && v.state === "ready" && v.height !== undefined) o.height = v.height;
    return o;
  }
  if (running && running.id === id) return { state: "coming" };
  if (!v || v.state === "ready") return { state: "coming" };
  const o = { state: v.state };
  if (v.error) o.error = v.error;
  return o;
}

const runningNow = () => (running ? { ...running } : null);

module.exports = { init, tick, status, videoState, running: runningNow, KILL_MS, FORMAT };
