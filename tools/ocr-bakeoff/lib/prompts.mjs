// Prompts for the OCR bake-off. Versioned: bump PROMPT_VERSION whenever the text
// changes, because the per-call cache key includes it (old results stay valid for
// the version they were produced under).
//
// These prompts implement the "Transcription policy" section of
// Book-Reader/docs/book-ingest-policies.md (rules 1-6 plus the low-confidence flag
// rule) so that every candidate is asked for exactly the conventions the ground
// truth was written under. They must NEVER contain ground-truth text.

// Changelog
//   v1  2026-09-04  first version.
//   v2  2026-09-04  rule 6 pins the reading order of COVER pages: strictly top to
//                   bottom as printed, which is the convention the ground truth was
//                   actually written under (on most of these covers the author and
//                   illustrator are printed ABOVE the title, and the reference keeps
//                   them there). Verified against the reference covers, not assumed -
//                   an earlier draft of this rule said "title first" and made seven
//                   models agree with each other and disagree with the reference on the
//                   same cover. v1 left cover order to
//                   "narrative flow", which a title page does not have, so two models
//                   could both transcribe a cover perfectly and score WER ~0.9 against
//                   the reference purely by reading the byline first. With 8 covers in
//                   120 pages that alone put a ~0.012 floor under the corpus micro-WER,
//                   twelve times the acceptance target. Scoring now ALSO reports an
//                   order-insensitive bag-of-words WER, so the two effects stay
//                   separable rather than one hiding the other.
//   v3  2026-09-04  two rules changed, everything else (including OUTPUT_CONTRACT)
//                   byte-identical to v2.
//                   Rule 5: v2's "drop illustration lettering" over-fired. On one page
//                   the story's punchline is painted into the picture as a character's
//                   trail of words, and every model dropped it as art while the
//                   reference (rightly) keeps it. Lettering a character writes, reads,
//                   holds up or paints IS story text and is transcribed in reading
//                   order. Publisher furniture is now named explicitly - running heads,
//                   page numbers, ISBN/barcode, imprint lines, price stickers - because
//                   several models narrated a publisher imprint printed on a cover.
//                   The drop clause names boat hulls only: an earlier draft of this
//                   rule dropped "signs" one sentence before the keep clause names a
//                   sign as story lettering, and "decorative" cannot be left to
//                   disambiguate a word against an explicit counter-example in the same
//                   rule. Fixed before any v3 call was billed - the cache held v1 and
//                   v2 only - so no cached result was invalidated.
//                   Rule 6: our copies of these books carry a handwritten gift
//                   inscription and a name sticker on the cover. They are not part of
//                   the book, the models correctly ignored them, and the reference
//                   wrongly contained them; the reference is amended (see the private
//                   dataset's amendments.json) and the prompt now says so.
//                   v2 IS STILL EXPORTED, as POLICY_V2 / transcribePromptV2(), because
//                   the decision the bake-off reached runs the pair asymmetrically and
//                   era-hub's book transcriber pins its first pass to v2 (see below).
//                   It is a second exported wording, not a second version: the cache
//                   key, and what this harness itself sends, stay v3.
export const PROMPT_VERSION = 'v3';

const POLICY = `You are transcribing one photographed page of a printed children's picture book so it can be read aloud by a speech synthesiser. A single wrong word is a failure. Follow these rules exactly.

1. VERBATIM PRINTED TEXT ONLY. Transcribe the words exactly as printed. Never modernise, localise or correct spelling (British spelling stays British). Never add, expand or paraphrase words that are not printed. Do not translate.
2. READING ORDER follows the visual and narrative flow of the page, not raw top-to-bottom geometry. For rhyming verse use rhyme and metre as an ordering signal across columns, panels and speech bubbles, so the text reads coherently start to finish.
3. ELLIPSES: render any printed ellipsis, including a spaced ". . .", as three dots "...". Keep leading or trailing ellipses that are used as page-turn continuations.
4. QUOTES: transcribe quotation marks exactly as printed, even when they are unbalanced on this page (a speech may continue across pages).
5. JUNK REMOVAL: drop text that belongs to the illustration rather than the story - decorative lettering painted on objects such as boat hulls, barcodes, printed page numbers, publisher furniture, and misread glyphs (for example a stray "99" that is really a quotation mark). BUT lettering that is PART OF THE STORY is story text and MUST be transcribed, in its place in reading order, even when it is hand-lettered or drawn into the art: words a character writes, reads, holds up or paints - a sign, a blackboard, a banner, a letter shown to the reader. If the words carry the story's meaning, they belong in "text". Publisher furniture is still dropped, always: running heads (the title or chapter repeated in the margin or the art), printed page numbers, ISBN and barcode lines, imprint, publisher and printer lines, and price stickers.
6. COVERS: if this page is a cover, transcribe the printed title, author and illustrator with the casing exactly as printed. Do not invent a byline that is not printed. ORDER ON A COVER IS FIXED, because a cover has no narrative flow: transcribe the printed blocks strictly TOP TO BOTTOM in the order they appear on the page. On many picture books the author and illustrator names are printed ABOVE the title - when they are, they come first. Do not promote the title to the front, and do not group the names with a byline at the end. Anything added to this particular copy is NOT part of the book and must be ignored entirely: handwritten inscriptions, gift dedications, an owner's name written or printed on a label, library stamps, and stickers of any kind. Only text PRINTED as part of the cover is transcribed, top to bottom as printed.
7. If the page has no printed story text at all (a full-bleed illustration, an endpaper), return an empty string for "text".
8. LINE AND STANZA BREAKS: use a single newline between printed lines of verse and a blank line between stanzas or separate text blocks. Do not re-wrap prose.
9. FLAG, DO NOT GUESS: list in "uncertain" every word you are not fully confident about (obscured, blurred, cut off, or ambiguous). Still put your best reading in "text"; the list is for human review.`;

// v2, VERBATIM, because it is still being sent. The bake-off measured its winning
// pair asymmetrically - the transcriber (gemini-3.1-flash-lite) under v2, its
// decorrelating partner (gemini-3.5-flash-lite) under v3 - so era-hub's
// content-providers.js pins its transcribe pass to THIS string and asserts it
// against this file byte for byte. v3 is not an upgrade, it is a trade (README:
// 3.1 reads better under v2, 3.5 under v3), so exporting v2 is not keeping a
// museum piece: it is keeping the wording the 89.2% row was measured under.
// PROMPT_VERSION stays 'v3' - it stamps the cache key for what the HARNESS sends,
// which is transcribePrompt(), and restamping it would invalidate real records.
// Copied from the 06:33 worktree snapshot it was recovered from, never retyped.
const POLICY_V2 = `You are transcribing one photographed page of a printed children's picture book so it can be read aloud by a speech synthesiser. A single wrong word is a failure. Follow these rules exactly.

1. VERBATIM PRINTED TEXT ONLY. Transcribe the words exactly as printed. Never modernise, localise or correct spelling (British spelling stays British). Never add, expand or paraphrase words that are not printed. Do not translate.
2. READING ORDER follows the visual and narrative flow of the page, not raw top-to-bottom geometry. For rhyming verse use rhyme and metre as an ordering signal across columns, panels and speech bubbles, so the text reads coherently start to finish.
3. ELLIPSES: render any printed ellipsis, including a spaced ". . .", as three dots "...". Keep leading or trailing ellipses that are used as page-turn continuations.
4. QUOTES: transcribe quotation marks exactly as printed, even when they are unbalanced on this page (a speech may continue across pages).
5. JUNK REMOVAL: drop text that belongs to the illustration rather than the story - lettering painted on objects such as boat hulls or signs, barcodes, printed page numbers, publisher furniture, and misread glyphs (for example a stray "99" that is really a quotation mark).
6. COVERS: if this page is a cover, transcribe the printed title, author and illustrator with the casing exactly as printed. Do not invent a byline that is not printed. ORDER ON A COVER IS FIXED, because a cover has no narrative flow: transcribe the printed blocks strictly TOP TO BOTTOM in the order they appear on the page. On many picture books the author and illustrator names are printed ABOVE the title - when they are, they come first. Do not promote the title to the front, and do not group the names with a byline at the end.
7. If the page has no printed story text at all (a full-bleed illustration, an endpaper), return an empty string for "text".
8. LINE AND STANZA BREAKS: use a single newline between printed lines of verse and a blank line between stanzas or separate text blocks. Do not re-wrap prose.
9. FLAG, DO NOT GUESS: list in "uncertain" every word you are not fully confident about (obscured, blurred, cut off, or ambiguous). Still put your best reading in "text"; the list is for human review.`;

const OUTPUT_CONTRACT = `Reply with a single JSON object and nothing else - no prose, no markdown code fence:
{"text": "<the full page transcription>", "uncertain": ["<word>", ...]}
Use "uncertain": [] when you are confident about every word.`;

export function transcribePrompt() {
  return `${POLICY}\n\n${OUTPUT_CONTRACT}`;
}

export function transcribePromptV2() {
  return `${POLICY_V2}\n\n${OUTPUT_CONTRACT}`;
}

export function reviewPrompt(draft) {
  return `You are an ADVERSARIAL VERIFIER checking someone else's transcription of the attached photographed page of a printed children's picture book. Assume at least one error exists: a wrong word, a wrong reading order, a dropped line, an invented word, or punctuation that does not match the print. Examine every line of the image and prove each word right or wrong against the image, not against what sounds plausible.

The transcription conventions that the draft was supposed to follow are:

${POLICY}

DRAFT TRANSCRIPTION UNDER REVIEW (may contain errors):
<<<DRAFT
${draft}
DRAFT

Return the CORRECTED FULL page text - not a diff, not a list of comments - plus every word you remain unsure about.

${OUTPUT_CONTRACT}`;
}

export default { PROMPT_VERSION, transcribePrompt, transcribePromptV2, reviewPrompt };
