"""Shared source-snapshot and selected-trajectory census queries."""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException, Query
from surge_engine.common import dt


def patient_filters(
    unit_id: str | None = None,
    facility_id: str | None = None,
    admission_pending: bool | None = None,
    state: str | None = None,
    care_level: Literal["ward", "icu", "ambulatory"] | None = None,
    search: str | None = Query(default=None, max_length=128),
    waiting_reason: str | None = Query(default=None, max_length=96),
    arrival_from: str | None = None,
    arrival_until: str | None = None,
    remaining_min_hours: float | None = Query(default=None, ge=0, le=1_000_000, allow_inf_nan=False),
    remaining_max_hours: float | None = Query(default=None, ge=0, le=1_000_000, allow_inf_nan=False),
    transfer_eligible: bool | None = None,
):
    values = dict(locals())
    try:
        for key in ("arrival_from", "arrival_until"):
            values[key] = dt(values[key]) if values[key] else None
        if (
            values["arrival_from"]
            and values["arrival_until"]
            and values["arrival_from"] >= values["arrival_until"]
        ):
            raise ValueError("Arrival interval end must follow start")
        if (
            remaining_min_hours is not None
            and remaining_max_hours is not None
            and remaining_min_hours > remaining_max_hours
        ):
            raise ValueError("Maximum remaining hours must be at least the minimum")
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, {"code": "invalid_filter", "message": str(exc)}) from exc
    return values


def pending(patient):
    return bool(patient.get("admission_pending", patient.get("state") in {"ed_boarding", "direct_waiting"}))


def remaining_summary(patient, at, templates=None, *, simulated=False):
    """No random draws: exact retained sample, supplied residual or declared mean."""
    if patient.get("expected_stage_end_at"):
        return {
            "hours": max(0, (dt(patient["expected_stage_end_at"]) - dt(at)).total_seconds() / 3600),
            "basis": "selected_trajectory" if simulated else "supplied_expected_end",
            "label": "Sampled stage remaining" if simulated else "Supplied expected remaining",
        }
    if patient.get("state") in {"ed_boarding", "direct_waiting", "ed_waiting"} or pending(patient):
        return {"hours": None, "basis": "not_started", "label": "Next service has not started"}
    if simulated:
        spec = patient.get("remaining_stage_spec") or {}
        if patient.get("care_paused") and spec.get("kind") == "fixed_minutes":
            minutes = spec.get("minutes")
            if isinstance(minutes, (int, float)) and minutes >= 0:
                return {
                    "hours": minutes / 60,
                    "basis": "paused_trajectory",
                    "label": "Care paused · active care remaining",
                }
        return {"hours": None, "basis": "unavailable", "label": "No retained remaining-stage value"}
    spec = patient.get("remaining_stage_spec") or {}
    if not spec:
        minutes = patient.get("remaining_stay_minutes", patient.get("assessment_remaining_minutes"))
        if minutes is not None:
            spec = {"kind": "fixed_minutes", "minutes": minutes}
        elif patient.get("remaining_stay_template_id"):
            spec = {
                "kind": "remaining_distribution",
                "distribution_id": patient["remaining_stay_template_id"],
            }
    kind = spec.get("kind")
    if kind == "fixed_minutes":
        return {"hours": spec["minutes"] / 60, "basis": "supplied_residual", "label": "Supplied residual"}
    if kind == "expected_end":
        return {
            "hours": max(0, (dt(spec["expected_end_at"]) - dt(at)).total_seconds() / 3600),
            "basis": "supplied_expected_end",
            "label": "Supplied expected remaining",
        }
    template = (templates or {}).get(spec.get("distribution_id"))
    if template:
        if template.get("family") == "fixed":
            hours = template["fixed_minutes"] / 60
        else:
            hours = template["shape"] * template["scale_hours"]
        if kind == "conditional_total":
            from scipy.special import gammaincc

            elapsed = spec["elapsed_minutes"] / 60
            tail = gammaincc(template["shape"], elapsed / template["scale_hours"])
            hours = (
                hours * gammaincc(template["shape"] + 1, elapsed / template["scale_hours"]) / tail - elapsed
                if tail > 1e-12
                else None
            )
        return {
            "hours": hours,
            "basis": "conditional_mean" if kind == "conditional_total" else "residual_template_mean",
            "label": "Conditional remaining mean"
            if kind == "conditional_total"
            else "Residual template mean",
            "template_id": template["template_id"],
        }
    return {"hours": None, "basis": "unavailable", "label": "Remaining stage unspecified"}


def patient_summary(patient, at, templates=None, *, simulated=False):
    waiting = pending(patient) or patient.get("state") == "ed_waiting"
    requested = patient.get("admission_requested_at") if pending(patient) else patient.get("queue_entered_at")
    requested = (
        requested
        or patient.get("queue_entered_at")
        or patient.get("state_entered_at")
        or patient.get("start_at")
    )
    waiting_hours = (
        max(0, (dt(at) - dt(requested)).total_seconds() / 3600)
        if waiting and requested
        else 0
        if not waiting
        else None
    )
    requirements = (
        (patient.get("inpatient_resource_requirements") if pending(patient) else None)
        or patient.get("resource_requirements")
        or []
    )
    return {
        **patient,
        "admission_pending": pending(patient),
        "required_care_level": patient.get("target_unit_kind") or patient.get("care_level"),
        "remaining_summary": remaining_summary(patient, at, templates, simulated=simulated),
        "waiting_hours": waiting_hours,
        "placement_resource_requirements": requirements,
    }


def filtered_patients(patients, at, filters, templates=None, *, simulated=False, units=None):
    units = units or {}
    for patient in patients:
        facility = patient.get("facility_id") or units.get(patient.get("unit_id"), {}).get("facility_id")
        state = patient.get("state")
        if filters.get("unit_id") and patient.get("unit_id") != filters["unit_id"]:
            continue
        if filters.get("facility_id") and facility != filters["facility_id"]:
            continue
        if filters.get("admission_pending") is not None and pending(patient) != filters["admission_pending"]:
            continue
        wanted = filters.get("state")
        if wanted and not (
            state == "ed_waiting" or pending(patient) if wanted == "waiting" else state == wanted
        ):
            continue
        if (
            filters.get("care_level")
            and (patient.get("target_unit_kind") or patient.get("care_level")) != filters["care_level"]
        ):
            continue
        if (
            filters.get("search")
            and filters["search"].lower() not in patient.get("patient_id", patient.get("id", "")).lower()
        ):
            continue
        if filters.get("waiting_reason") and filters["waiting_reason"] not in patient.get("blockers", []):
            continue
        if (
            filters.get("transfer_eligible") is not None
            and patient.get("eligible_for_transfer") is not filters["transfer_eligible"]
        ):
            continue
        arrival = dt(patient["arrival_at"]) if patient.get("arrival_at") else None
        if filters.get("arrival_from") and (not arrival or arrival < filters["arrival_from"]):
            continue
        if filters.get("arrival_until") and (not arrival or arrival >= filters["arrival_until"]):
            continue
        low, high = filters.get("remaining_min_hours"), filters.get("remaining_max_hours")
        if low is not None or high is not None:
            hours = remaining_summary(patient, at, templates, simulated=simulated)["hours"]
            if hours is None or (low is not None and hours < low) or (high is not None and hours > high):
                continue
        yield patient if patient.get("facility_id") else {**patient, "facility_id": facility}


def unit_timeline(trace, unit_id, at, max_points=400):
    """Actual selected-run unit values and explicitly shared care-level queues."""
    import bisect

    from .series import visible_series

    history = trace.get("unit_history", {}).get(unit_id, [])
    series = trace.get("unit_series", {}).get(unit_id)
    if not history or not series:
        raise HTTPException(404, "Unit is not present in this replication")
    minutes = (dt(at) - dt(trace["start_at"])).total_seconds() / 60
    if not 0 <= minutes <= trace["horizon_elapsed_minutes"]:
        raise HTTPException(422, "Selected time lies outside this replication")
    index = bisect.bisect_right([r["elapsed_minutes"] for r in history], minutes) - 1
    current = history[max(0, index)]
    kind = current.get("kind")
    queue_key = f"{kind}_queue" if kind in {"ward", "icu", "ed"} else None
    rows = []
    for i, row in enumerate(trace.get("series", [])):
        values = {key: numbers[i] for key, numbers in series["fields"].items() if i < len(numbers)}
        rows.append(
            {"at": row["at"], **values, "shared_care_queue": row.get(queue_key) if queue_key else None}
        )
    visible = visible_series(rows, max_points)
    changes, previous = [], current
    relevant = ("physical", "enabled", "staffed", "admission_gate", "active")
    for future in history[index + 1 :]:
        if any(future.get(key) != previous.get(key) for key in relevant):
            changes.append({"at": future["at"], **{key: future.get(key) for key in relevant}})
        previous = future
    return {
        "unit_id": unit_id,
        "current": current,
        "series": [rows[i] for i in visible],
        "source_point_count": len(rows),
        "capacity_schedule": changes[:50],
        "capacity_schedule_total": len(changes),
        "queue_scope": f"All {kind} placement requests; shared demand across compatible units"
        if kind in {"ward", "icu"}
        else "All ED assessment waiting"
        if kind == "ed"
        else None,
        "source": "selected_replication",
    }
