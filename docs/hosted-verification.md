# Hosted verification record

The application is running at <https://hospital-surge.131.186.0.156.sslip.io> on the approved OCI deployment. The private local login handoff is `data/deployment/access.md` (ignored, mode 0600). It contains only the application URL and admin credentials.

## Verified operations

- Clean source release `c4ff451f09f3974198aa19f9e2f8305f03167899` deployed through strict, authenticated SSH. API, PostgreSQL and Redis readiness checks pass; nginx is bound only to 127.0.0.1:8080, and Caddy provides trusted HTTPS on 443.
- Actual authenticated simulations completed through PostgreSQL/Redis/RQ and produced private OCI artifacts with exact code/input/seed manifests. The first export ZIP passed every included SHA256 checksum (`evidence/cloud-acceptance.json`).
- The deployed API, web, PostgreSQL, Redis and Caddy images have zero HIGH/CRITICAL findings in the recorded ARM64 Trivy scan, including unfixed findings (`evidence/container-security.json`). Image digests identify the scanned builds; this is a dated scan, not a permanent guarantee.
- A1 capacity was unavailable; the approved A2 fallback has four OCPUs/eight physical ARM cores and 16 GiB. Native aarch64 execution, eight visible CPUs, unlimited container CPU quota and zero CPU throttling were checked (`evidence/oci-native-runtime.json`).
- A private PostgreSQL backup was uploaded, downloaded through instance identity, SHA256 verified and restored into a separate scratch database. Its 61 documents, 8 jobs and 17 audit events were readable; the scratch database was dropped. Anonymous bucket retrieval returned 404. The live database was not replaced (`evidence/hosted-backup-restore.json`).
- Daily backup and bounded artifact-retention timers are enabled. Both installed systemd services ran successfully (`evidence/hosted-maintenance-timers.json`).
- The RQ argument logging defect was fixed: queue payloads now carry only job identity and a safe description. The database credential was rotated, completed RQ payloads removed, Redis persistence rewritten and affected containers recreated. Checks of new logs/payloads found no database URL or current password (`evidence/credential-rotation.json`).

## Performance gates

Initial measurements use the actual public HTTPS endpoint and native OCI worker, four replica processes, planning_baseline fixture (84 initial patients), 30 calendar days and a 70% ED arrival increase. The worker measurement includes aggregation, selected trace regeneration, durable database completion and private artifact storage. Each row is one complete workload, not a distribution of run durations.

| Workload | Required worker time | Initial worker time | HTTP pipeline | Result |
|---|---:|---:|---:|---|
|30 days,10 replications|<10s|51.70s|53.23s|Missed target|
|30 days,100 replications|<60s|150.08s|151.46s|Missed target|
|365 days,100 replications|<600s|Pending|Pending|Pending final optimization release|

The original results are preserved in `evidence/cloud-benchmark-30d-10r-before-optimization.json` and `evidence/cloud-benchmark-30d-100r-before-optimization.json`. Correct completion does not satisfy a missed speed target. Local macOS engine timings are separate and do not substitute for these hosted results.

Warm bounded reads passed the 500 ms target: metrics, selected end-state, census, events and checkpoint responses ranged from39–109ms maximum over five warm samples per endpoint in the 10-rep workload, and44–99ms in the 100-rep workload. These small samples use the maximum as a conservative empirical 95th percentile. Cold fetches remain separately recorded. Ten concurrent viewers are a separate gate.

`evidence/profile-cloud-30d.txt` profiles the exact frozen hosted inputs without creating jobs or changing artifacts. Profiling adds overhead. It found selected-trace full-slot snapshots and repeated percentile calculations as substantial costs; JSON/gzip were comparatively small. The optimizations preserve exact trace hashes and aggregate values. No replication count, trajectory content or accuracy requirement is relaxed.

## Optimized release measurements

Release `e4c54e2bdd8f0ad1322574256df7b1932430ffb2` uses eight bounded replica processes plus exact snapshot/blocker caching and vectorized percentile calculations. On the same frozen planning_baseline dataset and 70% ED increase,30 days ×10 replications completed in45.24s worker time (46.09s HTTPS pipeline);30 days ×100 completed in93.52s (94.22s pipeline). Both targets remain missed. The100-rep workload improved38% from150.08s. Current bounded warm reads were42–113ms maximum across five samples per endpoint (`evidence/cloud-benchmark-30d-10r-before-file-initializer.json`, `evidence/cloud-benchmark-30d-100r-before-file-initializer.json`).

A separate read-only pool startup diagnostic proves avoidable initializer-transfer overhead: eight initialized spawn children took24.07s with the complete input passed individually, versus3.78s loading the same trusted15.23MB input from one private temporary file (0.26s to write). Both cases used the actual initializer and an eight-child barrier. Forkserver with preload measured21.25s/2.34s respectively, but spawn is the recommended narrower change. The single-trial diagnostic is not simulation acceptance evidence (`evidence/cloud-pool-startup-diagnostic.json`, reproducible `scripts/profile_pool_startup.py`). The annual measurement follows the reliability and initializer patch.

## Current hosted release

Release `c4ff451f09f3974198aa19f9e2f8305f03167899` includes private-file spawn inputs, lease-attempt fencing, idempotent creation and bounded orphan retention. All 156 Python and 31 frontend tests passed before deployment. A new authenticated simulation (`run_6625cd08b9844acc932c`) and private ZIP export (`export_049f961cc30c41b7b9dd`) completed on this exact commit; all ZIP checksums matched. All five exact runtime images had zero HIGH/CRITICAL findings in the refreshed scan. A read-only pre-benchmark artifact census found 310 objects, 310 persisted references, zero unreferenced candidates and zero missing referenced keys; nothing was deleted.

| Workload | Required worker time | Current worker time | HTTPS pipeline | Result |
|---|---:|---:|---:|---|
|30 days,10 replications|<10s|35.33s|36.63s|Missed target|
|30 days,100 replications|<60s|82.76s|84.99s|Missed target|
|365 days,100 replications|<600s|765.14s|762.23s|Missed target|

These use the same planning_baseline dataset, base seed and 70% ED increase. The original and intermediate failed timings remain preserved. The private-file initializer reduced the actual end-to-end worker time by about 10 seconds for each short workload; its standalone readiness improvement is not equivalent to the whole forecast's improvement because imports and computation overlap. Warm bounded reads on the current short workloads were 36–111 ms maximum across five warm samples per endpoint. The annual workload has a separate 15-second host/container resource sampler; its gauges are not a continuous peak measurement.

The full annual workload completed all 100 replications and saved all four private OCI manifest artifacts on this exact release (`evidence/cloud-benchmark-365d-100r.json`). The selected end-state contains 54,133 patients; the API returns 500 with exact total counts. Warm endpoint maxima across five samples were 47–216 ms, below 500 ms. Cold metrics 7.13 s and cold state 12.05 s are recorded separately. Worker process-lifetime peak RSS was 5.58 GB, with child CPU reported separately; this is not a sum of simultaneous child peaks. The HTTP poll observed SUCCEEDED before final worker bookkeeping completed, so the reported 765.14 s worker duration slightly exceeds the 762.23 s client duration. All three hosted compute timing gates remain missed.

The 45 host samples within the annual execution window showed at least 9.37 GiB available memory. The sampler was stopped after final capture; it did not change the workload. These 15-second gauges do not claim a continuous maximum (`evidence/cloud-resource-samples.json`).

## Annual serial-phase diagnostic

A read-only diagnostic on the completed c4 annual artifacts recomputed the exact saved aggregate hash and measured individual phases without cProfile overhead (`evidence/profile-cloud-annual-phases.json`; reproducible `scripts/profile_annual_phases.py`). It created no jobs or object writes. Aggregate calculation took 35.78 s, comparison summary less than 1 ms, week/month summaries 2.16 s combined, and canonical serialization of all 100 replications 18.04 s. The serialized replication data is 707,167,992 bytes. Loading that saved artifact took 23.07 s, but this reload is diagnostic setup and is not part of a normal fresh forecast.

| Gzip level | Compression time | Compressed bytes | Exact restored bytes verified |
|---|---:|---:|---|
| 1 | 2.10 s | 44,157,126 | Yes |
| 3 | 2.21 s | 38,512,210 | Yes |
| 6 | 5.75 s | 30,261,834 | Yes |
| 9 (current) | 18.87 s | 26,922,468 | Yes |

Level 9 also reproduced the stored compressed artifact's checksum. Each result is one diagnostic trial; gzip settings remain unchanged on the deployed release. The selected annual trace's persisted timing was 90.90 s, while the 100 ordinary replications ranged from 40.93–43.52 s each (42.48 s median). These measurements identify costs but do not replace a complete benchmark after any optimization. Diagnostic process peak RSS was 3.52 GB under an explicit 10 GiB address-space limit.

## Candidate aggregation and compression verification

The next source revision batches numeric time rows in groups of 64, retaining the old scalar rules for irregular values. An isolated read-only process using the new function reproduced the exact saved annual aggregate checksum and reduced aggregation from 35.78 s to 22.56 s (36.9%). The first unbounded candidate did not improve timing; its evidence is retained separately. The bounded candidate and gzip level 6 passed 49 relevant regression tests plus a separate numeric-subclass regression. See `evidence/aggregation-batching-and-compression.json` and `evidence/profile-cloud-annual-batched-candidate.json`. These are scoped diagnostic gains; the deployed c4 application was unchanged, and a fresh complete hosted benchmark is required after release.
