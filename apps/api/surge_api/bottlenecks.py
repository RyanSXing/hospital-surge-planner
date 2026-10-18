"""Read-only constraint evidence reconstructed from one immutable trajectory.

Queue membership is swept from patient intervals: blocker histories only change
when reasons change, so their snapshots cannot supply integrated patient counts.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import timedelta

from surge_engine.common import dt, iso


def ensemble_bottlenecks(replications, run_group_id):
    """Summarize compact per-run exposure, with zeros only for proven absence."""
    from surge_engine.aggregate import stats

    evidence = [r.get("bottleneck_evidence") for r in replications]

    def valid(item, replication_index):
        if not isinstance(item, dict) or item.get("evidence_available") is not True:
            return False
        try:
            start, end = dt(item["start_at"]), dt(item["end_at"])
            if start >= end:
                return False
        except (KeyError, ValueError, TypeError, OverflowError):
            return False
        for table in ("categories", "units", "resources"):
            rows = item.get(table)
            if not isinstance(rows, list):
                return False
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("reason"), str):
                    return False
                required = (
                    ("unit_id",)
                    if table == "units"
                    else ("unit_id", "kind", "code")
                    if table == "resources"
                    else ()
                )
                if any(not isinstance(row.get(field), str) or not row[field] for field in required):
                    return False
                if any(
                    type(row.get(field)) not in (int, float)
                    or not math.isfinite(row[field])
                    or row[field] < 0
                    for field in ("patient_hours", "peak_waiting")
                ):
                    return False
                try:
                    if not start <= dt(row["first_at"]) < end:
                        return False
                except (KeyError, ValueError, TypeError, OverflowError):
                    return False
                if row.get("first_replication_index") != replication_index:
                    return False
        return True

    indexes = [r.get("replication_index") for r in replications]
    complete = (
        bool(evidence)
        and all(type(index) is int and index >= 0 for index in indexes)
        and len(set(indexes)) == len(indexes)
        and all(r.get("status") == "SUCCEEDED" for r in replications)
        and all(valid(e, index) for e, index in zip(evidence, indexes))
    )
    complete = complete and len({(e["start_at"], e["end_at"]) for e in evidence}) == 1
    base = {
        "scope": "ensemble",
        "evidence_available": complete,
        "non_additive": True,
        "replications_completed": len(replications),
    }
    if not complete:
        return {
            **base,
            "categories": [],
            "units": [],
            "resources": [],
            "unavailable_reason": "Complete numeric constraint evidence for every simulation and the same measured period is required.",
        }
    base.update(start_at=evidence[0]["start_at"], end_at=evidence[0]["end_at"])
    for table, fields in (
        ("categories", ("reason",)),
        ("units", ("unit_id", "reason")),
        ("resources", ("unit_id", "reason", "kind", "code")),
    ):
        indexed = [{tuple(row.get(k) for k in fields): row for row in e.get(table, [])} for e in evidence]
        rows = []
        for key in sorted(set().union(*(set(items) for items in indexed))):
            originals = [items.get(key) for items in indexed]
            known = [row for row in originals if row is not None]
            first = min(known, key=lambda row: (dt(row["first_at"]), row.get("first_replication_index", 0)))
            index = first.get("first_replication_index", 0)
            rows.append(
                {
                    **{
                        field: first[field]
                        for field in ("unit_id", "unit_kind", "reason", "kind", "code")
                        if field in first
                    },
                    "patient_hours": stats([row["patient_hours"] if row else 0.0 for row in originals]),
                    "peak_waiting": stats([row["peak_waiting"] if row else 0 for row in originals]),
                    "first_at": first["first_at"],
                    "first_replication_id": f"{run_group_id}_rep_{index:04d}",
                    "first_replication_index": index,
                    "replications_with_constraint": len(known),
                    "first_at_basis": "Earliest recorded occurrence across completed simulations",
                }
            )
        base[table] = sorted(
            rows,
            key=lambda row: (
                -row["patient_hours"]["mean"],
                row.get("unit_id", ""),
                row["reason"],
                row.get("code", ""),
            ),
        )
    return base


def recorded_bottlenecks(trace, dataset, scenario):
    if trace.get("bottleneck_evidence", {}).get("evidence_available"):
        return {**trace["bottleneck_evidence"], "replication_id": trace["replication_id"]}
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
    categories, resources, unit_burdens = {}, {}, {}

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
        category_counts, resource_counts, unit_counts = Counter(), Counter(), Counter()
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
                for reason in reasons:
                    unit_counts[(uid, reason)] += count

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
        for (uid, reason), count in unit_counts.items():
            add(
                unit_burdens,
                (uid, reason),
                {"unit_id": uid, "unit_kind": definitions.get(uid, {}).get("kind"), "reason": reason},
                count,
                begin,
                end,
            )
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
        "units": sorted(
            unit_burdens.values(), key=lambda x: (-x["patient_hours"], x["unit_id"], x["reason"])
        ),
        "non_additive": True,
        "evidence_available": "blocker_history" in trace,
    }
