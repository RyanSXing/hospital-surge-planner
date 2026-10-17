# Shared implementation contract

The user requests a complete working application. Call the product Hospital Surge Planner. Synthetic data is provenance, not product/demo branding. docs/reference/hospital-surge-planner-build-spec.md is authoritative; images are appearance references.

## Module boundaries

- `packages/engine/surge_engine`: generator.py, simulation.py, aggregate.py, validation.py, __init__.py. Public functions `generate_dataset(fixture='planning_baseline', seed=41021, days=365) -> dict`, `validate_dataset(dataset) -> dict` (valid/errors/warnings), `run_replication(dataset, scenario, replication_index=0, keep_trace=True) -> dict`, `aggregate_results(replications, scenario=None) -> dict`.
- `apps/api/surge_api`: FastAPI API, persistence models/services, jobs/artifacts/auth. Imports surge_engine via installed editable package or PYTHONPATH. Engine returns pure JSON-serializable data, ISO UTC timestamps. `pyproject.toml` at root owned by infrastructure agent; do not edit without coordination.
- `apps/web`: React TypeScript Vite, calls `/api` prefixed API proxied to FastAPI port 8000. Server routes may be declared directly at /api or app mounted /api; backend to support /api. Frontend Vite port 5173. Use `fetch` credentials include. Session cookie local seeded session initially, explicit login for hosted writable app.

## Scenario inputs

`id`, `name`, `dataset_version_id`, `start_at`, `timezone='America/Chicago'`, `horizon_calendar_days=30`, `base_seed=20261016`, `replications=100`, `conditions` (canonical control_points plus convenience shape/surge_percent allowed), `interventions` (kind staff_existing, physical_overflow, staffed_overflow, clinic, partner_transfer; quantities/start_at/duration optional), `updates`.

## Dataset

`id`/`dataset_version_id`, `fixture`, `synthetic=true`, `snapshot_at`, `timezone`, `seed`, `manifest`, `facilities`, `units`, `slots`, `staff`, `assignments`, `equipment_pools`, `patients`, `routes`, `vehicles`, `cohorts`, `los_templates`, `arrival_profiles`, `history`, `presets`, `intervention_templates`, `update_fixtures`, `geometry`, `assumptions`. Canonical entities/IDs from spec. Schema compatibility aliases are allowed, never replace core requirements with shortcuts.

## Replication output

`replication_id`, `replication_index`, `seed`, `scalar_metrics`, `series` (hourly rows: at, elapsed_minutes, ward_occupied, ward_staffed, icu_occupied, icu_staffed, ed_occupied, ed_staffed, inpatient_queue, ward_queue, icu_queue, ed_queue, waiting_patient_hours, plus units list/map when available), `daily` (local_date, start_at,end_at, inpatient_waiting_patient_hours, peak_inpatient_queue, occupied/staffed/capacity metrics), `events` (sequence_number,occurred_at,elapsed_minutes,event_type,patient_id,from_unit_id,to_unit_id,resource_ids,reason_code,payload), `checkpoints` (at,elapsed_minutes,event_sequence,patients,units,vehicles), `patients` all encountered entities with state intervals for reconstruction.

## Ensemble output

`scalar_metrics` maps each metric to {p10,p50,p90,mean,min,max}; `series` hourly aggregate rows with `at`, `elapsed_minutes`, and {p10,p50,p90,mean} under each metric key; `daily` analogous rows; `selected_replication_index`, `replications_completed`, `replications_requested`, `timezone`.

## Decisions resolving audited seams

- Equipment operations explicit `add`, `decommission`, `fail`, `repair`; nonnegative free availability and separate deficits; preserve existing patient commitments.
- Capacity lost before pickup: release mission/reservation, retain source state, requeue; after dispatch: honor existing destination commitment, show receiving deficit, block new commitments. Never delete/divert without modeled path.
- Rank feasible plans by median full-horizon inpatient waiting, median peak queue, additional staff-hours then supplied monetary cost, activation time and stable plan ID. Costs absent are N/A.
- Transfer reservation expiry is scheduled latest pickup, default 120 minutes from acceptance (versioned configurable parameter).
- Stable unit/slot ID ordering breaks compatible-destination ties.
- Complete application means all P0 and P1; P2 later extensions remain outside initial acceptance.
