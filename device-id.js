// device-id.js — one stable name per install (spec §5 "Device id").
//
// DEVICE_ID used to default to the literal "hub". Two devices in one family
// then wrote the pool's events into the same `events/hub/<date>.jsonl`, and
// the clothing log (§5) is laid out exactly the same way: one writer per file,
// `picks/<device-id>/<date>.jsonl`. Two writers on one file is the whole class
// of bug the dot-folder design exists to avoid (torn lines, lost appends), so
// the id has to be the install's, not the product's.
//
// Precedence (plan I25):
//   1. ERA_DEVICE_ID      — an operator or a suite says who this is
//   2. profile.deviceId   — the family named it in /setup (a change needs a
//                           restart: the id is read once, at boot)
//   3. <DATA>/device-id   — what this install generated the first time
//   4. generated once     — "<hostname-slug>-<4 hex>", written to that file
//
// Whatever the source, the answer is always a slug — /^[a-z0-9-]{1,32}$/ —
// because it becomes a DIRECTORY NAME in a folder Google Drive mirrors onto
// Windows, macOS and Linux alike.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX_LEN = 32;
const HEX = 4;                       // the random tail's length
const FILE = "device-id";

// Lowercase, anything that is not [a-z0-9-] becomes a dash, no leading or
// trailing dashes, never longer than `max`. Returns "" when nothing survives.
function slug(value, max = MAX_LEN) {
  let s = String(value == null ? "" : value).toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/-+$/, "");
  return s;
}

let warned = false;   // the "could not write" line is said once per process

// resolveDeviceId(DATA, {env, profile, hostname}) → the slug this hub signs
// its shared lines with. `hostname` is injectable so a test never has to print
// the machine's real name; the default is os.hostname().
function resolveDeviceId(dataDir, opts = {}) {
  const env = opts.env || process.env;
  const profile = opts.profile || {};
  const hostname = "hostname" in opts ? opts.hostname : os.hostname();

  // 1 + 2 — given. Slugged rather than trusted: the giver may have typed a
  // machine name with spaces, and this ends up as a path segment.
  const given = slug(env && env.ERA_DEVICE_ID) || slug(profile && profile.deviceId);
  if (given) return given;

  // 3 — what this install generated before. Validated on the way back in: a
  // half-written or hand-edited file must not become a directory name.
  const file = path.join(dataDir, FILE);
  try {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (ID_RE.test(stored)) return stored;
  } catch { /* no file yet, or unreadable: generate below */ }

  // 4 — generate. The hostname makes it recognisable in a folder listing; the
  // four hex keep two "kitchen-pc"s apart.
  const base = slug(hostname, MAX_LEN - HEX - 1) || "hub";
  const id = base + "-" + crypto.randomBytes(HEX / 2).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, id + "\n");
    const back = fs.readFileSync(file, "utf8").trim();
    if (back === id) return id;
    throw new Error("device-id read back as " + JSON.stringify(back));
  } catch (e) {
    // A read-only data dir must not throw, and must not answer a DIFFERENT
    // name every boot either — a new name every morning looks like a new
    // device to the merge reader, and yesterday's own picks stop being
    // skipped. The hostname slug alone is deterministic and needs no memory.
    if (!warned) {
      warned = true;
      console.error("[device] could not store this device's name (" + e.message +
        ") — using \"" + base + "\"");
    }
    return base;
  }
}

module.exports = { resolveDeviceId, slug };
