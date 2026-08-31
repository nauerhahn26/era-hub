// clothing.js — thin shell for the Clothing Picker. The actual pipeline
// (HEIC decode, AI ingest, composites, board build) lives in
// clothing-worker.js and runs in a WORKER THREAD: on 8/31 dad's ingest froze
// every hub page — Settings' "Back to apps" included — because the pixel
// loops starved the event loop. The shell only tracks state, spawns one
// worker at a time, and answers /clothing/status instantly.
"use strict";
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");

const PROVIDERS = ["anthropic", "openai", "google"];

let DATA = null;
let worker = null;
let ingesting = null;   // {done, total} live from the worker
let lastResult = null;
let queued = false;     // a regenerate asked for while one was running

function aiCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA, "ai-config.json"), "utf8"));
    if (typeof c.apiKey !== "string" || !c.apiKey) return null;
    return { provider: PROVIDERS.includes(c.provider) ? c.provider : "anthropic" };
  } catch { return null; }
}

function isBuilding() { return !!worker; }

function status() {
  const cfg = aiCfg();
  let cataloged = 0, photos = 0;
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(DATA, "wardrobe.json"), "utf8"));
    cataloged = Object.values(cat.items || {}).filter(i => i.ok).length;
  } catch {}
  try {
    photos = fs.readdirSync(path.join(DATA, "clothing")).filter(f =>
      [".heic", ".heif", ".jpg", ".jpeg", ".png"].includes(path.extname(f).toLowerCase())).length;
  } catch {}
  return { building: !!worker, ingesting, cataloged, photos,
    aiConfigured: !!cfg, aiProvider: cfg ? cfg.provider : null,
    guidance: lastResult && lastResult.guidance ? lastResult.guidance : null };
}

function regenerate(force) {
  if (worker) {           // one build at a time; run again when this one ends
    queued = true;
    return Promise.resolve({ busy: true });
  }
  return new Promise((resolve) => {
    worker = new Worker(path.join(__dirname, "clothing-worker.js"),
      { workerData: { dataDir: DATA, force: !!force } });
    worker.on("message", (m) => {
      if ("ingesting" in m) ingesting = m.ingesting;
      if (m.done) lastResult = m.done;
    });
    worker.on("error", (e) => console.error("[clothing] worker: " + e.message));
    worker.on("exit", () => {
      worker = null; ingesting = null;
      resolve(lastResult || {});
      if (queued) { queued = false; regenerate(true).catch(() => {}); }
    });
  });
}

function start(dataDir) {
  DATA = dataDir;
  setTimeout(() => { regenerate(false).catch(e => console.error("[clothing] " + e.message)); }, 20 * 1000).unref();
  setInterval(() => { regenerate(false).catch(() => {}); }, 30 * 60 * 1000).unref();
}

module.exports = { start, regenerate, isBuilding, status };
