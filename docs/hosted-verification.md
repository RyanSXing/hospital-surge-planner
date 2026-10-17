# Hosted verification record

[Hospital Surge Planner](https://hospital-surge.131.186.0.156.sslip.io) is running reviewed release **`6febf00912b930fe6b00a5a748a4acde0550e505`**, with model and generator **1.1.0**. The private login handoff is `data/deployment/access.md` (ignored, mode 0600). Correct completion and speed acceptance are separate gates.

## Current release gates

| Gate | Current evidence and status |
|---|---|
| Immutable release and public HTTPS/authentication | **Passed.** Clean committed archive, fresh build, exact commit tags, HTTPS200, readiness200 and unauthenticated workspace401 — [deployment](../evidence/deployment.json), [readiness](../evidence/hosted-readiness.json) |
| Exact runtime image security | **Passed at scan time.** API, web, PostgreSQL, Redis and Caddy: zero HIGH/CRITICAL findings, including unfixed, with refreshed Trivy database — [five-image report](../evidence/container-security.json) |
| Current curated fixtures and immutable upgrade | **Passed.** Both generator1.1.0 365-day planning/stress datasets validate; exactly two datasets and one starter added. All25 old datasets/scenarios and31 jobs retain their hashes, revisions and timestamps — [upgrade proof](../evidence/hosted-seed-upgrade.json) |
| Selected-time snapshot projection | **Open correctness finding.** At fractional cutoffs, active inpatient remaining time can drift from its absolute expected end; ordinary reserved and active-clinic snapshots can omit required residual state. A local projection-only repair is under review. Hosted browser, recovery and annual gates are held until its reviewed release is deployed. |
| Actual simulation, private OCI artifacts and ZIP integrity | **Passed.** One day × two replications, all four private artifacts and every exported checksum verified — [smoke](../evidence/cloud-acceptance.json) |
| 30 days × 10 replications, worker <10 s | **Missed.** 33.070 s worker /33.524 s HTTPS pipeline — [measurement](../evidence/cloud-benchmark-30d-10r.json) |
| 30 days × 100 replications, worker <60 s | **Missed.** 76.125 s worker /76.595 s HTTPS pipeline — [measurement](../evidence/cloud-benchmark-30d-100r.json) |
| 365 days × 100 replications, worker <600 s | **Pending.** Historical e2e65eb measured622.256 s; it is not evidence for this release. |
| Ten viewers, warm bounded endpoint p95 <500 ms | **Pending refresh.** Historical e2e65eb passed250 reads. |
| Controlled AGGREGATING process failure/recovery | **Pending.** The tracked harness verifies the workhorse identity, child cleanup, natural120-second lease and saved input/replication fingerprints. |
| Hosted navigation, corrected full workflow, timeline and500-marker Replay | **Pending refresh in a separate browser window.** Local release checks passed; historical hosted evidence is not relabeled. |
| Fresh private backup and isolated restore of final state | **Pending refresh after final curation.** Prior operational proof passed; daily backup/retention timers remain enabled. |

The current benchmarks use `demo-v1-1-0-planning_baseline-41021-365`, base seed20261016 and a70% ED arrival increase. Both short measurements share that immutable dataset. Earlier e2e65eb/c4 measurements used generator1.0.0 and therefore have different frozen input hashes. Named historical reports remain preserved; this generator upgrade is not presented as a controlled same-input cross-release comparison. Each compute result is one complete workload, not a distribution of run durations.

The approved host is native ARM64 OCI A2Flex with four OCPUs/eight physical cores and16GiB, within the approved budget. Eight bounded simulation children share one RQ runner. The current smoke measured warm endpoint maxima38–51ms over five samples each. The100-replication forecast completed with 4245 end-state patients and500 returned records; warm endpoint maxima ranged 39–114ms. The separate ten-viewer gate is still pending.

The hosted sequence keeps heavy forecasts, browser timing and fault injection in separate windows. The annual workload is held for the snapshot projection repair and short-run timing review. Controlled recovery and final browser acceptance are also held for that repair. A four-trial read-only numerical-library thread-cap diagnostic reproduced all eight ordinary outputs, the aggregate and selected trace exactly. Mean pool time was20.808s with production defaults and20.526s with caps of one (1.36% difference); readiness stayed4.23–4.24s. This small diagnostic gain does not close either compute target. The live configuration is unchanged — [diagnostic](../evidence/cloud-thread-cap-diagnostic-6feb.json). No unfinished gate is inferred from local tests or projected diagnostic gains.

A separate [read-only serial-phase profile](../evidence/cloud-parent-phases-6feb.json) reproduced the saved aggregate and all four compressed artifact checksums for both short runs. On10/100 replications, aggregation took0.474/2.056s, per-replication local serialization/compression/checksum preparation0.207/2.138s, and the combined replication artifact serialization/compression0.198/1.971s. Cold OCI SDK import took1.61s, instance-principal client setup0.25–0.27s, input load/copy/hash about1.93s. Selected-trace serialization/compression was about0.65s. The PUT client was replaced by a strict no-network stub, so actual upload latency and durable per-replication SQL costs remain unmeasured. These small phases do not establish a sufficient optimization for the missed targets.

## Release and operational handoff

Deployment packages committed bytes with `git archive`, excludes private/runtime/evidence paths, and builds in a fresh temporary directory. The private environment travels separately over verified SSH; full commit image tags, labels and result manifests identify the deployed source. [Deployment evidence](../evidence/deployment.json) records the archive checksum. Passwords, SSH keys, database credentials and browser cookies remain outside tracked files.

The new current starter is `scenario-demo-v1-1-0-planning_baseline-41021-365`. A completed100-replication current result is [Winter surge —70% additional ED demand](https://hospital-surge.131.186.0.156.sslip.io/?scenario=scenario_7fd0a41f5c0249f1b2e8&run=run_6278e8f0faf644209992&view=overview). Old immutable datasets and results remain readable. Model1.1.0 rejects recomputation of incompatible historical runs and offers a fresh clone; authentic observed resets retain their validated semantics. Final user-facing curation will preserve result history and archive only known synthetic verification scenarios.

## Appendix: operational details and historical measurements

### Verified operations

- Clean source release `e2e65eb81c023ae8b4385742756662be524c29fb` deployed through strict, authenticated SSH. API, PostgreSQL and Redis readiness checks pass; nginx is bound only to 127.0.0.1:8080, and Caddy provides trusted HTTPS on 443.
- Actual authenticated simulations completed through PostgreSQL/Redis/RQ and produced private OCI artifacts with exact code/input/seed manifests. The first export ZIP passed every included SHA256 checksum (`evidence/cloud-acceptance-e2e65eb.json`).
- The deployed API, web, PostgreSQL, Redis and Caddy images have zero HIGH/CRITICAL findings in the recorded ARM64 Trivy scan, including unfixed findings (`evidence/container-security-e2e65eb.json`). Image digests identify the scanned builds; this is a dated scan, not a permanent guarantee.
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

### Historical hosted release: e2e65eb

The reviewed release `e2e65eb81c023ae8b4385742756662be524c29fb` deployed successfully after 184 Python tests, 36 frontend tests and a production build passed. The public HTTPS readiness and authentication checks passed. Smoke run `run_f4047909cedf4753ab3b` stored all four manifest artifacts in private OCI storage; export `export_41625e2d24784749a9ec` passed every ZIP checksum. All five exact runtime images have zero HIGH/CRITICAL findings in the refreshed Trivy reports. Prior c4 reports and timings are retained with `-c4` suffixes.

| Workload | Required worker time | Actual worker time | HTTPS pipeline | Result |
|---|---:|---:|---:|---|
| 30 days, 10 replications | <10 s | 31.373 s | 32.473 s | Missed target |
| 30 days, 100 replications | <60 s | 69.150 s | 70.260 s | Missed target |
| 365 days, 100 replications | <600 s | 622.256 s | 620.002 s | Missed target |

Both short workloads used the same frozen planning_baseline dataset, 70% ED increase, seed and calendar boundaries as the earlier measurements. Warm bounded endpoint maxima were 38–113 ms across five samples per endpoint; these pass the 500 ms warm-read gate. The 100-replication result is `run_c30d30b258c24199ac42`, scenario `scenario_ba3b15dc71504ff8a93f`, named “Winter surge — 70% additional ED demand.” The selected replication is 0068, with 4,245 end-state patients and 500 returned in the bounded state response. Nine resource samples during the short-workload window showed at least 12.67 GiB available host memory; the sampler was stopped before browser verification. See `evidence/cloud-resource-samples-e2e-short.json`. Final browser, concurrent-viewer, worker-recovery and annual measurements use separate exclusive windows.

### Concurrent access and worker recovery on e2e65eb

Ten distinct viewer sessions completed 250 authenticated HTTPS reads, with 50 samples per endpoint. The measured p95 values ranged from 166–222 ms across metrics, state, census, events and dataset cards; all passed the 500 ms target. Viewer mutations were rejected, and all ten temporary accounts were disabled afterward (`evidence/cloud-ten-viewers-e2e65eb.json`). This window did not overlap simulation or browser timing workloads.

The controlled fault test killed only the verified RQ job process for synthetic run `run_42be2ed4f26746aeaca4`. Its supervisor survived and all eight pure simulation children exited within 0.61 s. After the normal, unmodified lease timeout, the same job completed all 30 unique replications; two saved seed/artifact fingerprints and the frozen input hash remained unchanged. Incomplete metrics returned 409, and the abandoned private pool input directory was removed. Recovery took 159.87 s after the signal, including lease expiration and remaining computation (`evidence/hosted-worker-recovery-e2e65eb.json`). The API, database, supervisor and other saved results were preserved.

### Annual completion on e2e65eb

The same frozen planning_baseline inputs completed all 100 annual replications in run `run_498137b160f948a3bd9a`, with selected replication 0068 and all four checksummed private OCI artifacts. Worker time was 622.256 s and HTTPS pipeline time was 620.002 s; the 600 s compute target remains missed by 22.256 s. The worker metric includes final bookkeeping after the HTTP observer sees SUCCEEDED. The selected end-state has 54,133 patients, returned as a bounded 500 records with exact counts. Five warm samples per endpoint had maxima of 47–244 ms, passing 500 ms; cold metrics (6.727 s) and state (12.058 s) are reported separately. See `evidence/cloud-benchmark-365d-100r-e2e65eb.json`.

The exclusive annual resource window recorded 42 host/container samples at an approximately 17-second cadence (15 seconds configured plus collection time). Available host memory stayed at or above 8.30 GiB in those samples. Worker process-lifetime peak RSS was 5.58 GB; this is not the sum of simultaneous child peaks. Sampling stopped after final read checks, and no benchmark or browser workload remains active from this verification (`evidence/cloud-resource-samples-e2e-annual.json`). Release 6febf009 subsequently deployed pure selected-trace calculation overlapping parent aggregation; the historical result above remains unchanged.
