"""Read-only constraint evidence reconstructed from one immutable trajectory.

Queue membership is swept from patient intervals: blocker histories only change
when reasons change, so their snapshots cannot supply integrated patient counts.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta

from surge_engine.common import dt, iso


def recorded_bottlenecks(trace, dataset, scenario):
    start = dt(trace["start_at"])
    horizon = float(trace["horizon_elapsed_minutes"])
    lower = max(
        0.0,
        (
            dt(scenario.get("measurement_start_at") or scenario.get("branch_at") or trace["start_at"]) - start
        ).total_seconds()
        / 60,
    )
    lower = min(lower, horizon)
    events = defaultdict(list)
    events[lower]
    events[horizon]

    def minute(row):
        value = row.get("start_elapsed_minutes", row.get("elapsed_minutes"))
        if value is not None:
            return float(value)
        return (dt(row.get("start_at") or row["at"]) - start).total_seconds() / 60

    for patient in trace.get("patients", []):
        intervals = patient.get("state_intervals", [])
        for index, interval in enumerate(intervals):
            if interval.get("state") in {"transfer_reserved", "in_transit", "discharged"}:
                continue
            if not (interval.get("admission_pending") or interval.get("state") == "ed_waiting"):
                continue
            group = interval.get("queue_group")
            if not group:
                continue
            begin = max(lower, minute(interval))
            ending = interval.get("end_elapsed_minutes")
            if ending is None and index + 1 < len(intervals):
                ending = minute(intervals[index + 1])
            end = min(horizon, float(ending) if ending is not None else horizon)
            if begin < end:
                events[begin].append(("queue", group, 1))
                events[end].append(("queue", group, -1))

    def history_events(table, kind):
        for identity, history in trace.get(table, {}).items():
            previous = None
            for row in history:
                at = minute(row)
                if at <= lower:
                    previous = row
                elif at < horizon:
                    events[at].append((kind, identity, row))
            if previous is not None:
                events[lower].append((kind, identity, previous))

    history_events("blocker_history", "blocker")
    history_events("unit_history", "unit")
    history_events("equipment_pool_history", "pool")
    definitions = {u["unit_id"]: u for u in dataset.get("units", [])}
    policies = {p["capacity_policy_id"]: p for p in dataset.get("capacity_policies", [])}
    staff = {p["staff_id"]: p for p in dataset.get("staff", [])}
    queues, blockers, units, pools = Counter(), {}, {}, {}
    categories, resources = {}, {}

    def add(target, key, metadata, count, begin, end):
        item = target.setdefault(
            key,
            {
                **metadata,
                "patient_hours": 0.0,
                "peak_waiting": 0,
                "first_at": iso(start + timedelta(minutes=begin)),
                "last_at": iso(start + timedelta(minutes=end)),
            },
        )
        item["patient_hours"] += count * (end - begin) / 60
        item["peak_waiting"] = max(item["peak_waiting"], count)
        item["last_at"] = iso(start + timedelta(minutes=end))

    times = sorted(events)
    for index, begin in enumerate(times[:-1]):
        for kind, identity, value in events[begin]:
            if kind == "queue":
                queues[identity] += value
            elif kind == "blocker":
                blockers[identity] = value
            elif kind == "unit":
                units[identity] = value
            else:
                pools[identity] = value
        end = times[index + 1]
        serviceable = defaultdict(Counter)
        for pool in pools.values():
            serviceable[pool.get("unit_id")][pool["capability_code"]] += max(
                0,
                pool["quantity"] - pool.get("failed", 0) - pool.get("pending_decommission", 0),
            )
        category_counts, resource_counts = Counter(), Counter()
        resource_metadata = {}
        for group, count in queues.items():
            if count <= 0:
                continue
            blocker = blockers.get(group, {})
            for reason in set(blocker.get("reasons", [])):
                category_counts[reason] += count
            # A queued group can encounter the same resource in several units;
            # keep unit evidence separate while counting each group only once
            # per named resource and unit in this time slice.
            named = {}
            required = Counter(
                cap for cap in group.partition(":")[2].split(",") if cap and not cap.startswith("profile:")
            )
            for detail in blocker.get("units", []):
                uid = detail["unit_id"]
                unit = units.get(uid, {})
                definition = definitions.get(uid, {})
                policy = policies.get(definition.get("capacity_policy_id"), {})
                reasons = set(detail.get("reasons", []))
                meta = {"unit_id": uid, "unit_kind": unit.get("kind", definition.get("kind"))}

                def resource(kind, code, reason, named=named, uid=uid, meta=meta):
                    named[(kind, code, uid, reason)] = {**meta, "kind": kind, "code": code, "reason": reason}

                # Only name a staff role where actual recorded qualifications
                # prove a deficit. Never interpret staffed-bed occupancy alone
                # as proof of a nurse shortage (equipment also caps staffing).
                ids = unit.get("active_staff_ids", [])
                known = "active_staff_ids" in unit and all(identity in staff for identity in ids)
                care = unit.get("kind", definition.get("kind", "ward"))

                def qualified(capability, role, unit=unit, known=known, ids=ids):
                    if role in unit.get("qualified_staff_by_role", {}):
                        return unit["qualified_staff_by_role"][role]
                    if known:
                        return sum(capability in staff[identity].get("capabilities", []) for identity in ids)
                    return unit.get("staff_by_role", {}).get(role)

                if "nursing_capacity" in reasons:
                    nurses = qualified(policy.get("nurse_capability", care.upper() + "_NURSING"), "rn")
                    ratio = policy.get("slots_per_nurse", 2 if care == "icu" else 4)
                    demand = unit.get("occupied", 0) + unit.get("reserved", 0) + 1
                    if nurses is not None and nurses * ratio < demand:
                        resource("staff", "rn", "nursing_capacity")
                    # Staffed beds are also capped by blanket per-bed equipment
                    # stock. A basic patient can have no explicit equipment in
                    # its queue group while monitors still limit this unit.
                    blanket = Counter()
                    for requirement in policy.get("per_slot_resources", []):
                        blanket[requirement["capability_code"]] += requirement.get("quantity", 1)
                    for capability, amount in blanket.items():
                        quantity = (
                            serviceable[uid][capability]
                            if "equipment_pool_history" in trace
                            else unit.get("equipment", {}).get(capability, {}).get("quantity", 0)
                            if "equipment" in unit
                            else None
                        )
                        if quantity is not None and quantity < demand * amount:
                            resource("equipment", capability, "nursing_capacity")
                if "minimum_operating_team" in reasons:
                    for role, capability, minimum in (
                        (
                            "provider",
                            care.upper() + "_PROVIDER",
                            policy.get("minimum_provider_count", 2 if care == "ed" else 1),
                        ),
                        ("support", "GENERAL_SUPPORT", policy.get("minimum_support_count", 1)),
                    ):
                        amount = qualified(capability, role)
                        if amount is not None and amount < minimum:
                            resource("staff", role, "minimum_operating_team")
                if "required_equipment_unavailable" in reasons:
                    demands = required.copy()
                    blanket = Counter()
                    for requirement in policy.get("per_slot_resources", []):
                        blanket[requirement["capability_code"]] += requirement.get("quantity", 1)
                    for capability, amount in blanket.items():
                        demands[capability] = max(demands[capability], amount)
                    for cap, amount in demands.items():
                        if unit.get("equipment", {}).get(cap, {}).get("available", 0) < amount:
                            resource("equipment", cap, "required_equipment_unavailable")
            for key, metadata in named.items():
                resource_counts[key] += count
                resource_metadata[key] = metadata
        for reason, count in category_counts.items():
            add(categories, reason, {"reason": reason}, count, begin, end)
        for key, count in resource_counts.items():
            add(resources, key, resource_metadata[key], count, begin, end)

    return {
        "scope": "selected_replication",
        "replication_id": trace["replication_id"],
        "start_at": iso(start + timedelta(minutes=lower)),
        "end_at": iso(start + timedelta(minutes=horizon)),
        "categories": sorted(categories.values(), key=lambda x: (-x["patient_hours"], x["reason"])),
        "resources": sorted(
            resources.values(), key=lambda x: (-x["patient_hours"], x["kind"], x["code"], x["unit_id"])
        ),
        "non_additive": True,
        "evidence_available": "blocker_history" in trace,
    }
