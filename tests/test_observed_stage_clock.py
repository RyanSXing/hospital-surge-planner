"""Actual replay snapshots preserve active clocks across an observed reset."""

import copy
from datetime import timedelta

import pytest
from surge_api.demand_summary import synchronize_demand_summary
from surge_engine import generate_dataset, run_replication, state_at, validate_dataset
from surge_engine.common import dt, iso
from test_clinic_policy import observed_clinic_snapshot, scenario
from test_clinic_policy import source as clinic_source


def source_patient(state="inpatient", duration=300):
    data = generate_dataset(days=3)
    patient = copy.deepcopy(
        next(
            p
            for p in data["patients"]
            if p["state"] == state
            and (
                state == "ed_assessment"
                or p["care_level"] == "ward"
                and any(r["capability_code"] == "WARD_OXYGEN" for r in p["resource_requirements"])
            )
        )
    )
    patient["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": duration}
    for field in ("remaining_stay_template_id", "remaining_stay_minutes", "assessment_remaining_minutes"):
        patient.pop(field, None)
    data["patients"] = [patient]
    data["patient_resources"] = []
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
        if stream["entry_type"] == "ed":
            stream["disposition_probabilities"] = {"discharge": 1}
    synchronize_demand_summary(data)
    assert validate_dataset(data)["valid"]
    return data


def observed_snapshot(data, trace, minute):
    snapshot = state_at(trace, minute)
    observed = copy.deepcopy(data)
    observed["snapshot_at"] = snapshot["at"]
    observed["patients"] = copy.deepcopy(snapshot["patients"])
    for patient in observed["patients"]:
        patient["source_type"] = "initial_census"
    return observed


def continue_observation(data, original):
    validation = validate_dataset(data)
    assert validation["valid"], validation["errors"]
    return run_replication(
        data,
        {
            "start_at": data["snapshot_at"],
            "end_at": original["end_at"],
            "state_origin": "observed_reset",
            "horizon_calendar_days": 1,
            "base_seed": 999,
        },
    )


def event_time(trace, kind):
    return next(event["occurred_at"] for event in trace["events"] if event["event_type"] == kind)


@pytest.mark.parametrize("state", ["inpatient", "ed_assessment"])
@pytest.mark.parametrize("minute", [0.25, 1])
def test_observed_active_stage_retains_exact_absolute_completion(state, minute):
    data = source_patient(state)
    original = run_replication(data, {"horizon_calendar_days": 1})
    untouched = copy.deepcopy(original)
    observed = observed_snapshot(data, original, minute)
    patient = observed["patients"][0]
    expected_end = iso(dt(data["snapshot_at"]) + timedelta(minutes=300))
    assert patient["remaining_stage_spec"] == {
        "kind": "expected_end",
        "expected_end_at": expected_end,
    }
    assert original == untouched
    continued = continue_observation(observed, original)
    assert event_time(continued, "discharge") == event_time(original, "discharge") == expected_end
    assert state_at(continued, 300 - minute - 0.01)["patients"]
    assert not state_at(continued, 300 - minute)["patients"]
    assert continued["scalar_metrics"]["patient_conservation_ok"]


def test_observed_sampled_residual_is_not_resampled_under_new_reset_seed():
    data = source_patient()
    patient = data["patients"][0]
    template = next(t for t in data["los_templates"] if t["purpose"] == "remaining_los")
    patient["remaining_stage_spec"] = {
        "kind": "remaining_distribution",
        "distribution_id": template["template_id"],
    }
    original = run_replication(data, {"horizon_calendar_days": 2, "base_seed": 17})
    observed = observed_snapshot(data, original, 0.25)
    expected_end = observed["patients"][0]["expected_stage_end_at"]
    assert observed["patients"][0]["remaining_stage_spec"]["expected_end_at"] == expected_end
    continued = continue_observation(observed, original)
    assert event_time(continued, "discharge") == event_time(original, "discharge") == expected_end


@pytest.mark.parametrize("minute", [0.25, 9, 9.75, 10.25])
def test_observed_ordinary_transfer_preserves_source_clock_and_departure_residual(minute):
    data = source_patient()
    original = run_replication(
        data,
        {
            "horizon_calendar_days": 1,
            "interventions": [{"kind": "partner_transfer", "include_inpatients": True}],
        },
    )
    observed = observed_snapshot(data, original, minute)
    patient = observed["patients"][0]
    transfer = copy.deepcopy(patient["pending_transfer"])
    assert transfer["remaining_stage_minutes"] == 290
    if minute < 10:
        assert patient["state"] == "transfer_reserved"
        assert patient["remaining_stage_spec"] == {
            "kind": "expected_end",
            "expected_end_at": iso(dt(data["snapshot_at"]) + timedelta(minutes=300)),
        }
    else:
        assert patient["state"] == "in_transit"
        assert not patient.get("remaining_stage_spec")
    continued = continue_observation(observed, original)
    assert state_at(continued, 0)["patients"][0]["pending_transfer"] == transfer
    assert state_at(continued, 0)["patients"][0]["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert event_time(continued, "discharge") == event_time(original, "discharge")
    if minute < 10:
        assert event_time(continued, "transfer_departed") == event_time(original, "transfer_departed")
    assert event_time(continued, "transfer_arrived") == event_time(original, "transfer_arrived")
    assert continued["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize("offset", [0.25, 1, 36.75])
def test_observed_active_clinic_service_retains_exact_clock_and_resources(offset):
    data = copy.deepcopy(clinic_source.__wrapped__())
    service = next(t for t in data["los_templates"] if t["template_id"] == "CLINIC-SERVICE")
    service["fixed_minutes"] = 37
    original = run_replication(data, scenario(data))
    observed = observed_clinic_snapshot(data, original, 60 + offset)
    patient = observed["patients"][0]
    expected_end = iso(dt(data["snapshot_at"]) + timedelta(minutes=97))
    assert patient["state"] == "clinic_assessment"
    assert patient["remaining_stage_spec"] == {
        "kind": "expected_end",
        "expected_end_at": expected_end,
    }
    continued = continue_observation(observed, original)
    initial = state_at(continued, 0)
    assert initial["patients"][0]["resource_profile_id"] == patient["resource_profile_id"]
    assert sum(p["in_use"] for p in initial["equipment_pools"] if p["capability_code"] == "CLINIC_KIT") == 1
    assert event_time(continued, "discharge") == event_time(original, "discharge") == expected_end
    assert not state_at(continued, 37 - offset)["patients"]
    assert continued["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize("duration", [5, 10])
@pytest.mark.parametrize("minute", [0.25, 1])
@pytest.mark.parametrize("declared_status", [True, False])
def test_observed_source_completing_before_pickup_cancels_and_releases_reservation(
    duration, minute, declared_status
):
    data = source_patient(duration=duration)
    if not declared_status:
        data["patients"][0].pop("stage_status", None)
    original = run_replication(
        data,
        {
            "horizon_calendar_days": 1,
            "interventions": [{"kind": "partner_transfer", "include_inpatients": True}],
        },
    )
    observed = observed_snapshot(data, original, minute)
    patient = observed["patients"][0]
    transfer = patient["pending_transfer"]
    assert patient["state"] == "transfer_reserved"
    assert transfer["remaining_stage_minutes"] == 0
    continued = continue_observation(observed, original)
    initial = state_at(continued, 0)
    assert (
        sum(p["reserved"] for p in initial["equipment_pools"] if p["capability_code"] == "WARD_OXYGEN") == 1
    )
    assert any(s.get("reservation_id") == patient["patient_id"] for s in initial["slots"])
    assert any(v["mission"] == patient["patient_id"] for v in initial["vehicles"])
    assert event_time(continued, "discharge") == event_time(original, "discharge")
    assert event_time(continued, "transfer_cancelled") == event_time(original, "transfer_cancelled")
    cancelled = next(e for e in continued["events"] if e["event_type"] == "transfer_cancelled")
    assert cancelled["reason_code"] == "service_completed_before_pickup"
    assert not any(e["event_type"] in ("transfer_departed", "transfer_arrived") for e in continued["events"])
    finished = state_at(continued, duration - minute)
    assert not finished["patients"]
    assert not any(s.get("reservation_id") == patient["patient_id"] for s in finished["slots"])
    assert not any(v["mission"] == patient["patient_id"] for v in finished["vehicles"])
    assert not any(p["reserved"] for p in finished["equipment_pools"])
    assert continued["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize(
    "case",
    ["negative", "missing_clock", "clock_at_snapshot", "clock_after_pickup", "departed", "wrong_source"],
)
def test_zero_departure_residual_requires_guaranteed_active_source_completion(case):
    data = source_patient(duration=5)
    original = run_replication(
        data,
        {
            "horizon_calendar_days": 1,
            "interventions": [{"kind": "partner_transfer", "include_inpatients": True}],
        },
    )
    observed = observed_snapshot(data, original, 0.25)
    patient = observed["patients"][0]
    transfer = patient["pending_transfer"]
    if case == "negative":
        transfer["remaining_stage_minutes"] = -1
    elif case == "missing_clock":
        patient.pop("remaining_stage_spec")
    elif case == "clock_at_snapshot":
        patient["remaining_stage_spec"]["expected_end_at"] = observed["snapshot_at"]
    elif case == "clock_after_pickup":
        patient["remaining_stage_spec"]["expected_end_at"] = iso(
            dt(transfer["planned_departure_at"]) + timedelta(seconds=1)
        )
    elif case == "departed":
        patient["state"] = "in_transit"
        transfer["status"] = "departed"
    else:
        transfer["prior_state"] = "ed_boarding"
    validation = validate_dataset(observed)
    assert not validation["valid"]
    assert any(e["field"].endswith("remaining_stage_minutes") for e in validation["errors"]), validation[
        "errors"
    ]
