"""Compact immutable comparison evidence and explicit lexicographic ranking."""

from __future__ import annotations

import threading
from collections import OrderedDict
from datetime import timedelta

from surge_engine import paired_improvement
from surge_engine.aggregate import stats

from .artifacts import ArtifactStore
from .domain import date
from .feasibility import result_feasibility

_cache = OrderedDict()
_lock = threading.Lock()


def compact_summary(replications):
    return {
        "paired_waits": [
            {
                "replication_index": r["replication_index"],
                "scalar_metrics": {
                    "inpatient_waiting_patient_hours": r["scalar_metrics"].get(
                        "inpatient_waiting_patient_hours", 0
                    )
                },
            }
            for r in replications
        ],
        "feasibility": result_feasibility(replications),
    }


def summary_for(metadata, aggregate):
    if aggregate.get("comparison_summary"):
        return aggregate["comparison_summary"]
    store = ArtifactStore()
    key = (store.backend, str(store.root), metadata["object_key"], metadata["sha256"])
    with _lock:
        if key in _cache:
            summary = _cache.pop(key)
            _cache[key] = summary
            return summary
        summary = compact_summary(store.get_json(metadata))
        if len(_cache) >= 32:
            _cache.popitem(last=False)
        _cache[key] = summary
        return summary


def paired_summary(reference, candidate):
    value = paired_improvement(reference, candidate)
    by_index = {
        r["replication_index"]: r["scalar_metrics"]["inpatient_waiting_patient_hours"] for r in reference
    }
    relative = [
        100
        * (by_index[r["replication_index"]] - r["scalar_metrics"]["inpatient_waiting_patient_hours"])
        / by_index[r["replication_index"]]
        for r in candidate
        if by_index[r["replication_index"]] > 0
    ]
    relative_stats = stats(relative) if relative else None
    return {
        **value,
        **value["absolute_change"],
        "probability_improvement": value["probability_of_improvement"],
        "relative_change_percent": relative_stats,
        "percent_reduction": relative_stats["p50"] if relative_stats else None,
        "relative_replications": len(relative),
        "relative_undefined_replications": len(candidate) - len(relative),
        "relative_basis": "Paired percent reduction for repetitions with positive reference waiting; zero reference repetitions are N/A",
    }


def activation_at(plan, scenario):
    times = []
    for response in plan.get("interventions", []):
        if response.get("enabled", True):
            kind = response.get("kind", response.get("template_kind"))
            default = (
                360
                if kind in {"clinic", "activate_clinic"}
                else 720
                if kind in {"physical_overflow", "staffed_overflow", "activate_overflow"}
                else 0
            )
            times.append(
                date(response.get("start_at", scenario["start_at"]))
                + timedelta(minutes=response.get("activation_minutes", default))
            )
    return min(times) if times else date(scenario["start_at"])


def rank_plans(plans, scenario):
    eligible = [p for p in plans if p.get("status") == "SUCCEEDED"]
    currency = {p.get("cost_currency") for p in eligible}
    use_cost = bool(
        eligible
        and len(currency) == 1
        and None not in currency
        and all(isinstance(p.get("resource_cost"), (int, float)) for p in eligible)
    )

    def median(plan, key):
        metric = plan.get("metrics", {}).get("scalar_metrics", {}).get(key, 0)
        return metric.get("p50", 0) if isinstance(metric, dict) else metric

    for plan in eligible:
        plan["activation_at"] = activation_at(plan, scenario).isoformat()
        plan["financial_cost_comparable"] = use_cost
    return sorted(
        eligible,
        key=lambda p: (
            median(p, "inpatient_waiting_patient_hours"),
            median(p, "peak_inpatient_queue"),
            median(p, "additional_staff_hours"),
            p["resource_cost"] if use_cost else 0,
            activation_at(p, scenario),
            p["id"],
        ),
    )
