# era-hub — instructions for agents

This repo is one of the Our Era Comms repos; the house-wide router and its
rules live in the private `aac-board-builder` repo (`AGENTS.md` there). This
page is the era-hub half, so a fresh session here is not blind. Read in order:

1. `docs/dev-flow.md` — worktree per feature, merge-only master, the gate, the
   three release shapes, push-to-device.
2. `docs/specs/` (design records) and `docs/plans/` (task plans with ticked
   boxes and retrospectives) — newest date first. A unit of work has both.
3. `README.md` — what the hub is; `tools/era-gate.sh` header — what the gate does.

## Laws (each is pinned by a test or a script refusal)

- Work in a worktree (`<repo>--wt-<slug>`), never in the main checkout; master is
  only merged into by `worktree.sh land` after a green gate stamp under 2 h old.
- Never restart the live hub on port 8377 from a tool. Manual test hubs use
  `ERA_TEST_PORT` 8380-8389 after checking `ss -ltn`; the gate uses 8378.
- The installed payload ships no PowerShell; links are written by `shortcuts.js`
  from the running hub (`tests/start-hub-bat.test.mjs` pins this).
- No family names (one first name excepted), towns, IPs or device identifiers in
  code, tests, fixtures, docs or commit messages; the pre-commit scan refuses them.
- Code, docs and commit messages never name an AI vendor or model. Commits are
  authored by the user with no co-author or session trailers.
- Agents write all code and tests, test first; the overseer scopes, reviews and
  decides. A full gate outruns a 10-minute tool call — run it detached with a
  sentinel file.
- Publishing a release waits for the maintainer's explicit word.

## Layout

`server.js` (hub), `clothing.js` + `clothing-worker.js` (Clothing Picker and
weather), `shortcuts.js` (links), `update.js` (self-update), `tools/`
(`era-gate.sh`, `release.sh`, `build-payload.sh`, `build-dist.sh`, `vm-e2e.sh`),
`tests/` (node --test), `tests-vm/` (Windows VM legs), `docs/`.
