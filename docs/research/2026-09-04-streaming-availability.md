# Streaming availability + deep links for the New ERA Movies board

Research date **2026-09-04**. Every claim below is either (a) fetched from a
current vendor doc with the URL cited, or (b) **probed live from this machine
today** — marked `[LIVE]`. Live probes used the family's existing
`TMDB_API_KEY` (`/home/claude/new-era/era-family/data/tmdb.env`) and the
keyless JustWatch endpoint. Nothing here is from memory.

Context assumed: US household; subscribes to **Netflix, Prime Video, Apple TV+,
Disney+** (`/home/claude/aac-board-builder/docs/movie-player-research.md`);
spec `docs/superpowers/specs/2026-09-04-local-content-pipelines-design.md`
leaves "streaming lookup provider" open for this task and already defines the
catalog row as `{title, year, tmdbId?, link, provider, poster, addedBy}`.

---

## 0. TL;DR recommendation

| Flow | Primary | Fallback | Last resort |
|---|---|---|---|
| **(a) "type a title → found on X → add tile"** | **TMDB** (`/search/multi` → title, year, poster, `tmdb_id`) **+ Watchmode** (`/v1/title/tv-129604/sources`) for the deep link | **JustWatch GraphQL** — best data, zero keys, but ToS says personal/non-commercial only; ship as an explicitly parent-enabled "no extra key" mode, not the default | **TMDB `/watch/providers`** — names the service ("found on Netflix") with **no deep link**; tile falls back to the provider's own search URL, or the already-specced *paste a URL* path |
| **(b) recommendation engine** | **TMDB `/discover`** (`with_watch_providers` + `certification.lte` + `with_genres`) and **TMDB `/tv/{id}/recommendations`** — free, no meaningful quota, best kids filtering | **Watchmode `TitleDetails.similar_titles` + `/v1/list-titles`** for anything TMDB can't rank | JustWatch `popularTitles(sortBy: TRENDING)` + `similarTitlesV2` |

Rationale in §7. The short version: **TMDB is the metadata/discovery spine you
already pay no money and hold a key for; it cannot give you a deep link.
Exactly one extra key (Watchmode) buys the deep link legally. JustWatch gives
the best deep links for free but its Terms of Use forbid what we'd be doing.**

---

## 1. Comparison table

Deep-link columns: ✅ = a per-title, service-native URL was **observed** (or is
documented); ❌ = only a provider name/flag.

| | **TMDB /watch/providers** | **Watchmode** | **Streaming Availability API** (Movie of the Night) | **JustWatch GraphQL** (unofficial) | **Wikidata** | **Reelgood** | **Utelly** |
|---|---|---|---|---|---|---|---|
| Netflix deep link | ❌ | ✅ `web_url` | ✅ `link`/`videoLink` | ✅ `netflix.com/title/{id}` `[LIVE]` | partial (P1874) | ✅ (sales) | weak |
| Disney+ | ❌ | ✅ | ✅ | ✅ `disneyplus.com/browse/entity-{uuid}` `[LIVE]` | ~none | ✅ | weak |
| Prime Video | ❌ | ✅ | ✅ | ✅ `watch.amazon.com/detail?gti=…` + ASIN via Roku deeplink `[LIVE]` | partial (P8055/P14440) | ✅ | weak |
| Apple TV+ | ❌ | ✅ | ✅ | ✅ `tv.apple.com/us/movie/…/umc.cmc.{id}` `[LIVE]` | partial (P9586) | ✅ | weak |
| Paramount+ | ❌ | ✅ | ✅ | ✅ `paramountplus.com/shows/{slug}/video/{id}` `[LIVE]` | ~none | ✅ | weak |
| Peacock | ❌ | ✅ | ✅ | ✅ `peacocktv.com/watch/asset/…` `[LIVE]` | ~none | ✅ | weak |
| HBO Max | ❌ | ✅ | ✅ | ✅ `play.hbomax.com/video/watch/{uuid}` `[LIVE]` | ~none | ✅ | weak |
| YouTube | ❌ | ✅ (as a source) | ✅ | packages 192/235/188 exist `[LIVE]` | P1651 | ✅ | weak |
| **Freshness** | JustWatch feed, refreshed continuously | daily catalog updates + `/changes/*` feeds | daily | live JustWatch production data (freshest possible) | volunteer-edited, stale | real-time | unclear |
| **Free-tier quota** | effectively unlimited (~40 req/s soft cap) | **2,500 req/month**, ≤3 countries, non-commercial, no CC | **1,000 req/month**, no CC, all endpoints | none published; **8 rapid calls → 8×200, no 429** `[LIVE]` | unlimited (WDQS, be polite) | none | RapidAPI freemium |
| **Cost beyond free** | commercial use needs a written agreement | **$349/mo → 40k**, $599/mo → 100k, Enterprise custom | **$49/mo → 25k**, $99 → 100k, $299 → 1M | n/a (commercial = contact `data-partner@justwatch.com`) | free | sales-gated | RapidAPI tiers |
| **Signup friction (1 easy – 5 awful)** | **3** — already held | **3** — one web form, instant key, no CC | **3** — signup, no CC | **1** — no key at all | **1** | **5** — sales call | 4 (RapidAPI acct) |
| **Recommendations** | ✅ `/{type}/{id}/recommendations`, `/similar`, `/discover` | ✅ `similar_titles[]` on details; `/v1/list-titles` filters | ❌ none | ✅ `similarTitlesV2`, `popularTitles(sortBy: TRENDING)` `[LIVE]` | ❌ | ✅ | claims "recommendations" |
| **Kids / age filtering** | ✅ `certification.lte` (**works on `/discover/tv` too** `[LIVE]`), genres 10751/10762, `/content_ratings` | ✅ `us_rating` (`TV-Y`…), `content_ratings{}`, `genres` | ⚠️ **no age-rating field at all**; only a `family` genre | ✅ `ageCertification` (`TV-Y`,`TV-PG`,`G`,`PG`) + `genres` incl. `fml` = Kids & Family `[LIVE]` | ❌ | ✅ | ❌ |
| **ToS risk** | Low — but **must show TMDB logo + "not endorsed by TMDB"**, attribute JustWatch on provider data, **no caching >6 months**, non-commercial only | Low — normal commercial API terms; free tier is explicitly non-commercial | Low — attribution required, redistribution banned, data may be kept after sub ends | **HIGH** — see §5 | Low (CC0) | Low | Low |

---

## 2. TMDB `/watch/providers` — verified live

**Verdict: provider *flags* only. There is no deep link, and there never will
be.** TMDB's own docs: *"we do not return full deep links on the API… you can
redirect users to our /watch pages"*, and
*"In order to use this data you must attribute the source of the data as
JustWatch."* — <https://developer.themoviedb.org/reference/movie-watch-providers>

`[LIVE]` `GET /3/tv/129604/watch/providers?api_key=…` returned:

```json
{"id":129604,"results":{
  "US":{"link":"https://www.themoviedb.org/tv/129604-ada-twist-scientist/watch?locale=US",
        "flatrate":[{"provider_id":8,"provider_name":"Netflix","logo_path":"/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg","display_priority":0},
                    {"provider_id":175,"provider_name":"Netflix Kids","logo_path":"/kwVegvKCinXTPuzZmYT1J3i1HJz.jpg","display_priority":16}]},
  "AD":{…}, "AE":{…}, …~90 more countries… }}
```

Gotchas found live:
- **The response carries every country on Earth.** Slice `results.US` client-side; do not
  cache the whole blob.
- The only URL is a `themoviedb.org/…/watch` page — useless as a kiosk target
  for a 6-year-old.
- **`provider_id` is byte-identical to JustWatch's `packageId`** (8 Netflix,
  9 Prime Video, 15 Hulu, 175 Netflix Kids, 337 Disney Plus, 350 Apple TV,
  386 Peacock Premium, 1796 Netflix Std w/ Ads, 1825 HBO Max Amazon Ch.,
  1899 HBO Max) `[LIVE]` — because TMDB's feed *is* JustWatch. **One provider-id
  table serves both adapters.** Pull `/3/watch/providers/{movie|tv}?watch_region=US`
  once at install and cache it.

**Rate limit:** the old 40-req/10-s cap was disabled 2019-12-16; today
*"upper limits… somewhere in the 40 requests per second range"* and *"respect
the 429"* — <https://developer.themoviedb.org/docs/rate-limiting>. For a
household this is effectively unlimited.

**Key friction (rank 3):** account → Settings → API → agree to terms → key
issued. Docs warn *"the API registration process is **not** optimized for
mobile devices"* — <https://developer.themoviedb.org/docs/getting-started>.
The family already holds one (`TMDB_API_KEY`, dad, 2026-08-28).

**Terms — three load-bearing constraints**
(<https://www.themoviedb.org/api-terms-of-use>, effective 2023-10-20):
1. *"You must use the TMDB logo to identify Your use of TMDB…"* plus a notice
   that the app *"is not endorsed, certified, or otherwise approved by TMDB."*
   → needs a line + logo on the Movies board's About/Settings page.
2. **"Data obtained through the APIs cannot be cached for longer than 6 months."**
   → the Drive catalog must re-sync TMDB-derived fields at least twice a year.
   Design a `tmdbRefreshedAt` field now.
3. Commercial use requires a separate written agreement. New ERA is free →
   fine, but note it if that ever changes.

### Recommendations / discovery (this is where TMDB shines) `[LIVE]`

- `GET /3/tv/129604/recommendations` → *Mr. Bean: The Animated Series*,
  **Sid the Science Kid**, … — genuinely on-profile for a learning-forward 6-y-o.
- `GET /3/tv/129604/similar` → *W.I.T.C.H.*, teen fantasy — **junk**.
  **Use `/recommendations`, never `/similar`, for TV.**
- `GET /3/discover/movie?watch_region=US&with_watch_providers=337&with_watch_monetization_types=flatrate&certification_country=US&certification.lte=G&sort_by=popularity.desc`
  → 609 results (vs 1667 unfiltered) — Toy Story, WALL·E, The Lion King.
- **`certification.lte` also works on `/discover/tv`** — 257 results vs 3518
  unfiltered for `certification.lte=TV-Y7` on Netflix; top hits Miraculous,
  Sesame Street, PAW Patrol. This contradicts the widespread "certification is
  movie-only" claim; verified today.
- Genre ids: `10751` Family (movie+tv), `10762` Kids (tv), `16` Animation.
- `with_watch_providers` accepts `8|337|9|350` (OR) and needs `watch_region=US`.

---

## 3. Watchmode

Docs: <https://api.watchmode.com/> · machine-readable spec (undocumented but
live, 100 KB): **`https://api.watchmode.com/openapi.json`** `[LIVE]` — hand this
to the implementer instead of the Redoc page.

- Base `https://api.watchmode.com/v1`. Auth `X-API-Key: …` header
  (also `Authorization: Bearer …`; legacy `?apiKey=`).
- **Free tier: 2,500 requests/month, up to 3 countries, non-commercial, no
  credit card.** Next tier is **$349/mo for 40k** — a brutal cliff, but
  irrelevant: each family runs its own key against its own 2,500.
- **Credit accounting matters** (from the spec's own param docs): a lookup by
  Watchmode id = 1 credit; **by IMDB or TMDB id = 2 credits**; each
  `append_to_response` value = **+1**. So `title/tv-129604/details?append_to_response=sources`
  = 3 credits ≈ **830 title-adds/month** on the free tier. Plenty.
- Free keys have **no access to the `/changes/*` feeds** — so a nightly
  "what moved services" sweep is a paid feature. Re-poll per-title instead.

**Endpoints that matter**

```
GET /v1/autocomplete-search?search_value=ada%20twist&search_type=2
GET /v1/search?search_field=tmdb_tv_id&search_value=129604      # ← join from TMDB
GET /v1/title/{title_id}/sources?regions=US                      # title_id: 345534 | tt0903747 | movie-278 | tv-1396
GET /v1/title/{title_id}/details?append_to_response=sources&regions=US
GET /v1/list-titles?types=tv_series&regions=US&source_types=sub&source_ids=203,372&genres=…&sort_by=popularity_desc&limit=250
GET /v1/status                                                   # quota remaining
GET /v1/sources /v1/genres /v1/regions                           # cache these once
```

**`TitleSource` schema** (deep links, verbatim from the spec):

```
source_id:203  name:"Netflix"  type:"sub"  region:"US"
ios_url  android_url  web_url  tvos_url  android_tv_url  roku_url
format:"HD"  price:3.99  seasons:5  episodes:62
```

**`TitleDetails`** carries everything the catalog needs in one call:
`tmdb_id`, `tmdb_type`, `imdb_id`, `us_rating:"TV-MA"`,
`content_ratings:{"US":"TV-MA","AU":"MA 15+"}`, `genre_names[]`,
`similar_titles:[330884,343611]`, `poster/posterMedium/posterLarge`,
`popularity_percentile`, `trailer`.

`similar_titles[]` + `us_rating` together are a complete, legal recommendation
engine — no extra vendor needed. **There is no `/recommendations` endpoint**;
`similar_titles` on the details payload is the whole story.

**Signup (rank 3):** one web form at
<https://api.watchmode.com/requestApiKey> — *"Create a Watchmode API account to
get 2,500 monthly requests and choose up to 3 countries"*, no credit card.
Set the 3 countries to `US` (+ 2 spare). A parent can do this in ~2 minutes;
it is the same shape of task as the TMDB key they already did.

**Caveat:** I could not obtain a key without signing the family up, so the
literal `web_url` string for a Netflix title is documented-but-unverified.
Watchmode's marketing states it provides *"web links, iOS deeplinks, and
Android deeplinks to send users to the correct streaming service"*. **First
implementation step should be: get a key, `curl` one title, and assert the
`web_url` shape before wiring the kiosk.**

---

## 4. Streaming Availability API (Movie of the Night)

Docs <https://docs.movieofthenight.com/> · pricing
<https://www.movieofthenight.com/about/api/pricing> · terms
<https://github.com/movieofthenight/streaming-availability-api/blob/main/TERMS.md>

- **Direct, not RapidAPI-only.** Header `X-API-Key` (RapidAPI variant uses
  `X-RapidAPI-Key`).
- **Free: 1,000 requests/month, no payment info.** Then $49/25k, $99/100k,
  $299/1M. *"Request quota is a hard limit"* — no overage, you just get blocked
  until the cycle rolls. Image bandwidth is capped separately (1 GB free).
- 65 countries, ~35 services, "3,362 streaming catalogs".

```
GET /shows/search/title?title=ada%20twist&country=us&show_type=series
  → [{ itemType:"show", showType:"series", id, imdbId, tmdbId:"tv/129604",
       title, overview, genres:[{id:"family",name:"Family"}], rating:0-100,
       imageSet:{…},
       streamingOptions:{ us:[ { service:{id:"netflix",name:"Netflix"},
                                 type:"subscription",
                                 link:"https://www.netflix.com/watch/…",
                                 deepLink:"nflx://…",
                                 videoLink:"https://netflix.com/watch/70111700",
                                 quality:"4k", audios:[…], subtitles:[…] } ] } }]
```

It has the **best-shaped** deep-link contract of the lot — three link
flavours including a native-scheme `deepLink` and a play-now `videoLink`.

**Two disqualifiers for us:**
1. **No age/content-rating field anywhere in the `Show` schema** (confirmed
   against the schema page). `rating` is a 0-100 *quality* score, not TV-Y.
   For an app whose whole job is age-appropriateness, that's a hole you'd have
   to plug from TMDB anyway.
2. **No similar/recommendations endpoint.**

Plus 1,000/mo is the tightest free tier here. Terms: attribution required
(*"streaming availability information is provided by Streaming Availability API
by Movie of the Night"*), **commercial use allowed**, data may be retained
after the subscription ends (images may not), and **redistribution/resale of
the data is banned** — fine for a local catalog on the family's own PC.

**Verdict: credible #2 fallback to Watchmode if Watchmode's 2,500/mo or key
form is a problem, but it is strictly worse for a kids app.**

---

## 5. JustWatch unofficial GraphQL — the best data, the worst terms

Endpoint **`POST https://apis.justwatch.com/graphql`**, `content-type: application/json`.
**No API key, no auth header, no Referer required** `[LIVE]`. Introspection is
disabled (`"introspection disabled"`), so the query shapes below were taken
from the maintained client `Electronic-Mango/simple-justwatch-python-api`
(<https://github.com/Electronic-Mango/simple-justwatch-python-api>) and then
**executed successfully against production today**.

### 5.1 Live "ada twist" request/response

Request:

```jsonc
POST https://apis.justwatch.com/graphql
{
  "operationName": "GetSearchTitles",
  "query": "query GetSearchTitles($searchTitlesFilter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!, $filter: OfferFilter!) { popularTitles(country: $country, filter: $searchTitlesFilter, first: $first, sortBy: POPULAR, sortRandomSeed: 0) { edges { node { id objectId objectType content(country: $country, language: $language) { title originalReleaseYear shortDescription ... on MovieOrShowContent { ageCertification } ... on MovieOrShowOrSeasonContent { fullPath genres { shortName } externalIds { imdbId tmdbId } posterUrl(profile: S332, format: JPG) } } offers(country: $country, platform: WEB, filter: $filter) { monetizationType presentationType package { packageId clearName technicalName shortName } standardWebURL deeplinkRoku: deeplinkURL(platform: ROKU_OS) } } } } }",
  "variables": {
    "first": 5,
    "country": "US", "language": "en",
    "filter": { "bestOnly": true },
    "searchTitlesFilter": { "searchQuery": "ada twist", "includeTitlesWithoutUrl": true }
  }
}
```

Response (verbatim, trimmed to the first edge):

```json
{"data":{"popularTitles":{"edges":[{"node":{
  "id":"ts258321","objectId":258321,"objectType":"SHOW",
  "content":{
    "title":"Ada Twist, Scientist","originalReleaseYear":2021,
    "shortDescription":"Ada Twist, a young scientist who will explore helping people through scientific discovery, collaboration and friendship.",
    "ageCertification":"TV-PG",
    "fullPath":"/us/tv-show/ada-twist-scientist",
    "genres":[{"shortName":"ani"},{"shortName":"cmy"},{"shortName":"fml"},{"shortName":"msc"}],
    "externalIds":{"imdbId":"tt13241650","tmdbId":"129604"},
    "posterUrl":"/poster/320374519/s332/ada-twist-scientist.jpg"},
  "offers":[
    {"monetizationType":"FLATRATE","presentationType":"HD",
     "package":{"packageId":8,"clearName":"Netflix","technicalName":"netflix","shortName":"nfx"},
     "standardWebURL":"https://www.netflix.com/title/80198673",
     "deeplinkRoku":"launch/12?contentID=80198673&MediaType=show"},
    {"…":"Netflix Kids (175) and Netflix Standard with Ads (1796), same URL"}
  ]}}]}}}
```

Gotchas found the hard way: declaring `$backdropProfile` without using it is a
**422** (`GRAPHQL_VALIDATION_FAILED`); `posterUrl` needs the profile inline
(`S332`) unless you also declare `$profile`.

### 5.2 Deep-link shapes observed across providers `[LIVE]`

| Service | `standardWebURL` | Extra id available |
|---|---|---|
| Netflix | `https://www.netflix.com/title/80198673` | same numeric id in `deeplinkRoku` `contentID` |
| Disney+ | `https://www.disneyplus.com/browse/entity-328b0ec7-6e50-4ead-aa7f-c8bb92e6f08a` | — |
| Prime Video | `https://watch.amazon.com/detail?gti=amzn1.dv.gti.aebe765d-…` | **ASIN** in `deeplinkRoku` `contentID=B0FSKQBQ5T` |
| Apple TV+ | `https://tv.apple.com/us/movie/…/umc.cmc.52sgmi3vdpedurrbtz6louqqo?at=1000l3V2&ct=app_tvplus&itscg=30200&itsct=justwatch_tv` | `umc.cmc.*` id |
| Paramount+ | `https://www.paramountplus.com/shows/paw-patrol/video/_lYKmpsvLTC4eAA1k0JcXvjWOPdsh0un/…` | episode-level |
| Peacock | `https://www.peacocktv.com/watch/asset/tv/curious-george/8456…/seasons/1/episodes/…/5e98bffb-…` | episode-level |
| HBO Max | `https://play.hbomax.com/video/watch/8c936d8d-088c-42a9-9ab9-2e886d680cf9?utm_source=universal_search` | — |
| Hulu | `https://www.hulu.com/watch/64cbedfc-548d-4a3e-bcd8-c07a744023e5` | — |
| Tubi (free) | `https://tubitv.com/series/300019823/sesame-street` | — |

**JustWatch monetises these links.** Amazon retail URLs carry
`?tag=justwatch09-20`; Apple URLs carry `at=1000l3V2&…&itsct=justwatch_tv`;
Fubo carries `irmp=/irad=`. Whatever provider we pick, **strip tracking params
before storing a link in a child's board** — and note that stripping JustWatch's
affiliate tags while using their unlicensed API is not a good look.

### 5.3 Deep-link URL forms — resolved empirically `[LIVE]`

Unauthenticated `curl` (Chrome UA), so read these as *routing* facts, not
signed-in playback facts:

```
netflix.com/title/80198673                              → 200
netflix.com/watch/80198673                              → 302 → /title/80198673?fromWatch=true
disneyplus.com/browse/entity-328b0ec7-…                 → 200
disneyplus.com/play/328b0ec7-…                          → 308 → /browse/entity-328b0ec7-…
primevideo.com/detail/B0FSKQBQ5T                        → 200
watch.amazon.com/detail?gti=amzn1.dv.gti.aebe765d-…     → 302 → amazon.com/gp/video/detail/0PI1EPL…
```

Three concrete consequences for the existing catalog schema:

1. **Disney+ `/play/{uuid}` and `/browse/entity-{uuid}` share the same UUID** —
   `/play/` now 308s to `/browse/`. The app's current `disneyplus.com/play/{uuid}`
   is *not* wrong, but Disney has moved the canonical form. Adapter: take
   JustWatch's URL, `replace('/browse/entity-','/play/')` if you want the old
   shape, else store as given.
2. **Prime: do not use `watch.amazon.com/detail?gti=…`** — it bounces through a
   redirect to a third id space. Pull the **ASIN** out of
   `deeplinkRoku` (`contentID=B0FSKQBQ5T`) and build
   `https://www.primevideo.com/detail/{ASIN}` — that's the form the board
   already uses and it returns 200.
3. **Netflix**: the `/watch/ → /title/` 302 is Netflix's *logged-out* bounce
   (it fires for movies too — tested `81498621` K-Pop Demon Hunters). The
   numeric id is identical in both forms, so keep the existing
   `netflix.com/watch/{id}` for the signed-in kiosk. **Verify once on the i13
   while signed in** before trusting either form.

### 5.4 Filters, genres, packages `[LIVE]`

- `TitleFilter` accepts `searchQuery`, `objectTypes` (enum: `MOVIE`, `SHOW`, …;
  a bad value 422s and names itself), `genres`, `packages` (shortNames),
  `ageCertifications` (**free-form strings — a bogus value silently returns
  `edges: []` rather than erroring; validate your own list**), `releaseYear
  {min,max}`, `includeTitlesWithoutUrl`.
- `OfferFilter`: `bestOnly: true` dedupes; `monetizationTypes: [FLATRATE, FREE, ADS]`
  **excludes rent/buy** — this directly implements the movie-player rule
  *"Rent/buy titles must NEVER surface as picker tiles."*
- Full genre list (`query { genres { shortName translation(language:"en") } }`):
  `fml`=**Kids & Family**, `ani`=Animation, `cmy`=Comedy, `drm`, `act`, `doc`,
  `fnt`, `scf`, `msc`, `spt`, `rma`, `war`, `crm`, `hst`, `hrr`, `wsn`, `rly`,
  `trl`, `eur`.
- 422 US packages. The four that matter: `8/nfx` Netflix, `9/amp` Amazon Prime
  Video, `337/dnp` Disney Plus, `350/atp` Apple TV. (Also `2303/2616`
  Paramount+ Premium/Essential, `386` Peacock Premium, `1899` HBO Max,
  `15` Hulu, `209` PBS, `293` PBS Kids Amazon Channel.)

### 5.5 Discovery + similar `[LIVE]`

```graphql
# recommendation engine, one call
popularTitles(country: US, filter: {
  objectTypes: ["MOVIE"], genres: ["fml"],
  packages: ["nfx","dnp"], ageCertifications: ["G","TV-Y","TV-G"]
}, first: 20, sortBy: TRENDING, sortRandomSeed: 0) { … }
```
→ Muppet Treasure Island, Ice Princess, … (correctly `G`, correctly on Disney+).
Note the `packages` filter selects **titles**, not offers — the returned
`offers[]` still lists every package, so filter again client-side.

```graphql
node(id: "ts258321") { ... on MovieOrShow {
  similarTitlesV2(country: US, filter: {}) { edges { node { … } } } } }
```
→ Dragon Striker (TV-Y7-FV), T.O.T.S. (TV-Y), Kiff (TV-Y7) — plus one miss
(Corner Gas Animated, TV-14). **Always re-filter on `ageCertification`.**

### 5.6 Refresh query — store the node id, never re-search

There is **no lookup-by-TMDB-id** (`nodeByExternalId` doesn't exist; passing an
IMDB id as `searchQuery` returns `[]`). But `node(id: "ts258321")` works, so
store JustWatch's `id` at add-time and refresh with one cheap call:

```graphql
query GetTitleOffers($nodeId: ID!, $country: Country!, $language: Language!) {
  node(id: $nodeId) { ... on MovieOrShowOrSeasonOrEpisode {
    id objectType
    content(country: $country, language: $language) {
      title originalReleaseYear
      ... on MovieOrShowContent { ageCertification }
      ... on MovieOrShowOrSeasonContent {
        fullPath posterUrl(profile: S332, format: JPG)
        externalIds { tmdbId imdbId } genres { shortName } } }
    offers(country: $country, platform: WEB,
           filter: { bestOnly: true, monetizationTypes: [FLATRATE, FREE, ADS] }) {
      monetizationType
      package { packageId clearName technicalName shortName }
      standardWebURL
      deeplinkRoku: deeplinkURL(platform: ROKU_OS)
      availableTo } } }
}
```
Verified HTTP 200 today. `availableTo` gives leaving-soon dates (null here).

### 5.7 ToS — read this before choosing it

- `justwatch.com/robots.txt` is **`User-agent: * / Disallow:`** (nothing
  disallowed) `[LIVE]` — but robots.txt is not the licence.
- **JustWatch Terms of Use**
  (<https://support.justwatch.com/article/just-watchs-terms-of-use>):
  *"users will not engage in or use any data mining, robots, scraping or
  similar data gathering or extraction methods"*; *"…not to … frame, scrape …
  or create derivative works based on … the Service Content in any way for any
  public or commercial purpose"*; the service is *"intended for personal and
  non-commercial use only."*
- **JustWatch's own statement about the unofficial API**, reproduced in the
  reference client's README (<https://github.com/dawoudt/JustWatchAPI>,
  **archived 2026-03-18**):
  *"it is prohibited to use the API for commercial purposes…"*;
  *"The API may be used for non-commercial purposes such as private projects,
  but please be respectful with your API calls"*;
  *"JustWatch can disable and change the API at any time without notice and
  without giving any reason"*;
  *"Incorrect or prohibited use of the API… may result in a claim for damages"*.
  Official route for anything else: `data-partner@justwatch.com`.

**Assessment.** New ERA is free, has no server, and each install calls from the
family's own PC for their own household — that is the closest thing to
"personal, non-commercial, private project" a shipped product can be, and it is
almost certainly not what JustWatch means to chase. But it is a *distributed*
product, which is squarely "public purpose" under the ToS clause above. Two
real risks, in order of likelihood:

1. **Silent breakage.** No versioning, no notice, introspection off, and the
   one canonical Python client was archived six months ago. A schema change
   bricks the Movies board's add flow for every family at once, with no
   warning and no support channel.
2. **Legal/blocking.** Low probability, non-zero, and it would land on the
   project rather than on any one family.

**Recommendation: do not make it the shipped default.** It is superb as
(i) the reference the adapter is developed and tested against, and (ii) an
explicitly parent-toggled "don't make me get another key" mode, with the ToS
summarised in the Settings copy. Keep the adapter interface identical to
Watchmode's so the swap is one config line.

---

## 6. Everything else — checked and rejected

**Wikidata.** Properties exist: Netflix ID **P1874**, Amazon Prime Video ID
**P8055**, Prime Video ID **P14440**, Apple TV movie ID **P9586**, YouTube video
ID P1651. Coverage is the problem. `[LIVE]` SPARQL over six canon titles
(Ada Twist, Bluey, Encanto, Sesame Street, PAW Patrol, Gabby's Dollhouse)
returned **exactly one** Netflix ID (Gabby's Dollhouse, `81009946`) and **zero**
Disney+/Prime ids; Ada Twist (Q108822177) has no `P1874` at all. Wikidata also
carries no *current availability* — an id persists after a title leaves the
service. **Unusable as a source; fine as an occasional cross-check.**

**Reelgood.** Real product, 300+ services, deep links, real-time
(<https://data.reelgood.com/products/reelgood-partner-api/>) — but **entirely
sales-gated**: no self-serve signup, no free tier, no published pricing, the
page's only CTA is *"Let's talk →"*. Dead end for a BYO-key family app.

**Utelly.** RapidAPI-marketplace freemium, thin metadata, no age rating,
positioned around search/recommendations rather than deep links; the RapidAPI
listing is JS-rendered and I could not verify current quotas or maintenance
from a fetched source. **No reason to prefer it over the three above.**

**Official Netflix / Disney+ / Prime Video APIs — confirmed: none exist.**
Netflix *"began phasing out its public API developers service in 2013 and
finally decided to shut down the API service entirely by November 2014"*
(<https://data.reelgood.com/netflix-api-for-developers/>). Disney+ and Hulu
have never published one (Reelgood's companion articles). Every "deep link"
above is a public web URL pattern reverse-engineered from the consumer site by
JustWatch/Watchmode, not a sanctioned integration — which is why deep-link
shapes drift and why §5.3-style empirical checks belong in the gate tests.

---

## 7. YouTube: Data API v3 vs yt-dlp

**Google's quota model changed in 2026 and the old advice is now wrong.**
Per Google's own page (<https://developers.google.com/youtube/v3/determine_quota_cost>,
last updated 2026-06-01):

> *"Projects that enable the YouTube Data API have a default quota allocation
> of 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per
> day combined for all other endpoints."*
> *"The `search.list` and `videos.insert` methods have their own quota buckets.
> Each of these methods has a default daily limit of 100 per day."*

So it is **not** "10,000 units ÷ 100 = 100 searches" any more — search has its
own hard bucket of **100 calls/day**, and the 10,000-unit pool no longer buys
you extra searches at all.

| | YouTube Data API v3 | yt-dlp `ytsearchN:` |
|---|---|---|
| Key | Google Cloud project → enable API → create key. **Friction 5/5** for a non-technical parent — by far the worst signup in this document | **none** |
| Search quota | **100 searches/day, hard** | unmetered (be polite) |
| Metadata | clean, structured, stable contract | 88 fields, no key, but scraped → breaks periodically and needs frequent updates |
| Already needed? | no | **yes — audio download for the Music board needs yt-dlp regardless** |

**Recommendation: use `yt-dlp "ytsearch5:<query>" --dump-single-json` for
YouTube search. Do not add the Data API.** It would add the single hardest
signup step in the product to save nothing: yt-dlp already ships for the music
pipeline, needs no key, and isn't capped at 100/day. The one thing to build is
**a yt-dlp self-update path** (its search/extraction breaks when YouTube
changes), which the music pipeline needs anyway.

---

## 8. What to cache in the Drive catalog vs look up live

The governing constraints: **TMDB data must not be cached >6 months**;
availability genuinely churns (Sesame Street moved Max→Netflix in Nov 2025);
Watchmode free tier is 2,500 credits/month; and the board must render instantly
and offline-ish for a gaze user.

**Cache in `movies/catalog.json` (Drive-synced) — written once at add-time:**

```jsonc
{
  "id": "ada-twist-scientist",
  "title": "Ada Twist, Scientist",
  "year": 2021,
  "type": "show",                      // MOVIE | SHOW
  "tmdbId": 129604, "tmdbType": "tv",  // join key to everything
  "imdbId": "tt13241650",
  "providerRef": { "watchmode": 3173903, "justwatch": "ts258321" },  // refresh handles
  "provider": "netflix",               // technicalName, == TMDB provider slug
  "providerId": 8,                     // TMDB provider_id === JustWatch packageId
  "link": "https://www.netflix.com/watch/80198673",  // tracking params stripped
  "poster": "ada-twist-scientist.jpg", // downloaded bytes, served from the movies jail
  "ageRating": "TV-PG",
  "genres": ["ani","fml","msc"],
  "addedBy": "search",
  "availabilityCheckedAt": "2026-09-04",
  "tmdbRefreshedAt": "2026-09-04"      // TMDB 6-month cache ceiling
}
```

Also cache, once per install, refreshed monthly: the **provider-id table**
(`/3/watch/providers/{movie,tv}?watch_region=US` — ~1 call) and the **genre
table**. Both are tiny and change rarely.

**Cache the poster bytes, not a poster URL.** The board already serves
`movies/<file>` from the media jail; a remote URL breaks the offline story and
TMDB's image CDN paths rotate. (Note the Movie of the Night terms explicitly
forbid keeping *their* images after a subscription lapses — another reason to
source posters from TMDB, which the app already does.)

**Look up live (never cache long):**
- Nothing on the render path. The board must draw from `catalog.json` alone.

**Background refresh, not live:**
- **Availability + deep link:** re-check per title on a rolling schedule —
  weekly for the ~20-title active set, or lazily on "tile failed to launch".
  At 3 Watchmode credits per title, 20 titles/week ≈ 260 credits/month, ~10% of
  the free tier. Mark a tile "moved — ask a grown-up" rather than deleting it.
- **TMDB-derived fields** (title, year, poster, genres): re-pull inside the
  6-month window; fold it into the same sweep.
- **Recommendation candidates:** generate offline (nightly/weekly), write to
  `discovery.json`, and gate on the parent's yes/no pass — matching the
  workflow already described in `movie-player-research.md` §1b. Never surface an
  unapproved recommendation to the child.

---

## 9. Adapter contract (so this doesn't get re-researched)

One interface, three implementations, chosen by which key is present:

```js
// availability.js
// search(query, {region:'US'}) -> [Candidate]
// refresh(candidate)           -> Candidate | {gone:true}
// Candidate = { title, year, type, tmdbId, tmdbType, imdbId, providerRef,
//               offers: [ { providerId, provider, monetization, url } ],
//               ageRating, genres, posterUrl }
```

- `watchmode.js` — `X-API-Key`; `GET /v1/search?search_field=tmdb_tv_id&search_value={tmdbId}`
  then `GET /v1/title/{id}/sources?regions=US`; map `TitleSource.web_url` → `offers[].url`,
  `source_id` → `providerId`, `type:"sub"|"free"` kept, `"rent"|"buy"` dropped.
- `justwatch.js` — §5.1 for search, §5.6 for refresh; drop offers whose
  `monetizationType` isn't in `[FLATRATE, FREE, ADS]`; Prime URL rebuilt from
  the Roku ASIN (§5.3); strip `tag=`, `at=`, `ct=`, `itsc*`, `irmp`, `irad`, `utm_*`.
- `tmdb-only.js` — degraded: `/search/multi` + `/{type}/{id}/watch/providers`
  sliced to `.results.US`; emits `offers[].url = null` and a `provider` name
  only, so the UI says "found on Netflix" and the tile links to the provider's
  own search page until a parent pastes the real URL.

**Attribution the UI owes** (all three paths): TMDB logo + *"not endorsed,
certified, or otherwise approved by TMDB"*; *"Streaming availability data by
JustWatch"* whenever TMDB `/watch/providers` is the source; Movie of the
Night's required line if that adapter is ever added.

**First three implementation steps:**
1. Request a Watchmode key; `curl` one title; **assert the literal `web_url`
   for Netflix/Disney+/Prime** against §5.3 — this is the one unverified claim
   in this document.
2. On the i13, **signed in**, confirm `netflix.com/watch/{id}` plays a series
   rather than bouncing to `/title/` (§5.3, note 3).
3. Add a gate test that pins the six deep-link URL shapes in §5.2, so a
   provider changing its URL scheme fails CI instead of failing a 6-year-old.
