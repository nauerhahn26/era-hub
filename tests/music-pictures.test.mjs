import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { planFrames, cropFrame, safeSelection, storyboardUrl } = require("../music-pictures.js");
const { collect, buildPictures } = require("../music-pictures.js");
const { encodeJpg, decodeJpg } = require("../image-util.js");

test("storyboard decoding follows the bytes when a jpg address returns WebP", async () => {
  const { decodeSheet } = require("../music-pictures.js");
  const fixture = fs.readFileSync(new URL("./fixtures/music-storyboard.webp", import.meta.url));
  const sheet = await decodeSheet(fixture);
  assert.equal(sheet.width, 200);
  assert.equal(sheet.height, 20);
  assert.ok(sheet.data[1] > 230, "first frame is green");
  assert.ok(sheet.data[(199 * 4)] > 190, "last frame is red");
  await assert.rejects(decodeSheet(Buffer.from("not an image")));
});

test("storyboards sample the whole video, choose the largest frames, and skip padding", () => {
  const info = { duration: 100, formats: [
    { protocol: "mhtml", width: 2, height: 2, rows: 2, columns: 2, fps: 0.1,
      fragments: [{ url: "https://i.ytimg.com/sb/a/0.jpg" }, { url: "https://i.ytimg.com/sb/a/1.jpg" }, { url: "https://i.ytimg.com/sb/a/2.jpg" }] },
    { protocol: "mhtml", width: 1, height: 1, rows: 2, columns: 2, fps: 0.1, fragments: [{ url: "x" }] },
  ] };
  const plan = planFrames(info);
  assert.equal(plan.length, 10);
  assert.equal(plan[0].width, 2);
  assert.equal(plan.at(-1).cell, 1, "last sheet has only two real frames");
  assert.match(plan.at(-1).url, /2.jpg$/);
  assert.deepEqual(planFrames({ formats: [] }), []);
  assert.deepEqual(planFrames({ ...info, duration: 0 }), []);
});

test("crop takes the intended cell without adjacent frames", () => {
  const data = Buffer.alloc(4 * 2 * 4);
  for (let i = 0; i < 8; i++) data.fill(i, i * 4, i * 4 + 4);
  const out = cropFrame({ data, width: 4, height: 2 }, { width: 2, height: 1, columns: 2, cell: 3 });
  assert.equal(out.width, 2);
  assert.deepEqual([...out.data], [...data.subarray(24, 32)]);
  assert.throws(() => cropFrame({ data, width: 4, height: 2 }, { width: 2, height: 1, columns: 2, cell: 4 }));
});

test("screening requires ten distinct explicit approvals, rejects uncertain or malformed answers", () => {
  const approved = { text: "1,2,3,4,5,6,7,8,9,10", uncertain: [], parseError: false };
  assert.deepEqual(safeSelection(approved, 12), [0,1,2,3,4,5,6,7,8,9]);
  for (const reply of [null, { ...approved, parseError: true }, { ...approved, uncertain: ["3"] },
    { ...approved, text: "1,2" }, { ...approved, text: "1,1,2,3,4,5,6,7,8,9" },
    { ...approved, text: "1,2,3,4,5,6,7,8,9,30" }, { ...approved, text: "safe: 1,2,3,4,5,6,7,8,9,10" }])
    assert.deepEqual(safeSelection(reply, 12), []);
});

test("frame fetches allow only the video image CDN with no credentials or alternate ports", () => {
  assert.equal(storyboardUrl("https://i.ytimg.com/sb/example/0.jpg?sigh=test"), true);
  for (const url of ["http://i.ytimg.com/x", "https://i.ytimg.com.evil.invalid/x", "https://user@i.ytimg.com/x",
    "https://i.ytimg.com:444/x", "https://localhost/x", "file:///x", "bad"])
    assert.equal(storyboardUrl(url), false, url);
});

test("picture pipeline saves ten distinct screened frames, and keeps unapproved frames off disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-pictures-"));
  try {
    const data = Buffer.alloc(200 * 20 * 4);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 200; x++) {
      const at = (y * 200 + x) * 4, cell = Math.floor(x / 20);
      data[at] = cell * 24; data[at + 1] = 255 - cell * 20; data[at + 2] = cell * 10; data[at + 3] = 255;
    }
    const sheet = encodeJpg({ data, width: 200, height: 20 });
    const info = { duration: 10, formats: [{ protocol: "mhtml", width: 20, height: 20, fps: 1,
      rows: 1, columns: 10, fragments: [{ url: "https://i.ytimg.com/sb/example/0.jpg" }] }] };
    let screened = 0;
    const options = { info, dir, slug: "test-song", cfg: { apiKey: "test-key" } };
    const deps = { sheetBytes: async () => sheet, screen: async o => {
      screened++;
      assert.ok(fs.existsSync(o.imagePath));
      assert.match(o.policy, /six-year-old/);
      return { text: "1,2,3,4,5,6,7,8,9,10", uncertain: [], parseError: false };
    } };
    const result = await collect(options, deps);
    assert.equal(screened, 1);
    assert.equal(result.pictureStatus, "ready");
    assert.equal(result.pictures.length, 10);
    for (const name of result.pictures) {
      assert.match(name, /^test-song-frame-[a-f0-9]{16}-\d\d\.jpg$/);
      assert.equal(decodeJpg(fs.readFileSync(path.join(dir, name))).width, 20);
    }
    assert.equal(fs.readdirSync(dir).length, 10, "temporary contact sheet removed");
    const denied = await collect(options, { ...deps, screen: async () => ({ text: "1,2", uncertain: [] }) });
    assert.equal(denied.pictureStatus, "needs-review");
    assert.equal(fs.readdirSync(dir).length, 10, "no unapproved pictures published");
    await assert.rejects(collect(options, { ...deps, screen: async () => { throw new Error("offline"); } }));
    assert.equal(fs.readdirSync(dir).length, 10);
    const noKey = await buildPictures({ ...options, cfg: null });
    assert.equal(noKey.pictureStatus, "needs-helper", "installed worker degrades cleanly without a key");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
