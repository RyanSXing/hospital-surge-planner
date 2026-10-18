"""Exact floor-plan counters survive seeks and bounded patient transport."""

import copy
from collections import Counter

import pytest
from surge_api.replay import bounded_state, exact_state
from surge_engine.common import digest


def trace(identity, *, events=None, patients=None):
    start = "2026-10-16T05:00:00Z"
    return {
        "replication_id": identity, "model_version": "1.1.0", "start_at": start,
        "horizon_elapsed_minutes": 240,
        "patients": patients or [],
        "unit_history": {
            identity: [{"unit_id": identity, "facility_id": facility, "kind": kind,
                        "elapsed_minutes": 0, "at": start}]
            for identity, facility, kind in [("WARD-A", "FAC-MAIN", "ward"),
                                            ("ICU", "FAC-MAIN", "icu"),
                                            ("ED", "FAC-MAIN", "ed"),
                                            ("OTHER-WARD", "FAC-OTHER", "ward")]
        },
        "events": events or [],
    }


def patient(identity, state="direct_waiting", facility="FAC-MAIN", **fields):
    return {
        "patient_id": identity,
        "state_intervals": [{"start_elapsed_minutes": 0, "state": state,
                             "facility_id": facility, "care_level": "ward", **fields}],
    }


@pytest.mark.parametrize("minute,arrivals,discharges,other", [(0, 0, 0, 0), (10, 1, 0, 0),
                                                            (30, 2, 1, 0), (60, 2, 2, 1), (120, 2, 2, 1)])
def test_cumulative_events_include_equal_time_and_correct_facility(minute, arrivals, discharges, other):
    source = trace("floor-plan-flow-" + str(minute), patients=[patient("P1"), patient("P2")], events=[
        # Deliberately unsorted: index chronology must not depend on transport order.
        {"event_type": "discharge", "elapsed_minutes": 60, "patient_id": "P2", "from_unit_id": "WARD-A"},
        {"event_type": "arrival", "elapsed_minutes": 10, "patient_id": "P1"},
        {"event_type": "discharge", "elapsed_minutes": 60, "patient_id": "P3", "from_unit_id": "OTHER-WARD"},
        {"event_type": "discharge", "elapsed_minutes": 30, "patient_id": "P1", "from_unit_id": "ED"},
        {"event_type": "arrival", "elapsed_minutes": 20, "patient_id": "P2"},
        {"event_type": "admission", "elapsed_minutes": 25, "patient_id": "P1"},
    ])
    original = digest(source)
    state = exact_state(source, minute)
    assert state["flow_counts"]["FAC-MAIN"] == {"arrivals": arrivals, "discharges": discharges}
    assert state["flow_counts"]["FAC-OTHER"]["discharges"] == other
    assert state["flow_counts_start_at"] == source["start_at"]
    assert digest(source) == original


def test_backward_seeks_do_not_keep_future_discharge_totals():
    source = trace("floor-plan-backwards", patients=[patient("P")], events=[
        {"event_type": "arrival", "elapsed_minutes": 10, "patient_id": "P"},
        {"event_type": "discharge", "elapsed_minutes": 30, "patient_id": "P", "from_unit_id": "WARD-A"},
    ])
    assert exact_state(source, 100)["flow_counts"]["FAC-MAIN"]["discharges"] == 1
    assert exact_state(source, 20)["flow_counts"]["FAC-MAIN"]["discharges"] == 0
    assert exact_state(source, 0)["flow_counts"]["FAC-MAIN"] == {"arrivals": 0, "discharges": 0}


def test_unit_constraints_use_full_population_before_patient_sampling_and_preserve_overlap():
    source = trace("floor-plan-large-queue", patients=[
        patient(f"WAIT-{index}", queue_group="ward:oxygen", admission_pending=True)
        for index in range(630)
    ] + [patient("PAUSED", state="inpatient", unit_id="WARD-A", care_paused=True,
                 care_pause_reasons=["medical_supplies", "treatment_disruption", "medical_supplies"])])
    source["blocker_history"] = {"ward:oxygen": [{
        "start_elapsed_minutes": 0,
        "reasons": ["required_equipment_unavailable", "nursing_capacity"],
        "units": [{"unit_id": "WARD-A", "reasons": ["required_equipment_unavailable", "nursing_capacity"]},
                  {"unit_id": "WARD-A", "reasons": ["required_equipment_unavailable"]},
                  {"unit_id": "ICU", "reasons": ["unsupported_care_capability"]}],
    }]}
    original = copy.deepcopy(source)
    exact = exact_state(source, 60)
    small = bounded_state(exact, source["replication_id"], maximum=2)
    assert small["patient_total"] == 631 and len(small["patients"]) == 2
    assert small["queue_counts"]["FAC-MAIN"]["total"] == 630
    assert small["blocker_counts_by_unit"] == {
        "WARD-A": {"required_equipment_unavailable": 630, "nursing_capacity": 630,
                   "medical_supplies": 1, "treatment_disruption": 1},
        "ICU": {"unsupported_care_capability": 630},
    }
    assert small["blocker_counts_by_unit"] == exact["blocker_counts_by_unit"]
    assert small["flow_counts"] == exact["flow_counts"]
    assert source == original


def test_missing_event_ledger_is_unavailable_while_empty_ledger_proves_zero():
    missing = trace("floor-plan-missing-ledger")
    del missing["events"]
    assert exact_state(missing, 0)["flow_counts"] is None
    empty = trace("floor-plan-empty-ledger")
    assert exact_state(empty, 0)["flow_counts"]["FAC-MAIN"] == {"arrivals": 0, "discharges": 0}


def test_current_paused_and_queue_reasons_do_not_leak_after_recovery():
    paused = patient("P", state="inpatient", unit_id="WARD-A", care_paused=True,
                     care_pause_reasons=["medical_supplies"])
    paused["state_intervals"].append({"start_elapsed_minutes": 60, "state": "inpatient",
                                       "facility_id": "FAC-MAIN", "unit_id": "WARD-A", "care_paused": False})
    source = trace("floor-plan-recovery", patients=[paused])
    assert exact_state(source, 30)["blocker_counts_by_unit"] == {"WARD-A": {"medical_supplies": 1}}
    assert exact_state(source, 60)["blocker_counts_by_unit"] == {}
    assert exact_state(source, 30)["blocker_counts_by_unit"] == {"WARD-A": {"medical_supplies": 1}}


def test_actual_generated_trace_counters_reconcile_independent_event_oracle():
    from surge_engine import generate_dataset, run_replication

    dataset = generate_dataset("hospital_baseline", days=2)
    source = run_replication(dataset, {"horizon_calendar_days": 1, "base_seed": 82351})
    for minute in [0, 1, 60, 360, 719.5, 1000, 1440, 60]:
        state = exact_state(source, minute)
        oracle = Counter(event["event_type"] for event in source["events"]
                         if event["event_type"] in {"arrival", "discharge"}
                         and event["elapsed_minutes"] <= minute)
        assert state["flow_counts"]["FAC-MAIN"] == {
            "arrivals": oracle["arrival"], "discharges": oracle["discharge"],
        }
