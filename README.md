# Hospital Surge Planner

A planning workspace for configuring hospital surge scenarios, running constrained patient-flow simulations, comparing saved scenarios, and inspecting the events behind a forecast. The included operational data and medical parameters are synthetic engineering fixtures. The product does not dispatch patients or make clinical treatment decisions.

The complete initial scope is P0 and P1 in [the build specification](docs/reference/hospital-surge-planner-build-spec.md). Current implementation and verification are tracked separately in [the acceptance ledger](docs/acceptance-tracker.md). Deferred P2 items include live hospital integrations, calibrated prediction, generalized optimization, AI assistance and 3D.

## Hosted application

Open [AEGIS Console](https://aegisconsole.131.186.0.156.sslip.io). The previous hospital-surge address remains available for saved links. Private sign-in details are saved locally in `data/deployment/access.md`, outside version control. [Hosted verification](docs/hosted-verification.md) records the deployed release, completed workloads, measured performance limits, recovery and backup evidence.

The app has two primary pages: **Configuration** for the current hospital baseline and simulation inputs, and **Analysis** with **Summary**, **Replay**, **Analytics**, and **Comparison**. Analytics includes outcomes and patient/unit inspection. Main setup uses duration, draggable daily arrivals, editable bed counts and per-unit nurse/provider/support sliders. Exact optional settings are under **More parameters**. Summary identifies recorded bottlenecks; Analytics presents its charts in one bookmarked workspace. Replay shows recorded bed occupancy on a hospital floor plan; Comparison compares two saved library scenarios. See the [replay and comparison guide](docs/replay-and-scenario-comparison.md), [single-hospital workflow](docs/single-hospital-workflow.md), and [workflow guide](docs/overview-analysis-flow.md).

## Start locally

Prerequisites: Python 3.12, `uv`, Node.js 24 and npm. Docker is needed for the PostgreSQL/Redis deployment stack, but the local development path uses SQLite and local artifacts.

```sh
make setup
make migrate
make seed-demo
make dev
```

Open [http://localhost:5173](http://localhost:5173). The API is [http://127.0.0.1:8000/api](http://127.0.0.1:8000/api); OpenAPI is available at `/openapi.json`. Local development uses a visibly marked seeded session. `make setup` creates private `.env` settings with unique generated secrets and preserves an existing `.env`.

The frontend is React/TypeScript/Vite with Mantine components; the API is FastAPI; the model uses Python/NumPy/SimPy; durable deployment uses PostgreSQL, Redis/RQ, private OCI Object Storage and separate API/worker containers. Locked Python dependencies are in `uv.lock`; locked frontend dependencies are in `apps/web/package-lock.json`.

## Data and visual assets

`make generate-data` reproduces the planning and stress snapshots, historical arrivals, staff rosters, resource inventories and travel assumptions from the versioned generator in `packages/engine/surge_engine/generator.py`. Both snapshots pass the same import validation used by the app. Completed runs and exports retain their frozen inputs, generator version, seeds and checksums.

Generator 1.1.0 includes the required historical admission timestamps. Its fixture IDs include the generator version, fixture, seed and coverage days (for example, `demo-v1-1-0-planning_baseline-41021-365`). Startup adds the current 365-day planning and stress fixtures and one current starter scenario if absent. Upgrades preserve every older dataset, scenario and run; repeated startup also preserves edits to the starter. Default navigation selects the newest scenario, so the newly added starter provides valid current input immediately after upgrade. Explicit historical links keep their original context.

The campus geometry, product mark, charts, capacity grids, and Replay floor plan are code-native assets. `apps/web/public/assets/campus.geojson` contains synthetic local geographic context; `apps/web/src/pages/ReplayFloorPlan.tsx` renders the hospital map from exact recorded units and installed bed slots. The optional local reference is centered on Vanderbilt University Medical Center using official location and visitor-map sources; the floor plan is illustrative. Bed states, queue counts and movement evidence come from the selected recorded run. The original six supplied images remain references under `docs/reference/`; the subsequent user-supplied white hospital-management references govern the current visual style. Illustrative reference counts never replace computed results. Locally served Barlow Condensed and IBM Plex Sans include their Open Font License notices in `apps/web/public/fonts/`; interface icons use the locked Lucide dependency.

## Developer commands

| Command | Purpose |
|---|---|
| `make setup` | Install locked dependencies and create local settings |
| `make dev` | Start local API and web server together |
| `make migrate` | Apply versioned Alembic database migrations |
| `make seed-demo` | Generate/validate fixtures and load the local workspace |
| `make validate-data` | Validate both canonical synthetic snapshots |
| `make simulate-demo` | Run the model without the browser |
| `make test` | Run model/API/contract checks |
| `make test-e2e` | Run the browser acceptance suite |
| `make benchmark` | Measure the 30-day, 10-replication preview workload |
| `make benchmark-full` | Measure 30-day and 365-day, 100-replication workloads |
| `make build` | Build the frontend and production container images |
| `make containers-up` | Start PostgreSQL/Redis, migrate, then start API/worker/web |
| `make containers-down` | Stop containers without deleting named data volumes |
| `make backup` | Make a consistent local SQLite backup |
| `make restore-check BACKUP=backups/<file>.sqlite` | Restore into a temporary database and verify integrity |
| `make oci-readiness` | Read current OCI access/resources without provisioning |
| `make deploy-demo` | Deploy to a configured, existing authorized OCI VM |
| `make audit-status` | List requirements still awaiting acceptance evidence |

The `demo` command names identify the supplied synthetic fixtures, not a separate product. A successful container build is not proof of a completed hosted run; deployment, performance and restoration evidence belong under `evidence/`.

See [the runbook](docs/runbook.md) for hosted configuration, identity/storage setup, migrations, backups, recovery, health checks and deployment verification. The specification's numerical performance budgets remain targets until measured on the chosen host.
