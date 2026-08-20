// pool.js — the family data pool (New ERA shared-data contract, v1).
// A directory laid out so ANY folder-syncer (Google Drive for desktop,
// Dropbox, Syncthing, rsync) can carry it safely:
//   pool/
//     .pool-version            "1"
//     events/<device-id>/<YYYY-MM-DD>.jsonl   ONE WRITER PER FILE: each device
//                              appends only under its own id — no conflicts.
//     devices/<device-id>.json heartbeat {lastSeen, service, version}
//     content/                 published artifacts (recipes, catalogs, books)
//     profile/                 timestamped configs, newest-wins
// Readers MERGE across all device dirs. Nothing here ever edits another
// device's files.
// The pool dir must be a LOCAL folder (a syncer like Drive for desktop mirrors
// it); never point it at a network mount — blocked sync fs calls can hang.
"use strict";
const fs = require("fs");
const path = require("path");

function initPool(dataDir, deviceId) {
  const root = process.env.ERA_POOL_DIR || path.join(dataDir, "pool");
  const mine = path.join(root, "events", deviceId);
  // LAW (dad, 8/19): history is nice-to-have — the apps must run even if the
  // pool is unavailable. Any boot failure degrades to an inert pool, never a
  // dead server.
  try {
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(path.join(root, "devices"), { recursive: true });
    fs.mkdirSync(path.join(root, "content"), { recursive: true });
    fs.mkdirSync(path.join(root, "profile"), { recursive: true });
    const ver = path.join(root, ".pool-version");
    if (!fs.existsSync(ver)) fs.writeFileSync(ver, "1\n");
  } catch (e) {
    console.error("[pool] UNAVAILABLE (apps unaffected; history paused): " + e.message);
    return { root, deviceId, degraded: true,
             append() {}, heartbeat() {}, readMerged() { return []; } };
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  // Append one event line to THIS device's file. Never throws (pool loss must
  // never break the app — legacy stores remain canonical during transition).
  function append(kind, obj) {
    try {
      const line = JSON.stringify({ t: new Date().toISOString(), device: deviceId, kind, ...obj });
      fs.appendFileSync(path.join(mine, today() + ".jsonl"), line + "\n");
    } catch (e) { console.error("[pool] append failed: " + e.message); }
  }

  // Heartbeat: lets a doctor distinguish "quiet day" from "device gone".
  function heartbeat(extra) {
    try {
      fs.writeFileSync(path.join(root, "devices", deviceId + ".json"),
        JSON.stringify({ lastSeen: new Date().toISOString(), device: deviceId, ...extra }, null, 2));
    } catch (e) { console.error("[pool] heartbeat failed: " + e.message); }
  }

  // Merge-read events across ALL devices (optionally one day / one kind).
  function readMerged({ day, kind } = {}) {
    const out = [];
    const evRoot = path.join(root, "events");
    let devs = [];
    try { devs = fs.readdirSync(evRoot); } catch { return out; }
    for (const d of devs) {
      let files = [];
      try { files = fs.readdirSync(path.join(evRoot, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        if (day && f !== day + ".jsonl") continue;
        let lines = [];
        try { lines = fs.readFileSync(path.join(evRoot, d, f), "utf8").split("\n"); } catch { continue; }
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            if (!kind || e.kind === kind) out.push(e);
          } catch { /* skip torn line (syncer mid-flight) */ }
        }
      }
    }
    out.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    return out;
  }

  return { root, deviceId, append, heartbeat, readMerged };
}

module.exports = { initPool };
