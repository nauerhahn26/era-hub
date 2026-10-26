# Independent Windows qualification

The maintainer requested two Windows QA runs in parallel after the Linux
concurrency rollout. Monitoring and finishing existing candidates take priority.
This stage must not change the canonical QA helpers or configuration while
another owner's executed-input witnesses depend on them.

Capacity is one managed isolated host plus the reserved canonical lane, or
one strict private-context legacy worker holding that lane: two remote hosts
total. The managed host uses a distinct discovery
tag so legacy allocation, teardown and reaping cannot claim it. Admission counts
both kinds of host under the existing short provider-allocation lock. This is
remote compute; local tunnel, orchestration and disk costs still need admission.

Each managed job owns an immutable source snapshot, copied artifact bytes,
private credential context, known-host file, local CDP port, output and exact
host lease. Remote guest and feed ports may retain their existing values on
different hosts. Cleanup verifies captured process identities and the exact
created provider identity; it never kills by group or deletes an unheld host.
Missing or ambiguous provider state fails closed and retains recovery evidence.
The validated ready receipt supplies the guest account selector without
exporting its password. Completed job directories cannot allocate another host.

Run the candidate's actual Windows legs and required application journeys.
Any control adaptation is explicit, hashed and restricted to transport, paths
and per-job locks. Preserve test assertions, source inventory, complete TAP
counters and actual native browser geometry. A bootstrap diagnostic establishes
readiness only; it cannot qualify a release or replace a pristine acceptance run.

The current driver supports complete patch baseline B. It refuses signed cuts
before allocation. Optional explicit manifests pin the full native initialization
and application entry closures. Initialization runs only after the stock pristine
revert and before baseline installation; application execution runs only after a
complete baseline, before parent-owned teardown. Each has fresh outputs and
requires before/after input verification. Baseline evidence cannot be overwritten.
Preparation is single-use; supplemental entries cannot revert again. Entry exits
are execution records, not automatic application or release acceptance.

Qualification does not acquire the publication lock. Final source integration,
version selection, signing and publication remain serialized and require the
existing authorization and complete evidence. A later candidate must retain its
declared predecessor and tested artifact identity. Parallel completion does not
authorize landing a stale or different source tree.

Before real adoption, use fake provider/SSH and concurrent local jobs to prove
capacity, configuration independence, port refusal, failed bootstrap recovery,
cross-run teardown refusal, source/artifact mutation detection and complete
evidence requirements. Then coordinate an isolated real pilot alongside the
consenting existing QA owner. Do not claim a speedup before actual overlap.

A real managed baseline has now passed9/9 with zero failures, cancellations,
skips or TODOs, followed by confirmed owned transport and host deletion. It
overlapped a canonical Windows run on another four-CPU/eight-GB host. This
establishes managed allocation/transport/baseline independence; optional hooks
still require their owner's actual candidate qualification. Local checks cover
both strict slots, refusals, input mutation and failed-phase cleanup.

After this capability, review bounded diagnostics before teardown, early cheap
checks, immutable artifact reuse, failure classification and input-complete
suite-result reuse. The last item needs a separate acceptance design; no partial
or composed green stamp is introduced here.
