"""Exact compact queue evidence and honest ensemble reduction."""

import copy
from datetime import timedelta
from types import SimpleNamespace

import pytest
from surge_api.bottlenecks import ensemble_bottlenecks, recorded_bottlenecks
from surge_engine import generate_dataset, run_replication
from surge_engine.common import dt, iso
from surge_engine.constraint_evidence import finish_constraint_evidence, integrate_constraint_evidence


def evidence(index, hours=None, at="2026-10-16T06:00:00Z"):
    rows = (
        []
        if hours is None
        else [
            {
                "reason": "nursing_capacity",
                "patient_hours": hours,
                "peak_waiting": 3,
                "first_at": at,
                "last_at": "2026-10-17T05:00:00Z",
                "first_replication_index": index,
            }
        ]
    )
    return {
        "replication_index": index,
        "status": "SUCCEEDED",
        "bottleneck_evidence": {
            "scope": "selected_replication",
            "evidence_available": True,
            "non_additive": True,
            "start_at": "2026-10-16T05:00:00Z",
            "end_at": "2026-10-17T05:00:00Z",
            "categories": rows,
            "units": [],
            "resources": [],
        },
    }


def test_ensemble_uses_zeros_only_for_a_complete_run_with_no_constraint():
    result = ensemble_bottlenecks([evidence(0, 6), evidence(1)], "run-test")
    assert result["evidence_available"]
    assert result["non_additive"]
    row = result["categories"][0]
    assert row["patient_hours"]["mean"] == 3
    assert row["patient_hours"]["min"] == 0
    assert row["replications_with_constraint"] == 1
    missing = ensemble_bottlenecks(
        [evidence(0, 6), {"replication_index": 1, "status": "SUCCEEDED"}], "run-test"
    )
    assert not missing["evidence_available"]
    assert not missing["categories"]


def test_first_occurrence_links_to_its_actual_replication_and_tie_breaks_by_index():
    result = ensemble_bottlenecks(
        [evidence(7, 4, "2026-10-16T07:00:00Z"), evidence(5, 1), evidence(2, 2)], "run-test"
    )
    row = result["categories"][0]
    assert row["first_at"] == "2026-10-16T06:00:00Z"
    assert row["first_replication_index"] == 2
    assert row["first_replication_id"] == "run-test_rep_0002"
    assert row["patient_hours"]["mean"] == pytest.approx(7 / 3)


def test_missing_numeric_values_are_unavailable_not_zero():
    missing = evidence(1, 6)
    missing["bottleneck_evidence"]["categories"][0]["patient_hours"] = None
    result = ensemble_bottlenecks([evidence(0, 4), missing], "run-test")
    # A partial set must not be described as a complete ensemble mean.
    assert not result["evidence_available"]
    assert result["categories"] == []


@pytest.mark.parametrize(
    "invalid",
    ["missing_window", "reversed_window", "invalid_window", "wrong_source", "failed", "missing_unit"],
)
def test_malformed_context_is_unavailable_instead_of_crashing_or_linking_wrong_run(invalid):
    row = evidence(1, 6)
    item = row["bottleneck_evidence"]
    if invalid == "missing_window":
        item.pop("start_at")
    elif invalid == "reversed_window":
        item["end_at"] = "2026-10-15T05:00:00Z"
    elif invalid == "invalid_window":
        item["start_at"] = "unknown"
    elif invalid == "wrong_source":
        item["categories"][0]["first_replication_index"] = 9
    elif invalid == "failed":
        row["status"] = "FAILED"
    else:
        item["units"] = [copy.deepcopy(item["categories"][0])]
    result = ensemble_bottlenecks([evidence(0, 4), row], "run-test")
    assert result["evidence_available"] is False
    assert result["categories"] == []
    assert result["units"] == []


def test_duplicate_blanket_requirements_name_the_actual_equipment_constraint():
    """The engine combines repeated capability rows; evidence must do so too."""
    start = dt("2026-10-16T05:00:00Z")
    unit = {"unit_id": "U", "kind": "icu", "capacity_policy_id": "P"}
    snapshot = {
        "occupied": 1,
        "reserved": 0,
        "qualified_staff_by_role": {"rn": 10, "provider": 2, "support": 2},
        "equipment": {"MONITOR": {"available": 1}},
    }
    reasons = ["nursing_capacity", "required_equipment_unavailable"]
    model = SimpleNamespace(
        now=0,
        measure_start=0,
        horizon=60,
        index=0,
        current_blockers={
            "icu:": {"patient_count": 1, "reasons": reasons, "units": [{"unit_id": "U", "reasons": reasons}]}
        },
        units={"U": unit},
        unit_snapshot=lambda _: snapshot,
        policies={
            "P": {
                "slots_per_nurse": 2,
                "per_slot_resources": [
                    {"capability_code": "MONITOR", "quantity": 1},
                    {"capability_code": "MONITOR", "quantity": 1},
                ],
            }
        },
        pools={"POOL": {"unit_id": "U", "capability_code": "MONITOR", "quantity": 3}},
        at=lambda minutes: iso(start + timedelta(minutes=minutes)),
    )
    integrate_constraint_evidence(model, 60)
    result = finish_constraint_evidence(model)
    rows = result["resources"]
    assert {(row["kind"], row["code"], row["reason"]) for row in rows} == {
        ("equipment", "MONITOR", "nursing_capacity"),
        ("equipment", "MONITOR", "required_equipment_unavailable"),
    }
    assert all(row["patient_hours"] == 1 for row in rows)
    assert not any(row["kind"] == "staff" for row in rows)
    assert result["non_additive"]


@pytest.mark.parametrize("dataset_name", ["hospital_baseline", "stress_snapshot"])
def test_compact_evidence_matches_independent_legacy_interval_sweep(dataset_name):
    dataset = generate_dataset(dataset_name, days=2)
    scenario = {
        "horizon_calendar_days": 1,
        "base_seed": 43121,
        "conditions": [
            {
                "kind": "staff_unavailability",
                "unit_id": "UNIT-WARD-A",
                "count": 2,
                "start_at": "2026-10-16T05:15:00Z",
                "end_at": "2026-10-17T05:00:00Z",
            }
        ],
    }
    trace = run_replication(dataset, scenario)
    original = copy.deepcopy(trace)
    compact = trace["bottleneck_evidence"]
    legacy = {key: value for key, value in trace.items() if key != "bottleneck_evidence"}
    swept = recorded_bottlenecks(legacy, dataset, scenario)
    for table, fields in (
        ("categories", ("reason",)),
        ("units", ("unit_id", "reason")),
        ("resources", ("unit_id", "kind", "code", "reason")),
    ):
        actual = {tuple(row.get(field) for field in fields): row for row in compact[table]}
        expected = {tuple(row.get(field) for field in fields): row for row in swept[table]}
        # The compact model now also names beds; the old interval-sweep surface
        # exposed physical-place categories without corresponding resource rows.
        assert not expected.keys() - actual.keys()
        for key in actual.keys() - expected.keys():
            assert table == "resources" and actual[key]["kind"] == "beds"
        for key, row in expected.items():
            assert actual[key]["patient_hours"] == pytest.approx(row["patient_hours"])
            assert actual[key]["peak_waiting"] == row["peak_waiting"]
            assert actual[key]["first_at"] == row["first_at"]
            assert actual[key]["last_at"] == row["last_at"]
    assert trace == original
