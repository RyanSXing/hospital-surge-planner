# Hosted verification record

The application is running at <https://hospital-surge.131.186.0.156.sslip.io> on the approved OCI deployment. The private local login handoff is `data/deployment/access.md` (ignored, mode 0600). It contains only the application URL and admin credentials.

## Verified operations

- Clean source release `26c3122490b3f8ba9b69347dc8a7a8d94a05a16d` deployed through strict, authenticated SSH. API, PostgreSQL and Redis readiness checks pass; nginx is bound only to 127.0.0.1:8080, and Caddy provides trusted HTTPS on 443.
- Actual authenticated simulations completed through PostgreSQL/Redis/RQ and produced private OCI artifacts with exact code/input/seed manifests. The first export ZIP passed every included SHA256 checksum (`evidence/cloud-acceptance.json`).
- The deployed API, web, PostgreSQL, Redis and Caddy images have zero HIGH/CRITICAL findings in the recorded ARM64 Trivy scan, including unfixed findings (`evidence/container-security.json`). Image digests identify the scanned builds; this is a dated scan, not a permanent guarantee.
- A1 capacity was unavailable; the approved A2 fallback has four OCPUs/eight physical ARM cores and 16 GiB. Native aarch64 execution, eight visible CPUs, unlimited container CPU quota and zero CPU throttling were checked (`evidence/oci-native-runtime.json`).
- A private PostgreSQL backup was uploaded, downloaded through instance identity, SHA256 verified and restored into a separate scratch database. Its 61 documents, 8 jobs and 17 audit events were readable; the scratch database was dropped. Anonymous bucket retrieval returned 404. The live database was not replaced (`evidence/hosted-backup-restore.json`).
- Daily backup and bounded artifact-retention timers are enabled. Both installed systemd services ran successfully (`evidence/hosted-maintenance-timers.json`).
- The RQ argument logging defect was fixed: queue payloads now carry only job identity and a safe description. The database credential was rotated, completed RQ payloads removed, Redis persistence rewritten and affected containers recreated. Checks of new logs/payloads found no database URL or current password (`evidence/credential-rotation.json`).

## Performance gates

Initial measurements use the actual public HTTPS endpoint and native OCI worker, four replica processes, canonical stress snapshot, 30 calendar days and a 70% ED arrival increase. The worker measurement includes aggregation, selected trace regeneration, durable database completion and private artifact storage. Each row is one complete workload, not a distribution of run durations.

| Workload | Required worker time | Initial worker time | HTTP pipeline | Result |
|---|---:|---:|---:|---|
|30 days,10 replications|<10s|51.70s|53.23s|Missed target|
|30 days,100 replications|<60s|150.08s|151.46s|Missed target|
|365 days,100 replications|<600s|Pending|Pending|Held for profiling/optimization|

The original results are preserved in `evidence/cloud-benchmark-30d-10r-before-optimization.json` and `evidence/cloud-benchmark-30d-100r-before-optimization.json`. Correct completion does not satisfy a missed speed target. Local macOS engine timings are separate and do not substitute for these hosted results.

Warm bounded reads passed the 500 ms target: metrics, selected end-state, census, events and checkpoint responses ranged from39–109ms maximum over five warm samples per endpoint in the 10-rep workload, and44–99ms in the 100-rep workload. These small samples use the maximum as a conservative empirical 95th percentile. Cold fetches remain separately recorded. Ten concurrent viewers are a separate gate.

`evidence/profile-cloud-30d.txt` profiles the exact frozen hosted inputs without creating jobs or changing artifacts. Profiling adds overhead. It found selected-trace full-slot snapshots and repeated percentile calculations as substantial costs; JSON/gzip were comparatively small. The annual benchmark is held until these costs are addressed and the shorter workloads are measured again. No replication count, trajectory content or accuracy requirement is relaxed.
