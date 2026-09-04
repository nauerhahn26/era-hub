// slug.js - one slugify, shared by the shelf and the content builder.
//
// The book builder builds IN PLACE inside the family's Drive content folder,
// so a package's directory is whatever a parent typed on the phone ("Tabby
// McTat", "Cafe Nino - Book 2!"). The board, the reader and the hub address a
// package by a URL slug. If the index and the builder ever derived that slug
// differently the shelf would link to a 404, so both sides call THIS function
// and nothing else (server.js booksIndex/serveBook today, content-worker.js
// next). Parity is proven in tests/books.test.mjs.
//
// Deliberately dumb: ASCII letters and digits survive, everything else becomes
// one dash, and the result is a fixed point (slugify(slugify(x)) === slugify(x))
// so a folder a parent already named in slug form is untouched.

// 64 chars matches the movies-catalog id rule (server.js moviesRecipe), so a
// slug is safe to reuse as an id anywhere in the suite.
const MAX = 64;

function slugify(name) {
  let s = String(name == null ? "" : name)
    // "Cafe" + combining acute -> drop the mark, keep the letter. Without this
    // every accented title would collapse to a dash run.
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // apostrophes close up ("Ellie's" -> ellies) instead of splitting a word
    .replace(/['\u2018\u2019\u02bc]/g, "")
    .replace(/[^a-z0-9]+/g, "-");
  if (s.length > MAX) s = s.slice(0, MAX);
  return s.replace(/^-+|-+$/g, "");   // after the cut, so a truncation never leaves a dash
}

module.exports = { slugify, MAX_SLUG: MAX };
