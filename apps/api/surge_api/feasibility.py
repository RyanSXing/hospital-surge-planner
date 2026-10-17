"""Deterministic plan prerequisite checks against declared schedules and inventory.

A feasible preflight does not promise a clinical outcome: runtime resource changes,
site draining, reservations and patient equipment needs remain engine constraints.
"""

from collections import Counter
from datetime import timedelta
from zoneinfo import ZoneInfo

from .domain import date

KINDS = {
    "staff_existing_beds": "staff_existing",
    "activate_clinic": "clinic",
    "activate_overflow": "staffed_overflow",
}


def plan_feasibility(dataset, scenario, interventions):
    reasons = []
    warnings = []
    units = {u["unit_id"]: u for u in dataset.get("units", [])}
    staff = {s["staff_id"]: s for s in dataset.get("staff", [])}
    policies = {p["capacity_policy_id"]: p for p in dataset.get("capacity_policies", [])}
    start = date(scenario["start_at"])
    end = (
        date(scenario["end_at"])
        if scenario.get("end_at")
        else start.astimezone(ZoneInfo(scenario.get("timezone", "America/Chicago")))
        + timedelta(days=scenario["horizon_calendar_days"])
    )
    windows = []
    equipment_windows = []
    pools = {p["equipment_pool_id"]: p for p in dataset.get("equipment_pools", [])}
    for index, plan in enumerate(interventions):
        if not plan.get("enabled", True):
            continue
        label = plan.get("name") or f"Intervention {index + 1}"
        kind = KINDS.get(
            plan.get("kind", plan.get("template_kind")), plan.get("kind", plan.get("template_kind"))
        )
        target = plan.get("destination_unit_id") or plan.get("unit_id")
        if not target and plan.get("facility_id"):
            target = next(
                (
                    u["unit_id"]
                    for u in units.values()
                    if u["facility_id"] == plan["facility_id"]
                    and u["kind"] == ("clinic" if kind == "clinic" else "ward")
                ),
                None,
            )
        if not target and kind in {"clinic", "physical_overflow", "staffed_overflow"}:
            target = "UNIT-CLINIC-NORTH" if kind == "clinic" else "UNIT-OVERFLOW-SOUTH"
        if target and target not in units:
            reasons.append(f"{label}: destination unit does not exist")
            continue
        if (
            target
            and kind in {"clinic", "physical_overflow", "staffed_overflow"}
            and units[target]["kind"] != ("clinic" if kind == "clinic" else "ward")
        ):
            reasons.append(f"{label}: destination does not support the required care")
            continue
        launch = date(plan.get("start_at", scenario["start_at"]))
        ready = launch + timedelta(
            minutes=plan.get(
                "activation_minutes",
                360 if kind == "clinic" else 720 if kind in {"physical_overflow", "staffed_overflow"} else 0,
            )
        )
        finish = (
            date(plan["end_at"])
            if plan.get("end_at")
            else min(
                end,
                launch + timedelta(minutes=plan.get("duration_minutes", (end - start).total_seconds() / 60)),
            )
        )
        if ready >= finish:
            reasons.append(f"{label}: activation finishes after the intervention closes")
            continue
        if ready >= end:
            continue
        rn = plan.get("nurses", 2 if kind == "clinic" else 5)
        needs = []
        if kind in {"staff_existing", "clinic", "staffed_overflow"}:
            care = "CLINIC" if kind == "clinic" else "WARD"
            needs += [("rn", care + "_NURSING", None)] * rn
            if kind != "staff_existing":
                needs += [("provider", care + "_PROVIDER", None)] * plan.get("providers", 1)
                needs += [("support", "GENERAL_SUPPORT", None)] * plan.get("support", 1)
            if "assigned_staff_ids" in plan:
                explicit = plan["assigned_staff_ids"]
                if len(explicit) != len(set(explicit)) or any(sid not in staff for sid in explicit):
                    reasons.append(f"{label}: explicit staff must be unique declared staff")
                    continue
                needs = [
                    (
                        staff[sid]["role"],
                        care + ("_NURSING" if staff[sid]["role"] == "rn" else "_PROVIDER")
                        if staff[sid]["role"] in {"rn", "provider"}
                        else "GENERAL_SUPPORT",
                        sid,
                    )
                    for sid in explicit
                ]
        if target and kind in {"clinic", "physical_overflow", "staffed_overflow"}:
            slots = [
                s
                for s in dataset.get("slots", [])
                if s["unit_id"] == target and s.get("installation_status") in {"installed", "planned"}
            ]
            count = plan.get(
                "enabled_slots",
                plan.get(
                    "quantity",
                    plan.get(
                        "spaces",
                        rn
                        * policies.get(units[target].get("capacity_policy_id"), {}).get("slots_per_nurse", 4)
                        if kind == "clinic"
                        else len(slots),
                    ),
                ),
            )
            if count > len(slots):
                reasons.append(f"{label}: requested places exceed declared installed and planned inventory")
            if kind == "clinic" and count > 0:
                policy = policies.get(units[target].get("capacity_policy_id"), {})
                counts = Counter(need[0] for need in needs)
                if (
                    counts["rn"] < 1
                    or counts["provider"] < policy.get("minimum_provider_count", 0)
                    or counts["support"] < policy.get("minimum_support_count", 0)
                ):
                    reasons.append(
                        f"{label}: clinic readiness requires at least one qualified nurse, {policy.get('minimum_provider_count', 0)} provider(s), and {policy.get('minimum_support_count', 0)} support staff"
                    )
                supported = counts["rn"] * policy.get("slots_per_nurse", 4)
                if supported < count:
                    warnings.append(
                        f"{label}: staffing supports {supported} of {count} enabled places; the remaining physical places cannot receive patients"
                    )
            allocations = plan.get("equipment_allocations")
            requested = Counter()
            if allocations is not None:
                for allocation in allocations:
                    pool_id, amount = allocation.get("equipment_pool_id"), allocation.get("quantity")
                    pool = pools.get(pool_id)
                    if not pool or not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
                        reasons.append(
                            f"{label}: equipment allocations require declared pool IDs and nonnegative integer quantities"
                        )
                        continue
                    if pool.get("unit_id") != target and (
                        not pool.get("portable") or pool.get("unit_id") is not None
                    ):
                        reasons.append(
                            f"{label}: use a declared unassigned portable equipment source; hospital equipment remains at its source"
                        )
                    if pool.get("unit_id") != target:
                        requested[pool_id] += amount
                equipment_windows.append((max(start, ready), min(end, finish), requested, label))
                if kind == "clinic":
                    kits = sum(
                        p.get("quantity", 0) - p.get("unserviceable_quantity", 0)
                        for p in pools.values()
                        if p.get("unit_id") == target and p["capability_code"] == "CLINIC_KIT"
                    )
                    kits += sum(
                        amount
                        for pool_id, amount in requested.items()
                        if pools[pool_id]["capability_code"] == "CLINIC_KIT"
                    )
                    if kits < count:
                        reasons.append(
                            f"{label}: allocate one clinic kit per enabled place from the declared portable inventory"
                        )
            if kind == "clinic":
                kits = sum(
                    p.get("quantity", 0) - p.get("unserviceable_quantity", 0)
                    for p in dataset.get("equipment_pools", [])
                    if p["capability_code"] == "CLINIC_KIT"
                    and (p.get("unit_id") == target or p.get("portable") and p.get("unit_id") is None)
                )
                if kits < count:
                    reasons.append(f"{label}: insufficient declared clinic kits")
        windows.append((max(start, ready), min(end, finish), needs, label))
    for instant in sorted({t for a, b, _, _ in equipment_windows for t in (a, b)}):
        required = Counter()
        for begin, finish, quantities, _ in equipment_windows:
            if begin <= instant < finish:
                required.update(quantities)
        for pool_id, amount in required.items():
            available = pools[pool_id].get("quantity", 0) - pools[pool_id].get("unserviceable_quantity", 0)
            if amount > available:
                reasons.append(
                    f"At {instant.isoformat()}, overlapping equipment allocations require {amount} from {pool_id}, but only {available} serviceable items are declared"
                )
    assignments = []
    for assignment in dataset.get("assignments", dataset.get("staff_assignments", [])):
        if not assignment.get("reserve_pool_id") or assignment.get("status") == "unavailable":
            continue
        lo, hi = date(assignment["start_at"]), date(assignment["end_at"])
        if lo < end and hi > start:
            assignments.append((lo, hi, assignment["staff_id"], assignment.get("allocation_fraction", 1)))
    points = {start, end}
    points.update(t for a, b, _, _ in windows for t in (a, b))
    points.update(t for a, b, _, _ in assignments for t in (max(a, start), min(b, end)))
    conditions = [
        c
        for c in scenario.get("conditions", [])
        if c.get("kind") in {"staff_unavailability", "staff_absence"} and c.get("staff_ids")
    ]
    for condition in conditions:
        points.update([date(condition["start_at"]), date(condition["end_at"])])
    for instant in sorted(points):
        active = [w for w in windows if w[0] <= instant < w[1]]
        needs = [need for window in active for need in window[2]]
        if not needs:
            continue
        absent = {
            sid
            for c in conditions
            if date(c["start_at"]) <= instant < date(c["end_at"])
            for sid in c["staff_ids"]
        }
        available = {
            sid
            for a, b, sid, fraction in assignments
            if a <= instant < b and fraction >= 1 and sid not in absent
        }
        options = [
            {
                sid
                for sid in available
                if staff[sid]["role"] == role
                and cap in staff[sid].get("capabilities", [])
                and (explicit is None or sid == explicit)
            }
            for role, cap, explicit in needs
        ]
        matches = {}

        def claim(index, visited, options=options, matches=matches):
            for sid in sorted(options[index]):
                if sid in visited:
                    continue
                visited.add(sid)
                if sid not in matches or claim(matches[sid], visited):
                    matches[sid] = index
                    return True
            return False

        if any(not claim(i, set()) for i in sorted(range(len(needs)), key=lambda i: len(options[i]))):
            reasons.append(
                f"At {instant.isoformat()}, overlapping plans require more qualified reserve staff than the declared roster provides; each person can be assigned once"
            )
            break
    return {
        "feasible": not reasons,
        "reasons": list(dict.fromkeys(reasons)),
        "warnings": list(dict.fromkeys(warnings)),
        "basis": "declared inventory and interval-qualified reserve roster; dynamic resource availability is checked during each simulation",
    }


def result_feasibility(replications):
    failures = [
        {"replication_index": r["replication_index"], **i}
        for r in replications
        for i in r.get("interventions", [])
        if i.get("status") == "infeasible"
    ]
    return {
        "feasible": not failures,
        "reasons": sorted(
            {f.get("reason", "Intervention prerequisites failed during execution") for f in failures}
        ),
        "failures": failures,
        "basis": "actual per-replication activation outcomes",
    }
