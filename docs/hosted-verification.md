# Hosted verification record

The application is available at [Hospital Surge Planner](https://hospital-surge.131.186.0.156.sslip.io). The deployed release is **`e2e65eb81c023ae8b4385742756662be524c29fb`**. The next candidate is under local verification and has not been deployed. The private login handoff is `data/deployment/access.md` (ignored, mode 0600); it contains only the application URL and admin credentials.

## Current deployed gates

These results describe the named deployed release, not the pending candidate. The hosted compute workloads use the same frozen `planning_baseline` dataset, base seed and 70% ED arrival increase. Correct completion and speed acceptance are separate gates.

| Gate | Current evidence | Status |
|---|---|---|
| Public HTTPS, login, durable API/worker/OCI storage | Authenticated simulation; four private artifacts; export ZIP checksums verified | Passed — [smoke evidence](../evidence/cloud-acceptance.json) |
| Runtime image security | Five exact ARM64 images; zero HIGH/CRITICAL findings, including unfixed findings, at the recorded scan time | Passed — [scan evidence](../evidence/container-security.json) |
| 30 days × 10 replications, <10 s worker time | 31.373 s worker / 32.473 s HTTPS pipeline | **Missed** — [measurement](../evidence/cloud-benchmark-30d-10r.json) |
| 30 days × 100 replications, <60 s worker time | 69.150 s worker / 70.260 s HTTPS pipeline | **Missed** — [measurement](../evidence/cloud-benchmark-30d-100r.json) |
| 365 days × 100 replications, <600 s worker time | 622.256 s worker / 620.002 s HTTPS pipeline; all 100 completed | **Missed** — [preserved measurement](../evidence/cloud-benchmark-365d-100r-e2e65eb.json) |
| Warm bounded APIs, p95 <500 ms with ten viewers | 250 reads; endpoint p95 166–222 ms; temporary accounts disabled | Passed — [concurrency evidence](../evidence/cloud-ten-viewers.json) |
| Cached timeline seek <500 ms; local panel update <100 ms | Observed maxima 16.6 ms / 26.8 ms; 500 visible replay markers measured | Passed for measured scope — [browser timing](../evidence/browser-hosted-performance.json) |
| Useful seeded navigation <3 s | Five warm authenticated reloads: median 3.679 s, maximum 3.731 s | **Missed** — [navigation evidence](../evidence/browser-hosted-seeded-navigation.json) |
| Browser configure→run→compare→branch→Replay→export | Workflow and ZIP integrity passed, but the intended 70% numeric arrival edit was not persisted | **Partial; must repeat after F06 fix** — [workflow evidence](../evidence/browser-hosted-workflow-final.json) |
| Worker process failure and lease recovery | Same job recovered 30 unique replications; saved fingerprints unchanged; children exited in 0.61 s | Passed during RUNNING; new overlap needs AGGREGATING check — [recovery evidence](../evidence/hosted-worker-recovery.json) |
| Backup/restore and maintenance schedule | Private cloud backup verified and restored into a scratch database; daily backup/retention services ran | Passed operational proof — [restore](../evidence/hosted-backup-restore.json), [timers](../evidence/hosted-maintenance-timers.json) |

The usable saved benchmark scenario is [Winter surge — 70% additional ED demand](https://hospital-surge.131.186.0.156.sslip.io/?scenario=scenario_ba3b15dc71504ff8a93f&run=run_c30d30b258c24199ac42&view=overview). It contains a correctly frozen 70% arrival condition and the completed 100-replication result. The browser exercise with the failed numeric edit is separate and is not evidence for that surge workload.

## Next release handoff

The pending candidate removes duplicate boot downloads, separates historical result context from the mutable draft, completes scenario/resource/map interactions, and overlaps pure selected-trace computation with parent aggregation. The overlap has 46 passing targeted regressions, including exact full-trace equality, cancellation/deadline/lease fencing, and real parent-SIGKILL cleanup. These checks do not establish a hosted speed improvement.

The same local candidate now gives the Patients screen a compact desktop schematic with five complete census rows at 1600×1000 and a 180 px timeline dock. Mobile retains one accessible census DOM styled as labeled cards, a collapsible schematic, all filters and patient selection; no horizontal page overflow was observed at 390 px. Arrival filters use the selected scenario/result timezone. The production frontend build and nine focused patient/timezone unit tests passed after these changes. Final combined browser regressions and gallery are being run separately by the release owner, including the precise observed-cutoff regression already recorded in `evidence/browser-observed-cutoff-precision-report.json`.

| Next-candidate release check | State |
|---|---|
| Final clean commit and complete local regression gate | Pending release-owner completion; no candidate commit assigned here |
| Actual-secret scan of tracked and nonignored files | Passed at recorded scan time: 607 files, 20 distinct private values, zero matches — [counts-only report](../evidence/candidate-secret-scan.json) |
| Immutable archive, exclusions, fresh build and clean-tree refusal | Local test/checks and independent review passed — [preflight](../evidence/deployment-preflight.json) |
| Hosted readiness, exact-image security scan, private artifacts and checksummed export | **Pending for next candidate** |
| Hosted 30-day 10/100 and 365-day 100 compute measurements | **Pending for next candidate** |
| Hosted AGGREGATING recovery and combined memory sampling | **Pending for next candidate** |
| Hosted corrected scenario workflow, navigation timing and final gallery | **Pending for next candidate** |

No next-candidate hosted gate has been executed. The deployed e2e65eb results above remain historical evidence for that exact commit only.

Deployment must start from a clean reviewed commit. Source packaging now reads that immutable Git revision, excludes private/runtime/evidence paths, and builds in a fresh temporary extraction so deleted files cannot survive from an older checkout. The private environment is transferred separately over verified SSH; release image tags, labels and runtime manifests use the full commit. The archive checksum is recorded in deployment evidence. One focused archive regression verifies committed bytes and exclusions; the deployment command refuses this currently dirty candidate before any host access.

The next exclusive hosted sequence is readiness/security scan and checksummed smoke, same-input 30-day 10/100 measurements, controlled AGGREGATING recovery, then the annual 100-replication workload with host memory sampling. Browser navigation and complete scenario semantics must also be repeated on the final release in a separate window. No old benchmark result is relabeled as a result from the new commit. Historical measurements remain below and in their named evidence files.

## Appendix: operational details and historical measurements

### Verified operations

- Clean source release `e2e65eb81c023ae8b4385742756662be524c29fb` deployed through strict, authenticated SSH. API, PostgreSQL and Redis readiness checks pass; nginx is bound only to 127.0.0.1:8080, and Caddy provides trusted HTTPS on 443.
- Actual authenticated simulations completed through PostgreSQL/Redis/RQ and produced private OCI artifacts with exact code/input/seed manifests. The first export ZIP passed every included SHA256 checksum (`evidence/cloud-acceptance.json`).
- The deployed API, web, PostgreSQL, Redis and Caddy images have zero HIGH/CRITICAL findings in the recorded ARM64 Trivy scan, including unfixed findings (`evidence/container-security.json`). Image digests identify the scanned builds; this is a dated scan, not a permanent guarantee.
- A1 capacity was unavailable; the approved A2 fallback has four OCPUs/eight physical ARM cores and 16 GiB. Native aarch64 execution, eight visible CPUs, unlimited container CPU quota and zero CPU throttling were checked (`evidence/oci-native-runtime.json`).
- A private PostgreSQL backup was uploaded, downloaded through instance identity, SHA256 verified and restored into a separate scratch database. Its 61 documents, 8 jobs and 17 audit events were readable; the scratch database was dropped. Anonymous bucket retrieval returned 404. The live database was not replaced (`evidence/hosted-backup-restore.json`).
- Daily backup and bounded artifact-retention timers are enabled. Both installed systemd services ran successfully (`evidence/hosted-maintenance-timers.json`).
- The RQ argument logging defect was fixed: queue payloads now carry only job identity and a safe description. The database credential was rotated, completed RQ payloads removed, Redis persistence rewritten and affected containers recreated. Checks of new logs/payloads found no database URL or current password (`evidence/credential-rotation.json`).

### Performance gates

Initial measurements use the actual public HTTPS endpoint and native OCI worker, four replica processes, planning_baseline fixture (84 initial patients), 30 calendar days and a 70% ED arrival increase. The worker measurement includes aggregation, selected trace regeneration, durable database completion and private artifact storage. Each row is one complete workload, not a distribution of run durations.

| Workload | Required worker time | Initial worker time | HTTP pipeline | Result |
|---|---:|---:|---:|---|
|30 days,10 replications|<10s|51.70s|53.23s|Missed target|
|30 days,100 replications|<60s|150.08s|151.46s|Missed target|
|365 days,100 replications|<600s|Not measured|Not measured|Not measured on this historical release|

The original results are preserved in `evidence/cloud-benchmark-30d-10r-before-optimization.json` and `evidence/cloud-benchmark-30d-100r-before-optimization.json`. Correct completion does not satisfy a missed speed target. Local macOS engine timings are separate and do not substitute for these hosted results.

Warm bounded reads passed the 500 ms target: metrics, selected end-state, census, events and checkpoint responses ranged from39–109ms maximum over five warm samples per endpoint in the 10-rep workload, and44–99ms in the 100-rep workload. These small samples use the maximum as a conservative empirical 95th percentile. Cold fetches remain separately recorded. Ten concurrent viewers are a separate gate.

`evidence/profile-cloud-30d.txt` profiles the exact frozen hosted inputs without creating jobs or changing artifacts. Profiling adds overhead. It found selected-trace full-slot snapshots and repeated percentile calculations as substantial costs; JSON/gzip were comparatively small. The optimizations preserve exact trace hashes and aggregate values. No replication count, trajectory content or accuracy requirement is relaxed.

### Optimized release measurements

Release `e4c54e2bdd8f0ad1322574256df7b1932430ffb2` uses eight bounded replica processes plus exact snapshot/blocker caching and vectorized percentile calculations. On the same frozen planning_baseline dataset and 70% ED increase,30 days ×10 replications completed in45.24s worker time (46.09s HTTPS pipeline);30 days ×100 completed in93.52s (94.22s pipeline). Both targets remain missed. The100-rep workload improved38% from150.08s. Current bounded warm reads were42–113ms maximum across five samples per endpoint (`evidence/cloud-benchmark-30d-10r-before-file-initializer.json`, `evidence/cloud-benchmark-30d-100r-before-file-initializer.json`).

A separate read-only pool startup diagnostic proves avoidable initializer-transfer overhead: eight initialized spawn children took24.07s with the complete input passed individually, versus3.78s loading the same trusted15.23MB input from one private temporary file (0.26s to write). Both cases used the actual initializer and an eight-child barrier. Forkserver with preload measured21.25s/2.34s respectively, but spawn is the recommended narrower change. The single-trial diagnostic is not simulation acceptance evidence (`evidence/cloud-pool-startup-diagnostic.json`, reproducible `scripts/profile_pool_startup.py`). The annual measurement follows the reliability and initializer patch.

### c4 reliability and initializer release

Release `c4ff451f09f3974198aa19f9e2f8305f03167899` includes private-file spawn inputs, lease-attempt fencing, idempotent creation and bounded orphan retention. All 156 Python and 31 frontend tests passed before deployment. A new authenticated simulation (`run_6625cd08b9844acc932c`) and private ZIP export (`export_049f961cc30c41b7b9dd`) completed on this exact commit; all ZIP checksums matched. All five exact runtime images had zero HIGH/CRITICAL findings in the refreshed scan. A read-only pre-benchmark artifact census found 310 objects, 310 persisted references, zero unreferenced candidates and zero missing referenced keys; nothing was deleted.

| Workload | Required worker time | Current worker time | HTTPS pipeline | Result |
|---|---:|---:|---:|---|
|30 days,10 replications|<10s|35.33s|36.63s|Missed target|
|30 days,100 replications|<60s|82.76s|84.99s|Missed target|
|365 days,100 replications|<600s|765.14s|762.23s|Missed target|

These use the same planning_baseline dataset, base seed and 70% ED increase. The original and intermediate failed timings remain preserved. The private-file initializer reduced the actual end-to-end worker time by about 10 seconds for each short workload; its standalone readiness improvement is not equivalent to the whole forecast's improvement because imports and computation overlap. Warm bounded reads on the current short workloads were 36–111 ms maximum across five warm samples per endpoint. The annual workload has a separate 15-second host/container resource sampler; its gauges are not a continuous peak measurement.

The full annual workload completed all 100 replications and saved all four private OCI manifest artifacts on this exact release (`evidence/cloud-benchmark-365d-100r-c4.json`). The selected end-state contains 54,133 patients; the API returns 500 with exact total counts. Warm endpoint maxima across five samples were 47–216 ms, below 500 ms. Cold metrics 7.13 s and cold state 12.05 s are recorded separately. Worker process-lifetime peak RSS was 5.58 GB, with child CPU reported separately; this is not a sum of simultaneous child peaks. The HTTP poll observed SUCCEEDED before final worker bookkeeping completed, so the reported 765.14 s worker duration slightly exceeds the 762.23 s client duration. All three hosted compute timing gates remain missed.

The 45 host samples within the annual execution window showed at least 9.37 GiB available memory. The sampler was stopped after final capture; it did not change the workload. These 15-second gauges do not claim a continuous maximum (`evidence/cloud-resource-samples.json`).

### Annual serial-phase diagnostic

A read-only diagnostic on the completed c4 annual artifacts recomputed the exact saved aggregate hash and measured individual phases without cProfile overhead (`evidence/profile-cloud-annual-phases.json`; reproducible `scripts/profile_annual_phases.py`). It created no jobs or object writes. Aggregate calculation took 35.78 s, comparison summary less than 1 ms, week/month summaries 2.16 s combined, and canonical serialization of all 100 replications 18.04 s. The serialized replication data is 707,167,992 bytes. Loading that saved artifact took 23.07 s, but this reload is diagnostic setup and is not part of a normal fresh forecast.

| Gzip level | Compression time | Compressed bytes | Exact restored bytes verified |
|---|---:|---:|---|
| 1 | 2.10 s | 44,157,126 | Yes |
| 3 | 2.21 s | 38,512,210 | Yes |
| 6 | 5.75 s | 30,261,834 | Yes |
| 9 (previous c4 release) | 18.87 s | 26,922,468 | Yes |

Level 9 also reproduced the stored compressed artifact's checksum. Each result is one diagnostic trial. The diagnostic did not change the then-deployed c4 release; e2e65eb subsequently adopted explicit gzip level 6. The selected annual trace's persisted timing was 90.90 s, while the 100 ordinary replications ranged from 40.93–43.52 s each (42.48 s median). These measurements identify costs but do not replace a complete benchmark after any optimization. Diagnostic process peak RSS was 3.52 GB under an explicit 10 GiB address-space limit.

### Exact aggregation and compression verification

Release e2e65eb batches numeric time rows in groups of 64, retaining the old scalar rules for irregular values. An isolated read-only process using the new function reproduced the exact saved annual aggregate checksum and reduced aggregation from 35.78 s to 22.56 s (36.9%). The first unbounded candidate did not improve timing; its evidence is retained separately. The bounded candidate and gzip level 6 passed 49 relevant regression tests plus a separate numeric-subclass regression. See `evidence/aggregation-batching-and-compression.json` and `evidence/profile-cloud-annual-batched-candidate.json`. These are scoped diagnostic gains. The c4 application was unchanged during profiling; the complete e2e65eb short-workload results below provide separate post-deployment measurements.

### Current hosted release: e2e65eb

The reviewed release `e2e65eb81c023ae8b4385742756662be524c29fb` deployed successfully after 184 Python tests, 36 frontend tests and a production build passed. The public HTTPS readiness and authentication checks passed. Smoke run `run_f4047909cedf4753ab3b` stored all four manifest artifacts in private OCI storage; export `export_41625e2d24784749a9ec` passed every ZIP checksum. All five exact runtime images have zero HIGH/CRITICAL findings in the refreshed Trivy reports. Prior c4 reports and timings are retained with `-c4` suffixes.

| Workload | Required worker time | Actual worker time | HTTPS pipeline | Result |
|---|---:|---:|---:|---|
| 30 days, 10 replications | <10 s | 31.373 s | 32.473 s | Missed target |
| 30 days, 100 replications | <60 s | 69.150 s | 70.260 s | Missed target |
| 365 days, 100 replications | <600 s | 622.256 s | 620.002 s | Missed target |

Both short workloads used the same frozen planning_baseline dataset, 70% ED increase, seed and calendar boundaries as the earlier measurements. Warm bounded endpoint maxima were 38–113 ms across five samples per endpoint; these pass the 500 ms warm-read gate. The 100-replication result is `run_c30d30b258c24199ac42`, scenario `scenario_ba3b15dc71504ff8a93f`, named “Winter surge — 70% additional ED demand.” The selected replication is 0068, with 4,245 end-state patients and 500 returned in the bounded state response. Nine resource samples during the short-workload window showed at least 12.67 GiB available host memory; the sampler was stopped before browser verification. See `evidence/cloud-resource-samples-e2e-short.json`. Final browser, concurrent-viewer, worker-recovery and annual measurements use separate exclusive windows.

### Concurrent access and worker recovery on e2e65eb

Ten distinct viewer sessions completed 250 authenticated HTTPS reads, with 50 samples per endpoint. The measured p95 values ranged from 166–222 ms across metrics, state, census, events and dataset cards; all passed the 500 ms target. Viewer mutations were rejected, and all ten temporary accounts were disabled afterward (`evidence/cloud-ten-viewers.json`). This window did not overlap simulation or browser timing workloads.

The controlled fault test killed only the verified RQ job process for synthetic run `run_42be2ed4f26746aeaca4`. Its supervisor survived and all eight pure simulation children exited within 0.61 s. After the normal, unmodified lease timeout, the same job completed all 30 unique replications; two saved seed/artifact fingerprints and the frozen input hash remained unchanged. Incomplete metrics returned 409, and the abandoned private pool input directory was removed. Recovery took 159.87 s after the signal, including lease expiration and remaining computation (`evidence/hosted-worker-recovery.json`). The API, database, supervisor and other saved results were preserved.

### Annual completion on e2e65eb

The same frozen planning_baseline inputs completed all 100 annual replications in run `run_498137b160f948a3bd9a`, with selected replication 0068 and all four checksummed private OCI artifacts. Worker time was 622.256 s and HTTPS pipeline time was 620.002 s; the 600 s compute target remains missed by 22.256 s. The worker metric includes final bookkeeping after the HTTP observer sees SUCCEEDED. The selected end-state has 54,133 patients, returned as a bounded 500 records with exact counts. Five warm samples per endpoint had maxima of 47–244 ms, passing 500 ms; cold metrics (6.727 s) and state (12.058 s) are reported separately. See `evidence/cloud-benchmark-365d-100r-e2e65eb.json`.

The exclusive annual resource window recorded 42 host/container samples at an approximately 17-second cadence (15 seconds configured plus collection time). Available host memory stayed at or above 8.30 GiB in those samples. Worker process-lifetime peak RSS was 5.58 GB; this is not the sum of simultaneous child peaks. Sampling stopped after final read checks, and no benchmark or browser workload remains active from this verification (`evidence/cloud-resource-samples-e2e-annual.json`). A subsequent local candidate overlaps pure selected-trace calculation with parent aggregation; it is not yet deployed or timed and does not change this recorded result.
