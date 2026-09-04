// content-publish.js — step 4, the last one a book must pass: the folder of
// photos becomes a package the reader can open (spec §4.4).
//
// Everything before this step is "get the words and the voice right"; this step
// is deterministic from what is already on disk. It writes ONE file —
// manifest.json — and copies one more (cover.jpg), and its whole job is to make
// sure that file is honest:
//
//  1. MANIFEST LAST, AND ATOMIC. Its presence IS the package (server.js's
//     booksIndex() skips a folder without one), so it is written through
//     content-store's writeAtomic — manifest.tmp then rename — after every
//     other byte is in place. Google Drive for Windows mirrors this folder to
//     the family's other devices while we work; a half-written manifest, or one
//     that lands before its media, is a shelf entry that opens onto a 404.
//  2. IT NEVER NAMES A FILE THAT IS NOT THERE. Every image, mp3 and mp4 is
//     stat'd on the way in. A page whose mp3 never landed (a Drive mirror still
//     catching up, a narration that failed) publishes SILENT — no `audio` key,
//     no `words` — which is a page the reader already knows how to show.
//  3. AN IMPERFECT BOOK STILL PUBLISHES. Flagged pages publish (ruling 9/4: a
//     small mistake is tolerable, a book that never appears is not) and their
//     flags stay in text.json for the review page. A page the transcriber never
//     reached publishes as a picture page rather than holding the whole book.
//     The only thing that stops a publish is having no pages at all.
//  4. EVERY PUBLISH BUMPS exportedAt. The reader cache-busts its media on it
//     (public/reader/reader.js:187), so a re-publish that kept the old stamp
//     would leave the family looking at yesterday's audio for 24 hours. The
//     book's `id` is the opposite: read back from the manifest we are replacing,
//     so a package keeps one identity for life.
//
// No network, no key, no clock beyond the one the caller passes. The narration
// credit (provider/model/voice) is read from .build/narration.json, which
// content-narrate.js writes as the record of what actually spoke — not from the
// Voice card, which the family may have changed since.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./content-store.js");
const { pagesOf } = require("./content-providers.js");
const { readNarration } = require("./content-narrate.js");
const { slugify } = require("./slug.js");

const MANIFEST = "manifest.json";
const COVER = "cover.jpg";
const SCHEMA_VERSION = 1;

function iso(now) {
  if (typeof now === "string") return now;                    // tests pin the clock
  return new Date(now == null ? Date.now() : now).toISOString();
}

// A file is only worth naming in the manifest if it is on disk AND has bytes:
// Drive mirrors a big mp4 as a zero-length placeholder first.
function present(dir, rel) {
  if (!rel) return false;
  try { return fs.statSync(path.join(dir, rel)).size > 0; } catch { return false; }
}

// The cover the reader's shelf shows. text.json marks it (page 1 by default,
// or whatever a parent chose on the review page); the manifest points at
// "cover.jpg" because that is the name booksIndex() falls back to and the name
// every hand-authored package in the family already uses. Copied, not linked:
// the shelf must survive a page being re-ingested underneath it.
// Re-copied only when the bytes actually differ, or every scan would hand Drive
// another megabyte to upload.
function writeCover(dir, pages, text) {
  const marked = text.find(t => t.cover);
  const page = (marked && pages.find(p => p.index === marked.index)) || pages[0];
  if (!page || !present(dir, page.image)) return null;
  const src = fs.readFileSync(path.join(dir, page.image));
  const dst = path.join(dir, COVER);
  try { if (fs.readFileSync(dst).equals(src)) return COVER; } catch {}
  store.writeAtomic(dst, src);
  return COVER;
}

// Who spoke, for the record. content-narrate.js stamps narration.json with the
// provider it used; a book narrated by an older hub (or never narrated at all)
// carries nulls rather than a claim we cannot back up.
function narrationOf(narration, anyAudio) {
  if (!anyAudio) return { provider: null, model: null, voice: null };
  return {
    provider: narration.provider || "elevenlabs",
    model: narration.model || null,
    voice: narration.voice || null,
  };
}

// publishBook(dir, opts) — write the package manifest for the book in `dir`.
//
//   opts.slug   the URL slug (content.js computed it from the folder name)
//   opts.title  the folder name as the parent typed it
//   opts.now    pinned clock for exportedAt
//
// Returns {published:true, pages:[…], silent, flagged, blank, exportedAt}, or
// {hold:"no-pages"} for a folder with nothing built in it yet — a hold keeps
// the claim and the state exactly where they are (content-worker.js), which is
// what a book whose photos have not been ingested yet needs.
function publishBook(dir, opts) {
  const o = opts || {};
  const title = o.title || path.basename(dir);
  const slug = o.slug || slugify(title) || "book";
  const exportedAt = iso(o.now);

  // pagesOf() is the same reader the transcriber uses: ingest's own record when
  // it is there, the pages/ directory itself when it is not (a folder built by
  // hand in power mode still publishes).
  const built = pagesOf(dir).filter(p => present(dir, p.image)).sort((a, b) => a.index - b.index);
  if (!built.length) {
    store.appendLog(dir, "publish", "no pages yet - nothing to publish", { now: o.now });
    return { hold: "no-pages", published: false, pages: [] };
  }

  const text = ((store.readText(dir) || { pages: [] }).pages) || [];
  const byIndex = new Map(text.map(t => [t.index, t]));
  const narration = readNarration(dir);
  const spoke = new Map(narration.pages.map(p => [p.index, p]));

  let silent = 0, flagged = 0, blank = 0;
  const pages = built.map((b) => {
    const t = byIndex.get(b.index);
    const page = { index: b.index, image: b.image, text: t ? t.text : "" };
    if (!t || !t.text.trim()) blank++;
    if (t && t.flags.length) flagged++;
    const said = spoke.get(b.index);
    // The mp3 has to BE there. A page listed in narration.json whose audio has
    // not mirrored yet is silent for now and gains its voice on the next
    // publish — far better than a reader that stalls on a 404.
    if (said && present(dir, said.audio)) {
      page.audio = said.audio;
      page.words = Array.isArray(said.words) ? said.words : [];
    } else silent++;
    const video = "video/" + String(b.index).padStart(3, "0") + ".mp4";
    if (present(dir, video)) page.video = video;
    return page;
  });

  const cover = writeCover(dir, built, text);
  const previous = store.readJson(path.join(dir, MANIFEST));
  const id = previous && typeof previous.id === "string" && previous.id
    ? previous.id : crypto.randomUUID();

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    id, slug, title, exportedAt,
    narration: narrationOf(narration, pages.some(p => p.audio)),
    // Omitted rather than guessed at: booksIndex() falls back to cover.jpg and
    // the reader shows its own "No cover" card, so a bad path helps nobody.
    ...(cover ? { cover } : {}),
    authored: false,      // built by the hub; `true` is reserved for the books written by hand
    pages,
  };
  // LAST. Every path above has been stat'd, and the cover is already beside it.
  store.writeAtomic(path.join(dir, MANIFEST), manifest);
  store.appendLog(dir, "publish", "published " + pages.length + " page(s)" +
    (silent ? ", " + silent + " silent" : "") + (blank ? ", " + blank + " with no text yet" : "") +
    (flagged ? ", " + flagged + " with flags to review" : ""), { now: o.now });

  return { published: true, slug, title, exportedAt, pages, silent, flagged, blank };
}

module.exports = { publishBook, writeCover, narrationOf, present, MANIFEST, COVER, SCHEMA_VERSION };
