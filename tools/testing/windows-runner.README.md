# Independent Windows patch qualification

Use the driver by absolute path from its reviewed worktree. It snapshots the
selected candidate; adopting the driver does not require changing that frozen
candidate or rebuilding its already verified artifacts.

Capacity is two cooperating remote hosts: one `managed` slot beside either the
canonical lane or one strict `legacy` slot. The strict legacy worker retains
the canonical VM lock. A third host is refused. Each job has its own source,
eight copied artifact files, private VM context, trust files, tunnel port,
outputs and exact provider lease. Current cloud hosts have four CPUs and eight
GB RAM each. Windows executes remotely; the local worker orchestrates it.

```sh
node /absolute/driver/tools/windows-gate.mjs prepare \
  --hub /absolute/candidate/era-hub \
  --dist /absolute/verified-dist \
  --family-tools /absolute/private-worktree/tools/vm \
  --suffix --wt-candidate --slot managed --cdp-port 8511

node /absolute/driver/tools/windows-gate.mjs run /absolute/prepared-job \
  --secret-env /absolute/private-credentials.env \
  --api-env /absolute/private-provider.env \
  --lease-dir /absolute/canonical-qa-leases

node /absolute/driver/tools/windows-gate.mjs status /absolute/prepared-job
```

Secret sources must be owned regular mode-0600 files. Do not change the
canonical configuration to satisfy this requirement; create a protected copy.
The lease directory must already exist and permit mutation only by its owner.
The driver refuses occupied local ports without stopping listeners. Use a
fresh job for every attempt. Preserve failed records; never edit their controls
or relabel them as successful.

The first supported release shape is a patch carrying its same-series signed
installer. Signed releases needing legs A/C and a previous installer are
refused before provisioning. The artifact HEAD and TREE must exactly match
the selected Hub source. No automatic equivalence exception exists.

## Required native initialization and application journeys

`--preparation-manifest /absolute/manifest.json` adds native initialization
immediately after the stock pristine revert finishes and before installation.
`--application-manifest /absolute/manifest.json` adds the owner's application
entry after the complete baseline succeeds and before transport/host teardown.
Both use the same manifest format:

```json
{
  "version": 1,
  "id": "native-display",
  "entry": "run.mjs",
  "files": ["run.mjs", "native-display.mjs", "native-display.cs"]
}
```

Declare every entry, import, helper, expected receipt and fixture relative to
the manifest directory. The owner reviews this input closure. The driver
copies only those regular files, rejects aliases/escape paths and binds the
entry/ID/file set to the unchanged manifest. It checks originals and copies
before and after execution. Entry code uses the copied Node and protocol
libraries beside the candidate execution directory.

Entries receive the exact `ERA_VM_MODULE` and its `ERA_VM_MODULE_SHA256`,
`VM_DIST`, candidate version/build, validated guest account, run/context and
private CDP endpoint. An entry must verify its bound module digest. `VM_OUT`
and staged screenshot output use a fresh `preparation-out` or `application-out`
directory; baseline TAP stays separate. Owner-specific variables and receipt
assertions belong in the pinned entry, not an inherited shell setting.

Preparation is single-use for the baseline's one pristine revert. Application
entries must not revert that VM again. A preparation refusal stops installation;
a missing preparation receipt, incomplete baseline, application failure, input
drift or cleanup refusal makes the job fail. Required test bodies, assertions
and order remain unchanged. Native dimensions must be observed on the actual
desktop; browser emulation does not establish that evidence.

The driver records process execution, complete baseline counters and cleanup.
It never infers application acceptance from exit zero: owners still inspect
their complete native, app and restart receipts. `completeReleaseEvidence`
stays false. Linux acceptance, fresh exact-tree integration, version allocation,
signing and authorized publication retain their existing rules.

## Monitoring and recovery

Read `status.json`, `runner.log`, baseline `vm-out/leg-b.log`, optional phase
logs/receipts, `result.json` and `cleanup.log`. Do not archive the `private/`
directory: it contains credentials and resource authority. Preserve original
outputs and issue times. Historical status remains historical when sources
later move; it does not grant a new release stamp.

Child receipts distinguish the waiting permit wrapper from its observed executed
command. `launchIdentity` retains the original PID/start/command, `execution`
records the authorized argv/digest, and `captureStage` says whether that exec
was observed. The PID/start must remain unchanged. Do not replace a stored hash
merely because it mismatches; validate the explicit transition and current
identity before any owner-controlled individual-PID interruption.

Cleanup stops only captured individual process identities, then requests deletion
of the exact owned provider resource. Accepted deletion is recorded before
polling. Ambiguous inventory or changed identity retains the reservation for
inspection. The private manager's `reap` path requires the original owner to be
proved dead/replaced; it never reaps a live or unknown owner. No automatic
cross-session cancellation, global reaper or process-group kill is introduced.

The real managed pilot overlapped a canonical Windows run and passed all nine
baseline cases in about fourteen minutes, including confirmed owned cleanup.
Optional initialization/application hooks have local negative coverage and need
the adopting owner's actual candidate qualification. Pilot success does not
qualify a later application's different source or artifacts.
