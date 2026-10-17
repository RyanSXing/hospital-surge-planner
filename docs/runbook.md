# Hospital Surge Planner operations runbook

## Deployment status and prerequisites

The build is intended for one OCI Compute VM with separate web, API, PostgreSQL, Redis and simulation-worker containers and private Object Storage. It is not a high-availability deployment. Run `make oci-readiness` to refresh `evidence/oci-readiness.json`; that command performs read-only SDK calls and does not create resources or establish that a shape is available for immediate allocation.

The initial inventory on 2026-10-17 authenticated successfully in `us-chicago-1` and found no existing VCN, instance, bucket or active child compartment in the inspected account scope. A positive quota is not a price, remaining-credit or capacity guarantee. Before provisioning, establish the intended compartment, supported architecture/shape, maximum cost and public endpoint. Target 8 vCPUs and 16 GiB as a benchmark reference; map OCPUs to vCPUs for the selected shape instead of treating them as interchangeable.

Create a project-specific VCN/subnet, a VM with durable storage, private artifact and backup buckets, and a narrowly scoped instance identity. Allow inbound HTTPS (TCP 443; UDP 443 optional for HTTP/3). Restrict SSH to an approved administration address/path. The Compose file never publishes PostgreSQL, Redis or API to the public interface. Caddy uses the TLS-ALPN challenge so port 80 is unnecessary. DNS for `DOMAIN` must resolve to the VM for public certificates.

Grant the instance identity only needed object operations in this project's buckets. Example policy structure, replacing names with reviewed project values:

```text
Allow dynamic-group hospital-surge-workers to manage objects in compartment hospital-surge where any {target.bucket.name='hospital-surge-artifacts', target.bucket.name='hospital-surge-backups'}
Allow dynamic-group hospital-surge-workers to read buckets in compartment hospital-surge where any {target.bucket.name='hospital-surge-artifacts', target.bucket.name='hospital-surge-backups'}
```

The dynamic-group rule should identify only the intended instance(s). Do not copy laptop OCI API private keys into an image. On the VM use `OCI_AUTH=instance_principal`; the SDK obtains and refreshes its workload token. Keep buckets private. An object key is not authorization; downloads must go through the application ownership check.

## Configuration

Copy `.env.example` to a private file or run `make setup`, then configure:

- `APP_ENV=production`, `COMPOSE_APP_ENV=production`, `DEMO_MODE=false` for hosted operation.
- Long unique `ADMIN_PASSWORD`, `SESSION_SECRET`, `POSTGRES_PASSWORD`; do not reuse local values for a public host. Restrict the env file to mode 0600.
- `PUBLIC_BASE_URL=https://<domain>` and `ALLOWED_ORIGINS=https://<domain>`.
- `DOMAIN=<domain>` resolving to the deployment host. Caddy ACME registration does not require an email.
- `COMPOSE_ARTIFACT_BACKEND=oci`, `ARTIFACT_BACKEND=oci`, `OCI_AUTH=instance_principal`, `OCI_REGION`, `OCI_NAMESPACE`, `OCI_ARTIFACT_BUCKET`, `OCI_BACKUP_BUCKET`.
- `WORKER_CONCURRENCY`, `JOB_TIMEOUT_SECONDS=1200`, replication/horizon/upload/queue limits appropriate to the measured host.

Compose sets the container PostgreSQL and Redis URLs internally. The source `.env` used for ordinary local development may retain SQLite; don't point a public host at the local development session. OIDC is an optional future organizational-auth adapter configuration; the current hosted login is the configured administrator login, not an implemented SSO integration.

## Build, migrate and start

On a prepared Docker host:

```sh
export CODE_COMMIT="$(python3 scripts/code_version.py)"
docker compose --env-file .env -f infra/compose.yaml build
docker compose --env-file .env -f infra/compose.yaml up -d postgres redis
docker compose --env-file .env -f infra/compose.yaml run --rm api .venv/bin/alembic -c infra/alembic.ini upgrade head
docker compose --env-file .env -f infra/compose.yaml up -d api worker web
docker compose --env-file .env -f infra/compose.yaml --profile tls up -d tls
docker compose --env-file .env -f infra/compose.yaml ps
```

For an existing authorized host, `make deploy-demo` performs source upload and the sequence above using `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_ENV_FILE` and optional `DEPLOY_DIR`. It requires a trusted existing SSH host-key entry; verify the fingerprint through the approved administration channel before adding it. It does not create a VM, open a firewall, purchase a domain or bypass host verification. Keep the host-side deployment directory out of other users' access because it contains `.env`.

The API and web images have fixed version tags for their Python/uv/Node/nginx bases. Resolve and record their image digests after the first validated build. `IMAGE_TAG` should identify an immutable release, ideally a commit. Source changes require a new reviewed release tag. Record image digests, migration revision, endpoint, worker count and run IDs in `evidence/deployment.json` and operational records. Do not record passwords or tokens.

Migrations are a controlled one-off job. `infra/migrations/versions/0001_initial.py` establishes documents, jobs, sessions, audit and idempotency tables. The initial migration can adopt equivalent development tables, but it must not be used to hide schema drift; run `alembic check` when models change and add a migration. Back up before upgrades. A rollback restores the reviewed application image plus a compatible database schema; never blindly downgrade a database containing newer results.

## Health and completion proof

Check `/api/health/live` for process liveness and `/api/health/ready` for dependency/schema readiness. A healthy process does not demonstrate the whole flow. The hosted release acceptance must record:

1. Login succeeds and unauthenticated mutations fail.
2. Load a synthetic fixture, create a scenario, submit a run and record its actual job/run IDs.
3. Confirm computation executed in the OCI worker, the run reaches a legitimate terminal status, and its manifest matches the input/model/seeds.
4. Verify an artifact written to the private OCI bucket can be downloaded through authorized API retrieval and passes checksum verification.
5. Inspect a day/unit, compare plans, apply an update, replay a retained run, export and reload its inputs.
6. Measure the required preview/standard/long-horizon budgets on this host, reporting actual timings and sample counts.
7. Complete a private PostgreSQL backup and an isolated restore test; record evidence.

`docs/acceptance-tracker.json` covers F01–F31, W01–W15 and E01–E16. Change a row to `verified` only with concrete implementation paths and test/run evidence. P2 rows remain deferred. An unimplemented control, incomplete run, local mock, or screenshot cannot stand in for completion.

## Backups and restoration

Local SQLite: `make backup`, then `make restore-check BACKUP=<path>`. These use SQLite's online backup API and restore into a new temporary database, check integrity, and query the core tables. Local restore evidence is not proof of hosted PostgreSQL recovery.

Hosted PostgreSQL: run `bash infra/backup.sh` from the deployment checkout. It makes a consistent custom-format `pg_dump`, uploads it and a SHA256 manifest to the private OCI backup bucket using the application instance identity, and retains seven days of local dump files. Configure a seven-day lifecycle rule for the `backups/` prefix in the private backup bucket. The job fails if the upload fails; no successful backup is claimed on a failed command.

Install `infra/hospital-backup.service` and `infra/hospital-backup.timer` after replacing their deployment path. The timer runs daily at approximately 03:15 UTC. Check `systemctl list-timers hospital-backup.timer` and `journalctl -u hospital-backup.service`. Record and alert on failures. A budget/monitoring system should also check absence of a new backup within 24 hours.

To verify a downloaded PostgreSQL dump without touching the active database, run:

```sh
.venv/bin/python scripts/database_backup.py verify --compose --file backups/<downloaded>.dump
```

This creates a unique scratch database, restores the dump, queries the core tables, and drops only that scratch database. Confirm the downloaded SHA256 manifest before restoration. For a real recovery: stop API/worker writes, retain the damaged database/volume, restore to a new database using `pg_restore --exit-on-error --no-owner`, apply only compatible migrations, inspect row counts/run manifests and private artifact references, then change the reviewed connection target and restart services. Retain the prior database until recovery is verified. The initial project objectives are at most 24 hours of database changes lost and restoration within 4 hours; these are not production service guarantees.

## Failure recovery and observability

Persisted database records own run definitions and completion. Redis is a dispatch/progress component. Never delete the database/volume to repair a queue. Inspect API and worker logs with `docker compose --env-file .env -f infra/compose.yaml logs --tail 200 api worker`; keep request/run IDs but no dataset rows or tokens in ordinary logs.

Exercise and record worker termination, Redis restart, unavailable object storage, invalid foreign keys, concurrent stale draft saves, browser reload during a run, failed replay chunk retrieval and background-tab reconnection. Recovery must preserve frozen inputs and seeds, prevent duplicate completed work and label incomplete data. Measure queue depth, throughput, memory/CPU, artifact bytes, errors and cancellation latency. Failed invariants fail a run.

`docker compose ... down` stops services and preserves named volumes. Do not use `down --volumes` on a deployment holding needed data. Large imports, runs and exports must respect the configured quotas. Failed or cancelled comparisons must never appear as successful complete rankings.

## Local verification recorded on 2026-10-17

The local Docker Desktop ARM64 stack completed PostgreSQL migration, fixture seed, authenticated API login, a 2-replication one-day run through Redis/RQ, selected-state retrieval with 84 initial patients, and ZIP export. See `evidence/compose-smoke.json`. This is local container evidence; OCI hosting, private bucket access and public TLS remain separate acceptance gates.

`evidence/benchmark-30d-100r-surge70.json` records 22.784 seconds for a 30-day +70% ED surge with 100 replications, four engine processes, aggregation and regeneration of the selected trace. The host was macOS ARM64 with 11 logical CPUs and Python 3.12.13. The median arrival count was 5,214 and the configured expectation was 5,220. This measurement excludes API/database/artifact serialization and is not a measurement on the planned 8-vCPU/16-GiB OCI host. Run the deployed API benchmark before claiming the standard-run target there.

The local PostgreSQL backup `hospital-20261017T071943Z.dump` restored successfully into an isolated scratch database; core queries returned 7 document rows and 2 job rows. The scratch database was dropped after verification. `evidence/restore-verification.json` records the result. No active application database was replaced.

For HTTP-only container verification set `COMPOSE_APP_ENV=development` on the commands so the browser can send local session cookies. Public deployments must use the production setting with HTTPS. Run `.venv/bin/python scripts/compose_smoke.py` after the stack starts to repeat its local workflow probe. It creates only synthetic scenarios/runs in that local stack.

## Reference documentation checked during implementation

- [uv project/Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)
- [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)
- [OCI Python SDK](https://github.com/oracle/oci-python-sdk)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

These references support implementation tools. They do not validate the hospital simulation or the synthetic parameters.

## Release identity, CI and artifact retention

`make check` runs Python tests, frontend unit tests, and the production web build. `make test-e2e` runs the desktop/mobile browser suite; `make audit-dependencies` checks both locked dependency environments. `.github/workflows/ci.yml` runs these checks plus a separate local-container smoke on a clean runner. It has read-only repository permissions and never deploys. The workflow is prepared; a remote GitHub run is not claimed before the repository is pushed.

Make derives `CODE_COMMIT` from Git; dirty source is marked `-dirty` and an uncommitted checkout is explicitly labeled. Deployment requires a clean commit, passes the exact revision into image labels and runtime manifests, and persists it in the host's private `.env`. `DEPLOY_KNOWN_HOSTS` can point to the project host-key file authenticated through OCI console history.

Install `hospital-retention.service` and `.timer` alongside the backup units after adjusting their deployment paths. At approximately 04:15 UTC daily, retention processes at most 100 eligible records. It expires old unselected traces, failed import staging, and exports according to workspace policy, preserving selected traces, frozen inputs, revisions, aggregates and audit records. Inspect first with `docker compose --env-file .env -f infra/compose.yaml run --rm --no-deps api python -m surge_api.manage retention`; the timer adds `--apply --limit 100`. Failed object deletions retain retry metadata.

The approved host was provisioned with an A2 capacity fallback retaining eight ARM vCPUs and 16 GiB at a lower estimated cost. See `docs/oci-provisioning-plan.md` and `evidence/oci-provisioning.json`. The deployment login will be provided through private ignored `data/deployment/access.md`; credentials do not belong in the tracked runbook or evidence.

## Hosted image verification

The runtime dependency and patched service images passed the actual Linux ARM64 Trivy HIGH/CRITICAL preflight; see `evidence/container-preflight-security.json` and `docs/container-security.md`. The PostgreSQL runtime is Alpine17.11: for an existing Debian-based database volume, perform a logical dump/restore into a new volume and reindex as needed instead of switching libc under an existing cluster. Keep the original volume until restore verification succeeds. The new OCI database starts on a fresh volume.

Run `.venv/bin/python scripts/cloud_acceptance.py --expected-commit COMMIT` after deployment. It authenticates using private `data/deployment/production.env`, executes a synthetic run, checks bounded state/census/events/checkpoints, downloads an export, verifies every ZIP checksum, and asserts manifest provenance. Add `--days 30 --replications 100 --skip-export --output evidence/cloud-benchmark-30d-100r.json` for the standard timing gate; use 365 days for the annual gate. Timing covers actual HTTPS queue/execution/durable result completion, while replay/export timing is separate. `--run-id ID` resumes polling without duplicating work and labels the timing as resumed.
