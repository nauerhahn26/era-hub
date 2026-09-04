// ai-config.js — which key plays which role, read-only.
// The family types keys into two different Settings cards: the AI helper card
// writes <DATA>/ai-config.json (POST /ai-key) and the Voice card writes
// <DATA>/tts-config.json (POST /tts-key, which also records whether
// ElevenLabs recognised the key). Book jobs need a third, optional one (fal,
// for the animate step), so ai-config.json grows from the flat
// {provider, apiKey} it has today into a map keyed by ROLE:
//
//   { vision: {provider, apiKey}, elevenlabs: {apiKey, voiceId}, fal: {apiKey} }
//
// Two rules make that growth safe on a machine that already has keys:
//
//  1. THE OLD SHAPE IS READ FOREVER. Self-update never touches <DATA>
//     (update.js filters "data" out of the overlay), so there is no migration
//     hook and there never will be one — a hub that only ran a one-shot
//     migration would meet the flat file again on any restore from backup.
//  2. NOTHING HERE WRITES. Not a rewrite, not a "tidy up", not a default
//     filled in on disk. A bad parse in a writer is one keystroke away from
//     erasing the key the family typed in, and the writers already live in
//     server.js where the user actually asked for the save.
//
// Keys are returned to the caller and are never logged, never put in job.json
// and never echoed over HTTP.
"use strict";
const fs = require("fs");
const path = require("path");

// The three the vision card offers (server.js's /ai-key allowlist); anything
// else on disk reads as the free default rather than failing the whole role.
const VISION_PROVIDERS = ["anthropic", "openai", "google"];
const DEFAULT_VISION_PROVIDER = "google";
// Same voice the Voice card offers first (CURATED_VOICES[0] in server.js), so
// a family that saved a key but never picked a voice still gets narration.
const DEFAULT_VOICE_ID = "cgSgspJ2msm6clMCkdW9";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// A key is only a key when it is a non-blank string. "" and "   " are what a
// cleared card leaves behind.
function key(v) { return typeof v === "string" && v.trim() ? v.trim() : ""; }

function visionRole(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  // role-keyed if `vision` is there, otherwise the whole object IS the vision
  // key (the flat shape every hub built before today wrote)
  const role = cfg.vision && typeof cfg.vision === "object" ? cfg.vision : cfg;
  const apiKey = key(role.apiKey);
  if (!apiKey) return null;
  return { provider: VISION_PROVIDERS.includes(role.provider) ? role.provider : DEFAULT_VISION_PROVIDER,
           apiKey };
}

function falRole(cfg) {
  if (!cfg || typeof cfg !== "object" || !cfg.fal || typeof cfg.fal !== "object") return null;
  const apiKey = key(cfg.fal.apiKey);
  return apiKey ? { apiKey } : null;
}

function elevenRole(dir) {
  // The Voice card owns this file; the environment variable is the operator's
  // way in (same order loadTtsCfg uses in server.js).
  const cfg = readJson(path.join(dir, "tts-config.json")) || {};
  const apiKey = key(cfg.apiKey) || key(process.env.ELEVENLABS_API_KEY);
  // keyOk === false means ElevenLabs already refused this key when it was
  // saved. Spending a narration run on it would just buy silence, so it is no
  // key at all — exactly what /voices reports to the Voice card. keyOk
  // undefined (never verified, or set from the environment) still counts.
  if (!apiKey || cfg.keyOk === false) return null;
  return { apiKey, voiceId: key(cfg.voiceId) || DEFAULT_VOICE_ID };
}

// The one export: a snapshot of every role, read fresh each call (a key saved
// a second ago must be visible to the next job without a restart).
function aiRoles(dir) {
  const cfg = readJson(path.join(dir, "ai-config.json"));
  return { vision: visionRole(cfg), elevenlabs: elevenRole(dir), fal: falRole(cfg) };
}

// Which roles are SET UP, and nothing about what they are set up WITH. A caller
// that only needs to know whether the family has bought a voice yet — content.js
// refusing a re-narrate before it spawns a worker (spec §5) — must not have to
// hold a key to find that out, and "no key is read in that file" stays true.
function haveRoles(dir) {
  const r = aiRoles(dir);
  return { vision: !!r.vision, elevenlabs: !!r.elevenlabs, fal: !!r.fal };
}

module.exports = { aiRoles, haveRoles, VISION_PROVIDERS };
