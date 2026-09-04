// content-imprint.test.mjs — the publisher furniture a reader must never read
// aloud (E5, 9/4).
//
// PORTS: none. content-imprint.js is a pure function over a string — no
// network, no disk, no clock — so this suite stands up nothing and spends
// nothing. The WIRING of it into the transcribe step (both readings, before the
// agreement comparison, before storing) is asserted in
// content-transcribe.test.mjs against that suite's stand-in provider, and the
// empty page it can produce is asserted against the narrate stand-in in
// content-narrate.test.mjs.
//
// EVERY LINE IN HERE IS INVENTED. No page of a real book, no real publisher, no
// real ISBN and no family name goes into this repo: the fake book is "The
// Bramblewick Bus", its fake publisher is "Puddleduck Press", and the fake town
// is Fakebury. The patterns are what matters, never the words.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const imprint = require(path.join(HUB, "content-imprint.js"));

// ------------------------------------------------------- what comes off a page

// The shapes the bake-off watched Gemini narrate off a cover or a title page,
// under every prompt it was asked: a reader would say all of these out loud.
const FURNITURE = [
  "© 2019 Ada Bramblewick",
  "(c) 2019 Puddleduck Press",
  "Copyright 2019 Puddleduck Press",
  "Text copyright © 2019 Ada Bramblewick",
  "Illustrations copyright © 2019 Bo Thistledown",
  "ISBN 978-1-00000-000-0",
  "All rights reserved.",
  "All rights reserved. No part of this book may be reproduced.",
  "Printed in Wobblonia.",
  "Printed and bound in Wobblonia by Tinkerbolt Printers.",
  "First published in Wobblonia in 2019 by Puddleduck Press.",
  "Published by Puddleduck Press.",
  "This edition published 2021 by Puddleduck Press.",
  "www.puddleduckpress.example",
  "https://puddleduckpress.example/thebramblewickbus",
  "A CIP catalogue record for this book is available from the National Library.",
  "A CIP catalog record for this book is available.",
  "Puddleduck Press Ltd, 12 Marigold Lane, Fakebury, FK1 2ZZ",
  "Thistledown Books Limited, 4 Gable Row, Fakebury",
  "Puddleduck Press Inc., 900 Sixth Street, Fakebury",
  "2019",
  "2019.",
  "FSC C000000",
];

// A story line that happens to CONTAIN an imprint word. Every one of these is a
// sentence a child is meant to hear, and losing one is worse than reading a
// copyright line aloud: the page would go silent in the middle.
const STORY = [
  "The bus published a great grey cloud of steam and rolled away.",
  "In 2019 the bramble bush grew right over the garden gate.",
  "Their footprints were printed in the soft grey mud.",
  "Bo counted three buses, four bees and one very cross goose.",
  "Ada was printing her name in wobbly letters.",
  "The end.",
  "Chapter 3",
  "3 buses",
  "It was 1902, and the bus was already old.",
  "\"Reserved!\" said the goose, and sat down on the seat.",
];

test("every line of publisher furniture is recognised", () => {
  for (const line of FURNITURE)
    assert.equal(imprint.isImprintLine(line), true, "should be imprint: " + line);
});

test("a story line is never mistaken for furniture", () => {
  for (const line of STORY)
    assert.equal(imprint.isImprintLine(line), false, "should be story: " + line);
});

test("'published' and a year inside a sentence are story, not imprint", () => {
  const page = "The bus published a great grey cloud of steam.\nIn 2019 it was painted red.";
  const r = imprint.strip(page);
  assert.equal(r.removed, 0);
  assert.equal(r.text, page);
});

// ------------------------------------------------------------- the short lines

test("a short line that is only a year or only a code is furniture", () => {
  assert.equal(imprint.isImprintLine("2019"), true);
  assert.equal(imprint.isImprintLine("978-1-00000-000-0"), true);
  assert.equal(imprint.isImprintLine("FSC C000000"), true);
});

test("a short line with no digits in it is left alone", () => {
  assert.equal(imprint.isImprintLine("The end."), false);
  assert.equal(imprint.isImprintLine("Goodnight."), false);
  assert.equal(imprint.isImprintLine("Ada"), false);
});

// ----------------------------------------------------------------- the page

test("furniture comes out of a page and the story stays, in its own order", () => {
  const page = [
    "The Bramblewick Bus",
    "Ada Bramblewick",
    "First published in Wobblonia in 2019 by Puddleduck Press.",
    "Text copyright © 2019 Ada Bramblewick",
    "All rights reserved.",
    "ISBN 978-1-00000-000-0",
    "The bus was old, and it was red.",
  ].join("\n");
  const r = imprint.strip(page);
  assert.equal(r.removed, 4);
  assert.equal(r.text, "The Bramblewick Bus\nAda Bramblewick\nThe bus was old, and it was red.");
});

test("a page that is nothing but furniture becomes an empty page", () => {
  const page = [
    "Puddleduck Press Ltd, 12 Marigold Lane, Fakebury, FK1 2ZZ",
    "First published in Wobblonia in 2019 by Puddleduck Press.",
    "Text copyright © 2019 Ada Bramblewick",
    "All rights reserved.",
    "www.puddleduckpress.example",
    "ISBN 978-1-00000-000-0",
    "2019",
  ].join("\n");
  const r = imprint.strip(page);
  assert.equal(r.removed, 7);
  assert.equal(r.text, "", "an imprint-only page has nothing left to read aloud");
});

test("the hole a removed line leaves does not become a paragraph break", () => {
  const page = "The bus was red.\n\n© 2019 Puddleduck Press\n\nThe bus was old.";
  const r = imprint.strip(page);
  assert.equal(r.removed, 1);
  assert.equal(r.text, "The bus was red.\n\nThe bus was old.");
});

test("a page with no furniture on it comes back byte for byte", () => {
  const page = "The bus was old, and it was red.\nAda climbed aboard.";
  const r = imprint.strip(page);
  assert.equal(r.removed, 0);
  assert.equal(r.text, page);
});

test("nothing in, nothing out — never a throw", () => {
  for (const v of [null, undefined, "", "   \n  \n"]) {
    const r = imprint.strip(v);
    assert.equal(r.text, "");
    assert.equal(r.removed, 0);
  }
});

test("blank lines are not counted as lines removed", () => {
  const r = imprint.strip("\n\n© 2019 Puddleduck Press\n\n");
  assert.equal(r.removed, 1);
  assert.equal(r.text, "");
});

// A line's leading spaces are the OCR's, not the page's: a copyright line
// indented under a title is the same copyright line.
test("indentation does not hide a line from the stripper", () => {
  assert.equal(imprint.isImprintLine("    All rights reserved."), true);
  assert.equal(imprint.isImprintLine("\tISBN 978-1-00000-000-0"), true);
});
