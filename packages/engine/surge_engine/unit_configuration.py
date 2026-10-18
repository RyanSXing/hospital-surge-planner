"""Explicit initial hospital capacity and on-duty planning assumptions.

The committed source dataset is never changed. Configured staff are concrete,
qualified planning identities on non-overlapping rotating shifts; they do not
borrow or double-book the source roster or its reserve pool.
"""

from __future__ import annotations

import copy
from datetime import timedelta
from itertools import pairwise

from .common import digest, dt, endpoint, iso

ROLES = ("rn", "provider", "support")
MAX_CONFIGURED_ASSIGNMENTS = 100_000


def configured_shift_cuts(dataset, scenario, uid):
    days = scenario.get("horizon_calendar_days", 30)
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 365:
        raise ValueError("Horizon must be 1–365 local calendar days")
    start = dt(scenario.get("start_at", dataset["snapshot_at"]))
    end = (
        dt(scenario["end_at"])
        if scenario.get("state_origin") == "observed_reset" and scenario.get("end_at")
        else endpoint(
            start,
            scenario.get("horizon_calendar_days", 30),
            scenario.get("timezone", dataset.get("timezone", "America/Chicago")),
        )
    )
    if not 0 < (end - start).total_seconds() / 60 <= 527100:
        raise ValueError("Configured staffing horizon must be positive and at most 365 calendar days")
    cuts = {start, end}
    for assignment in dataset.get("assignments", dataset.get("staff_assignments", [])):
        if assignment.get("unit_id") != uid:
            continue
        for key in ("start_at", "end_at"):
            instant = dt(assignment[key])
            if start < instant < end:
                cuts.add(instant)
    instant = start + timedelta(hours=12)
    while instant < end:
        cuts.add(instant)
        instant += timedelta(hours=12)
    return sorted(cuts)


def protected_unit_slots(dataset, unit_id):
    slots = [s for s in dataset.get("slots", []) if s.get("unit_id") == unit_id]
    identities = {s["slot_id"] for s in slots}
    protected = set()
    unit = next((u for u in dataset.get("units", []) if u["unit_id"] == unit_id), {})
    # The manager reserves the first declared slots for background occupants.
    protected.update(s["slot_id"] for s in slots[: int(unit.get("background_occupied", 0))])
    for patient in dataset.get("patients", []):
        if patient.get("state") == "discharged":
            continue
        if patient.get("slot_id") in identities:
            protected.add(patient["slot_id"])
        target = (patient.get("pending_transfer") or {}).get("destination_slot_id")
        if target in identities:
            protected.add(target)
    return protected


def unit_configuration_errors(dataset, scenario):
    """Shared API/engine validation, with paths suitable for form errors."""
    errors, seen, assignment_count = [], set(), 0
    units = {u["unit_id"]: u for u in (dataset or {}).get("units", [])}
    main = next(
        (
            s.get("destination_facility_id")
            for s in (dataset or {}).get("entry_streams", [])
            if s.get("destination_facility_id")
        ),
        next((u.get("facility_id") for u in units.values() if u.get("kind") == "ed"), None),
    )

    def error(path, message):
        errors.append({"field": path, "message": message})

    def integer(value, maximum):
        return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum

    conditions = scenario.get("conditions", [])
    for index, row in enumerate(conditions if isinstance(conditions, list) else []):
        if not isinstance(row, dict) or row.get("kind") != "unit_configuration":
            continue
        path = f"conditions.{index}"
        uid = row.get("unit_id")
        unit = units.get(uid) if isinstance(uid, str) else None
        if (
            not isinstance(uid, str)
            or not uid
            or (
                dataset is not None
                and (
                    not unit
                    or unit.get("capacity_mode") != "staff_derived"
                    or unit.get("kind") not in {"ward", "icu", "ed"}
                    or unit.get("facility_id") != main
                )
            )
        ):
            error(path + ".unit_id", "Select a staffed ward, ICU or emergency unit in this hospital")
            continue
        if uid in seen:
            error(path + ".unit_id", "Only one initial configuration is allowed per unit")
        seen.add(uid)
        if row.get("start_at") or row.get("end_at"):
            error(path, "Initial hospital configuration applies to the full simulation period")
        if row.get("source", "user_assumption") != "user_assumption":
            error(path + ".source", "Hospital configuration must be a user planning assumption")
        for field in ("physical_capacity", "enabled_capacity", "staffed_capacity"):
            if field in row and not integer(row[field], 1000):
                error(path + "." + field, "Use a whole number from 0 to 1000")
        counts = row.get("staff_counts")
        if counts is not None:
            if not isinstance(counts, dict) or not counts or set(counts) - set(ROLES):
                error(path + ".staff_counts", "Specify nurses, providers or support staff")
            else:
                for role, count in counts.items():
                    if not integer(count, 500):
                        error(path + ".staff_counts." + role, "Use a whole on-duty count from 0 to 500")
        if unit:
            stock = sum(
                s.get("installation_status") == "installed"
                for s in dataset.get("slots", [])
                if s.get("unit_id") == uid
            )
            physical = row.get("physical_capacity", stock)
            enabled = row.get("enabled_capacity", unit.get("enabled_capacity", stock))
            staffed = row.get("staffed_capacity")
            if integer(physical, 1000) and integer(enabled, 1000):
                protected = len(protected_unit_slots(dataset, uid))
                if enabled > physical:
                    error(path + ".enabled_capacity", "Available beds cannot exceed installed beds")
                if min(physical, enabled) < protected:
                    error(
                        path + ".physical_capacity",
                        f"Keep at least {protected} beds for the starting census and reservations",
                    )
                if staffed is not None and integer(staffed, 1000) and staffed > enabled:
                    error(path + ".staffed_capacity", "Staffed-bed limit cannot exceed available beds")
            if isinstance(counts, dict) and counts and all(integer(v, 500) for v in counts.values()):
                try:
                    cuts = configured_shift_cuts(dataset, scenario, uid)
                except (ValueError, TypeError, KeyError, OverflowError):
                    pass  # The scenario's separate timestamp/horizon errors are authoritative.
                else:
                    assignment_count += sum(counts.values()) * max(0, len(cuts) - 1)
                    if assignment_count > MAX_CONFIGURED_ASSIGNMENTS:
                        error(
                            path + ".staff_counts",
                            "This staffing plan exceeds 100,000 shift assignments; reduce the staff count or simulation duration",
                        )
    return errors


def apply_unit_configuration(dataset, scenario):
    conditions = scenario.get("conditions", [])
    rows = (
        [r for r in conditions if isinstance(r, dict) and r.get("kind") == "unit_configuration"]
        if isinstance(conditions, list)
        else []
    )
    if not rows:
        return dataset
    errors = unit_configuration_errors(dataset, scenario)
    if errors:
        raise ValueError("; ".join(e["field"] + ": " + e["message"] for e in errors))
    result = dict(dataset)
    result["units"] = list(dataset["units"])
    result["slots"] = list(dataset["slots"])
    result["staff"] = list(dataset["staff"])
    result["assignments"] = list(dataset.get("assignments", dataset.get("staff_assignments", [])))
    staff = {s["staff_id"]: s for s in dataset["staff"]}
    start = dt(scenario.get("start_at", dataset["snapshot_at"]))
    policies = {p["capacity_policy_id"]: p for p in dataset.get("capacity_policies", [])}
    for config in rows:
        uid = config["unit_id"]
        at = next(i for i, u in enumerate(result["units"]) if u["unit_id"] == uid)
        unit = copy.deepcopy(result["units"][at])
        result["units"][at] = unit
        slots = [s for s in result["slots"] if s["unit_id"] == uid]
        physical = config.get(
            "physical_capacity", sum(s["installation_status"] == "installed" for s in slots)
        )
        enabled = config.get("enabled_capacity", unit.get("enabled_capacity", physical))
        protected = protected_unit_slots(dataset, uid)
        installed = [s for s in slots if s["installation_status"] == "installed"]
        # Protected identities stay first so a reduced stock cannot delete a
        # patient's bed, a transfer reservation or a background occupancy.
        chosen = [s for s in installed if s["slot_id"] in protected]
        chosen += [s for s in installed if s["slot_id"] not in protected][: max(0, physical - len(chosen))]
        existing_ids = {s["slot_id"] for s in result["slots"]}
        for number in range(max(0, physical - len(chosen))):
            identity = f"SLOT-CONFIG-{uid}-{number + 1:04}"
            while identity in existing_ids:
                identity += "-P"
            existing_ids.add(identity)
            prototype = (
                slots[0]
                if slots
                else {
                    "slot_kind": {"ward": "ward_bed", "icu": "icu_bed", "ed": "ed_bay"}[unit["kind"]],
                    "capabilities": unit.get("capabilities", []),
                }
            )
            chosen.append(
                {
                    **prototype,
                    "slot_id": identity,
                    "unit_id": uid,
                    "display_label": str(len(chosen) + 1),
                    "layout_x": 0.5,
                    "layout_y": 0.5,
                    "source": "user_assumption",
                }
            )
        enabled_order = [s for s in chosen if s["slot_id"] in protected] + [
            s for s in chosen if s["slot_id"] not in protected
        ]
        active_ids = {s["slot_id"] for s in enabled_order[:enabled]}
        configured_slots = [
            {**s, "installation_status": "installed", "enabled": s["slot_id"] in active_ids} for s in chosen
        ]
        # Source planned stock is not silently installed by a bed-count edit.
        planned = [s for s in slots if s["installation_status"] != "installed"]
        result["slots"] = [s for s in result["slots"] if s["unit_id"] != uid] + configured_slots + planned
        unit["physical_capacity"], unit["enabled_capacity"] = physical, enabled
        if config.get("staffed_capacity") is not None:
            unit["configured_staffed_limit"] = config["staffed_capacity"]
        counts = config.get("staff_counts") or {}
        if not counts:
            continue
        unit["baseline_staff"] = {**unit.get("baseline_staff", {}), **counts}
        # Explicit twelve-hour planning shifts also cover source schedule gaps.
        cuts = configured_shift_cuts(dataset, scenario, uid)
        result["assignments"] = [
            a
            for a in result["assignments"]
            if not (a.get("unit_id") == uid and staff.get(a["staff_id"], {}).get("role") in counts)
        ]
        nurse_cap = policies.get(unit.get("capacity_policy_id"), {}).get(
            "nurse_capability", unit["kind"].upper() + "_NURSING"
        )
        prefix = digest({"unit": uid, "counts": counts})[:12]
        people = {}
        for role, count in counts.items():
            cap = (
                nurse_cap
                if role == "rn"
                else unit["kind"].upper() + "_PROVIDER"
                if role == "provider"
                else "GENERAL_SUPPORT"
            )
            for team in range(4):
                for number in range(count):
                    sid = f"STAFF-CONFIG-{prefix}-{role}-{team + 1}-{number + 1:03}"
                    while sid in staff:
                        sid += "-P"
                    person = {
                        "staff_id": sid,
                        "role": role,
                        "capabilities": [cap],
                        "team_id": f"CONFIG-{uid}-TEAM-{team + 1}",
                        "employment_pool": "hospital",
                        "home_unit_id": uid,
                        "source": "user_assumption",
                    }
                    people[(role, team, number)] = person
                    result["staff"].append(person)
        for index, (lo, hi) in enumerate(pairwise(cuts)):
            team = int((lo - start).total_seconds() // (12 * 3600)) % 4
            for role, count in counts.items():
                for number in range(count):
                    sid = people[(role, team, number)]["staff_id"]
                    result["assignments"].append(
                        {
                            "assignment_id": f"ASG-CONFIG-{prefix}-{index}-{role}-{number}",
                            "staff_id": sid,
                            "unit_id": uid,
                            "reserve_pool_id": None,
                            "start_at": iso(lo),
                            "end_at": iso(hi),
                            "status": "scheduled",
                            "allocation_fraction": 1.0,
                            "source": "user_assumption",
                        }
                    )
    result["staff_assignments"] = result["assignments"]
    return result
