import copy

import pytest
from surge_api.compute import estimate, expected_demand
from surge_engine import generate_dataset, run_replication


def test_estimate_matches_engine_hour_integration_and_corrects_reports():
    dataset = generate_dataset(days=4)
    scenario = {
        "id": "estimate-test",
        "start_at": dataset["snapshot_at"],
        "timezone": dataset["timezone"],
        "base_seed": 1234,
        "dataset_version_id": dataset["dataset_version_id"],
    }
    scenario.update(horizon_calendar_days=1, conditions=[], replications=100)
    scenario["updates"] = [
        {
            "update_id": "batch",
            "type": "arrival_batch",
            "effective_at": scenario["start_at"],
            "payload": {"count": 30},
        },
        {
            "update_id": "correction",
            "type": "retract_or_correct",
            "effective_at": scenario["start_at"],
            "payload": {"referenced_update_id": "batch", "replacement_payload": {"count": 10}},
        },
    ]
    demand = expected_demand(dataset, scenario)
    result = run_replication(dataset, scenario, keep_trace=False)
    assert demand["forecast_arrivals_per_replication"] == pytest.approx(
        result["scalar_metrics"]["expected_arrivals"]
    )
    assert demand["reported_arrivals_per_replication"] == 10
    assert demand["expected_trajectories_per_replication"] == pytest.approx(
        demand["forecast_arrivals_per_replication"] + 10 + len(dataset["patients"])
    )
    high = copy.deepcopy(scenario)
    high["replications"] = 500
    assert not estimate(dataset, high, {"max_run_trajectories": 1000})["within_budget"]


def test_exact_equipment_allocations_detect_overlapping_commitments():
    from surge_api.feasibility import plan_feasibility

    dataset = generate_dataset(days=4)
    pool = next(p for p in dataset["equipment_pools"] if p.get("portable") and p.get("unit_id") is None)
    scenario = {
        "start_at": dataset["snapshot_at"],
        "timezone": dataset["timezone"],
        "horizon_calendar_days": 1,
        "conditions": [],
    }
    response = {
        "kind": "physical_overflow",
        "unit_id": "UNIT-OVERFLOW-SOUTH",
        "activation_minutes": 0,
        "equipment_allocations": [
            {"equipment_pool_id": pool["equipment_pool_id"], "quantity": pool["quantity"]}
        ],
    }
    result = plan_feasibility(dataset, scenario, [response, {**response, "name": "Second allocation"}])
    assert not result["feasible"]
    assert any("overlapping equipment allocations" in reason for reason in result["reasons"])


def test_clinic_preflight_distinguishes_missing_minimum_team_and_partial_coverage():
    from surge_api.feasibility import plan_feasibility

    dataset = generate_dataset(days=4)
    scenario = {
        "start_at": dataset["snapshot_at"],
        "timezone": dataset["timezone"],
        "horizon_calendar_days": 1,
        "conditions": [],
    }
    response = {
        "kind": "clinic",
        "unit_id": "UNIT-CLINIC-NORTH",
        "activation_minutes": 0,
        "enabled_slots": 8,
        "nurses": 0,
        "providers": 0,
        "support": 0,
    }
    assert not plan_feasibility(dataset, scenario, [response])["feasible"]
    partial = plan_feasibility(dataset, scenario, [{**response, "nurses": 1, "providers": 1, "support": 1}])
    assert partial["feasible"] and any("4 of 8" in message for message in partial["warnings"])
