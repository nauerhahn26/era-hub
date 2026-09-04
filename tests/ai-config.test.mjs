// ai-config.test.mjs — one read-only answer to "which key plays which role?".
// The family's keys live in two files written by two different Settings cards
// (`/ai-key` -> ai-config.json, `/tts-key` -> tts-config.json) and ai-config.json
// is growing from a flat {provider, apiKey} into a role map. Nothing may ever
// rewrite those files on read: a hub that "migrates" a key file at boot is one
// bad parse away from erasing the key the family typed in. So aiRoles() only
// reads, tolerates the old shape forever, and answers null for a role with no
// usable key. No port, no network, no key is spent here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { aiRoles } = require("./ai-config.js");

// a fresh <DATA> per case; `files` is {name: object-or-string}
function dataDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "era-roles-"));
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 1));
  return dir;
}

// ai-config.js reads ELEVENLABS_API_KEY as the operator's way in (server.js
// documents it), so an operator who exports it in their shell would turn every
// "this role is null" case below green-then-red. The variable is put out of the
// way for the whole suite and handed back afterwards; the one test that is
// ABOUT the variable sets it itself.
let hadEleven;
before(() => { hadEleven = process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_API_KEY; });
after(() => { if (hadEleven === undefined) delete process.env.ELEVENLABS_API_KEY;
              else process.env.ELEVENLABS_API_KEY = hadEleven; });

// Stand-in key material only — never a real credential (plan §B.3).
const VKEY = "test-vision-key";
const TKEY = "test-eleven-key";
const FKEY = "test-fal-key";

test("no ElevenLabs key is in the environment while this suite runs", () => {
  // Without the guard above, every "the voice role is null" case below would be
  // testing the operator's shell rather than the files on disk, and would fail
  // on any box that exports the variable the hub documents.
  assert.equal(process.env.ELEVENLABS_API_KEY, undefined);
});

test("legacy flat ai-config.json still names the vision key", () => {
  const dir = dataDir({ "ai-config.json": { provider: "anthropic", apiKey: VKEY } });
  const r = aiRoles(dir);
  assert.deepEqual(r.vision, { provider: "anthropic", apiKey: VKEY });
  assert.equal(r.fal, null);
  assert.equal(r.elevenlabs, null);
});

test("the role-keyed file is read as roles", () => {
  const dir = dataDir({ "ai-config.json": {
    vision: { provider: "openai", apiKey: VKEY }, fal: { apiKey: FKEY } } });
  const r = aiRoles(dir);
  assert.deepEqual(r.vision, { provider: "openai", apiKey: VKEY });
  assert.deepEqual(r.fal, { apiKey: FKEY });
});

test("a role key wins over a legacy field left beside it", () => {
  const dir = dataDir({ "ai-config.json": {
    provider: "google", apiKey: "stale-flat-key",
    vision: { provider: "anthropic", apiKey: VKEY } } });
  assert.deepEqual(aiRoles(dir).vision, { provider: "anthropic", apiKey: VKEY });
});

test("both files together fill both roles", () => {
  const dir = dataDir({
    "ai-config.json": { provider: "google", apiKey: VKEY },
    "tts-config.json": { apiKey: TKEY, voiceId: "EXAVITQu4vr4xnSDxMaL", keyOk: true } });
  const r = aiRoles(dir);
  assert.deepEqual(r.vision, { provider: "google", apiKey: VKEY });
  assert.deepEqual(r.elevenlabs, { apiKey: TKEY, voiceId: "EXAVITQu4vr4xnSDxMaL" });
});

test("an empty <DATA> is every role null, not a throw", () => {
  const dir = dataDir({});
  assert.deepEqual(aiRoles(dir), { vision: null, elevenlabs: null, fal: null });
});

test("an unreadable or half-written file is every role null", () => {
  const dir = dataDir({ "ai-config.json": "{ not json", "tts-config.json": "" });
  assert.deepEqual(aiRoles(dir), { vision: null, elevenlabs: null, fal: null });
});

test("an empty apiKey is no key", () => {
  const dir = dataDir({
    "ai-config.json": { provider: "google", apiKey: "   " },
    "tts-config.json": { apiKey: "", voiceId: "EXAVITQu4vr4xnSDxMaL" } });
  const r = aiRoles(dir);
  assert.equal(r.vision, null);
  assert.equal(r.elevenlabs, null);
});

test("an unknown vision provider falls back to google (clothing.js's rule)", () => {
  const dir = dataDir({ "ai-config.json": { provider: "mistral", apiKey: VKEY } });
  assert.deepEqual(aiRoles(dir).vision, { provider: "google", apiKey: VKEY });
  const dir2 = dataDir({ "ai-config.json": { vision: { apiKey: VKEY } } });
  assert.deepEqual(aiRoles(dir2).vision, { provider: "google", apiKey: VKEY });
});

test("a key ElevenLabs already rejected (keyOk false) is no key", () => {
  const dir = dataDir({ "tts-config.json": {
    apiKey: TKEY, voiceId: "EXAVITQu4vr4xnSDxMaL", keyOk: false,
    keyError: "ElevenLabs did not recognise that key" } });
  assert.equal(aiRoles(dir).elevenlabs, null);
});

test("a key not verified yet still counts (server.js's own enabled rule)", () => {
  const dir = dataDir({ "tts-config.json": { apiKey: TKEY } });
  const r = aiRoles(dir);
  assert.equal(r.elevenlabs.apiKey, TKEY);
  // no voice chosen yet -> the same default voice the Voice card shows first
  assert.equal(r.elevenlabs.voiceId, "cgSgspJ2msm6clMCkdW9");
});

test("ELEVENLABS_API_KEY in the environment fills the voice role", () => {
  const dir = dataDir({});
  const had = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = TKEY;
  try { assert.equal(aiRoles(dir).elevenlabs.apiKey, TKEY); }
  finally { if (had === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = had; }
});

test("fal is null until its card is filled in", () => {
  const dir = dataDir({ "ai-config.json": { vision: { provider: "google", apiKey: VKEY },
                                            fal: { apiKey: "" } } });
  assert.equal(aiRoles(dir).fal, null);
});

test("reading roles never writes: no fs write call in the module, no byte moved", () => {
  const src = fs.readFileSync(path.join(HUB, "ai-config.js"), "utf8");
  for (const forbidden of ["writeFileSync", "appendFileSync", "renameSync", "rmSync",
                           "unlinkSync", "mkdirSync", "createWriteStream"])
    assert.equal(src.includes(forbidden), false, "ai-config.js must not " + forbidden);

  const dir = dataDir({
    "ai-config.json": { provider: "google", apiKey: VKEY },
    "tts-config.json": { apiKey: TKEY, voiceId: "EXAVITQu4vr4xnSDxMaL" } });
  const before = fs.readdirSync(dir).sort().map(f =>
    [f, fs.readFileSync(path.join(dir, f), "utf8"), fs.statSync(path.join(dir, f)).mtimeMs]);
  aiRoles(dir); aiRoles(dir);
  const after = fs.readdirSync(dir).sort().map(f =>
    [f, fs.readFileSync(path.join(dir, f), "utf8"), fs.statSync(path.join(dir, f)).mtimeMs]);
  assert.deepEqual(after, before);
});

test("a key never reaches a log line or a thrown message", () => {
  const dir = dataDir({ "ai-config.json": "{ \"apiKey\": \"" + VKEY + "\" " });   // truncated
  const said = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => said.push(a.join(" "));
  try { aiRoles(dir); } finally { Object.assign(console, real); }
  assert.deepEqual(said, []);
});
