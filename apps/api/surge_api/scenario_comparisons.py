"""Read-only, descriptive comparison of two saved scenario configurations.

Each side is its own ensemble. Matching random seeds do not turn separately
saved runs into paired causal evidence, and this projection never ranks plans.
"""

from __future__ import annotations

import copy
import math
from datetime import UTC, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .artifacts import ArtifactStore
from .db import Document, Job
from .domain import date, normalize_conditions, serialize
from .model_versions import ModelVersionMismatch, require_current_model
from .series import bound_comparison_series, visible_series

CONFIGURATION_FIELDS = (
    "dataset_version_id",
    "start_at",
    "end_at",
    "timezone",
    "horizon_calendar_days",
    "base_seed",
    "replications",
    "conditions",
    "interventions",
    "updates",
    "hospital_operations",
    "measurement_start_at",
    "state_origin",
    "branch_at",
    "parent_run_group_id",
    "parent_replication_id",
    "source_replication_id",
    "branch_strategy",
    "branch_replication_index",
    "reconciliation",
)

DELTA_METRICS = (
    ("average_wait_per_patient_hours", "Average wait per patient", "hours", 1),
    ("peak_inpatient_queue", "Peak patients waiting for a bed", "patients", 1),
    ("medical_supply_average_percent", "Average medical supplies", "percent", 1),
    ("success_score_percent", "Patients treated within 24 hours", "percent", 1),
    ("arrivals", "Patient arrivals", "patients", 1),
    ("discharges", "Completed discharges", "patients", 1),
    ("ward_utilization", "Ward utilization", "percent", 100),
    ("icu_utilization", "ICU utilization", "percent", 100),
)


def reason(code, message):
    return {"code": code, "message": message}


def scenario_end(scenario):
    if scenario.get("end_at"):
        return date(scenario["end_at"])
    return date(scenario["start_at"]).astimezone(ZoneInfo(scenario["timezone"])) + timedelta(
        days=scenario["horizon_calendar_days"]
    )


def measurement_start(scenario):
    return date(scenario.get("measurement_start_at") or scenario.get("branch_at") or scenario["start_at"])


def normalized_saved_configuration(session, user, row):
    # Enqueue normalizes legacy absence aliases and materialized percentage
    # counts. Reuse that exact rule, projecting only baseline unit metadata,
    # so a successful rerun can match without rewriting its saved draft.
    units = session.scalar(
        select(Document.data["units"]).where(
            Document.id == row.data.get("dataset_version_id"),
            Document.kind == "dataset",
            Document.workspace_id == user["workspace_id"],
        )
    )
    return normalize_conditions(row.data, {"units": units or []})


def matches_saved_configuration(job, row, saved):
    payload = job.payload
    frozen = payload.get("scenario", {})
    return (
        payload.get("scenario_id") == row.id
        and frozen.get("id") == row.id
        and payload.get("source_draft_revision") == row.revision
        and payload.get("dataset_version_id") == saved.get("dataset_version_id")
        and all(frozen.get(field) == saved.get(field) for field in CONFIGURATION_FIELDS)
    )


def legacy_severity(job):
    return job.payload.get("hospital_operations_model_version") == "1.0" and bool(
        (job.payload.get("scenario", {}).get("hospital_operations") or {}).get("severity_mix")
    )


def run_permission(session, user, row):
    if row.data.get("archived"):
        return False, "This scenario is archived. Restore it in the scenario library before running it."
    if user.get("role") not in {"planner", "admin"}:
        return False, "Your account has read-only access."
    scenario = row.data
    if scenario.get("state_origin") != "observed_reset":
        parent_id = scenario.get("parent_run_group_id")
        if not parent_id and scenario.get("parent_replication_id"):
            replication = session.get(Document, scenario["parent_replication_id"])
            if not replication or replication.workspace_id != user["workspace_id"]:
                return False, "Review the saved scenario's simulation history before running it."
            parent_id = replication.data.get("run_group_id")
        if parent_id:
            parent = session.get(Job, parent_id)
            if not parent or parent.kind != "run" or parent.workspace_id != user["workspace_id"]:
                return False, "Review the saved scenario's simulation history before running it."
            if legacy_severity(parent):
                return (
                    False,
                    "This simulation history retains the earlier severity model. Create a new independent scenario for corrected inpatient stays.",
                )
            try:
                require_current_model(parent.payload)
            except ModelVersionMismatch:
                return (
                    False,
                    "Review configuration and create a new independent scenario to use the current model.",
                )
    return True, None


def aggregate_problem(job, value):
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("scalar_metrics"), dict)
        or not value["scalar_metrics"]
    ):
        return "The completed simulation has no recorded summary measures."
    scenario = job.payload["scenario"]
    requested = scenario.get("replications")
    if (
        type(requested) is not int
        or requested <= 0
        or job.completed != requested
        or job.total != requested
        or value.get("replications_completed") != requested
        or value.get("replications_requested") != requested
    ):
        return "The simulation does not contain all requested results."
    version = job.payload.get("model_version")
    operations = job.payload.get("hospital_operations_model_version")
    if not isinstance(version, str) or not version or value.get("model_version") != version:
        return "The saved model version cannot be matched to these results."
    if scenario.get("hospital_operations") and (not isinstance(operations, str) or not operations):
        return "The saved hospital-operations model version is unavailable."
    if value.get("hospital_operations_model_version") != operations:
        return "The saved hospital-operations model does not match these results."
    try:
        if (
            date(value["start_at"]) != date(scenario["start_at"])
            or date(value["end_at"]) != scenario_end(scenario)
            or value.get("timezone") != scenario.get("timezone")
        ):
            return "The recorded result period does not match the saved configuration."
    except (KeyError, ValueError, TypeError):
        return "The recorded result period is unavailable."
    return None


def frozen_context_problem(session, user, row, job):
    identity = job.payload.get("scenario_revision_id")
    revision = session.get(Document, identity) if isinstance(identity, str) and identity else None
    if (
        not revision
        or revision.kind != "scenario_revision"
        or revision.workspace_id != user["workspace_id"]
        or revision.data.get("scenario_id") != row.id
        or any(
            revision.data.get(field) != job.payload["scenario"].get(field) for field in CONFIGURATION_FIELDS
        )
    ):
        return "The result cannot be linked to this saved configuration's frozen revision."
    dataset = session.scalar(
        select(Document.id).where(
            Document.id == job.payload.get("dataset_version_id"),
            Document.kind == "dataset",
            Document.workspace_id == user["workspace_id"],
        )
    )
    if dataset is None:
        return "The result's hospital baseline dataset is unavailable in this workspace."
    return None


def compact_metrics(job, aggregate, project_job):
    keys = (
        "scalar_metrics",
        "metric_definitions",
        "series",
        "daily",
        "start_at",
        "end_at",
        "timezone",
        "model_version",
        "hospital_operations_model_version",
        "replications_completed",
        "replications_requested",
        "uncertainty_label",
        "warnings",
    )
    value = {key: copy.deepcopy(aggregate[key]) for key in keys if key in aggregate}
    for field in ("series", "daily"):
        if not isinstance(value.get(field), list):
            value[field] = []
    # A local-calendar horizon can include two partial endpoint days.
    daily = value["daily"]
    value["daily"] = [daily[index] for index in visible_series(daily, 366)]
    value["context"] = {
        **project_job(job)["context"],
        "source_draft_revision": job.payload.get("source_draft_revision"),
        "timezone": aggregate["timezone"],
        "start_at": aggregate["start_at"],
        "end_at": aggregate["end_at"],
        "measurement_start_at": measurement_start(job.payload["scenario"]).isoformat(),
        "evidence_scope": "ensemble",
        "comparison_basis": "independent_simulations",
    }
    return value


def scenario_side(session, user, row, project_job):
    can_run, blocked = run_permission(session, user, row)
    query = (
        select(Job)
        .where(
            Job.workspace_id == user["workspace_id"],
            Job.kind == "run",
            Job.payload["scenario_id"].as_string() == row.id,
            Job.payload["comparison_id"].as_string().is_(None),
        )
        .order_by(Job.created_at.desc(), Job.id.desc())
    )
    latest = session.scalar(query.limit(1))
    scenario = serialize(row)
    scenario["end_at"] = scenario_end(row.data).astimezone(UTC).isoformat().replace("+00:00", "Z")
    side = {
        "scenario": scenario,
        "state": "missing",
        "reasons": [],
        "run": None,
        "latest_run": project_job(latest) if latest else None,
        "metrics": None,
        "can_run": can_run,
        "can_run_reason": blocked,
    }
    if row.data.get("archived"):
        side.update(state="archived", reasons=[reason("archived", blocked)])
        return side
    normalized = normalized_saved_configuration(session, user, row)
    completed = session.scalars(
        query.where(
            Job.status == "SUCCEEDED",
            Job.payload["source_draft_revision"].as_integer() == row.revision,
        )
    )
    current = next((job for job in completed if matches_saved_configuration(job, row, normalized)), None)
    if current:
        if legacy_severity(current):
            side.update(
                state="stale",
                reasons=[
                    reason(
                        "legacy_severity_model",
                        "These results use the earlier severity model, which also extended emergency assessment. Run an updated independent simulation for corrected inpatient stays.",
                    )
                ],
            )
            return side
        side["run"] = project_job(current)
        problem = frozen_context_problem(session, user, row, current)
        if problem:
            side.update(state="unavailable", reasons=[reason("frozen_context_unavailable", problem)])
            return side
        metadata = current.result.get("aggregate_artifact")
        if not metadata:
            side.update(
                state="unavailable",
                reasons=[
                    reason("metrics_unavailable", "The completed simulation's result file is unavailable.")
                ],
            )
            return side
        try:
            aggregate = ArtifactStore().get_json_cached(metadata)
        except Exception:  # noqa: BLE001 -- a failed storage read is an unavailable result, not a fabricated value
            # Storage/verification failures make this read unavailable; never
            # replace missing result evidence with numeric defaults.
            side.update(
                state="unavailable",
                reasons=[
                    reason("metrics_unavailable", "The completed simulation's result file could not be read.")
                ],
            )
            return side
        problem = aggregate_problem(current, aggregate)
        if problem:
            side.update(state="unavailable", reasons=[reason("result_context_mismatch", problem)])
            return side
        side.update(state="ready", metrics=compact_metrics(current, aggregate, project_job))
        if latest and latest.id != current.id and matches_saved_configuration(latest, row, normalized):
            side["reasons"].append(
                reason(
                    "newer_attempt", "Showing the latest completed result. A newer attempt is also listed."
                )
            )
        return side
    if latest and matches_saved_configuration(latest, row, normalized):
        if latest.status in {"QUEUED", "RUNNING", "AGGREGATING", "RETRY_WAIT", "CANCEL_REQUESTED"}:
            side.update(
                state="running",
                reasons=[reason("result_in_progress", "This saved configuration is being simulated.")],
            )
        elif latest.status in {"FAILED", "CANCELLED"}:
            state = "failed" if latest.status == "FAILED" else "cancelled"
            side.update(
                state=state,
                reasons=[
                    reason(
                        "result_" + state,
                        "The latest simulation did not complete. Run this saved configuration again.",
                    )
                ],
            )
        else:
            side.update(
                state="unavailable",
                reasons=[
                    reason("result_unavailable", "The latest simulation has no usable completed results.")
                ],
            )
    elif latest:
        side.update(
            state="stale",
            reasons=[
                reason(
                    "saved_configuration_changed",
                    "Run this saved configuration to compare its current settings. Previous results use different saved settings.",
                )
            ],
        )
    else:
        side["reasons"].append(reason("no_saved_result", "Run this saved configuration to see its results."))
    return side


def compatibility(left, right):
    reasons = []
    if left["state"] != "ready" or right["state"] != "ready":
        reasons.append(
            reason(
                "results_not_ready",
                "Both saved configurations need complete matching results before differences can be calculated.",
            )
        )
    a, b = left["scenario"], right["scenario"]
    for field, code, label in (
        ("dataset_version_id", "different_dataset", "hospital baseline datasets"),
        ("horizon_calendar_days", "different_horizon", "simulation lengths"),
        ("timezone", "different_timezone", "local time zones"),
    ):
        if a.get(field) != b.get(field):
            reasons.append(reason(code, f"The scenarios use different {label}. View each result separately."))
    try:
        for first, second, code, label in (
            (date(a["start_at"]), date(b["start_at"]), "different_start", "start times"),
            (scenario_end(a), scenario_end(b), "different_end", "end times"),
            (
                measurement_start(a),
                measurement_start(b),
                "different_measurement_period",
                "measurement periods",
            ),
        ):
            if first != second:
                reasons.append(
                    reason(code, f"The scenarios use different {label}. View each result separately.")
                )
    except (KeyError, ValueError, TypeError):
        reasons.append(reason("period_unavailable", "The saved simulation periods cannot be matched."))
    if left["state"] == right["state"] == "ready":
        a, b = left["metrics"], right["metrics"]
        if a.get("model_version") != b.get("model_version"):
            reasons.append(
                reason(
                    "different_model",
                    "The scenarios were simulated with different engine versions. Differences are unavailable.",
                )
            )
        first, second = a.get("hospital_operations_model_version"), b.get("hospital_operations_model_version")
        if first is not None and second is not None and first != second:
            reasons.append(
                reason(
                    "different_operations_model",
                    "The scenarios use different hospital-operations model versions. Differences are unavailable.",
                )
            )
    return {"comparable": not reasons, "reasons": reasons}


def finite_median(side, metric):
    value = (side.get("metrics") or {}).get("scalar_metrics", {}).get(metric)
    if isinstance(value, dict):
        value = value.get("p50")
    return value if type(value) in (int, float) and math.isfinite(value) else None


def descriptive_deltas(left, right, comparable):
    values = []
    for metric, label, unit, scale in DELTA_METRICS:
        first, second = finite_median(left, metric), finite_median(right, metric)
        first = first * scale if first is not None else None
        second = second * scale if second is not None else None
        available = comparable and first is not None and second is not None
        difference = second - first if available else None
        values.append(
            {
                "metric": metric,
                "label": label,
                "unit": unit,
                "left": first,
                "right": second,
                "difference": difference,
                "percent_change": 100 * difference / first if available and first != 0 else None,
                "available": available,
            }
        )
    return values


DISPLAY_NAMES = {
    "ED_MAIN": "Emergency arrivals",
    "DIRECT_WARD_MAIN": "Scheduled admissions",
    "UNIT-WARD-A": "Ward A",
    "UNIT-WARD-B": "Ward B",
    "UNIT-WARD-C": "Ward C",
    "UNIT-ICU": "Intensive care",
    "UNIT-ED": "Emergency department",
    "arrival_multiplier": "Arrival curve",
    "arrival_batch": "Additional patient arrivals",
    "unit_configuration": "Beds and staffing",
    "staff_unavailability": "Staff absence",
    "staff_absence": "Staff absence",
    "care_mix_override": "Care needs",
    "stage_duration_multiplier": "Treatment time",
    "staff_existing": "Additional qualified hospital staff",
    "step": "Steady",
    "ramp": "Builds up",
    "piecewise_linear": "Edited curve",
    "wave": "Rises and falls",
    "rn": "Nurses",
    "provider": "Providers",
    "support": "Support staff",
    "at": "Date and time",
    "start_at": "From",
    "end_at": "Until",
    "unit_id": "Department",
    "entry_stream_id": "Arrival group",
    "multiplier": "Times usual arrivals",
    "control_points": "Arrival points",
    "physical_capacity": "Installed beds",
    "enabled_capacity": "Available beds",
    "staffed_capacity": "Staffed beds",
    "staff_counts": "Staff on duty",
    "absence_percent": "Staff absent (%)",
}


def display_configuration(value):
    if isinstance(value, dict):
        return {
            DISPLAY_NAMES.get(key, key.replace("_", " ").capitalize()): display_configuration(item)
            for key, item in value.items()
            if key not in {"id", "update_id", "source", "input_kind", "surge_percent"}
            and not (key == "count" and "absence_percent" in value)
        }
    if isinstance(value, list):
        return [display_configuration(item) for item in value]
    return DISPLAY_NAMES.get(value, value) if isinstance(value, str) else value


def configuration_differences(left, right):
    rows = []

    def add(field, label, first, second, unit=None):
        if first != second:
            rows.append(
                {
                    "field": field,
                    "label": label,
                    "left": first,
                    "right": second,
                    **({"unit": unit} if unit else {}),
                }
            )

    for field, label, unit in (
        ("dataset_version_id", "Hospital baseline", None),
        ("start_at", "Simulation starts", None),
        ("horizon_calendar_days", "Simulation length", "days"),
        ("timezone", "Local time zone", None),
        ("base_seed", "Simulation sample seed", None),
        ("replications", "Simulation repetitions", None),
    ):
        add(field, label, left.get(field), right.get(field), unit)
    for field, label in (
        ("conditions", "Arrival, bed and staffing settings"),
        ("interventions", "Planned hospital responses"),
        ("updates", "Planned events and updates"),
    ):
        add(
            field,
            label,
            display_configuration(left.get(field, [])),
            display_configuration(right.get(field, [])),
        )
    a, b = left.get("hospital_operations") or {}, right.get("hospital_operations") or {}
    for level, label in (("low", "Low severity"), ("medium", "Medium severity"), ("high", "High severity")):
        first, second = (a.get("severity_mix") or {}).get(level), (b.get("severity_mix") or {}).get(level)
        for field, description, unit in (
            ("percentage", "patient share", "percent"),
            ("average_stay_hours", "average inpatient stay", "hours"),
        ):
            add(
                f"severity_mix.{level}.{field}",
                f"{label} {description}",
                first.get(field) if first else "Not modeled",
                second.get(field) if second else "Not modeled",
                unit,
            )
    for field, label, unit in (
        ("initial_percent", "Starting medical supplies", "percent"),
        ("capacity", "Maximum supply stock", "stock units"),
        ("usage_per_patient_day", "Supply use per patient-day", "stock units"),
        ("refill_every_days", "Supply refill interval", "days"),
        ("refill_percent", "Supply refill amount", "percent"),
    ):
        first, second = a.get("supplies"), b.get("supplies")
        add(
            f"supplies.{field}",
            label,
            first.get(field) if first else "Not modeled",
            second.get(field) if second else "Not modeled",
            unit,
        )
    add(
        "disruptions",
        "Treatment disruptions",
        display_configuration(a.get("disruptions", [])),
        display_configuration(b.get("disruptions", [])),
    )
    return rows


def compare_saved_scenarios(session, user, left_row, right_row, project_job, max_points=1000):
    left = scenario_side(session, user, left_row, project_job)
    right = scenario_side(session, user, right_row, project_job)
    match = compatibility(left, right)
    if match["comparable"]:
        bound_comparison_series([left, right], max_points)
    else:
        for side in (left, right):
            if side["metrics"]:
                metrics = side["metrics"]
                original = metrics["series"]
                indices = visible_series(original, max_points)
                metrics["series"] = [original[index] for index in indices]
                metrics["context"]["resolution"] = {
                    "source_point_count": len(original),
                    "returned_point_count": len(indices),
                    "max_points": max_points,
                    "source_indices": indices,
                    "method": "multivariate_minmax_envelope" if len(indices) < len(original) else "raw",
                    "values_are_original_points": True,
                    "aligned_across_plans": False,
                }
    return {
        "kind": "saved_scenarios",
        "scope": "independent_ensembles",
        "left": left,
        "right": right,
        "compatibility": match,
        "deltas": descriptive_deltas(left, right, match["comparable"]),
        "configuration_differences": configuration_differences(left["scenario"], right["scenario"]),
        "paired_evidence": None,
        "evidence_label": "Independent simulation results. Differences describe the saved results; they are not paired estimates.",
    }
