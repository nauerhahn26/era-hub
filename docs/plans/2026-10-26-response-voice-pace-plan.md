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
- [x] Complete Linux gate: 164 suites passed, zero failed. Windows patch leg B:
  12 checks passed, zero failed, skipped or todo.
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
- [x] Coordinate with Testing suite before shared runtime landing or publishing.
- [x] Publish v1.0.23 on the maintainer's explicit instruction, with Voice first.

The initial implementation hold was lifted by the maintainer's explicit request
to test and release. The maintainer subsequently changed the queue: Voice goes
first on the accepted baseline, without unpublished Lockout changes. Testing
suite and the Lockout owner handed over the Windows lane and release reservation.
The preceding release and unused version were checked under the shared release
lock. Testing suite confirmed that no reduced acceptance path was implemented;
the final complete green result was reused for release without another Linux run.

## Release receipt

Published [v1.0.23](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.0.23),
build `20261027.0013`, from qualified source `4e4d013`. Runtime landed as `891663f`.

- Complete Linux gate: 164 suites green, including 151 modern and 13 legacy
  suites. The original input manifest, execution plan, outputs and genuine
  same-run green stamp were preserved before landing.
- Standard Windows self-update qualification: all 12 checks green at native
  1280×800. The new control saved 90%, retained it after reload, and restored 80%.
- Retained the signed v1.0.0 installer and verified its signature.
- All six public assets were downloaded without authentication and matched the
  qualified local bytes. The public latest feed matched the tested version,
  build and archive hash.
- The public archive's Reader narration code, player and page are byte-identical
  to accepted baseline `aab8c93`. Book narration and timing are unchanged.
- The owned QA host was removed after publication. No live hub restart occurred.

Archive SHA-256:
`30cf7d49627552a3e61d442864fdcbcd161e71b7dcb68f7effebcdc425b28bc3`.

Retrospective: run the inexpensive port inventory before a complete gate when
adding a test hub. The two test fixes retained the exact behavior assertions;
neither required a Reader product change. Failed and interrupted evidence was
preserved separately and never treated as acceptance.
