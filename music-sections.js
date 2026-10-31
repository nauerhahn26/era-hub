// music-sections.js — which songs sit in which section of the songs board's
// rail, in what order (spec 2026-10-31 "Sections"). Pure: no fs, no clock.
//
//   Favorites  songs with a score above zero   score, high first
//   New        every song                       added time, newest first
//   Top hits   category "top-hits"              score
//   Disney     category "disney"                score
//   All        every song                       score
//
// Score ties break newest added first, then the old manifest `rank`, then the
// id, so two builds of the same inputs always give the same order. A song with
// no category is in Favorites (once played), New and All only.
"use strict";

const SECTIONS = [
  { key: "fav", label: "Favorites", say: "favorites" },
  { key: "new", label: "New", say: "new songs" },
  { key: "top-hits", label: "Top hits", say: "top hits" },
  { key: "disney", label: "Disney", say: "disney" },
  { key: "all", label: "All", say: "all songs" },
];
const CATEGORIES = ["top-hits", "disney"];

// songs: [{id, rank, addedMs, category}], scores: Map id -> number.
// -> {fav, new, "top-hits", disney, all}: arrays of ids.
function sectionOrders(songs, scores) {
  const list = Array.isArray(songs) ? songs.filter(s => s && typeof s.id === "string") : [];
  const score = (s) => (scores instanceof Map && Number(scores.get(s.id))) || 0;
  const added = (s) => Number(s.addedMs) || 0;
  const rank = (s) => Number(s.rank) || 0;
  const tail = (a, b) => (added(b) - added(a)) || (rank(a) - rank(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byScore = (a, b) => (score(b) - score(a)) || tail(a, b);
  const ids = (arr) => arr.map(s => s.id);
  const all = list.slice().sort(byScore);
  return {
    fav: ids(all.filter(s => score(s) > 0)),
    new: ids(list.slice().sort(tail)),
    "top-hits": ids(all.filter(s => s.category === "top-hits")),
    disney: ids(all.filter(s => s.category === "disney")),
    all: ids(all),
  };
}

module.exports = { SECTIONS, CATEGORIES, sectionOrders };
