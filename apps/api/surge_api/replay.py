"""Exact replay state cache and bounded transport representation."""

from __future__ import annotations

import threading
from collections import Counter, OrderedDict, defaultdict
from urllib.parse import urlencode

from surge_engine import state_at
from surge_engine.common import dt

_cache = OrderedDict()
_lock = threading.RLock()


def exact_state(trace, at):
    minute = (
        float(at or 0)
        if at is None or isinstance(at, (int, float))
        else (dt(at) - dt(trace["start_at"])).total_seconds() / 60
    )
    key = (trace["replication_id"], trace.get("model_version"), trace["start_at"], minute)
    with _lock:
        if key in _cache:
            value = _cache.pop(key)
            _cache[key] = value
            return value
        value = state_at(trace, minute)
        value["patients"].sort(key=lambda p: (not bool(p.get("slot_id")), p["patient_id"]))
        units = {u["unit_id"]: u for u in value["units"]}
        main = next((u["facility_id"] for u in value["units"] if u.get("kind") == "ed"), "FAC-MAIN")
        counts = {
            "total": len(value["patients"]),
            "by_state": Counter(),
            "by_facility": Counter(),
            "by_care_level": Counter(),
        }
        queues = defaultdict(
            lambda: {
                "total": 0,
                "ward": 0,
                "icu": 0,
                "ed": 0,
                "ed_boarding": 0,
                "direct_waiting": 0,
                "stepdown": 0,
            }
        )
        blockers = defaultdict(Counter)
        groups = Counter()
        transfers = defaultdict(Counter)
        for patient in value["patients"]:
            site = (
                patient.get("facility_id") or units.get(patient.get("unit_id"), {}).get("facility_id") or main
            )
            patient["facility_id"] = site
            state, care = patient["state"], patient.get("care_level")
            counts["by_state"][state] += 1
            counts["by_facility"][site] += 1
            counts["by_care_level"][care or "unknown"] += 1
            groups[
                (
                    state,
                    care,
                    site,
                    patient.get("unit_id"),
                    patient.get("prior_state"),
                    patient.get("target_unit_kind"),
                    bool(patient.get("admission_pending")),
                    patient.get("eligible_for_transfer"),
                )
            ] += 1
            transfer = patient.get("pending_transfer") or {}
            transfer_status = transfer.get("status")
            destination = (
                transfer.get("destination_facility_id")
                or units.get(transfer.get("destination_unit_id"), {}).get("facility_id")
            )
            if transfer_status in {"requested", "reserved", "departed"} and destination:
                transfers[(site, destination)][transfer_status] += 1
            if patient.get("admission_pending"):
                queues[site]["total"] += 1
                required = patient.get("target_unit_kind", care)
                if required in {"ward", "icu"}:
                    queues[site][required] += 1
                if state in {"ed_boarding", "direct_waiting"}:
                    queues[site][state] += 1
                if state == "inpatient":
                    queues[site]["stepdown"] += 1
            if state == "ed_waiting":
                queues[site]["ed"] += 1
            for reason in set(patient.get("blockers", [])):
                blockers[site][reason] += 1
        value.update(
            patient_total=counts["total"],
            patient_counts=counts,
            queue_counts=dict(queues),
            blocker_summary=dict(blockers),
            patient_groups=[
                dict(
                    zip(
                        (
                            "state",
                            "care_level",
                            "facility_id",
                            "unit_id",
                            "prior_state",
                            "target_unit_kind",
                            "admission_pending",
                            "eligible_for_transfer",
                        ),
                        group,
                    ),
                    count=count,
                )
                for group, count in groups.items()
            ],
            # A complete selected-time route aggregate calculated before
            # `bounded_state` samples the patient inspection list. It contains
            # no patient IDs or route animation data.
            transfer_paths=[
                {
                    "from_facility_id": source,
                    "to_facility_id": destination,
                    "count": sum(statuses.values()),
                    "status_counts": dict(sorted(statuses.items())),
                }
                for (source, destination), statuses in sorted(transfers.items())
            ],
        )
        # A few neighboring seeks share exact reconstructed state; no history
        # mutation or RNG is involved. Bound both state count and patient count.
        while _cache and (
            len(_cache) >= 4
            or sum(len(x["patients"]) for x in _cache.values()) + len(value["patients"]) > 180000
        ):
            _cache.popitem(last=False)
        if len(value["patients"]) <= 180000:
            _cache[key] = value
        return value


def bounded_state(value, replication_id, maximum=500):
    total = len(value["patients"])
    query = urlencode({"at": value["at"], "limit": min(maximum, 200)})
    return {
        **value,
        "patients": value["patients"][:maximum],
        "patient_total": total,
        "patients_next_cursor": str(maximum) if total > maximum else None,
        "partial_collections": ["patients"] if total > maximum else [],
        "full_paginated_patients_url": f"/api/runs/{replication_id}/patients?{query}",
        "patient_sample_policy": "occupied/reserved slots first, then stable patient ID; exact aggregate counts include every patient",
    }
