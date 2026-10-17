"""Synthetic equipment assumptions execute their stated quantities exactly."""

import pytest
from surge_api.domain import scenario_defaults, validate_scenario
from surge_engine import generate_dataset, run_replication, state_at
from surge_engine.equipment_planning import apply_planned_equipment


@pytest.fixture(scope="module")
def dataset():
    return generate_dataset(days=2)


def event(operation, quantity, at="2026-10-16T05:00:00Z", pool="EQ-RES-CLINIC-KIT"):
    return {
        "type": "equipment_change",
        "input_kind": "planned_assumption",
        "effective_at": at,
        "payload": {"equipment_pool_id": pool, "operation": operation, "quantity": quantity},
    }


def scenario(dataset, updates):
    return scenario_defaults({"horizon_calendar_days": 1, "replications": 1, "updates": updates}, dataset)


@pytest.mark.parametrize("operation,quantity", [("fail", 13), ("repair", 1), ("decommission", 13)])
def test_over_quantity_rejected_in_preflight_and_live_engine(dataset, operation, quantity):
    value = scenario(dataset, [event(operation, quantity)])
    assert any(
        e["field"] == "updates.0.payload.quantity" for e in validate_scenario(value, dataset)["errors"]
    )
    with pytest.raises(ValueError, match="cannot apply exactly"):
        run_replication(dataset, value)


def test_failure_then_repair_folds_chronology_and_same_time_stable_order(dataset):
    value = scenario(dataset, [event("repair", 3, "2026-10-16T06:00:00Z"), event("fail", 4)])
    assert validate_scenario(value, dataset)["valid"]
    trace = run_replication(dataset, value)
    pool = next(
        p for p in state_at(trace, 61)["equipment_pools"] if p["equipment_pool_id"] == "EQ-RES-CLINIC-KIT"
    )
    assert pool["quantity"] == 12 and pool["unserviceable_quantity"] == 1
    value["updates"][0]["effective_at"] = value["start_at"]
    assert not validate_scenario(value, dataset)["valid"]
    value["updates"].reverse()
    assert validate_scenario(value, dataset)["valid"]


def test_add_and_retire_failed_inventory_apply_exact_quantities(dataset):
    value = scenario(dataset, [event("add", 20), event("fail", 4), event("decommission", 30)])
    assert validate_scenario(value, dataset)["valid"]
    trace = run_replication(dataset, value)
    pool = next(
        p for p in state_at(trace, 1)["equipment_pools"] if p["equipment_pool_id"] == "EQ-RES-CLINIC-KIT"
    )
    assert pool["quantity"] == 2 and pool["unserviceable_quantity"] == 0


def test_prior_allocation_cannot_silently_shrink_a_planned_change(dataset):
    value = scenario(dataset, [event("fail", 5, "2026-10-16T05:01:00Z")])
    value["interventions"] = [
        {
            "kind": "clinic",
            "unit_id": "UNIT-CLINIC-NORTH",
            "activation_minutes": 0,
            "nurses": 2,
            "providers": 1,
            "support": 1,
            "enabled_slots": 8,
            "equipment_allocations": [{"equipment_pool_id": "EQ-RES-CLINIC-KIT", "quantity": 8}],
        }
    ]
    assert validate_scenario(value, dataset)["valid"]
    with pytest.raises(ValueError, match="requested 5, available 4 after prior allocations"):
        run_replication(dataset, value)


def test_retirement_defers_held_resources_without_losing_or_double_retiring_units():
    pool = {
        "equipment_pool_id": "P",
        "quantity": 10,
        "failed": 3,
        "pending_decommission": 0,
        "in_use": {"A": 6},
        "reserved": {"B": 2},
    }
    apply_planned_equipment(pool, "decommission", 9)
    assert pool == {
        "equipment_pool_id": "P",
        "quantity": 8,
        "failed": 0,
        "pending_decommission": 7,
        "in_use": {"A": 6},
        "reserved": {"B": 2},
    }
    with pytest.raises(ValueError, match="requested 2, available 1"):
        apply_planned_equipment(pool, "decommission", 2)
    with pytest.raises(ValueError, match="requested 2, available 1"):
        apply_planned_equipment(pool, "fail", 2)


def test_observed_report_saturation_remains_separate(dataset):
    value = scenario(dataset, [event("fail", 100)])
    del value["updates"][0]["input_kind"]
    assert validate_scenario(value, dataset)["valid"]
    trace = run_replication(dataset, value)
    pool = next(
        p for p in state_at(trace, 1)["equipment_pools"] if p["equipment_pool_id"] == "EQ-RES-CLINIC-KIT"
    )
    assert pool["unserviceable_quantity"] == 12


def test_null_update_identifiers_do_not_deduplicate_distinct_planned_changes(dataset):
    updates = [event("fail", 4), event("repair", 3)]
    for update in updates:
        update.update(update_id=None, idempotency_key=None, id=None)
    trace = run_replication(dataset, scenario(dataset, updates))
    pool = next(
        p for p in state_at(trace, 1)["equipment_pools"] if p["equipment_pool_id"] == "EQ-RES-CLINIC-KIT"
    )
    assert pool["unserviceable_quantity"] == 1


def test_planned_batch_updates_keep_synthetic_provenance_and_distinct_null_ids(dataset):
    updates = [
        {
            "update_id": None,
            "idempotency_key": None,
            "type": "arrival_batch",
            "input_kind": "planned_assumption",
            "effective_at": "2026-10-16T05:01:00Z",
            "payload": {"count": 2, "entry_stream_id": "ED_MAIN", "care_mix": {"ward": 1}},
        }
        for _ in range(2)
    ]
    trace = run_replication(dataset, scenario(dataset, updates))
    patients = [p for p in trace["patients"] if p.get("arrival_origin") == "synthetic_incident"]
    assert len(patients) == 4
    assert len({p["patient_id"] for p in patients}) == 4
    assert all(
        p["source_type"] == "surge_arrival" and p["input_kind"] == "planned_assumption" for p in patients
    )
    at = state_at(trace, 1)
    restored = [p for p in at["patients"] if p.get("arrival_origin") == "synthetic_incident"]
    assert len(restored) == 4
    assert all(
        p["source_type"] == "surge_arrival" and p["input_kind"] == "planned_assumption" for p in restored
    )


@pytest.mark.parametrize(
    "report_op,report_quantity,planned_op,planned_quantity,valid,remaining",
    [
        ("fail", 12, "fail", 1, False, None),
        ("fail", 100, "repair", 3, True, (12, 9)),
        ("decommission", 100, "fail", 1, False, None),
        ("decommission", 4, "fail", 8, True, (8, 8)),
    ],
)
def test_known_observed_equipment_reports_bound_later_plans(
    dataset, report_op, report_quantity, planned_op, planned_quantity, valid, remaining
):
    report = event(report_op, report_quantity)
    report.pop("input_kind")
    value = scenario(dataset, [report, event(planned_op, planned_quantity, "2026-10-16T05:01:00Z")])
    assert validate_scenario(value, dataset)["valid"] is valid
    if valid:
        trace = run_replication(dataset, value)
        pool = next(
            p for p in state_at(trace, 2)["equipment_pools"] if p["equipment_pool_id"] == "EQ-RES-CLINIC-KIT"
        )
        assert (pool["quantity"], pool["unserviceable_quantity"]) == remaining
    else:
        with pytest.raises(ValueError, match="cannot apply exactly"):
            run_replication(dataset, value)
