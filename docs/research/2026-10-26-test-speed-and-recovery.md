# Next test speed and recovery work

Preserve bug detection and the current complete acceptance rule. A failed run
stays failed. A diagnostic rerun answers a question; it does not replace missing
acceptance or turn partial successes into a full stamp.

## What the measurements establish

Two Linux gates have completed concurrently in about36 minutes versus about66
minutes summed individual durations. That suggests roughly30 minutes of queue
savings for that pair, without a controlled serial benchmark. New Games148 and
Chat155 each subsequently passed complete fresh Linux runs in about34 minutes.

A managed Windows baseline passed9/9 in14m01s, with confirmed owned cleanup,
while overlapping the canonical Games host. Both hosts had four remote CPUs
and eightGB RAM. The observation proves resource/transport independence; it
does not measure simultaneous start-to-finish throughput for two complete app
acceptances. For two similar fourteen-minute baselines started together, the
ideal bound is roughly fourteen instead of twenty-eight minutes, plus owner
app phases and serialized finalization. Treat that as an estimate.

The pilot also observed a360-second guest quiet wait and a33-second Edge warmup.
Those are targets for measurement, not evidence that either wait is unnecessary.
Its local job occupied513MB; local available memory was about4.6GB after the
Linux gates ended. Remote VM RAM must not be charged as local VM RAM, but local
snapshot copying, Node, protocol libraries and SSH still consume capacity.

## Priority order

| Order | Work | Benefit and evidence needed |
| --- | --- | --- |
| 1 | Finish owner adoption of two Windows hosts and retain two admitted Linux lanes | Removes shared-resource waiting. Keep frozen cumulative source candidates and serialized final integration/version/publication. Measure complete pair makespan. |
| 2 | Qualify cheap environment/native harness prerequisites before expensive acceptance | Games is already qualifying its Win32 hide/restore harness before replaying the full baseline. The new runner can initialize the native display immediately after pristine revert. A diagnostic that mutates the install must be followed by a pristine reset before acceptance. |
| 3 | Capture bounded failure diagnostics before owned teardown | Retain browser trace, failed locator/DOM, console/network errors, actual window PID/handle/iconic state/rectangle, screenshot, hub logs and exact input/artifact hashes. This should identify the failing boundary without another twelve-minute installation replay. Measure storage/runtime overhead. |
| 4 | Make failed-file diagnosis a distinct queue operation | Run the complete failing file with its owned fixtures and consumers first. Preserve the original failure; never retry until green and hide it. A private harness repair does not require rebuilding unchanged verified artifacts or rerunning a still-fresh exact-input Linux pass. |
| 5 | Automate cumulative source and release reservations | Verify S+A and S+A+B concurrently, then land/publish in order. If A changes or fails, hold B and recompute its source tuple. Prevent master movement from wasting an unrelated gate without pretending two independent branch passes prove their combination. |
| 6 | Measure Windows readiness and expensive deterministic fixtures | Instrument actual boot/servicing CPU and I/O before replacing process-presence waits. Review clothing image-fixture/cache work next; retain image/transport integration assertions. Report p50/p95 and false-failure frequency, not one favorable run. |
| 7 | Design input-complete result reuse separately | Potentially avoid repeating unchanged suites after a fixture-only correction. Requires complete dependency/environment/runtime identities, fresh original per-suite evidence, negative mutation tests, and updated gate/landing/release readers. No such composed acceptance exists today. |

## Recovery rules

Classify failures from evidence: allocation/SSH/port/bootstrap; test-harness
precondition; production behavior assertion; source/artifact drift; or teardown.
An ambiguous timeout remains unclassified until its diagnostics identify the
boundary. A harness visibility failure is not automatically an application
state defect. A passing install/update baseline is not a passing app/restart
journey.

Preserve immutable source/artifact/control copies and the original reports.
Replace a failed attempt with a fresh job. Do not edit a running control,
refresh stamp times, rebuild identical bytes merely to retry a private harness,
or terminate another owner's work. Recover a retained VM only after proving
the exact original owner dead/replaced and matching its resource authority.

For actual production/shared-runtime changes, run a complete integration gate
on the new combined candidate. For development, use the conservative affected
planner: reviewed dependencies can narrow; shared/unknown inputs expand to full.
Current acceptance continues to require the genuine full result and the
documented narrow Markdown-only exception.

## Primary-source support and ongoing review

Playwright records a first-failure/later-pass result as flaky, separately from a
first-pass success. This supports keeping failed attempts visible rather than
silently treating a retry as equivalent evidence. These suites use Node's test
runner and the Playwright library, so Playwright Test flags are not a drop-in
configuration change. [Retry behavior](https://playwright.dev/docs/test-retries).

Playwright's library tracing API supports DOM snapshots and screenshots for
post-run investigation; its documentation also identifies tracing overhead.
Use bounded capture where diagnosis needs it and measure cost before making it
universal. [Tracing](https://playwright.dev/docs/trace-viewer).

GitHub's merge queue checks the latest target together with preceding queued
changes. That validates the cumulative-candidate principle; it does not itself
prove our six-repository landing or artifact rules.
[Merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

Bazel describes reusable actions in terms of declared inputs, outputs, command
and environment plus content hashes. Apply that input discipline before
considering result reuse; adopting another build system is not proposed here.
[Remote caching](https://bazel.build/remote/caching).

Monthly, review slowest cases, queue wait, phase durations, first-pass reliability,
recovery time and resource peaks. Quarterly, review overlap against documented
regressions. New tests need a behavior reason, owner, material dependencies,
resources and stage. Remove coverage only when its requirement retired or
equivalent protection is demonstrated. Replay known failures to evaluate a
selection rule; an all-green sample cannot establish bug-detection recall.
