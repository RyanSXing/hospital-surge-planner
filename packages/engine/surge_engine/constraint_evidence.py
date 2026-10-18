"""Compact, exact waiting-burden evidence retained even without a replay trace.

Each queue member contributes once to a reason and once to each affected
unit/reason. Reasons and candidate units can overlap and must never be added
as independent causes of waiting.
"""

from collections import Counter
from copy import deepcopy


def integrate_constraint_evidence(model, next_time):
    begin = max(model.now, model.measure_start)
    if next_time <= begin:
        return
    ledger = getattr(model, "_constraint_evidence", None)
    if ledger is None:
        ledger = model._constraint_evidence = {"categories": {}, "units": {}, "resources": {}}
    categories, units, resources = Counter(), Counter(), Counter()
    snapshots = {}
    metadata = {}
    for group, blocker in model.current_blockers.items():
        count = blocker.get("patient_count", 0)
        if count <= 0:
            continue
        for reason in set(blocker.get("reasons", [])):
            categories[reason] += count
        named = set()
        for detail in blocker.get("units", []):
            uid = detail["unit_id"]
            unit = model.units.get(uid)
            if unit is None:
                continue
            reasons = set(detail.get("reasons", []))
            for reason in reasons:
                units[(uid, reason)] += count
            if uid not in snapshots:
                snapshots[uid] = model.unit_snapshot(unit)
            snap = snapshots[uid]
            policy = model.policies.get(unit.get("capacity_policy_id"), {})
            roles = snap.get("qualified_staff_by_role", {})

            def resource(kind, code, reason, uid=uid, unit=unit, named=named):
                key = (uid, reason, kind, code)
                named.add(key)
                metadata[key] = {
                    "unit_id": uid,
                    "unit_kind": unit["kind"],
                    "reason": reason,
                    "kind": kind,
                    "code": code,
                }

            if "no_matching_physical_place" in reasons:
                resource("beds", "beds", "no_matching_physical_place")
            blanket = Counter()
            for requirement in policy.get("per_slot_resources", []):
                blanket[requirement["capability_code"]] += requirement.get("quantity", 1)
            if "nursing_capacity" in reasons:
                demand = snap["occupied"] + snap["reserved"] + 1
                if (
                    roles.get("rn", 0) * policy.get("slots_per_nurse", 2 if unit["kind"] == "icu" else 4)
                    < demand
                ):
                    resource("staff", "rn", "nursing_capacity")
                for cap, amount in blanket.items():
                    quantity = sum(
                        max(0, pool["quantity"] - pool.get("failed", 0) - pool.get("pending_decommission", 0))
                        for pool in model.pools.values()
                        if pool.get("unit_id") == uid and pool["capability_code"] == cap
                    )
                    if quantity < demand * amount:
                        resource("equipment", cap, "nursing_capacity")
            if "minimum_operating_team" in reasons:
                for role, minimum in (
                    ("provider", policy.get("minimum_provider_count", 2 if unit["kind"] == "ed" else 1)),
                    ("support", policy.get("minimum_support_count", 1)),
                ):
                    if roles.get(role, 0) < minimum:
                        resource("staff", role, "minimum_operating_team")
            if "required_equipment_unavailable" in reasons:
                required = Counter(
                    cap
                    for cap in group.partition(":")[2].split(",")
                    if cap and not cap.startswith("profile:")
                )
                for cap, amount in blanket.items():
                    required[cap] = max(required[cap], amount)
                for cap, amount in required.items():
                    if snap.get("equipment", {}).get(cap, {}).get("available", 0) < amount:
                        resource("equipment", cap, "required_equipment_unavailable")
            for reason in reasons & {"medical_supplies", "treatment_disruption"}:
                resource("supplies" if reason == "medical_supplies" else "disruption", reason, reason)
        for key in named:
            resources[key] += count

    def add(table, key, count, meta):
        row = ledger[table].setdefault(
            key,
            {
                **meta,
                "patient_hours": 0.0,
                "peak_waiting": 0,
                "first_at": model.at(begin),
                "first_replication_index": model.index,
            },
        )
        row["patient_hours"] += count * (next_time - begin) / 60
        row["peak_waiting"] = max(row["peak_waiting"], count)
        row["last_at"] = model.at(next_time)

    for reason, count in categories.items():
        add("categories", reason, count, {"reason": reason})
    for (uid, reason), count in units.items():
        add(
            "units",
            (uid, reason),
            count,
            {"unit_id": uid, "unit_kind": model.units[uid]["kind"], "reason": reason},
        )
    for key, count in resources.items():
        add("resources", key, count, metadata[key])


def finish_constraint_evidence(model):
    ledger = getattr(model, "_constraint_evidence", {})
    return {
        "scope": "selected_replication",
        "evidence_available": True,
        "non_additive": True,
        "start_at": model.at(model.measure_start),
        "end_at": model.at(model.horizon),
        "replication_index": model.index,
        **{
            name: sorted(
                deepcopy(list(ledger.get(name, {}).values())),
                key=lambda row: (
                    -row["patient_hours"],
                    row.get("unit_id", ""),
                    row["reason"],
                    row.get("code", ""),
                ),
            )
            for name in ("categories", "units", "resources")
        },
    }
