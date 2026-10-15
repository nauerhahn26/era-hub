// device-id.test.mjs — one stable name per install (spec §5 "Device id").
//
// Until now DEVICE_ID defaulted to the literal "hub", so two devices in one
// family wrote the pool's events into the SAME file — and the clothing log
// (§5) is laid out the same way, one writer per file. Two hubs called "hub"
// sharing `picks/hub/<date>.jsonl` is exactly the concurrent-writer bug the
// whole dot-folder design exists to avoid.
//
// The id is resolved once, at boot, in this precedence (plan I25):
//   ERA_DEVICE_ID  >  profile.deviceId  >  <DATA>/device-id  >  generate once
// and it is always a slug: /^[a-z0-9-]{1,32}$/. Nothing here ever prints the
// real machine's hostname — every case injects a fixture one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { resolveDeviceId } = require("./device-id.js");

const ID = /^[a-z0-9-]{1,32}$/;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "era-devid-"));
// A made-up machine name, never this box's. The hostname is the one input that
// could carry a family's own words into a log line, so every case names it.
const HOST = "Family-PC.local";

test("ERA_DEVICE_ID wins over everything else, and writes no file", () => {
  const DATA = tmp();
  const id = resolveDeviceId(DATA, { env: { ERA_DEVICE_ID: "test-dev" },
    profile: { deviceId: "from-profile" }, hostname: HOST });
  assert.equal(id, "test-dev");
  assert.ok(!fs.existsSync(path.join(DATA, "device-id")),
    "an id that was GIVEN is not stored — the giver is the source of truth");
});

test("profile.deviceId beats the stored file", () => {
  const DATA = tmp();
  fs.writeFileSync(path.join(DATA, "device-id"), "on-disk-id\n");
  const id = resolveDeviceId(DATA, { env: {}, profile: { deviceId: "from-profile" }, hostname: HOST });
  assert.equal(id, "from-profile");
});

test("the stored file is used when nothing else says otherwise", () => {
  const DATA = tmp();
  fs.writeFileSync(path.join(DATA, "device-id"), "kitchen-pc-1a2b\n");
  assert.equal(resolveDeviceId(DATA, { env: {}, profile: {}, hostname: HOST }), "kitchen-pc-1a2b");
});

// The file is the install's identity: generated ONCE. If a second boot made a
// new one, yesterday's picks would be another device's as far as the merge
// reader is concerned, and the own-id skip (§5) would stop skipping them.
test("a generated id is created once and never re-rolled", () => {
  const DATA = tmp();
  const first = resolveDeviceId(DATA, { env: {}, profile: {}, hostname: HOST });
  assert.match(first, ID, "the generated id is a slug");
  assert.match(first, /^family-pc-local-[0-9a-f]{4}$/, "<hostname-slug>-<4 hex> (spec §5)");
  const file = path.join(DATA, "device-id");
  const mtime = fs.statSync(file).mtimeMs;
  const second = resolveDeviceId(DATA, { env: {}, profile: {}, hostname: HOST });
  assert.equal(second, first, "the second boot answers the same name");
  assert.equal(fs.statSync(file).mtimeMs, mtime, "…without touching the file at all");
});

test("a stored id that is not a slug is replaced, not honoured", () => {
  const DATA = tmp();
  const file = path.join(DATA, "device-id");
  fs.writeFileSync(file, "HUB!!");
  const id = resolveDeviceId(DATA, { env: {}, profile: {}, hostname: HOST });
  assert.match(id, ID, "the id handed out is always a slug");
  assert.notEqual(id, "HUB!!");
  assert.equal(fs.readFileSync(file, "utf8").trim(), id, "and the bad file was rewritten");
});

// A data dir the hub cannot write is a real family state (a locked profile, a
// read-only volume). It must not throw — and it must not answer a DIFFERENT
// name every boot either, or every day of picks looks like a new device.
test("a data dir that cannot be written still answers, deterministically", {
  skip: process.getuid && process.getuid() === 0 ? "root writes every directory" : false,
}, () => {
  const DATA = tmp();
  fs.chmodSync(DATA, 0o500);
  try {
    const a = resolveDeviceId(DATA, { env: {}, profile: {}, hostname: HOST });
    const b = resolveDeviceId(DATA, { env: {}, profile: {}, hostname: HOST });
    assert.equal(a, "family-pc-local", "the hostname slug alone, no hex to remember");
    assert.equal(b, a, "the same name on the next boot");
    assert.match(a, ID);
  } finally { fs.chmodSync(DATA, 0o700); }
});

// Whatever a family names a computer, the id has to be a slug: it becomes a
// DIRECTORY NAME under the shared dot-folder (`picks/<device-id>/`).
test("a hostname is slugged, capped at 32, and never empty", () => {
  const DATA = tmp();
  const long = resolveDeviceId(DATA, { env: {}, profile: {},
    hostname: "A Very Long Family Computer Name In The Kitchen" });
  assert.match(long, ID, "capped to the slug rule");
  assert.ok(long.length <= 32);
  assert.match(long, /-[0-9a-f]{4}$/, "the random tail survives the cut");
  const odd = resolveDeviceId(tmp(), { env: {}, profile: {}, hostname: "!!!" });
  assert.match(odd, ID, "a hostname with nothing slug-able still yields an id");
});

// A value handed in through the env or the profile is slugged too — the pool
// and the log both use it as a path segment.
test("a given id is slugged rather than trusted", () => {
  const DATA = tmp();
  assert.equal(resolveDeviceId(DATA, { env: { ERA_DEVICE_ID: "Kitchen PC" }, profile: {}, hostname: HOST }),
    "kitchen-pc");
  assert.equal(resolveDeviceId(DATA, { env: { ERA_DEVICE_ID: "  " }, profile: { deviceId: "Den" }, hostname: HOST }),
    "den", "an empty env value falls through to the profile");
});
