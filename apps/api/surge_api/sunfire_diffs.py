"""Plain-language, concrete before/after rows for the existing planning controls."""

from __future__ import annotations

from datetime import timedelta

from .domain import date
from .scenario_comparisons import configuration_differences


def configuration_rows(before, after, dataset):
    rows = [
        item
        for item in configuration_differences(before, after)
        if item["field"] not in {"conditions", "updates", "interventions"}
    ]

    def add(field, label, left, right, unit=None, start_at=None, end_at=None):
        if left != right:
            rows.append(
                {
                    "field": field,
                    "label": label,
                    "left": left,
                    "right": right,
                    **({"unit": unit} if unit else {}),
                    **({"start_at": start_at} if start_at else {}),
                    **({"end_at": end_at} if end_at else {}),
                }
            )

    add("name", "Scenario name", before.get("name"), after.get("name"))
    units = {unit["unit_id"]: unit for unit in dataset.get("units", [])}
    for identity, unit in units.items():
        first = next(
            (
                item
                for item in before.get("conditions", [])
                if item.get("kind") == "unit_configuration" and item.get("unit_id") == identity
            ),
            {},
        )
        second = next(
            (
                item
                for item in after.get("conditions", [])
                if item.get("kind") == "unit_configuration" and item.get("unit_id") == identity
            ),
            {},
        )
        if first == second:
            continue
        title = unit.get("name", identity)
        physical = sum(
            slot.get("installation_status") == "installed"
            for slot in dataset.get("slots", [])
            if slot.get("unit_id") == identity
        )
        for field, label, fallback in (
            ("physical_capacity", "installed beds", physical),
            ("enabled_capacity", "enabled bed availability", unit.get("enabled_capacity")),
            ("staffed_capacity", "staffed-bed target", "From qualified on-duty staffing"),
        ):
            add(
                f"unit.{identity}.{field}",
                f"{title} {label}",
                first.get(field, fallback),
                second.get(field, fallback),
                "beds",
            )
        baseline = scheduled_staff(dataset, unit, before["start_at"])
        for role, label in (
            ("rn", "registered nurses"),
            ("provider", "doctors and providers"),
            ("support", "support staff"),
        ):
            add(
                f"unit.{identity}.staff.{role}",
                f"{title} {label}",
                first.get("staff_counts", {}).get(role, baseline.get(role)),
                second.get("staff_counts", {}).get(role, baseline.get(role)),
                "people",
            )

    def indexed(value, collection):
        return {
            item.get("id", item.get("update_id", f"item-{index}")): item
            for index, item in enumerate(value.get(collection, []))
        }

    first_conditions, second_conditions = indexed(before, "conditions"), indexed(after, "conditions")
    represented = set()
    for identity in first_conditions.keys() | second_conditions.keys():
        first, second = first_conditions.get(identity), second_conditions.get(identity)
        if first == second:
            continue
        item = second or first
        kind = item.get("kind")
        if kind == "unit_configuration":
            represented.add(identity)
        elif kind == "arrival_batch":
            at, spread = item.get("at"), item.get("spread_minutes", 0)
            until = (date(at) + timedelta(minutes=spread)).isoformat() if at and spread else at
            add(
                f"incident.{identity}.count",
                "Additional emergency patients"
                if item.get("entry_stream_id", "ED_MAIN") == "ED_MAIN"
                else "Additional scheduled patients",
                first["count"] if first else 0,
                second["count"] if second else 0,
                "patients",
                at,
                until,
            )
            represented.add(identity)
        elif kind == "arrival_multiplier":
            add(
                f"arrivals.{identity}.multiplier",
                "Emergency arrival level"
                if item.get("entry_stream_id", "ED_MAIN") == "ED_MAIN"
                else "Scheduled arrival level",
                first.get("multiplier", 1) if first else 1,
                second.get("multiplier", 1) if second else 1,
                "times usual arrivals",
                item.get("start_at"),
                item.get("end_at"),
            )
            if (first or {}).get("control_points") != (second or {}).get("control_points"):
                add(
                    f"arrivals.{identity}.curve",
                    "Daily arrival curve",
                    (first or {}).get("control_points") or "Usual arrival pattern",
                    (second or {}).get("control_points") or "Usual arrival pattern",
                    start_at=item.get("start_at"),
                    end_at=item.get("end_at"),
                )
            if (first or {}).get("shape", "step") != (second or {}).get("shape", "step"):
                add(
                    f"arrivals.{identity}.pattern",
                    "Arrival pattern",
                    (first or {}).get("shape", "step"),
                    (second or {}).get("shape", "step"),
                    start_at=item.get("start_at"),
                    end_at=item.get("end_at"),
                )
            represented.add(identity)
        elif kind in {"staff_unavailability", "staff_absence"}:
            unit = units.get(item.get("unit_id"), {})
            add(
                f"absence.{identity}.count",
                f"{unit.get('name', 'Selected unit')} unavailable nurses",
                (first or {}).get("count", 0),
                (second or {}).get("count", 0),
                "people",
                item.get("start_at"),
                item.get("end_at"),
            )
            represented.add(identity)

    first_updates, second_updates = indexed(before, "updates"), indexed(after, "updates")
    for identity in first_updates.keys() | second_updates.keys():
        first, second = first_updates.get(identity), second_updates.get(identity)
        if first == second:
            continue
        item = second or first
        at, payload = item.get("effective_at"), item.get("payload", {})
        if item.get("type") == "capacity_change" and item.get("input_kind") == "planned_assumption":
            unit_id = payload["unit_id"]
            title = units.get(unit_id, {}).get("name", unit_id)
            a = capacity_before_event(
                after if second and not first else before, dataset, unit_id, at, excluded=identity
            )
            b = (
                payload.get("enabled_capacity")
                if second
                else capacity_before_event(after, dataset, unit_id, at)
            )
            if first:
                a = first.get("payload", {}).get("enabled_capacity")
            group = item.get("sunfire_window_id")
            paired = sorted(
                (
                    record
                    for record in (after if second else before).get("updates", [])
                    if group and record.get("sunfire_window_id") == group
                ),
                key=lambda record: date(record["effective_at"]),
            )
            until = paired[-1]["effective_at"] if paired and item == paired[0] else None
            add(
                f"capacity.{identity}",
                f"{title} enabled bed availability"
                + (" restored" if paired and item == paired[-1] and len(paired) > 1 else ""),
                a,
                b,
                "beds",
                at,
                until,
            )
        elif item.get("type") == "equipment_change" and item.get("input_kind") == "planned_assumption":
            pool = next(
                (
                    pool
                    for pool in dataset.get("equipment_pools", [])
                    if pool["equipment_pool_id"] == payload.get("equipment_pool_id", payload.get("pool_id"))
                ),
                {},
            )
            unit = units.get(pool.get("unit_id"), {})
            description = {
                "add": "added equipment",
                "fail": "equipment unavailable",
                "repair": "equipment repaired",
                "decommission": "equipment retired",
            }.get(payload.get("operation"), "equipment change")
            add(
                f"equipment.{identity}",
                f"{unit.get('name', 'Hospital')} {pool.get('capability_code', '').replace('_', ' ').lower()} {description}",
                first.get("payload", {}).get("quantity", 0) if first else 0,
                second.get("payload", {}).get("quantity", 0) if second else 0,
                "units",
                at,
            )
        else:
            add(
                f"event.{identity}",
                "Planned hospital resource event",
                first or "Not scheduled",
                second or "Removed",
                start_at=at,
            )

    unmatched_first = [
        item
        for identity, item in first_conditions.items()
        if identity not in represented and item != second_conditions.get(identity)
    ]
    unmatched_second = [
        item
        for identity, item in second_conditions.items()
        if identity not in represented and item != first_conditions.get(identity)
    ]
    add("other_conditions", "Additional planning settings", unmatched_first, unmatched_second)
    add(
        "interventions",
        "Planned in-hospital staffing responses",
        before.get("interventions", []),
        after.get("interventions", []),
    )
    a, b = before.get("hospital_operations") or {}, after.get("hospital_operations") or {}
    add(
        "disruption_chance_percent",
        "Daily treatment disruption chance",
        a.get("disruption_chance_percent", 0),
        b.get("disruption_chance_percent", 0),
        "percent",
    )
    return sorted(rows, key=lambda item: (item.get("start_at", ""), item["field"]))


def scheduled_staff(dataset, unit, at):
    """Use the same qualified snapshot roster/fractions as the manual controls."""
    assignments = dataset.get("assignments", dataset.get("staff_assignments", []))
    if not assignments:
        return unit.get("baseline_staff", {})
    people = {person["staff_id"]: person for person in dataset.get("staff", [])}
    policy = next(
        (
            policy
            for policy in dataset.get("capacity_policies", [])
            if policy.get("capacity_policy_id") == unit.get("capacity_policy_id")
        ),
        {},
    )
    capabilities = {
        "rn": policy.get("nurse_capability", unit["kind"].upper() + "_NURSING"),
        "provider": unit["kind"].upper() + "_PROVIDER",
        "support": "GENERAL_SUPPORT",
    }
    current = date(at)
    active = [
        assignment
        for assignment in assignments
        if assignment.get("unit_id") == unit["unit_id"]
        and assignment.get("status") != "unavailable"
        and date(assignment["start_at"]) <= current < date(assignment["end_at"])
    ]
    return {
        role: sum(
            assignment.get("allocation_fraction", 1)
            for assignment in active
            if capability in people.get(assignment["staff_id"], {}).get("capabilities", [])
        )
        for role, capability in capabilities.items()
    }


def capacity_before_event(scenario, dataset, unit_id, at, excluded=None):
    unit = next(unit for unit in dataset["units"] if unit["unit_id"] == unit_id)
    config = next(
        (
            item
            for item in scenario.get("conditions", [])
            if item.get("kind") == "unit_configuration" and item.get("unit_id") == unit_id
        ),
        {},
    )
    value = config.get("enabled_capacity", unit.get("enabled_capacity"))
    for item in sorted(scenario.get("updates", []), key=lambda event: date(event["effective_at"])):
        if (
            item.get("id", item.get("update_id")) == excluded
            or item.get("type") != "capacity_change"
            or item.get("status", "active") != "active"
            or item.get("payload", {}).get("unit_id") != unit_id
        ):
            continue
        if date(item["effective_at"]) < date(at):
            value = item["payload"]["enabled_capacity"]
    return value
