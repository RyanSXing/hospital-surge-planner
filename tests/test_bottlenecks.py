"""Named resource evidence uses actual queue exposure and immutable trace state."""

import copy

import pytest
from surge_api.artifacts import ArtifactStore
from surge_api.bottlenecks import recorded_bottlenecks
from surge_api.db import Document, Job
from surge_engine import generate_dataset, run_replication
from test_review_api import reviewed  # noqa: F401


def example():
    dataset = {
        "units": [{"unit_id": "U", "kind": "icu", "capacity_policy_id": "P"}],
        "capacity_policies": [
            {
                "capacity_policy_id": "P",
                "slots_per_nurse": 2,
                "minimum_provider_count": 1,
                "minimum_support_count": 1,
            }
        ],
        "staff": [{"staff_id": "RN", "role": "rn", "capabilities": ["ICU_NURSING"]}],
    }
    unit = {
        "unit_id": "U",
        "kind": "icu",
        "elapsed_minutes": 0,
        "occupied": 2,
        "reserved": 0,
        "staffed": 2,
        "active_staff_ids": ["RN"],
        "staff_by_role": {"rn": 1},
        "equipment": {"VENTILATOR": {"available": 0}, "ICU_MONITOR": {"available": 1}},
    }
    reasons = [
        "nursing_capacity",
        "minimum_operating_team",
        "required_equipment_unavailable",
        "no_matching_physical_place",
    ]
    group = "icu:ICU_MONITOR,VENTILATOR"

    def waiting(begin, end):
        return {
            "start_elapsed_minutes": begin,
            "end_elapsed_minutes": end,
            "state": "ed_boarding",
            "admission_pending": True,
            "queue_group": group,
        }

    trace = {
        "replication_id": "REP",
        "start_at": "2026-10-16T05:00:00Z",
        "horizon_elapsed_minutes": 120,
        "patients": [
            {"patient_id": "A", "state_intervals": [waiting(0, 120)]},
            {"patient_id": "B", "state_intervals": [waiting(60, 120)]},
            {
                "patient_id": "TRANSPORT",
                "state_intervals": [{**waiting(0, 120), "state": "transfer_reserved"}],
            },
        ],
        "blocker_history": {
            group: [
                {
                    "start_elapsed_minutes": 0,
                    "reasons": reasons,
                    "units": [{"unit_id": "U", "reasons": reasons}],
                }
            ]
        },
        "unit_history": {
            "U": [
                unit,
                {
                    **unit,
                    "elapsed_minutes": 90,
                    "equipment": {"VENTILATOR": {"available": 1}, "ICU_MONITOR": {"available": 0}},
                },
            ]
        },
    }
    return trace, dataset


def test_counts_membership_changes_even_when_blocker_reasons_do_not_change():
    trace, dataset = example()
    before = copy.deepcopy(trace)
    result = recorded_bottlenecks(trace, dataset, {})
    assert trace == before
    assert result["non_additive"] is True
    assert all(row["patient_hours"] == 3 for row in result["categories"])
    assert all(row["peak_waiting"] == 2 for row in result["categories"])
    equipment = {
        row["code"]: row["patient_hours"] for row in result["resources"] if row["kind"] == "equipment"
    }
    # Resource availability changes while the broad equipment blocker remains.
    assert equipment == {"VENTILATOR": 2, "ICU_MONITOR": 1}
    roles = {row["code"] for row in result["resources"] if row["kind"] == "staff"}
    assert roles == {"rn", "provider", "support"}


def test_measurement_cutoff_and_overlapping_candidate_units_are_not_double_counted():
    trace, dataset = example()
    source = trace["blocker_history"][next(iter(trace["blocker_history"]))][0]
    source["units"].append(copy.deepcopy(source["units"][0]))
    result = recorded_bottlenecks(trace, dataset, {"measurement_start_at": "2026-10-16T06:00:00Z"})
    assert result["start_at"] == "2026-10-16T06:00:00Z"
    assert all(row["patient_hours"] == 2 for row in result["categories"])
    assert next(row for row in result["resources"] if row["code"] == "rn")["patient_hours"] == 2


def test_staffed_limit_does_not_invent_a_nurse_shortage_when_equipment_caps_beds():
    trace, dataset = example()
    dataset["staff"] += [
        {"staff_id": f"RN{i}", "role": "rn", "capabilities": ["ICU_NURSING"]} for i in range(2)
    ]
    for unit in trace["unit_history"]["U"]:
        unit["active_staff_ids"] += ["RN0", "RN1"]
    result = recorded_bottlenecks(trace, dataset, {})
    assert any(row["reason"] == "nursing_capacity" for row in result["categories"])
    assert not any(row["kind"] == "staff" and row["code"] == "rn" for row in result["resources"])


def test_blanket_monitor_stock_limit_is_named_even_for_a_basic_patient_and_no_equipment_reason():
    trace, dataset = example()
    group = "icu:"
    original = trace["blocker_history"].pop(next(iter(trace["blocker_history"])))
    original[0]["reasons"] = ["nursing_capacity"]
    original[0]["units"][0]["reasons"] = ["nursing_capacity"]
    trace["blocker_history"][group] = original
    for patient in trace["patients"]:
        for interval in patient["state_intervals"]:
            interval["queue_group"] = group
    dataset["capacity_policies"][0]["per_slot_resources"] = [
        {"capability_code": "ICU_MONITOR", "quantity": 1}
    ]
    # Three qualified nurses support six beds. The selected trace records two
    # failed monitors, so equipment supports only two beds, then recovers at 90m.
    for unit in trace["unit_history"]["U"]:
        unit["qualified_staff_by_role"] = {"rn": 3, "provider": 1, "support": 1}
    trace["equipment_pool_history"] = {
        "POOL": [
            {
                "elapsed_minutes": 0,
                "unit_id": "U",
                "capability_code": "ICU_MONITOR",
                "quantity": 4,
                "failed": 2,
            },
            {
                "elapsed_minutes": 90,
                "unit_id": "U",
                "capability_code": "ICU_MONITOR",
                "quantity": 4,
                "failed": 0,
            },
        ]
    }
    result = recorded_bottlenecks(trace, dataset, {})
    monitors = [row for row in result["resources"] if row["code"] == "ICU_MONITOR"]
    assert len(monitors) == 1
    assert monitors[0]["reason"] == "nursing_capacity"
    assert monitors[0]["patient_hours"] == 2
    assert not any(row["code"] == "rn" for row in result["resources"])


def test_real_stressed_hospital_constraint_integrals_match_engine_accounting():
    dataset = generate_dataset("stress_snapshot", days=2)
    scenario = {
        "horizon_calendar_days": 1,
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
    result = recorded_bottlenecks(trace, dataset, scenario)
    assert result["categories"]
    assert any(row["kind"] == "staff" and row["code"] == "rn" for row in result["resources"])
    actual = {row["reason"]: row["patient_hours"] for row in result["categories"]}
    assert actual == pytest.approx(dict(trace["blocker_patient_hours"]))


def test_bottleneck_endpoint_is_cached_read_only_and_uses_frozen_run_inputs(reviewed):  # noqa: F811
    client = reviewed
    run = client.completed
    rep = run["selected_replication_id"]
    with client.app.state.Session() as session:
        replication = session.get(Document, rep)
        trace = ArtifactStore().get_json(replication.data["trace_artifact"])
        job = session.get(Job, run["id"])
        dataset = session.get(Document, job.payload["dataset_version_id"]).data
        expected = recorded_bottlenecks(trace, dataset, job.payload["scenario"])
    path = f"/api/runs/{rep}/bottlenecks"
    first = client.get(path)
    assert first.status_code == 200, first.text
    actual = first.json()
    assert {key: actual[key] for key in expected} == expected
    assert client.get(path).json() == actual
    assert actual["context"]["run_group_id"] == run["id"]
    assert client.get("/api/runs/missing/bottlenecks").status_code == 404
    # Integrated reason exposure must match the engine's independently retained totals.
    for row in actual["categories"]:
        assert row["patient_hours"] == pytest.approx(trace["blocker_patient_hours"][row["reason"]])
