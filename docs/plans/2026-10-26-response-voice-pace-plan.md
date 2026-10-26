# Active response voice pace

Spec: [response voice pace](../specs/2026-10-26-response-voice-pace.md).

- [x] Set shared response generation speed to 0.8 and include speed in cache keys.
- [x] Keep the edit isolated to this feature worktree.
- [x] Add a per-device Settings control (70–120%, default 80%) with explicit
  save, server validation and read-back confirmation. Store outside Drive sync.
- [ ] After the maintainer authorizes testing, verify the request speed, cache
  separation, device independence, Settings save/error handling and audible
  pace. Tests have deliberately not been run.
- [ ] Coordinate with Testing suite before shared runtime landing or publishing.
- [ ] Release only on the maintainer's explicit instruction.

The maintainer requested implementation followed by a hold before testing and
release. The usual test-first execution is deferred by that instruction.
