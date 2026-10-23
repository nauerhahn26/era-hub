import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../public/settings/settings-books.js", import.meta.url));
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const job = (i, extra = {}) => ({ slug: "book-" + i, title: "Book " + String(i).padStart(3, "0"),
  state: "done", progress: { pages: 12, transcribed: 12, narrated: 12 }, ...extra });

const fixture = `<div class="card" id="content"><h2>Your books</h2>
  <p class="hint">Book preparation instructions</p><div id="contentActions"><button>Look for books</button></div>
  <div id="contentStatus"></div><div id="contentBooks"></div><div id="contentTiers">Cost and allowance guidance</div>
  </div><div id="writings"></div>`;

async function open(jobs = [], options = {}) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  if (options.storageOrigin) {
    await page.route("http://settings.test/**", route => route.fulfill({ contentType: "text/html", body: fixture }));
    await page.goto("http://settings.test/settings/#content");
    if (options.saved !== undefined) await page.evaluate(saved => sessionStorage.setItem("era-settings-books", saved), options.saved);
  } else await page.setContent(fixture);
  if (options.hash) await page.evaluate(hash => { location.hash = hash; }, options.hash);
  await page.addScriptTag({ path: script });
  await page.evaluate(jobs => {
    window.buildCalls = 0; window.retryCalls = 0; window.renderCalls = 0; window.armedSlug = null;
    window.disarm = () => {
      window.armedSlug = null;
      document.querySelectorAll(".ctbuild.armed").forEach(b => { b.classList.remove("armed"); b.textContent = "Build"; });
    };
    window.payload = { local: true, jobs, queued: [] };
    window.library = window.ERA_SETTINGS_BOOKS.create({
      card: document.querySelector("#content"), container: document.querySelector("#contentBooks"),
      syncActions(detail, j) {
        const b = detail.querySelector(".ctbuild");
        if (b) { const armed = window.armedSlug === j.slug; b.classList.toggle("armed", armed); b.textContent = armed ? "Confirm Build" : "Build"; }
      },
      renderRow(j) {
        window.renderCalls++;
        const row = document.createElement("div"); row.dataset.slug = j.slug;
        const title = document.createElement("h3"); title.textContent = j.title;
        const state = document.createElement("p"); state.textContent = j.error || j.state;
        const rename = document.createElement("input"); rename.className = "ct-rename-box";
        rename.setAttribute("aria-label", "Book title"); rename.value = j.title;
        const build = document.createElement("button"); build.className = "ctbuild"; build.textContent = "Build";
        build.onclick = () => { if (window.armedSlug === j.slug) { disarm(); window.buildCalls++; }
          else { disarm(); window.armedSlug = j.slug; build.classList.add("armed"); build.textContent = "Confirm Build"; } };
        const retry = document.createElement("button"); retry.textContent = "Retry";
        retry.onclick = () => window.retryCalls++;
        row.append(title, state, rename);
        if (!window.payload.queued?.includes(j.slug) && !(window.payload.building && window.payload.job?.slug === j.slug)) row.append(build);
        row.append(retry); return row;
      }
    });
    window.library.update(window.payload);
  }, jobs);
  return page;
}

test("empty and one-book libraries retain honest empty states and bounded rows", async () => {
  const page = await open();
  assert.equal(await page.locator("#contentBooks > *").count(), 0);
  assert.match(await page.locator("#booksEmpty").innerText(), /No books/i);
  await page.evaluate(j => library.update({ local: true, jobs: [j] }), job(1));
  assert.equal(await page.locator(".settings-book-row").count(), 1);
  assert.match(await page.locator("#booksPageCount").innerText(), /1.*1.*1/);
  assert.equal(await page.locator("[data-books-next]").isDisabled(), true);
  await page.close();
});

test("six-row pages bound 16 and 100-book libraries, with title search and sorting", async () => {
  const page = await open(Array.from({ length: 16 }, (_, i) => job(i)));
  assert.equal(await page.locator(".settings-book-row").count(), 6);
  await page.getByRole("button", { name: "Next books" }).click();
  assert.match(await page.locator("#booksPageCount").innerText(), /7–12 of 16/);
  await page.getByRole("searchbox", { name: "Search books" }).fill("015");
  assert.equal(await page.locator(".settings-book-row").count(), 1);
  assert.match(await page.locator(".settings-book-row").innerText(), /Book 015/);
  await page.getByRole("searchbox", { name: "Search books" }).fill("");
  await page.evaluate(jobs => library.update({ local: true, jobs }), Array.from({ length: 100 }, (_, i) => job(99 - i)));
  assert.equal(await page.locator(".settings-book-row").count(), 6);
  await page.getByRole("combobox", { name: "Sort books" }).selectOption("title");
  assert.match(await page.locator(".settings-book-row").first().innerText(), /Book 000/);
  await page.getByRole("searchbox", { name: "Search books" }).fill("not present");
  assert.equal(await page.locator(".settings-book-row").count(), 0);
  assert.match(await page.locator("#booksEmpty").innerText(), /No books match/i);
  await page.close();
});

test("filters derive review, building, waiting and failed states without confusing readable books", async () => {
  const page = await open([
    job(0, { flags: 2, published: true }), job(1, { pageFlags: 1 }),
    job(2, { state: "transcribing" }), job(3, { state: "holding", held: "no-ai-key" }),
    job(4, { state: "failed", held: "retry", error: "Could not read this page" }),
    job(5, { state: "transcribing", elsewhere: true })
  ]);
  await page.locator('[data-books-filter="review"]').click();
  assert.equal(await page.locator(".settings-book-row").count(), 2);
  assert.match(await page.locator(".settings-book-row").first().innerText(), /Ready to read/);
  await page.locator('[data-books-filter="building"]').click();
  assert.equal(await page.locator(".settings-book-row").count(), 2);
  assert.match(await page.locator("#contentBooks").innerText(), /another computer/);
  await page.locator('[data-books-filter="waiting"]').click();
  assert.equal(await page.locator(".settings-book-row").count(), 1);
  await page.locator('[data-books-filter="failed"]').click();
  assert.equal(await page.locator(".settings-book-row").count(), 1);
  await page.getByRole("button", { name: "View Book 004", exact: true }).click();
  assert.match(await page.locator('[data-slug="book-4"]').innerText(), /Could not read this page/);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal(await page.evaluate(() => retryCalls), 1);
  await page.close();
});

test("details use the real row renderer only on request and do not initiate builds", async () => {
  const page = await open([job(1, { state: "waiting", waiting: "pile" })]);
  assert.equal(await page.evaluate(() => renderCalls), 0);
  assert.equal(await page.evaluate(() => buildCalls), 0);
  await page.getByRole("button", { name: "View Book 001", exact: true }).click();
  assert.equal(await page.evaluate(() => renderCalls), 1);
  await page.getByRole("button", { name: "Build", exact: true }).click();
  assert.equal(await page.evaluate(() => buildCalls), 0);
  await page.evaluate(() => library.update(payload));
  await page.getByRole("button", { name: "Confirm Build", exact: true }).click();
  assert.equal(await page.evaluate(() => buildCalls), 1);
  await page.close();
});

test("polling preserves an editing title, focus and row identity while progress changes", async () => {
  const page = await open([job(1, { state: "transcribing" })]);
  await page.getByRole("button", { name: "View Book 001", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Book title" });
  await input.fill("My correction");
  await page.evaluate(() => { window.originalInput = document.activeElement; payload.jobs[0].progress.transcribed = 8; library.update(payload); });
  assert.equal(await input.inputValue(), "My correction");
  assert.equal(await page.evaluate(() => document.activeElement === originalInput), true);
  assert.equal(await page.evaluate(() => originalInput.isConnected), true);
  await page.close();
});

test("an unsaved rename survives leaving the section and a changed status response", async () => {
  const page = await open([job(1, { state: "transcribing" })]);
  await page.getByRole("button", { name: "View Book 001", exact: true }).click();
  await page.getByRole("textbox", { name: "Book title" }).fill("An unsaved correction");
  await page.evaluate(() => { window.originalInput = document.activeElement; payload.jobs[0].progress.transcribed = 8; library.update(payload); });
  await page.getByRole("button", { name: "Book setup", exact: true }).click();
  await page.waitForTimeout(30);
  await page.evaluate(() => { payload.jobs[0].progress.transcribed = 9; library.update(payload); });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Book title" }).inputValue(), "An unsaved correction");
  assert.equal(await page.evaluate(() => originalInput.isConnected), true);
  await page.close();
});

test("an outer queue or running claim refreshes detail action eligibility for an unchanged job", async () => {
  const page = await open([job(1, { state: "transcribing" })]);
  await page.getByRole("button", { name: "View Book 001", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Build", exact: true }).count(), 1);
  await page.evaluate(() => { payload.queued = ["book-1"]; library.update(payload); });
  assert.equal(await page.getByRole("button", { name: "Build", exact: true }).count(), 0);
  await page.evaluate(() => { payload.queued = []; payload.building = true; payload.job = { slug: "book-1" }; library.update(payload); });
  assert.equal(await page.getByRole("button", { name: "Build", exact: true }).count(), 0);
  await page.evaluate(() => { payload.building = false; payload.job = null; library.update(payload); });
  assert.equal(await page.getByRole("button", { name: "Build", exact: true }).count(), 1);
  await page.close();
});

test("an unsaved rename remains cached when its row is on another page", async () => {
  const page = await open(Array.from({ length: 16 }, (_, i) => job(i)));
  await page.getByRole("button", { name: "View Book 000", exact: true }).click();
  await page.getByRole("textbox", { name: "Book title" }).fill("A title in progress");
  await page.getByRole("button", { name: "Next books", exact: true }).click();
  await page.evaluate(() => { payload.jobs[0].progress.transcribed = 9; library.update(payload); });
  await page.getByRole("button", { name: "Previous books", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Book title" }).inputValue(), "A title in progress");
  await page.close();
});

test("detached build confirmations resync with the authoritative arm after expiry or another book", async () => {
  const page = await open(Array.from({ length: 16 }, (_, i) => job(i, { state: "inbox", waiting: "pile" })));
  await page.getByRole("button", { name: "View Book 000", exact: true }).click();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Next books", exact: true }).click();
  await page.evaluate(() => disarm());
  await page.getByRole("button", { name: "Previous books", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Confirm Build", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Build", exact: true }).click();
  assert.equal(await page.evaluate(() => buildCalls), 0, "the first tap after expiry arms only");
  await page.getByRole("button", { name: "Next books", exact: true }).click();
  await page.getByRole("button", { name: "View Book 006", exact: true }).click();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByRole("button", { name: "Previous books", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Confirm Build", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => armedSlug), "book-6");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  assert.equal(await page.evaluate(() => buildCalls), 0, "switching back must not confirm a different book");
  await page.close();
});

test("returning from review through a full reload at the legacy Books link restores browsing state", async () => {
  const jobs = Array.from({ length: 100 }, (_, i) => job(i, { flags: 1 }));
  const page = await open(jobs, { storageOrigin: true });
  await page.getByRole("searchbox", { name: "Search books" }).fill("Book 0");
  await page.locator('[data-books-filter="review"]').click();
  await page.getByRole("combobox", { name: "Sort books" }).selectOption("title");
  await page.getByRole("button", { name: "Next books" }).click();
  await page.reload();
  await page.addScriptTag({ path: script });
  await page.evaluate(jobs => {
    window.library = ERA_SETTINGS_BOOKS.create({ card: document.querySelector("#content"),
      container: document.querySelector("#contentBooks"), renderRow: () => document.createElement("div") });
    library.update({ local: true, jobs });
  }, jobs);
  assert.equal(await page.getByRole("searchbox", { name: "Search books" }).inputValue(), "Book 0");
  assert.equal(await page.locator('[data-books-filter="review"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("combobox", { name: "Sort books" }).inputValue(), "title");
  assert.match(await page.locator("#booksPageCount").innerText(), /7–12 of 100/);
  const stored = await page.evaluate(() => sessionStorage.getItem("era-settings-books"));
  assert.equal(stored.includes("book-"), false, "book metadata is not persisted");
  await page.close();
});

test("persisted browsing preferences reject malformed values and bound a search query", async () => {
  const page = await open(Array.from({ length: 16 }, (_, i) => job(i)), { storageOrigin: true,
    saved: JSON.stringify({ library: { query: { unexpected: true }, filter: "unknown", sort: "unknown", page: -100 } }) });
  assert.equal(await page.getByRole("searchbox", { name: "Search books" }).inputValue(), "");
  assert.match(await page.locator("#booksPageCount").innerText(), /1–6 of 16/);
  assert.equal(await page.locator('[data-books-filter="all"]').getAttribute("aria-pressed"), "true");
  await page.getByRole("searchbox", { name: "Search books" }).fill("x".repeat(1000));
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("era-settings-books")).library.query.length), 200);
  await page.close();
});

test("inbox, review and readable animation work remain visible in build activity", async () => {
  const page = await open([job(1, { state: "inbox" }), job(2, { state: "reviewing" }),
    job(3, { state: "animating", published: true }), job(4)]);
  await page.locator('[data-books-filter="building"]').click();
  assert.equal(await page.locator(".settings-book-row").count(), 3);
  await page.getByRole("button", { name: "Build activity", exact: true }).click();
  assert.equal(await page.locator(".settings-book-row").count(), 3);
  assert.match(await page.locator('[data-book-slug="book-3"]').innerText(), /Ready to read/);
  assert.match(await page.locator('[data-book-slug="book-3"]').innerText(), /animation/i);
  await page.close();
});

test("Book setup moves existing explanatory nodes and activity omits finished books", async () => {
  const page = await open([job(1), job(2, { state: "holding", paused: { until: "tomorrow" } })]);
  await page.getByRole("button", { name: "Book setup", exact: true }).click();
  assert.equal(await page.locator("#contentTiers").isVisible(), true);
  assert.equal(await page.locator("#contentBooks").isVisible(), false);
  assert.match(await page.locator("#booksSetup").innerText(), /Book preparation instructions/);
  await page.getByRole("button", { name: "Build activity", exact: true }).click();
  assert.equal(await page.locator(".settings-book-row").count(), 1);
  assert.equal(await page.locator("#contentTiers").isVisible(), false);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  assert.equal(await page.locator(".settings-book-row").count(), 2);
  await page.close();
});

test("the existing cost-guidance fragment opens Book setup when content loads after routing", async () => {
  const page = await open([job(1)], { hash: "#contentTiers" });
  assert.equal(await page.locator('[data-books-view="setup"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#contentTiers").isVisible(), true);
  await page.close();
});

test("page and filters survive refresh, and removed books clamp pagination", async () => {
  const page = await open(Array.from({ length: 16 }, (_, i) => job(i)));
  await page.getByRole("button", { name: "Next books" }).click();
  await page.evaluate(() => library.update(payload));
  assert.match(await page.locator("#booksPageCount").innerText(), /7–12 of 16/);
  await page.evaluate(j => library.update({ local: true, jobs: [j] }), job(1));
  assert.match(await page.locator("#booksPageCount").innerText(), /1–1 of 1/);
  await page.evaluate(() => library.update({ local: false, jobs: [] }));
  assert.equal(await page.locator(".settings-book-row").count(), 0);
  assert.equal(await page.getByRole("searchbox", { name: "Search books" }).isVisible(), false);
  await page.close();
});

test("saved writing is paginated after rendering and stays bounded after refresh", async () => {
  const page = await open();
  await page.evaluate(() => {
    const box = document.querySelector("#writings");
    for (let i = 0; i < 16; i++) { const row = document.createElement("div"); row.textContent = "Writing " + i; box.appendChild(row); }
    ERA_SETTINGS_BOOKS.paginateWriting(box);
  });
  assert.equal(await page.locator("#writings > :visible").count(), 6);
  await page.getByRole("button", { name: "Next writing" }).click();
  assert.equal(await page.locator("#writings > :visible").count(), 6);
  assert.match(await page.locator("#writingPageCount").innerText(), /7–12 of 16/);
  await page.evaluate(() => ERA_SETTINGS_BOOKS.paginateWriting(document.querySelector("#writings")));
  assert.match(await page.locator("#writingPageCount").innerText(), /7–12 of 16/);
  await page.close();
});
