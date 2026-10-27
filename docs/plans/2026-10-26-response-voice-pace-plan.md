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
- [x] Preserve the first complete isolated run: 163 suites passed; the port
  inventory failed because the new second-device test claimed reserved port
  8489, already owned by another suite. This is not an acceptance receipt.
- [x] Replace that test port with a kernel-selected port and wait for the owned
  child's readiness before connecting. Product code is unchanged. The complete
  Settings, port inventory and suite classification checks pass (98/98).
- [x] Preserve interrupted corrective run after Reader UI exposed an existing
  startup race: the book index had arrived but the initial content status had
  not, so the poll was not yet armed. Wait for that initial answer in the test;
  retain exact 60000/20000 interval assertions. Full Reader file passes (49/49),
  and disabling only initial poll scheduling still fails the exact assertion.
  Reader product code and narration pace remain unchanged.
- [x] Add an installed Windows save/reload smoke to normal patch leg B;
  existing VM contract checks pass (12/12). No private preparation hook.
- [ ] Coordinate with Testing suite before shared runtime landing or publishing.
- [ ] Release only on the maintainer's explicit instruction.

The initial implementation hold was lifted by the maintainer's explicit request
to test and release. The maintainer subsequently changed the queue: Voice goes
first on the accepted baseline, without unpublished Lockout changes. Coordinate
the native test lane, Windows lane and release lock handoff with Testing suite
and the Lockout owner. Recheck the next free release version under the shared
release lock. The maintainer also requested avoiding unnecessary full reruns;
confirm the minimum supported acceptance evidence before collection. Existing
focused checks grant no complete gate stamp by themselves.
