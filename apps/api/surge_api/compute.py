"""Deterministic execution estimates using the engine's exact demand integration."""

from __future__ import annotations

import copy

from surge_engine import estimate_expected_arrivals
from surge_engine.common import dt, endpoint

DEFAULT_LIMITS = {"max_run_trajectories": 40_000_000, "max_comparison_trajectories": 80_000_000}


def expected_demand(dataset, scenario):
    start_at = scenario.get("start_at", dataset["snapshot_at"])
    start = dt(start_at)
    end = (
        dt(scenario["end_at"])
        if scenario.get("end_at")
        else endpoint(
            start,
            scenario.get("horizon_calendar_days", 30),
            scenario.get("timezone", dataset.get("timezone", "America/Chicago")),
        )
    )
    horizon = (end - start).total_seconds() / 60
    forecast = estimate_expected_arrivals(dataset, scenario)

    def batch(at, payload):
        offset = (dt(at) - start).total_seconds() / 60
        spread = float(payload.get("spread_minutes", 0))
        fraction = (
            max(0, min(horizon, offset + spread) - max(0, offset)) / spread
            if spread
            else float(0 <= offset <= horizon)
        )
        return int(payload.get("count", 0)) * fraction

    reported = sum(
        batch(c.get("at", start_at), c)
        for c in scenario.get("conditions", [])
        if c.get("kind") == "arrival_batch"
    )
    updates = copy.deepcopy(scenario.get("updates", []))
    by_id = {u.get("update_id", u.get("id", str(i))): u for i, u in enumerate(updates)}
    for item in updates:
        if item.get("type") == "retract_or_correct" and item.get("status", "active") == "active":
            payload = item.get("payload", {})
            original = by_id.get(payload.get("referenced_update_id", payload.get("update_id")))
            if original is not None:
                if payload.get("replacement_payload") is None:
                    original["status"] = "retracted"
                else:
                    original["payload"] = payload["replacement_payload"]
            item["status"] = "superseded"
    seen = set()
    for i, item in enumerate(updates):
        key = item.get("idempotency_key", item.get("update_id", str(i)))
        if key in seen or item.get("status", "active") != "active":
            continue
        seen.add(key)
        if item.get("type") == "arrival_batch":
            reported += batch(item["effective_at"], item.get("payload", {}))
    return {
        "forecast_arrivals_per_replication": forecast,
        "reported_arrivals_per_replication": reported,
        "expected_arrivals_per_replication": forecast + reported,
        "initial_census_per_replication": len(dataset.get("patients", [])),
        "expected_trajectories_per_replication": forecast + reported + len(dataset.get("patients", [])),
    }


def estimate(dataset, scenario, settings=None, plans=1):
    limits = {**DEFAULT_LIMITS, **{k: v for k, v in (settings or {}).items() if k in DEFAULT_LIMITS}}
    demand = expected_demand(dataset, scenario)
    reps = scenario.get("replications", 100)
    group = demand["expected_trajectories_per_replication"] * reps
    per_rep_limit = min(400_000, scenario.get("max_expected_arrivals", 400_000))
    errors = []
    if demand["expected_arrivals_per_replication"] > per_rep_limit:
        errors.append(
            {
                "field": "conditions",
                "message": f"Expected arrivals per replication exceed {per_rep_limit:,}; reduce surge intensity or horizon",
            }
        )
    if group > limits["max_run_trajectories"]:
        errors.append(
            {
                "field": "replications",
                "message": "Expected trajectories exceed the run-group budget; reduce horizon or repetitions",
            }
        )
    if group * plans > limits["max_comparison_trajectories"]:
        errors.append(
            {
                "field": "plans",
                "message": "Expected trajectories exceed the comparison budget; reduce plans, horizon or repetitions",
            }
        )
    return {
        **demand,
        "replications": reps,
        "plans": plans,
        "expected_trajectories_per_run": group,
        "expected_trajectories_total": group * plans,
        "limits": {**limits, "max_expected_arrivals_per_replication": per_rep_limit},
        "within_budget": not errors,
        "errors": errors,
        "basis": "Exact local-calendar hourly demand integration, corrected additive reports, and current-census copies; expectation, not a random realized count",
    }
