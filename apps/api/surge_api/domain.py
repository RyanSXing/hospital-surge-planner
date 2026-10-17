from __future__ import annotations

import copy
import math
from datetime import datetime
from zoneinfo import ZoneInfo

from .db import Document, digest, now, uid

COLLECTIONS = {
    "facilities",
    "units",
    "slots",
    "staff",
    "assignments",
    "equipment_pools",
    "patients",
    "routes",
    "vehicles",
    "cohorts",
    "los_templates",
    "arrival_profiles",
    "intervention_templates",
    "presets",
    "update_fixtures",
    "capacity_policies",
    "resource_profiles",
    "partner_equipment",
    "geometry",
    "virtual_locations",
    "organizations",
}
COLLECTIONS.update(
    {
        "clinic_policies",
        "entry_streams",
        "pathway_profiles",
        "capabilities",
        "hour_of_day_baseline",
        "weekday_baseline",
        "history",
        "historical_daily_summaries",
        "assumptions",
    }
)


def date(value):
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("Timestamp requires an explicit UTC offset")
    return parsed


def scenario_defaults(data, dataset):
    return {
        "id": uid("scenario"),
        "name": "Untitled scenario",
        "dataset_version_id": dataset["id"],
        "start_at": dataset["snapshot_at"],
        "timezone": dataset.get("timezone", "America/Chicago"),
        "horizon_calendar_days": 30,
        "base_seed": 20261016,
        "replications": 100,
        "conditions": [],
        "interventions": [],
        "updates": [],
        "archived": False,
        **data,
    }


def normalize_conditions(data, dataset):
    value = copy.deepcopy(data)
    conditions = value.get("conditions", [])
    if not isinstance(conditions, list):
        return value
    for condition in conditions:
        if not isinstance(condition, dict):
            continue
        if condition.get("kind") == "staff_absence":
            condition["kind"] = "staff_unavailability"
            unit = next(
                (u for u in dataset.get("units", []) if u.get("unit_id") == condition.get("unit_id")), None
            )
            baseline = (unit or {}).get("baseline_staff", {}).get("rn", 0)
            percent = condition.get("absence_percent", 0)
            if isinstance(percent, (int, float)) and math.isfinite(percent) and 0 <= percent <= 100:
                condition["count"] = math.ceil(baseline * percent / 100)
    return value


def validate_scenario(data, dataset=None):
    """Validate all nested scenario inputs before they can become worker jobs."""
    from datetime import timedelta

    errors, warnings = [], []

    def error(field, message):
        errors.append({"field": field, "message": message})

    def finite(value, minimum=0):
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value >= minimum
        )

    def timestamp(value, field):
        try:
            return date(value)
        except (ValueError, KeyError, TypeError, AttributeError):
            error(field, "Use a timestamp with an explicit UTC offset")
            return None

    def records(field):
        value = data.get(field, [])
        if not isinstance(value, list):
            error(field, "Supply an array of objects")
            return []
        if len(value) > 1000:
            error(field, "At most 1000 records are supported")
        result = []
        for i, item in enumerate(value):
            if not isinstance(item, dict):
                error(f"{field}.{i}", "Supply an object")
            else:
                result.append((i, item))
        return result

    def interval(item, key, required=False):
        lo = timestamp(item.get("start_at", None if required else data.get("start_at")), key + ".start_at")
        hi = timestamp(item["end_at"], key + ".end_at") if item.get("end_at") else None
        if required and not item.get("end_at"):
            error(key + ".end_at", "An explicit end time is required")
        if lo and hi and hi <= lo:
            error(key + ".end_at", "End must follow start")
        return lo, hi

    if not isinstance(data, dict):
        return {
            "valid": False,
            "errors": [{"field": "scenario", "message": "Supply a JSON object"}],
            "warnings": [],
        }
    for name, lower, upper in [("horizon_calendar_days", 1, 365), ("replications", 1, 500)]:
        value = data.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or not lower <= value <= upper:
            error(name, f"Must be an integer between {lower} and {upper}")
    start = timestamp(data.get("start_at"), "start_at")
    try:
        zone = ZoneInfo(data.get("timezone", "America/Chicago"))
    except (KeyError, ValueError, TypeError):
        zone = None
        error("timezone", "Use a valid IANA timezone")
    end = None
    if (
        start
        and zone
        and isinstance(data.get("horizon_calendar_days"), int)
        and 1 <= data["horizon_calendar_days"] <= 365
    ):
        end = start.astimezone(zone) + timedelta(days=data["horizon_calendar_days"])
    if dataset and start and start != date(dataset["snapshot_at"]):
        error(
            "start_at",
            "Start must equal the selected dataset snapshot; supply a complete new observation to reset time",
        )
    if data.get("end_at"):
        supplied = timestamp(data["end_at"], "end_at")
        if supplied and start and supplied <= start:
            error("end_at", "End must follow start")
        if supplied and end and data.get("state_origin") != "observed_reset" and supplied != end:
            error("end_at", "End must match the local-calendar horizon")
        if data.get("state_origin") == "observed_reset":
            end = supplied
    if (
        not isinstance(data.get("base_seed"), int)
        or isinstance(data.get("base_seed"), bool)
        or data.get("base_seed", -1) < 0
    ):
        error("base_seed", "Seed must be a nonnegative integer")
    for field, limit in [("max_expected_arrivals", 400000), ("max_events_per_replication", 2000000)]:
        if field in data and (
            not isinstance(data[field], int) or isinstance(data[field], bool) or not 1 <= data[field] <= limit
        ):
            error(field, f"Must remain within the server maximum of {limit}")
    units = {u["unit_id"] for u in (dataset or {}).get("units", [])}
    sites = {f["facility_id"] for f in (dataset or {}).get("facilities", [])}
    staff = {s["staff_id"] for s in (dataset or {}).get("staff", [])}
    streams = {s["entry_stream_id"] for s in (dataset or {}).get("entry_streams", [])}
    profiles = {r["resource_profile_id"] for r in (dataset or {}).get("resource_profiles", [])}
    cohorts = {r["cohort_id"] for r in (dataset or {}).get("cohorts", [])}
    windows = []
    for index, condition in records("conditions"):
        key = f"conditions.{index}"
        kind = condition.get("kind", "arrival_multiplier")
        if kind not in {
            "arrival_multiplier",
            "care_mix_override",
            "staff_unavailability",
            "staff_absence",
            "arrival_batch",
            "stage_duration_multiplier",
        }:
            error(key + ".kind", "Unsupported condition kind")
            continue
        if kind in {"staff_unavailability", "staff_absence"}:
            interval(condition, key, True)
            if condition.get("unit_id") not in units and not condition.get("staff_ids"):
                error(key + ".unit_id", "Select a declared unit or explicit staff IDs")
            if condition.get("staff_ids") is not None and (
                not isinstance(condition["staff_ids"], list)
                or any(not isinstance(sid, str) or sid not in staff for sid in condition["staff_ids"])
            ):
                error(key + ".staff_ids", "Staff IDs must reference the declared roster")
            if (
                not finite(condition.get("count", 0))
                or not finite(condition.get("absence_percent", 0))
                or condition.get("absence_percent", 0) > 100
            ):
                error(key, "Absence requires nonnegative count and0–100percent")
            continue
        if kind == "arrival_batch":
            if (
                not isinstance(condition.get("count"), int)
                or isinstance(condition.get("count"), bool)
                or not 0 <= condition["count"] <= 10000
            ):
                error(key + ".count", "Batch count must be an integer from0to10000")
            timestamp(condition.get("at", data.get("start_at")), key + ".at")
            if not finite(condition.get("spread_minutes", 0)):
                error(key + ".spread_minutes", "Spread must be finite and nonnegative")
            continue
        if kind == "stage_duration_multiplier":
            interval(condition, key, True)
            if not finite(condition.get("multiplier")) or condition.get("multiplier", 0) <= 0:
                error(key + ".multiplier", "Stage multiplier must be positive and finite")
            if condition.get("stage_kind") not in {"ward", "icu", "ed", "clinic", "ambulatory"}:
                error(key + ".stage_kind", "Select a modeled service stage")
            continue
        stream = condition.get(
            "entry_stream_id",
            {"ed": "ED_MAIN", "direct_ward": "DIRECT_WARD_MAIN"}.get(
                condition.get("arrival_stream"), "ED_MAIN"
            ),
        )
        if streams and stream not in streams:
            error(key + ".entry_stream_id", "Choose a declared exogenous entry stream")
        override = condition.get(
            "care_mix_override", condition.get("weights") if kind == "care_mix_override" else None
        )
        if override is not None and (
            not isinstance(override, dict)
            or not override
            or any(k not in {"discharge", "ward", "icu", "ambulatory"} | profiles | cohorts for k in override)
            or any(not finite(v) for v in override.values())
            or not math.isclose(sum(override.values()), 1, abs_tol=1e-8)
        ):
            error(key + ".care_mix_override", "Use known care/cohort/profile weights summing to one")
        if kind == "care_mix_override":
            interval(condition, key, True)
            continue
        percent = condition.get("surge_percent", 0)
        if not isinstance(percent, (int, float)) or isinstance(percent, bool) or not math.isfinite(percent):
            error(key + ".surge_percent", "Percent must be finite")
            percent = 0
        if not finite(condition.get("multiplier", 1 + percent / 100)):
            error(key + ".multiplier", "Multiplier must be finite and nonnegative")
        if condition.get("shape", "step") not in {"step", "wave", "piecewise_linear", "ramp"}:
            error(key + ".shape", "Unsupported arrival pattern")
        points = condition.get("control_points", [])
        if not isinstance(points, list):
            error(key + ".control_points", "Supply an array of control points")
            points = []
        if points and len(points) < 2:
            error(key + ".control_points", "At least two boundary points are required")
        parsed = []
        for j, point in enumerate(points):
            if not isinstance(point, dict):
                error(key + f".control_points.{j}", "Supply at and multiplier")
                continue
            at = timestamp(point.get("at"), key + f".control_points.{j}.at")
            if not finite(point.get("multiplier")):
                error(key + f".control_points.{j}.multiplier", "Multiplier must be finite and nonnegative")
            if at:
                if parsed and at <= parsed[-1]:
                    error(key + ".control_points", "Control point times must strictly increase")
                parsed.append(at)
        lo, hi = (parsed[0], parsed[-1]) if len(parsed) > 1 else interval(condition, key)
        hi = hi or end
        if lo and hi and hi <= lo:
            error(key, "Condition end must follow start")
        if lo:
            for other_stream, other_lo, other_hi in windows:
                if (
                    stream == other_stream
                    and (hi is None or hi > other_lo)
                    and (other_hi is None or lo < other_hi)
                ):
                    error(key, "Arrival schedules for the same stream cannot overlap")
            windows.append((stream, lo, hi))
    allowed = {
        "staff_existing",
        "physical_overflow",
        "staffed_overflow",
        "clinic",
        "partner_transfer",
        "staff_existing_beds",
        "activate_overflow",
        "activate_clinic",
    }
    for index, intervention in records("interventions"):
        key = f"interventions.{index}"
        if intervention.get("kind", intervention.get("template_kind")) not in allowed:
            error(key + ".kind", "Unsupported intervention kind")
        lo, hi = interval(intervention, key)
        for field in (
            "nurses",
            "providers",
            "support",
            "enabled_slots",
            "quantity",
            "spaces",
            "max_patients",
        ):
            if field in intervention and (
                not isinstance(intervention[field], int)
                or isinstance(intervention[field], bool)
                or not 0 <= intervention[field] <= 100000
            ):
                error(key + "." + field, "Use a nonnegative bounded integer")
        for field in ("activation_minutes", "duration_minutes", "reservation_expiry_minutes"):
            if field in intervention and not finite(intervention[field]):
                error(key + "." + field, "Use finite nonnegative minutes")
        for field in ("unit_id", "destination_unit_id"):
            if intervention.get(field) and intervention[field] not in units:
                error(key + "." + field, "Unknown unit")
        if intervention.get("facility_id") and intervention["facility_id"] not in sites:
            error(key + ".facility_id", "Unknown facility")
        if "assigned_staff_ids" in intervention and (
            not isinstance(intervention["assigned_staff_ids"], list)
            or any(not isinstance(sid, str) or sid not in staff for sid in intervention["assigned_staff_ids"])
        ):
            error(key + ".assigned_staff_ids", "Choose declared staff IDs")
    for index, update in records("updates"):
        key = f"updates.{index}"
        timestamp(update.get("effective_at"), key + ".effective_at")
        if not isinstance(update.get("payload", {}), dict):
            error(key + ".payload", "Supply an update payload object")
    if dataset and not dataset.get("synthetic", True):
        warnings.append("This application is validated only against synthetic engineering fixtures")
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "assumptions": dataset.get("assumptions", []) if dataset else [],
    }


def normalize_dataset(dataset):
    value = copy.deepcopy(dataset)
    identity = uid("dataset")
    value.update(id=identity, dataset_version_id=identity, schema_version="1.0", committed_at=now())
    aliases = {"staff_assignments", "distributions", "unit_layouts", "baseline"}
    files = [
        {"name": key + ".json", "row_count": len(rows), "sha256": digest(rows)}
        for key, rows in value.items()
        if isinstance(rows, list) and key not in aliases
    ]
    value["manifest"] = {
        **value.get("manifest", {}),
        "dataset_version_id": identity,
        "snapshot_at": value.get("snapshot_at"),
        "timezone": value.get("timezone"),
        "files": files,
        "counts": {f["name"].removesuffix(".json"): f["row_count"] for f in files},
    }
    value["input_sha256"] = digest(
        {k: v for k, v in value.items() if k not in {"input_sha256", "committed_at"}}
    )
    return value


def serialize(doc):
    return {
        **doc.data,
        "id": doc.id,
        "workspace_id": doc.workspace_id,
        "revision": doc.revision,
        "created_at": doc.created_at,
        "updated_at": doc.updated_at,
    }


def add_document(session, workspace, kind, data, identity=None):
    identity = identity or data.get("id") or uid(kind)
    row = Document(
        id=identity, workspace_id=workspace, kind=kind, data={**copy.deepcopy(data), "id": identity}
    )
    session.add(row)
    session.flush()
    return row


def seed_database(factory):
    from sqlalchemy import select
    from surge_engine import generate_dataset, validate_dataset

    with factory.begin() as session:
        if session.scalar(
            select(Document).where(Document.kind == "dataset", Document.workspace_id == "workspace-main")
        ):
            return
        for fixture in ["planning_baseline", "stress_snapshot"]:
            dataset = normalize_dataset(generate_dataset(fixture=fixture, seed=41021, days=365))
            validation = validate_dataset(dataset)
            if not validation.get("valid"):
                raise ValueError(f"Generated dataset invalid: {validation.get('errors')}")
            dataset["validation"] = validation
            add_document(session, "workspace-main", "dataset", dataset)
            if fixture == "planning_baseline":
                scenario = scenario_defaults(
                    {
                        "name": "Sustained 70% surge",
                        "conditions": [
                            {
                                "id": "condition-ed-surge",
                                "kind": "arrival_multiplier",
                                "arrival_stream": "ed",
                                "shape": "step",
                                "surge_percent": 70,
                                "multiplier": 1.7,
                            }
                        ],
                    },
                    dataset,
                )
                add_document(session, "workspace-main", "scenario", scenario)


def reconstruct_state(trace, at=None):
    """Reconstruct the authoritative state from exact trajectory intervals, not chart samples."""
    start = trace.get("start_at") or (trace.get("series") or [{}])[0].get("at")
    if not start:
        start = (trace.get("checkpoints") or [{}])[0].get("at")
    elapsed = (date(at) - date(start)).total_seconds() / 60 if at and start else 0.0
    checkpoints = trace.get("checkpoints", [])
    eligible = [c for c in checkpoints if c.get("elapsed_minutes", 0) <= elapsed]
    checkpoint = copy.deepcopy(max(eligible, key=lambda c: c.get("elapsed_minutes", 0))) if eligible else {}
    patients = []
    source = trace.get("patients", [])
    if isinstance(source, dict):
        source = list(source.values())
    for patient in source:
        intervals = patient.get("state_intervals", patient.get("intervals", patient.get("trajectory", [])))
        found = None
        for interval in intervals:
            lo = interval.get("start_minutes", interval.get("start", interval.get("elapsed_minutes", 0)))
            hi = interval.get("end_minutes", interval.get("end"))
            if isinstance(lo, str):
                lo = (date(lo) - date(start)).total_seconds() / 60
            if isinstance(hi, str):
                hi = (date(hi) - date(start)).total_seconds() / 60
            if lo <= elapsed and (hi is None or elapsed < hi):
                found = interval
        if found is not None:
            patients.append({**patient, **found})
    if not patients:
        patients = checkpoint.get("patients", [])
        if isinstance(patients, dict):
            patients = list(patients.values())
    return {
        "at": at or start,
        "elapsed_minutes": elapsed,
        "patients": patients,
        "units": checkpoint.get("units", []),
        "vehicles": checkpoint.get("vehicles", []),
        "event_sequence": checkpoint.get("event_sequence", 0),
    }
