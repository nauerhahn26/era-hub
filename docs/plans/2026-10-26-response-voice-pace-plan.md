# Active response voice pace

Spec: [response voice pace](../specs/2026-10-26-response-voice-pace.md).

- [x] Set shared response generation speed to 0.8 and include speed in cache keys.
- [x] Keep the edit isolated to this feature worktree.
- [x] Add a per-device Settings control (70–120%, default 80%) with explicit
  save, server validation and read-back confirmation. Store outside Drive sync.
- [x] Maintainer authorized testing and release, with Book Reader pace preserved.
- [x] Focused speed API and browser checks passed (3/3); full Settings suite
  passed (75/75); narration suite passed
  (30/30), including unchanged requests and word timings at response speeds
  0.7, 0.8 and 1.2.
- [x] Verify second-device independence and persistence across restart.
- [ ] Run the complete Linux gate and Windows patch acceptance.
- [ ] Coordinate with Testing suite before shared runtime landing or publishing.
- [ ] Release only on the maintainer's explicit instruction.

The initial implementation hold was lifted by the maintainer's explicit request
to test and release. Testing suite has Lockout ahead of this candidate; sync
that accepted predecessor before the final gate and publication transaction.
