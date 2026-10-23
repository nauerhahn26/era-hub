/* Bounded content browsing around the existing book action renderer. */
(function () {
  "use strict";
  const libraries = new WeakMap();
  const writingLists = new WeakMap();
  const PAGE_SIZE = 6;
  const STORAGE_KEY = "era-settings-books";
  const FILTERS = [["all", "All books"], ["review", "Needs review"], ["building", "Building"],
    ["waiting", "Waiting"], ["failed", "Failed"]];
  let sequence = 0;

  function readBrowsingState() {
    const state = { library: { query: "", filter: "all", sort: "recent", page: 0 },
      activity: { query: "", filter: "all", sort: "recent", page: 0 } };
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return state;
      for (const view of ["library", "activity"]) {
        const s = saved[view];
        if (!s || typeof s !== "object" || Array.isArray(s)) continue;
        if (typeof s.query === "string") state[view].query = s.query.slice(0, 200);
        if (FILTERS.some(([id]) => id === s.filter)) state[view].filter = s.filter;
        if (["recent", "title"].includes(s.sort)) state[view].sort = s.sort;
        if (Number.isSafeInteger(s.page) && s.page >= 0 && s.page <= 100000) state[view].page = s.page;
      }
    } catch { /* Browsing also works when session storage is unavailable. */ }
    return state;
  }
  function saveBrowsingState(state) {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Keep browsing in memory. */ }
  }

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(label, action) {
    const b = node("button", "", label); b.type = "button"; b.onclick = action; return b;
  }
  function done(j) { return j.published === true || j.state === "done" || j.state === "published"; }
  function finishedState(j) { return j.state === "done" || j.state === "published"; }
  function failed(j) { return j.state === "failed"; }
  function waiting(j) {
    return !finishedState(j) && !failed(j) && !j.elsewhere && !!(j.waiting === "pile" || j.paused || j.held ||
      (j.pausedUntil && Date.parse(j.pausedUntil) > Date.now()) || j.state === "waiting" || j.state === "holding");
  }
  function building(j, status) {
    return !finishedState(j) && !failed(j) && !waiting(j) && !!(j.elsewhere ||
      (status.building && status.job?.slug === j.slug) || status.queued?.includes(j.slug) ||
      ["inbox", "queued", "claimed", "scanning", "transcribing", "reviewing", "checking", "narrating", "animating", "publishing", "running"].includes(j.state));
  }
  function review(j) { return Number(j.flags) > 0 || Number(j.pageFlags) > 0; }
  function inFilter(j, filter, status) {
    return filter === "all" || (filter === "review" && review(j)) ||
      (filter === "failed" && failed(j)) || (filter === "waiting" && waiting(j)) ||
      (filter === "building" && building(j, status));
  }
  function summary(j, status) {
    if (failed(j)) return ["Failed", "Open details for the problem and available recovery actions."];
    if (done(j)) {
      const marks = [];
      if (j.flags) marks.push(j.flags + " word" + (j.flags === 1 ? "" : "s") + " to review");
      if (j.pageFlags) marks.push(j.pageFlags + " page" + (j.pageFlags === 1 ? "" : "s") + " to check");
      if (building(j, status)) marks.push(j.state === "animating" ? "Adding animation" : "Updating this book");
      if (waiting(j)) marks.push("Preparation is waiting. Open details for the available choices.");
      return ["Ready to read", marks.length ? marks.join(" · ") : "Open details to review pages or rename this book."];
    }
    if (j.elsewhere) return ["Building", "Building on another computer."];
    if (waiting(j)) return ["Waiting", j.waiting === "pile" ? "Photos are waiting for a grown-up to choose Build." :
      j.paused ? "Waiting for allowance. Open details for the service and available choices." :
      "Open details to see what this book needs."];
    if (building(j, status)) {
      const p = j.progress || {};
      return ["Building", p.pages ? (p.transcribed || 0) + " of " + p.pages + " pages read" +
        (p.narrated ? " · " + p.narrated + " narrated" : "") : "Preparation is in progress."];
    }
    return ["Not started", "Open details to see the available actions."];
  }
  function safeHash() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; } }

  function create({ card, container, renderRow, syncActions }) {
    if (!card || !container || typeof renderRow !== "function") throw new TypeError("Book browsing needs its card, list and row renderer.");
    if (libraries.has(container)) return libraries.get(container);
    let status = { local: true, jobs: [] }, view = "library", loaded = false;
    const state = readBrowsingState();
    const rows = new Map();
    const tabs = node("div", "settings-books-tabs");
    tabs.setAttribute("aria-label", "Books views");
    const pane = node("div", "settings-books-library");
    const setup = node("div", "settings-books-setup"); setup.id = "booksSetup"; setup.hidden = true;
    const heading = card.querySelector("h2");
    if (heading) heading.after(tabs); else card.prepend(tabs);
    const tabButtons = new Map();
    for (const [id, label] of [["library", "Library"], ["activity", "Build activity"], ["setup", "Book setup"]]) {
      const b = button(label, () => {
        setView(id);
        const hash = "#books" + (id === "library" ? "" : "/" + id);
        if (location.hash !== hash) location.hash = hash;
      });
      b.dataset.booksView = id; tabButtons.set(id, b); tabs.append(b);
    }
    const intro = card.querySelector(":scope > p.hint");
    if (intro) setup.append(intro);
    const tiers = card.querySelector("#contentTiers");
    if (tiers) setup.append(tiers);
    const connections = node("div", "settings-books-links");
    for (const [hash, label] of [["drive", "Content folder & sync"], ["ai", "AI helper"],
      ["voice", "Recorded voice"], ["moving", "Moving pages"]]) {
      const a = node("a", "", label + " →"); a.href = "#connections/" + hash; connections.append(a);
    }
    setup.append(connections);
    for (const id of ["contentActions", "contentStatus"]) { const el = card.querySelector("#" + id); if (el) pane.append(el); }
    const toolbar = node("div", "settings-books-toolbar");
    const search = node("input"); search.type = "search"; search.placeholder = "Search your books";
    search.setAttribute("aria-label", "Search books");
    const sort = node("select"); sort.setAttribute("aria-label", "Sort books");
    for (const [value, text] of [["recent", "Folder order"], ["title", "Title A–Z"]]) {
      const option = node("option", "", text); option.value = value; sort.append(option);
    }
    toolbar.append(search, sort);
    const filters = node("div", "settings-books-filters"); filters.setAttribute("aria-label", "Book status filters");
    const filterButtons = new Map();
    for (const [id, label] of FILTERS) {
      const b = button(label, () => { state[view].filter = id; state[view].page = 0; paint(); });
      b.dataset.booksFilter = id; filterButtons.set(id, b); filters.append(b);
    }
    const empty = node("p", "settings-books-empty"); empty.id = "booksEmpty"; empty.setAttribute("role", "status");
    const pager = node("div", "settings-books-pagination");
    const count = node("span"); count.id = "booksPageCount"; count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite");
    const back = button("←", () => { state[view].page--; paint(); });
    back.dataset.booksPrevious = ""; back.setAttribute("aria-label", "Previous books");
    const next = button("→", () => { state[view].page++; paint(); });
    next.dataset.booksNext = ""; next.setAttribute("aria-label", "Next books");
    const arrows = node("div", "settings-books-page-buttons"); arrows.append(back, next); pager.append(count, arrows);
    pane.append(toolbar, filters, container, empty, pager); card.append(pane, setup);

    function protectedDetail(item) {
      const focused = document.activeElement;
      for (const input of item.dirtyInputs) {
        const rename = input.closest(".ct-rename");
        if (!item.detail.contains(input) || (rename && rename.style.display === "none") || input.value === item.job.title) item.dirtyInputs.delete(input);
      }
      const openRename = [...item.detail.querySelectorAll(".ct-rename")].some(el => !el.hidden && el.style.display !== "none");
      return (item.detail.contains(focused) && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName)) ||
        item.dirtyInputs.size > 0 || openRename || !!item.detail.querySelector(".armed, button:disabled, [aria-busy=true]");
    }
    function refreshDetail(item) {
      if (!item.open) return;
      // The original action handler owns confirmation truth. Cached rows can
      // be detached when that handler disarms the connected document.
      if (item.detail.firstChild && syncActions) syncActions(item.detail, item.job);
      const signature = JSON.stringify([item.job, status.local, !!(status.building && status.job?.slug === item.job.slug),
        !!status.queued?.includes(item.job.slug)]);
      if (signature === item.signature || (item.detail.firstChild && protectedDetail(item))) return;
      const rendered = renderRow(item.job);
      item.detail.replaceChildren(rendered); item.dirtyInputs.clear(); item.signature = signature;
      if (syncActions) syncActions(item.detail, item.job);
    }
    function makeRow(j) {
      const wrapper = node("article", "settings-book-row"); wrapper.dataset.bookSlug = j.slug;
      const line = node("div", "settings-book-summary");
      const cover = node("span", "settings-book-cover", "▤"); cover.setAttribute("aria-hidden", "true");
      const info = node("div", "settings-book-info");
      const title = node("strong"); const note = node("p"); const tag = node("span", "settings-book-tag");
      info.append(title, note, tag);
      const detail = node("div", "settings-book-detail"); detail.hidden = true; detail.id = "bookDetails" + (++sequence);
      const item = { wrapper, title, note, tag, detail, job: j, open: false, signature: "", dirtyInputs: new Set() };
      const toggle = button("View", () => {
        item.open = !item.open; item.detail.hidden = !item.open;
        toggle.textContent = item.open ? "Close details" : "View";
        toggle.setAttribute("aria-expanded", String(item.open));
        toggle.setAttribute("aria-label", (item.open ? "Close details for " : "View ") + (item.job.title || item.job.slug));
        refreshDetail(item);
      });
      toggle.dataset.bookView = ""; toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-controls", detail.id);
      item.toggle = toggle; line.append(cover, info, toggle); wrapper.append(line, detail);
      detail.addEventListener("input", e => { if (e.target.matches("input, textarea, select")) item.dirtyInputs.add(e.target); });
      detail.addEventListener("focusout", () => setTimeout(() => refreshDetail(item), 0));
      return item;
    }
    function paint() {
      if (view === "setup" || !loaded) return;
      const current = state[view];
      const jobs = Array.isArray(status.jobs) ? status.jobs : [];
      toolbar.hidden = status.local === false;
      filters.hidden = status.local === false || view === "activity";
      for (const [id, b] of filterButtons) {
        b.setAttribute("aria-pressed", String(current.filter === id));
        const amount = jobs.filter(j => inFilter(j, id, status)).length;
        b.textContent = FILTERS.find(f => f[0] === id)[1] + " " + amount;
      }
      let matches = status.local === false ? [] : jobs.filter(j =>
        (view !== "activity" || !done(j) || building(j, status) || waiting(j) || failed(j)) && inFilter(j, view === "activity" ? "all" : current.filter, status) &&
        String(j.title || j.slug || "").toLocaleLowerCase().includes(current.query.toLocaleLowerCase()));
      if (current.sort === "title") matches.sort((a, b) => String(a.title || a.slug).localeCompare(String(b.title || b.slug)));
      current.page = Math.max(0, Math.min(current.page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1)));
      const start = current.page * PAGE_SIZE, visible = matches.slice(start, start + PAGE_SIZE);
      const visibleItems = [];
      for (const j of visible) {
        let item = rows.get(j.slug);
        if (!item) { item = makeRow(j); rows.set(j.slug, item); }
        item.job = j;
        const [label, note] = summary(j, status);
        item.title.textContent = j.title || j.slug;
        item.note.textContent = note;
        item.tag.textContent = label;
        item.tag.dataset.state = failed(j) ? "failed" : done(j) ? "ready" : waiting(j) ? "waiting" : "building";
        item.toggle.setAttribute("aria-label", (item.open ? "Close details for " : "View ") + (j.title || j.slug));
        refreshDetail(item); visibleItems.push(item);
      }
      // Reconcile in place: an unchanged row must not lose a focused input or
      // an armed confirmation merely because the status timer ticked.
      const keep = new Set(visibleItems.map(i => i.wrapper));
      for (const child of [...container.children]) if (!keep.has(child)) child.remove();
      visibleItems.forEach((item, index) => {
        if (container.children[index] !== item.wrapper) container.insertBefore(item.wrapper, container.children[index] || null);
      });
      const present = new Set(jobs.map(j => j.slug));
      for (const slug of rows.keys()) if (!present.has(slug)) rows.delete(slug);
      empty.hidden = !!visible.length || status.local === false;
      empty.textContent = jobs.length ? "No books match this search or filter." :
        view === "activity" ? "No book builds are active or waiting." : "No books yet. Add page photos to your content folder, then choose Build.";
      if (view === "activity" && jobs.length && !matches.length && !current.query) empty.textContent = "No book builds are active or waiting.";
      pager.hidden = status.local === false || !matches.length;
      count.textContent = (matches.length ? start + 1 : 0) + "–" + Math.min(start + PAGE_SIZE, matches.length) + " of " + matches.length + " books";
      back.disabled = current.page === 0; next.disabled = start + PAGE_SIZE >= matches.length;
      saveBrowsingState(state);
    }
    function setView(nextView) {
      view = ["library", "activity", "setup"].includes(nextView) ? nextView : "library";
      for (const [id, b] of tabButtons) b.setAttribute("aria-pressed", String(id === view));
      pane.hidden = view === "setup"; setup.hidden = view !== "setup";
      if (view !== "setup") { search.value = state[view].query; sort.value = state[view].sort; paint(); }
    }
    search.oninput = () => {
      state[view].query = search.value.slice(0, 200); search.value = state[view].query;
      state[view].page = 0; paint();
    };
    sort.onchange = () => { state[view].sort = sort.value; state[view].page = 0; paint(); };
    const api = { update(nextStatus) { status = nextStatus || { local: false, jobs: [] }; loaded = true; paint(); }, setView };
    libraries.set(container, api);
    window.ERA_SETTINGS_BOOKS_VIEW = setView;
    document.addEventListener("era:settings-route", e => { if (e.detail?.section === "books") setView(e.detail.subview); });
    const hash = safeHash();
    setView(hash === "contentTiers" || hash === "booksSetup" ? "setup" : hash.startsWith("books/") ? hash.split("/")[1] : "library");
    return api;
  }

  function paginateWriting(container) {
    if (!container) return;
    let state = writingLists.get(container);
    if (!state) {
      const pager = node("div", "settings-books-pagination");
      const count = node("span"); count.id = "writingPageCount"; count.setAttribute("role", "status");
      const buttons = node("div", "settings-books-page-buttons");
      const back = button("←", () => { state.page--; paint(); }); back.setAttribute("aria-label", "Previous writing");
      const next = button("→", () => { state.page++; paint(); }); next.setAttribute("aria-label", "Next writing");
      buttons.append(back, next); pager.append(count, buttons); container.after(pager);
      state = { page: 0, pager, count, back, next }; writingLists.set(container, state);
    }
    function paint() {
      const children = [...container.children];
      state.page = Math.max(0, Math.min(state.page, Math.max(0, Math.ceil(children.length / PAGE_SIZE) - 1)));
      const start = state.page * PAGE_SIZE;
      children.forEach((child, index) => { child.hidden = index < start || index >= start + PAGE_SIZE; });
      state.count.textContent = (children.length ? start + 1 : 0) + "–" + Math.min(start + PAGE_SIZE, children.length) + " of " + children.length + " writings";
      state.pager.hidden = children.length <= PAGE_SIZE;
      state.back.disabled = state.page === 0; state.next.disabled = start + PAGE_SIZE >= children.length;
    }
    paint();
  }

  window.ERA_SETTINGS_BOOKS = { create, paginateWriting };
})();
