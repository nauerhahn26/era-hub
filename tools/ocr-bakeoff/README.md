# OCR bake-off — which vision API should the Book Reader call?

The Book Reader narrates photographed children's picture books. A single wrong word in
narration is a family-facing failure: it needs the page's audio and word-alignment
regenerated, and in the meantime the child hears the wrong story. So the in-app book
builder's transcription step has to be **~99.9% word-accurate**, and the choice of vision
API has to be a measurement, not a preference.

This directory is the measuring instrument. It is deliberately boring: Node 18+ standard
library only, no npm dependencies, every API call cached on disk so a re-run never
re-bills, every number reproducible from the cache.

**Decision order: accuracy first, then cost, then latency, then key-friction.**
Key-friction matters because families bring their own keys — a model that needs a billed
Google Cloud project is worse for us than a slightly weaker model that works on the free
API key a parent can make in two minutes.

---

## What is public and what is private

| | |
|---|---|
| **This directory** (`era-hub/tools/ocr-bakeoff/`, PUBLIC repo) | code, prompts, candidate table, prices, tests. **No page text, no images, no ground truth, no keys, no family names — ever.** |
| **The dataset + results** (`era-family/data/ocr-bakeoff/`, private, gitignored) | `dataset.json` (with ground-truth text), downscaled images, the per-call cache, `results/*/report.md`. Never `git add` it. |

`report.md` is generated **into the private results directory** and quotes page text (it
has to, for the "possible ground-truth errors" section). Do not copy it into this repo.
If you need to share a conclusion publicly, quote the numbers, not the text.

---

## The dataset

120 pages across 8 photographed picture books (16, 16, 16, 16, 16, 13, 17 and 10 pages).
**Eleven of the 120 have deliberately empty ground truth**, and they are the phantom-text
canaries: a model that invents a caption there is telling you something important.
One is a full-bleed illustration page with no printed words. The other ten are the
authored book whose photographed images genuinely carry no text (see the row-join defect
below); `amendments.json` in the private dataset sets their references to empty, with a
reason each, rather than leaving ten pages of words nobody can read from the image.

Those pages are **excluded from every WER/CER rate, the two perfect-page rates included**,
and reported only as *phantom pages / phantom words* and as the clean-canary count. An
empty reference has no denominator, so folding its insertions into a micro rate would let
one page swamp the corpus: 119 word-perfect pages plus one 20-word invented caption used
to report a loose micro-WER of 0.0042 — four times the acceptance target — with zero real
word errors, while macro called the same page 1.0. Perfect-page % used to be the one
exception, on the grounds that a model which correctly returns nothing has earned the
credit and the effect was bounded at one page in 120. At eleven in 120 it was not: it
moved a candidate's perfect(l) by up to 6.5 pp for producing nothing, and perfect-page
rate is a stated acceptance criterion. Every rate now describes exactly the same set of
pages — the leaderboard prints `pages` (answered), `scored` and `empty-ref` side by side
so the two can never be read as one number again.

Every page exists in three **conditions**, so we can find out how much image preparation
the shipped app actually needs to do:

| condition | what it is |
|---|---|
| `raw` | the original camera JPEG, straight off the phone (~5712×4284 or 3024×4032, 2–6 MB) |
| `raw2048` | `raw` downscaled to a 2048px long edge, JPEG q≈85 (built by this tool with ffmpeg) |
| `processed` | the manually cropped and deskewed 2400px image the current pipeline produces |

`raw` and `processed` are referenced **by absolute path** — the 500 MB original set is
never copied. Only the `raw2048` variants are materialised (~53 MB for 120 pages).

### Ground truth provenance

The reference text was produced by the pipeline described in
`Book-Reader/docs/book-ingest-policies.md`: Google Vision `documentTextDetection`, then a
blind Claude cleanup pass, then an **adversarial verification pass** (a fresh-context
agent instructed to assume at least one error exists and to prove every word against the
image at maximum zoom), plus the reading-order coherence check added 2026-07-05. A page's
text is frozen only after it passes with zero unresolved discrepancies.

That makes the ground truth good, not infallible — which is why `score` computes a
**possible ground-truth errors** list (see below) and the report tells you to work
through it before believing any sub-0.001 WER.

### Reference amendments

That "good, not infallible" is not hypothetical: the first full grid's suspects list
found a word transposition, a UK/US spelling the printed page settles, cover text that
belonged to *our copy* rather than to the book, and ten rows whose images carry no
printed words at all. Corrections like these must be **reviewable**, so they do not go
into `dataset.json` — that file is regenerated by `build-dataset`, and nobody reads a
120-page JSON diff. They go into a separate file that is re-applied on every load:

```
<dataset>/amendments.json
{
  "note": "<why this file exists>",
  "pages": {
    "<pageId>": { "gt": "<replacement reference text, may be empty>", "reason": "<short>" }
  }
}
```

* `loadDataset` applies it, so **every** command (`run`, `score`, `probe-quota`) sees
  the amended reference — there is no path that reads the raw file.
* Applying = replace `gt`, recompute `gtChars`/`gtWords` with the same helper
  `build-dataset` uses, set `page.amended = true`, and re-derive `emptyGtPages`.
* An **empty** replacement is meaningful, not a deletion. The page keeps its images and
  becomes another phantom-text canary: no reference words, so it is excluded from every
  micro and macro rate, and a model that invents a caption there shows up in the
  *phantom pages / phantom words* columns.
* An **unknown page id throws**, naming the id, and so does an entry without a string
  `gt`. A typo must not silently amend nothing and leave a reader believing a correction
  was applied. The check is a full pass over every entry *before* the first page is
  touched, so "nothing was amended" is literally true even when the bad entry is the last
  one — `applyAmendments` is exported, and a caller that catches the error must not be
  holding a half-amended dataset.
* `score` puts the count in `summary.json`'s `meta.amendedPages` and `report` prints
  `N reference amendments applied` at the top, so two reports of the same corpus can
  never differ without saying why.

**`amendments.json` lives in the private dataset directory only.** It quotes reference
text, so like `dataset.json` and `report.md` it must never appear in this repo. Nothing
here but the mechanism is public.

### Rebuilding the dataset from scratch

`build-dataset` takes a pre-joined row file. Each row is
`{slug, index, gt, raw, processed, db_ocr, exported_image}` with `raw`/`processed` as
absolute paths. To rebuild that row file after a machine rebuild, join three private
sources:

1. **The Supabase archive dump** — `~/backups/books/db/books-<YYYY-MM-DD>.tar.zst`,
   extracted to `<date>/{books,pages}.json`.
   `books.json`: `id, title, cover_path, …`.
   `pages.json`: `id, book_id, page_index, raw_path, processed_path, ocr_text, …`
   (`ocr_text` is the original Vision OCR → the `db_ocr` field, useful as a sanity
   check but *not* the ground truth).
2. **The object-store mirror** — `~/backups/books/objects/book-pages/<raw_path>`, where
   `raw_path` is the `<userId>/<bookId>/<pageId>/raw.jpeg` value from `pages.json`
   (likewise `processed_path` → `processed.jpg`).
3. **The era-family export manifests** — `era-family/data/books/<slug>/manifest.json`,
   whose `pages[]` entries carry `{index, image, text, audio, words}`. **`text` is the
   verified ground truth** and `slug` is the stable book id used throughout this tool.

Join on: manifest `slug` ↔ `books.title`, then manifest `pages[].index` ↔
`pages.page_index`. Emit one row per page and hand the file to `build-dataset`. Sanity
checks that must pass: 120 rows, every `raw`/`processed` path exists on disk, and exactly
one row with empty `gt`.

---

## Loading keys

Secrets are read from the environment **by name**. Nothing in this tool prints, logs, or
writes a key value, and no result file contains one.

```bash
set -a
. /home/claude/Book-Reader/.env.local
. /home/claude/new-era/era-family/data/google-ai.env
set +a
```

| env var | used for |
|---|---|
| `OPENAI_API_KEY` | OpenAI Responses API (`/v1/responses`) |
| `GOOGLE_AI_STUDIO_KEY` | Gemini via AI Studio (`generativelanguage.googleapis.com`) |
| `GOOGLE_VISION_SA_JSON_B64` | base64 GCP service-account JSON → Cloud Vision (the adapter mints its own RS256 JWT and exchanges it for an access token; the private key stays in memory) |
| `ANTHROPIC_API_KEY` | **not set in this environment.** `lib/providers/anthropic.mjs` is a complete, ready adapter that throws `ANTHROPIC_API_KEY not set` until one exists. Claude is therefore **untested via API** here and was measured separately through Claude Code's own image reading. |

---

## Commands

```bash
# 1. tests (the scoring core and the cache key are the parts worth distrusting)
node --test 'tools/ocr-bakeoff/test/*.test.mjs'

# 2. build the dataset into the PRIVATE directory
node tools/ocr-bakeoff/bakeoff.mjs build-dataset \
  --rows /path/to/gt-rows.json \
  --out  /home/claude/new-era/era-family/data/ocr-bakeoff

# 3. what models exist today? (live lists + the registered candidate table)
node tools/ocr-bakeoff/bakeoff.mjs discover --out /tmp/models.json

# 4. is the Gemini key free-tier, and what does that cost us?
node tools/ocr-bakeoff/bakeoff.mjs probe-quota \
  --dataset /home/claude/new-era/era-family/data/ocr-bakeoff --candidates gemini

# 5. run (smoke first, always)
node tools/ocr-bakeoff/bakeoff.mjs run \
  --dataset /home/claude/new-era/era-family/data/ocr-bakeoff \
  --candidates all --conditions raw2048 --pages 2 --max-usd 2

# 6. score + report
node tools/ocr-bakeoff/bakeoff.mjs score \
  --dataset /home/claude/new-era/era-family/data/ocr-bakeoff \
  --out     /home/claude/new-era/era-family/data/ocr-bakeoff/results/smoke
node tools/ocr-bakeoff/bakeoff.mjs report \
  --results /home/claude/new-era/era-family/data/ocr-bakeoff/results/smoke
```

The full run is the same command with `--pages all --conditions raw,raw2048,processed`
(and `--with-review` for the second-pass pairings in `REVIEW_PLAN`).

> **Test-runner note.** On the Node 22.22 build here, `node --test <directory>` tries to
> execute the directory as a module and fails; the glob form above is what works. Quote
> the glob so the shell hands it to Node.

### Flags worth knowing

| flag | meaning |
|---|---|
| `--pages all \| N \| <slug>` | `N` takes the first N pages **round-robin across books**, so a 2-page smoke test spans two different books rather than two pages of one. |
| `--candidates all \| <id,…> \| <provider> \| <tier>` | `--candidates gemini` and `--candidates cheap` both work. |
| `--conditions raw,raw2048,processed` | comma list. |
| `--max-usd <n>` | **per candidate.** On breach the candidate stops and the log shouts `!! COST CAP`; every remaining page gets an explicit `candidate stopped` record, never a silent hole. An incident is recorded. A candidate with **no price row** cannot be capped at all (its calls add $0 to the accumulator), so the run refuses to start rather than billing without limit — see `--allow-unpriced`. |
| `--allow-unpriced` | run candidates that have no `lib/pricing.json` row **uncapped**, under `--max-usd`. Deliberately awkward: the alternative is a cap that silently does nothing. |
| `--with-review` | additionally runs the `REVIEW_PLAN` pairings (verifier sees image + another model's draft). |
| `--keep-failures` | treat cached *failures* as final instead of retrying them. |

### Caching and idempotency

Every call is cached at
`<dataset>/cache/<provider>/<model>[@<optionsFingerprint>]/<promptVersion>/<transcribe|review__<draftModel>>/<condition>/<pageId>.json`
and holds the text, the parsed `uncertain` list, token usage, latency, HTTP status, the
model string the API actually returned, **the `options` the call was made with**, the
attempt count and the raw response.

* A cached **success is never re-run** — re-running the whole grid costs $0.
* A cached **failure is retried** by default (a 429/503 cost nothing and caching it
  forever would silently drop a candidate). `--keep-failures` turns that off.
* **Everything that changes the answer is in the key.** That includes the candidate's
  `options` and its `id`, via the `@<8 hex>` fingerprint (omitted for a plain candidate
  whose id is `<provider>:<model>` and whose options are empty). Flip a model from
  `reasoningEffort: 'none'` to `'low'`, or pin `thinkingBudget`, and you get *new* cache
  entries instead of the old numbers relabelled as the new settings, for $0, with
  nothing recorded to catch it. It is also what lets two candidate rows share one model
  (`gemini:gemini-3.6-flash` vs `gemini:gemini-3.6-flash-thinking`) without colliding.
* Changing the prompt means bumping `PROMPT_VERSION` in `lib/prompts.mjs`, which forks
  the cache — old results stay valid under their own version. `score` groups by prompt
  version **and** by options fingerprint, so results from two versions or two settings
  are never blended into one leaderboard row (they appear as separate, labelled rows).
* Cost is **recomputed at score time from stored usage**, so updating `pricing.json`
  re-prices every historical result for free.
* Each `run` and `probe-quota` stamps a **`runId`** on the incidents it records.
  `incidents.json` is append-only across every run ever made against the dataset, so the
  report breaks it out per run instead of presenting a year of quota trouble as today's.

Concurrency is per provider (OpenAI 4, Gemini 2, GCV 4). Retries are exponential backoff
on 429/5xx, max 5 attempts, and honour a `RetryInfo`/"please retry in Ns" hint when the
provider gives one. A 429 that looks like a **daily** quota (its `quotaId` says `PerDay`,
or the free-tier limit is literally 0, or the wait is over 5 minutes) is **not** retried:
the candidate stops and an incident is written.

---

## How to read the report

Two normalisations, because two different things can be wrong:

* **loose** — "are the spoken words right". Case-insensitive, punctuation-insensitive
  (intra-word apostrophes survive). A dash **between two letters disappears**, so
  `better-at`, `better—at` and `betterat` are the same single token: the reference prints
  an em dash exactly where the models print a hyphen, strict has already folded both to
  `-`, and any rule that tokenised the two differently would charge word errors for
  typography no listener can hear. A dash is *not* a space, though — printing a compound
  as two spaced words is still two word errors. This is the accuracy number that decides
  whether a child hears the right story.
* **strict** — "is the prosody right". Keeps case and punctuation, after unifying
  typography that no listener can hear: curly quotes → straight, en/em dash → hyphen,
  `…` and `. . .` → `...`, newlines → spaces. This is what the TTS engine sees.

For each: **micro** WER/CER (Σ errors ÷ Σ reference words — the honest whole-corpus
number) and **macro** (mean of per-page rates — lets one short page count as much as one
long one). Both are computed over the same pages: those with a non-empty reference — the
`scored` column, not the `pages` column. **Perfect-page %** is computed over that same
set, and it is the number that matters most for our target: at 99.9% word accuracy
on ~40-word pages you still expect a wrong word every 25 pages, so a 16-page book is only
safe if perfect-page rate is very high.

**`bagWERl` and the `order-only` column** separate *wrong words* from *right words in a
different order*. WER is order-sensitive, which is correct for narration and wrong for a
cover: a model that reads the byline before the title gets every word right and still
scores WER ≈ 0.9. `bagWERl` is the same loose comparison over the multiset of words, so
`WERl` ≫ `bagWERl` means an ordering disagreement, not a misreading — check it before
believing a leaderboard position. With 8 covers in 120 pages, an unpinned cover
convention alone put a ≈ 0.012 floor under the corpus micro-WER, twelve times the target.

The `run` column says `complete` only when every page a candidate was asked for produced
an answer; `STOPPED/ERR n/m` means a cost cap, a daily quota or an API error cost it
pages, so its micro-WER was computed over a smaller, quota-determined subset and is not
comparable to a full row. A separate footnote flags rows that simply cover fewer pages
than their neighbours (a different experiment, not a worse model).

Also in the report:

* **Self-flagging** — precision/recall of each model's own `uncertain` list. Recall is
  the operational number: the fraction of wrong pages the model itself asked a human to
  check. A cheap model with high self-flag recall may beat an expensive silent one,
  because the review checkpoint catches what it admits to.
* **Phantom pages / phantom words** — pages whose ground truth is empty but the model
  produced text, and how many words it invented; **empty-ref clean** is the other side of
  the same canary, the empty-reference pages it correctly left empty. Kept out of every
  rate column entirely, perfect-page % included.
* **Scoring sanity** — one line under the leaderboard counting pages where *loose* word
  errors exceeded *strict* ones. Loose is a relaxation of strict, so this number is a
  property of `lib/score.mjs`, not of the models: a jump in it means a normaliser change
  went wrong. A page can do it honestly (loose splits a hypothesis token on punctuation
  strict kept whole), which is why it is reported rather than enforced.
* **Settings each candidate ran under** — the `options` every row was produced with.
  Reasoning and thinking tokens bill at the *output* rate, so a model left thinking by
  default is not cost-comparable to one pinned not to think; the table sits in the same
  document as the cost column it moves.
* **Derived policies** — evaluated offline from results already on disk, no extra API
  calls: `agree(A,B) → accept A, else escalate to S`, with expected cost
  `cost(A) + cost(B) + P(disagree) × cost(S)`. A `-` in a policy cost column means one of
  the models it actually pays for has no price row; a partial sum is never shown, because
  it would read as "cheaper". Plus the real `review` runs when the grid was run with
  `--with-review`.
* **Possible ground-truth errors** — pages where ≥3 **distinct candidates** from ≥2
  different providers agree with each other (loose) but disagree with the stored
  reference. One model run under three conditions is one opinion, not three. Each entry
  is a candidate for a human re-check of the *reference*, not automatically a model win.
* **Free-tier footnote** — where a provider's free allowance changes the cost ranking.
  Google Cloud Vision is $0.0015/page *after* 1,000 free pages a month, and a family
  reading a few books a month never leaves the free tier; the leaderboard's marginal
  price would otherwise rank the raw-OCR baseline as costlier than several LLMs.
* **Quota / rate-limit incidents** — with the structured `quotaId` and `quotaValue`
  Google returns, so "free tier" is evidence rather than an assumption.

**Acceptance target: loose micro-WER ≤ 0.001 with a high perfect-page rate.**

---

## Adding a candidate

1. `node tools/ocr-bakeoff/bakeoff.mjs discover` — see what actually exists today. Do
   not trust model names from memory; they change every few months.
2. Add a price row to `lib/pricing.json`, fetched from the live pricing page. This is
   **enforced**: a candidate with no price row contributes $0 to the spend accumulator,
   so `--max-usd` could never fire for it. `run` refuses to start with an unpriced
   candidate under a cap (`--allow-unpriced` overrides, deliberately loudly). There are
   no `anthropic` rows today — add them before adding a Claude candidate.
3. Add a row to `CANDIDATES` in `lib/candidates.mjs`:
   `{id: '<provider>:<model>', provider, model, tier, options, notes}`. Put the *reason
   this model is in the list* in `notes` — the table is documentation, not config.
   Pin the lowest reasoning/thinking setting the model accepts, and say so in `notes`:
   those tokens bill at the output rate and decide the cost ranking.
4. Two rows may share one model when you are testing a **setting** rather than a model
   (`gemini:gemini-3.6-flash` vs `…-thinking`): give them distinct ids, and the cache
   key's options fingerprint keeps them apart.
5. `run --pages 2 --candidates <id>` and read the report before spending on a full grid.

Adding a whole **provider** means one file in `lib/providers/` exporting
`transcribe({model, imagePath, prompt, mode, draft, options}) →
{text, uncertain, usage, latencyMs, raw, httpStatus, modelReturned, parseError}`, plus a
line in `lib/providers/index.mjs` and a concurrency budget.
`lib/providers/anthropic.mjs` is the worked example of a complete-but-keyless adapter.

**Token convention for a new adapter:** `usage.inputTokens` is the **total** prompt,
cached tokens included, with `cachedInputTokens` (and `cacheWriteInputTokens`, if the
provider has them) reported alongside; `lib/cost.mjs` subtracts them to find the fresh
input. That is what OpenAI and Gemini report natively. The Anthropic Messages API does
*not* — its `input_tokens` excludes cache reads and cache writes — so that adapter adds
them back in. Get this wrong in the other direction and cached calls are billed twice or
not at all.

## Updating pricing

`lib/pricing.json` carries `asOf` and `sources`. Re-fetch all three source URLs, update
the numbers, bump `asOf`, and re-run `score` — no API calls needed, because cost is
derived from stored token usage. If a fetch fails, put `null` rather than a guess: a null
price shows up as `-` in the report instead of a confident zero.

---

## Known caveats

* **Cover reading order: decided, prompt `v2`.** Two models can both transcribe a cover
  perfectly and still score WER ≈ 0.9 against each other because one read
  title-then-byline and the other byline-then-title, and v1 left the order to "narrative
  flow", which a title page does not have. `v2` rule 6 pins it: **strictly top to bottom
  as printed**. That is the convention the reference itself uses — on most of these
  covers the author and illustrator are printed *above* the title and the reference keeps
  them there. Verify, do not assume: an interim draft of the rule said "title first", and
  the harness caught it immediately by flagging a cover where seven models agreed with
  each other and disagreed with the reference. Scoring also reports the order-insensitive
  `bagWERl`, so if the convention is ever wrong again it shows up as an ordering
  disagreement instead of hiding inside the word-error rate.
* **Story lettering vs publisher furniture: decided, prompt `v3`.** `v2`'s "drop
  illustration lettering" rule over-fired — on one page the story's punchline is painted
  into the picture, every model dropped it as art, and the reference (rightly) keeps it.
  `v3` rule 5 says lettering a character writes, reads, holds up or paints is story text
  and is transcribed in reading order, and names the publisher furniture that is still
  always dropped (running heads, page numbers, ISBN/barcode, imprint lines, price
  stickers) — several models had narrated an imprint printed on a cover. `v3` rule 6
  also ignores anything added to *our copy*: handwritten inscriptions, gift dedications,
  library stamps, owner-name labels, stickers. The matching reference corrections are in
  the private `amendments.json`.
* **Prompt versions are never blended.** Bumping `PROMPT_VERSION` forks the cache *and*
  the leaderboard: rows carry a `prompt` column. Results captured under an older prompt
  (for example a hand-captured `claude-code` corpus) stay visible but must be read as a
  separate experiment, or re-captured under the current prompt.
* **Gemini thinking has a floor, and `thinkingBudget: 0` is rejected.** For parity with
  the OpenAI rows (which are pinned to the lowest reasoning effort each model accepts),
  every reachable Gemini row is pinned to `thinkingBudget: 1` — the lowest *those* models
  accept. Verified live 2026-09-04: a budget of exactly `0` returns
  `400 Request contains an invalid argument` on `gemini-3.6-flash` and
  `gemini-3.5-flash-lite` (though `gemini-3.1-flash-lite` accepts it), while any budget
  ≥ 1 is accepted everywhere. `thinkingLevel: 'low'` is **not** the parity setting — it
  made `gemini-3.1-flash-lite` think *more* than its own default. At budget 1 the Lite
  models emit 0 thought tokens; `gemini-3.6-flash` still emits ~57, its floor, against
  ~2,000 by default (84% of that call's cost). `gemini:gemini-3.6-flash-thinking` keeps
  the default-thinking behaviour as an explicit control.
* **Free-tier quotas are a product constraint, not a nuisance.** See the quota section
  of the generated report: on a free AI Studio key the Pro tier is not rate-limited, it
  is *unavailable* (free-tier limit 0), and some new Flash models allow only tens of
  requests per day. A family transcribing a 16-page book has to fit inside that.
* **Reported token usage varies wildly per model for the same image.** One model billed
  ~5.1k input tokens for the same 2048px page another billed at ~3.4k and a third at
  ~1.6k. Sticker price per million tokens is not the cost ranking; `$/16pp` in the
  report is.
* **Thinking models can dominate their own cost.** A Flash model spending ~1.3k
  reasoning tokens to transcribe a 40-word page pays output rates for the privilege. The
  Gemini adapter folds `thoughtsTokenCount` into output tokens so this shows up in the
  cost column instead of hiding.
* **`processed` may not be reachable in production.** It comes from a manual crop/deskew
  step. If the in-app builder does not do that, decide on `raw` / `raw2048` alone.
* **One sample per model per page.** There is no repeat-sampling, so a "consensus of one
  model run twice" policy cannot be evaluated here; the agree-or-escalate policies use
  two *different* cheap models instead.
* **Transient 503s.** At least one Gemini model answered `503 high demand` on every
  attempt one afternoon. Re-run before concluding anything about a model that only
  produced 503s.

---

## Results 2026-09-04

Two grids. The first was a 120-page × 13-candidate × 3-condition sweep under prompt `v2`
($11.32). It surfaced defects in our own reference, which were then amended; a second
`raw2048` grid of 6 candidates plus 3 review pairings ran under prompt `v3` ($4.64 spent,
~$4.46 after Cloud Vision's free tier). All numbers below are recomputed from stored
per-call usage in the private results directory; the page text, the book identities and
the ground truth stay there.

`score` walks the whole cache and groups by the prompt version stored in each record, so
**every row below — v1, v2 and v3 — is scored against the same amended reference.** There
is no `--prompt-version` flag and none is needed.

### The amendments

`score`'s **possible ground-truth errors** list flagged 18 of 120 pages. **14 pages were
amended**, in three kinds:

* **10 pages** of one authored book (typed text, generated art) whose `raw` and
  `processed` images both point at a text-free art render — a row-join defect. Their
  references are now **empty**, so they are canary pages rather than pages every model
  fails. Before this they put a ≈ 0.019 floor under every candidate's corpus WER and were
  the whole reason macro-WER (≈ 0.10) sat four times above micro-WER (≈ 0.027).
* **2 one-word reference corrections** — a word transposition, and a UK/US spelling in a
  UK-edition book.
* **2 cover references** where a handwritten gift inscription and a stuck-on owner's-name
  label had been transcribed into the reference. Both are "added to this copy", not part
  of the book; both are dropped. The two references are two photographs of the same
  jacket and now agree word for word.

The suspects list fell **18 → 7**. That the mechanism which found the defects now agrees
with the corrected references is the strongest evidence the amendments are right.

Amendments live in the private dataset's `amendments.json` and are applied by
`loadDataset`, which is the only path `run`, `score` and `probe-quota` use — there is no
unamended read path. It throws loudly if `build-dataset` is re-run and an amended id
disappears.

Scored pages are **109** (120 answered − 11 empty references).

### Leaderboard — prompt `v3`, `raw2048`

`WERl` loose (spoken words), `bagWERl` order-insensitive, `WERs` strict (case +
punctuation, what TTS sees), `$/16pp` one 16-page book, `p95` per-page 95th-percentile
latency.

| # | candidate | cond | prompt | WERl | bagWERl | perfect-page % | $/16pp | p95 | key friction |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **gpt-5.6-sol** | raw2048 | v3 | **0.0044** | 0.0037 | 92.7% | $0.2341 | 4.8 s | paid, card required |
| 2 | gpt-5.6-sol reviewing a gemini-3.1-flash-lite draft | raw2048 | v3 | 0.0112 | 0.0039 | 93.6% | $0.2473 | 3.3 s | free key **+** paid key |
| 3 | **gemini-3.1-flash-lite** | raw2048 | v3 | 0.0152 | **0.0040** | 90.8% | **$0.0093** | 4.4 s | **free AI Studio key** |
| 4 | gemini-3.5-flash-lite | raw2048 | v3 | 0.0185 | 0.0052 | 91.7% | $0.0122 | 45.3 s ¹ | free AI Studio key |
| 5 | gpt-5.4-mini | raw2048 | v3 | 0.0225 | 0.0179 | 76.1% | $0.0463 | 2.5 s | paid, card required |
| 6 | gpt-5.6-luna | raw2048 | v3 | 0.0264 | 0.0143 | 78.0% | $0.0120 | 3.1 s | paid, card required |
| 7 | gcv:documentTextDetection | raw2048 | v3 | 0.1356 | 0.0231 | 42.2% | $0.0240 ² | 1.2 s | SA JSON, billed project |

¹ Inflated by 16 transient per-minute rate-limit 429s that the runner retried
successfully; its median is 1.9 s. A free-tier throttle, not model latency.
² Marginal price. 120 units sit inside the 1,000/month free allowance, so real spend was $0.

**Two truncated review rows are excluded.** `gemini-3.1-flash-lite` reviewing itself
(n = 32, stopped by a daily-quota 429) and `gpt-5.6-sol` reviewing itself (n = 17, stopped
by the cost cap) both score WERl 0.0000, and the harness sorts them to the top of
`report.md` next to full 120-page rows. They are arbitrary page subsets — whatever
finished before the stop fired — and are not wins. Check the `pages` column before
believing any row.

### v2 (before amendments), for the delta

The same models under prompt `v2` on the **unamended** reference read:
`gemini-3.1-flash-lite` **0.0268**, `gpt-5.6-sol` **0.0427**, the two-pass pipeline
**0.0230**, `gcv:documentTextDetection` **0.1520**. Almost all of the apparent improvement
since then is the **amendments**, not the prompt — see the next section, which is the
single most important correction in this document.

### v3 is not an upgrade — it is a trade

Scored like for like (both prompt versions against the **same amended reference**, same
109 pages), the prompt change helps some models and hurts others:

| candidate, raw2048 | WERl v2 | WERl v3 | perfect-page % v2 → v3 |
|---|---|---|---|
| **gemini-3.1-flash-lite** | **0.0064** | 0.0152 | 95.4% → 90.8% |
| gemini-3.5-flash-lite | 0.0360 | **0.0185** | 85.3% → 91.7% |
| gpt-5.6-sol | 0.0225 | **0.0044** | 87.2% → 92.7% |
| gpt-5.6-luna | **0.0145** | 0.0264 | 76.1% → 78.0% |
| gpt-5.4-mini | **0.0193** | 0.0225 | 75.2% → 76.1% |
| sol reviewing a flash-lite draft | **0.0025** | 0.0112 | 96.3% → 93.6% |
| gcv:documentTextDetection | 0.1353 | 0.1356 | 42.2% → 42.2% |

Cloud Vision is promptless and moves only by rounding, which is the control that confirms
the reference is identical across both columns.

What v3 changed, and what it cost:

* **Its story-lettering rule works.** One page's punchline is painted into the picture as
  a character's trail of words; under v2 every model dropped it as illustration art.
  Under v3 **7 of 8 model rows** transcribe it correctly.
* **It over-fires on set dressing.** The same rule cannot tell a story sign from
  background scenery: a wall poster and a shop sign are now transcribed by most rows,
  costing 5 and 2 word errors on pages where v2 scored zero.
* **Its explicit publisher-furniture rule is provider-dependent.** v3 names running heads,
  page numbers, ISBN/barcode, imprint lines and price stickers as always-drop. The OpenAI
  models obey it (one went from 8 errors to 0 on a cover carrying an imprint line); **both
  Gemini models ignore it entirely** and still narrate the imprint. That is a
  prompt-portability finding, not a model-quality one.
* **It fixed reading order for `gpt-5.6-sol`** — `orderOnlyPages` 8 → 0, which is most of
  its 5× improvement — and **introduced** a reading-order flip on one two-block verse
  spread that both Gemini models now get wrong the same way.

Net: v3 trades one page of dropped story text for roughly three pages of added set
dressing. Both are policy questions about the reference, not misreadings — which is why
v3 barely moves `bagWERl` for anyone.

### Where the error actually is

`bagWERl ≈ WERl` means real misreadings; `bagWERl ≈ 0` alongside a large `WERl` means
reading order. Word-level alignment of every error on all 109 scored pages:

* **`gemini-3.1-flash-lite` under v2 makes 33 error-words in 5,190, on 5 pages, and not
  one of them is a substituted word.** Zero misreadings in the corpus. The 33 break down
  as 7 words of a publisher imprint added on a cover, 3 words of a running head printed
  into the art, 3 words of story text dropped because it was painted into the picture, and
  10 words × 2 of pure reading order on one two-column spread that the corpus happens to
  contain twice (the same physical page, photographed twice).
* **`gpt-5.6-sol` under v3 makes 23 error-words in 5,190, of which 8 are genuine
  misreadings** — one two-word phrase misjoined across a line break, two invented compound
  animal names, and one proper noun. The rest is added set dressing, an added running
  head, one ordering disagreement, one US/UK spelling where **our reference is the odd one
  out**, and one word-joining artifact a listener would never hear.

**No single model reaches the 99.9% bar (WERl ≤ 0.001) under either prompt.** The best
single row is 0.0044. The bar is reachable only by a *policy* — see below.

### The second-opinion policy is the result that matters

Transcribe each page with model **A**; transcribe it again with a different model **B**;
**auto-publish the page when the two agree** (loose-normalised text identical) and show a
human the pages where they differ. The number that matters is the **silent-error rate** —
A's loose WER on the pages that were auto-published without anyone looking.

With A = `gemini-3.1-flash-lite` under v3 and partners under v3, as originally planned:

| partner B | agree % | silent WERl | human queue | $/16pp |
|---|---|---|---|---|
| gemini-3.5-flash-lite | 87.2% | **0.00940** | 12.8% | $0.0215 |
| gpt-5.6-sol | 87.2% | 0.00180 | 12.8% | $0.2434 |
| gpt-5.6-luna | 72.5% | 0.00135 | 27.5% | $0.0213 |
| gpt-5.4-mini | 68.8% | **0.00000** | 31.2% | $0.0556 |

**Two models from the same family under the same prompt is the worst partner on the
board.** Their errors are correlated: they flip the same verse spread the same way and add
the same wall poster, so they agree while both being wrong. A partner that fails the same
way is not a second opinion.

Prompt version is a free axis — v2 and v3 rows for every model are already cached. Running
all 45 distinct pairs, **16 produce zero silent errors**, so "zero" is not a cherry-pick;
what separates them is how small a queue they hand the human:

| policy (A + B) | agree % | silent WERl | human queue | $/16pp | keys needed |
|---|---|---|---|---|---|
| **flash-lite@v2 + 3.5-flash-lite@v3** | **88.1%** | **0.00000** (0 / 4,642 words) | **11.9%** | **$0.0207** | **free only** |
| gpt-5.6-sol@v2 + 3.5-flash-lite@v3 | 80.7% | 0.00000 | 19.3% | $0.2373 | paid + free |
| 3.5-flash-lite@v2 + flash-lite@v3 | 78.0% | 0.00000 | 22.0% | $0.0206 | free only |
| flash-lite@v2 + gpt-5.6-sol@v3 | 89.9% | 0.00065 | 10.1% | $0.2427 | free + paid |
| flash-lite@v2 + 3.5-flash-lite@v2 | 83.5% | 0.00068 | 16.5% | $0.0198 | free only |
| flash-lite@v2 + flash-lite@v3 | 93.6% | **0.00629** | 6.4% | $0.0179 | free only |

The last row is the trap: **the same model under two prompts** agrees 93.6% of the time
and hides 30 error-words. A model's identity drives its failures more than its prompt
does, so decorrelation needs a **different model *and* a different prompt**.

Over all 120 pages including the wordless ones, the top row auto-publishes **89.2%** with
**zero silent error-words**, and **every one of the transcriber's 5 error pages falls
inside the 13 flagged** — error recall **1.00**. Set that against self-flagging, below,
where the same model's recall is **0.00**.

**Statistical honesty:** 0 errors in 4,642 auto-published words is not proof of
perfection. By the rule of three the 95% upper bound on the silent-error rate is
3/4,642 = **0.00065**, i.e. **≥99.935% word accuracy on auto-published pages at 95%
confidence**. That is the only configuration measured here that clears 99.9%.

### Escalating disagreements beats reviewing every page

Because only ~12% of pages disagree, a paid adjudicator is billed for about 2 pages of a
16-page book:

| adjudicator on the disagreed pages | whole-book WERl | $/16pp |
|---|---|---|
| a human (assumed correct) | 0.00000 | $0.0207 |
| **gpt-5.4-mini@v3** | **0.00154** | **$0.0263** |
| gpt-5.6-sol@v3 | 0.00193 | $0.0487 |
| gpt-5.6-sol@v2 | 0.00212 | $0.0476 |
| gpt-5.6-luna@v3 | 0.00694 | $0.0222 |

Compare the two-pass pipeline that reviews **every** page: 0.0025 at $0.2366/16pp.
**Escalating only the pages where two transcribers disagree is more accurate at one ninth
the cost.** This retires "review every page" as a design, and it reframes the earlier
open question — a cheap reviewer does get most of the way there, but what matters is
*when* you call it, not *which* model you call.

### Self-flagging is still not a safety net

Unchanged from the first grid and worth restating: the two most accurate models never
populate their own `uncertain` list — **0 flags across 360 pages each** — while the models
that flag usefully are not the ones you would ship. Best precision-with-useful-recall was
`gpt-5.6-luna` on `raw2048` under `v2` (precision 1.00, recall 0.38). A product built on
`gemini-3.1-flash-lite` gets **no automated warning when it is wrong**, which is precisely
why the second-opinion partner, not the model's own confidence, has to be the safety
mechanism.

Phantom-text canary: under v3, four candidates each wrote 5 invented words on **one** of
the 11 wordless pages. That page is a known problem with the canary set rather than a
model failure — its generated art carries lettered marker signs, which v3's story-lettering
rule tells a model to transcribe, against a reference that is empty. Fix the canary set
before reading anything into that column.

### Free-tier Gemini quotas, measured live

| model | free-tier status 2026-09-04 | evidence |
|---|---|---|
| `gemini-3.1-flash-lite` | works; ceiling now **found** | **634 successful calls** in one day (482 transcribe + 152 review), then a daily-quota 429 |
| `gemini-3.5-flash-lite` | works; ceiling not reached | 242 successful calls, no daily 429 |
| `gemini-3.6-flash` | **20 requests/day** | `generate_content_free_tier_requests, limit: 20` |
| `gemini-3.6-flash-thinking` | 20/day (same underlying model) | same quota metric |
| `gemini-3.8-flash` | **20 requests/day** | `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue: "20"` |
| `gemini-3.1-pro-preview` | **unavailable — limit 0** | free-tier request *and* input-token limits both 0 |
| `gemini-2.5-flash-lite` | retired | `404 … no longer available to new users` |

A 16-page book is 16 requests per model. The earlier claim that `gemini-3.1-flash-lite`
"could not be exhausted" is now **withdrawn**: it was exhausted, at roughly 630+ calls/day,
about 39 books. The recommended pair splits its load across two models (16 calls each per
book), so a family still gets ~39 books/day — far beyond family scale, but the ceiling now
has a number. On the 20/day models a free key gets **one book a day, and not even that**
once a retry burns a request. The Pro tier is not throttled on free, it is *off*: no design
may assume a cardless fallback to it. Cloud Vision's free tier is 1,000 units/month, which
a family never exceeds.

Separately, 16 transient per-minute rate-limit 429s hit the two Gemini models during the
grid and were retried successfully by the runner. Budget for retry latency, not failure.

### Conclusion

**Ship two cheap transcribers and publish only where they agree.**

> Default (free): transcriber **`gemini-3.1-flash-lite` under prompt `v2`**, partner
> **`gemini-3.5-flash-lite` under prompt `v3`**, both on `raw2048`, both on a free AI
> Studio key. Auto-publish agreeing pages; show a human the rest.

* **89.2% of pages auto-publish with zero measured silent errors** (≥99.935% at 95%
  confidence) — the only configuration measured that clears the 99.9% bar.
* **The human reviews ~11%**, about 2 pages of a 16-page book, and those pages contain
  **100% of the transcriber's errors**.
* **$0.0207 per book at list price, $0 in practice.** No credit card anywhere in the
  default path.
* **The two-prompt asymmetry is load-bearing and must be pinned in code.** A on v2 (which
  does not over-transcribe set dressing) and B on v3 (which does) is what decorrelates
  them. A future "upgrade everything to the latest prompt" change collapses this to a
  both-on-v3 pairing further down the full 45-pair grid (not shown above; the worst row
  shown hides 30), which hides 43 error-words.

> Opt-in (paid): escalate the ~11% disagreements to **`gpt-5.4-mini` under `v3`** and
> pre-fill the review screen with its answer — whole-book **WERl 0.00154** fully
> automatic, **$0.0263 per book**.

**Withdrawn:** the earlier recommendation to offer `gpt-5.6-sol` reviewing every page as
the paid tier. It is less accurate and nine times more expensive than escalation.

**Do not ship `gcv:documentTextDetection` as the narration source.** 0.1356, 42.2% perfect
pages, unmoved by any prompt work — excellent at finding *where* text is, poor at deciding
what order to read it in. Keep it, if at all, for seeding ground truth.

**Do not ship same-model self-review.** It was worthless in the first grid, and both
self-review rows this time died on a quota or a cost cap before producing a comparable
page set.

**Claude remains untested via API.** Its rows are hand-captured under prompt `v1` and there
is no `ANTHROPIC_API_KEY` here, so there is no price and no latency. `lib/providers/anthropic.mjs`
is complete; add pricing rows and re-run before treating any Claude number as comparable.

### Follow-ups this run generated

1. **The row-join defect is deferred, not fixed.** The 10 rows carry an empty reference so
   they no longer distort rates, but their images still point at a text-free render.
   Re-point them at the composited export (or drop the book) and re-run `build-dataset`,
   pruning `amendments.json` in the same change — it throws on ids that disappear.
2. **One canary page is not wordless.** Its generated art carries lettered marker signs
   that v3 tells a compliant model to transcribe, so four candidates score phantom text
   against an empty reference. Exclude it from the canary set or give it a real reference.
3. **Write a `v4` prompt** that keeps v3's story-lettering rule but excludes background
   set dressing, and re-states the publisher-furniture rule in a form the Gemini models
   actually obey — an explicit negative that one provider follows and another ignores is a
   portability bug in the prompt. Until then the shipped transcriber stays on `v2`.
4. **Three new reference suspects** need an eyeball: two are pages where the models are
   wrong and the reference is right (a verse-block ordering, a wall poster), and one looks
   like a genuine one-character reference typo in an onomatopoeic word.
5. **A JSON-unescaping bug.** One `gemini-3.5-flash-lite` page returned `ok` with literal
   `\n` sequences unescaped into the text, corrupting 12 words. The runner logged
   PARSE-ERR but kept the record. Add a guard.
6. **`--max-usd` is per candidate, not per run** (and cached successes count against the
   same accumulator, so a cached transcribe row can eat a review run's budget). Size a grid
   by worst case × number of candidates. Consider adding a true per-run cap.
7. **`--with-review` cannot express "just this pair"** — it queues every pair whose
   reviewer *and* draftFrom are both in `--candidates`, which forced an unwanted third
   self-review pairing this run. Given that escalation now beats whole-book review,
   consider retiring `REVIEW_PLAN` rather than fixing the flag.
8. **Add a `--prompt-version` filter to `report`.** `score` already groups correctly and
   never blends versions, but restricting a rendered table to one version means filtering
   the `prompt` column by eye.
9. Retire dead candidate ids and re-probe quotas before trusting any number here — the
   free-tier limits are the fastest-moving figures in this document.
