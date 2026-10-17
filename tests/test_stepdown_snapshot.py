"""Completed ICU care survives observed resets without restarting its service."""

import copy
from datetime import timedelta

import pytest
from surge_api.demand_summary import synchronize_demand_summary
from surge_engine import generate_dataset, run_replication, state_at, validate_dataset
from surge_engine.common import dt, iso


def at(data, minute):
    return iso(dt(data["snapshot_at"]) + timedelta(minutes=minute))


def stepdown_source():
    data = generate_dataset(days=3)
    patient = copy.deepcopy(next(patient for patient in data["patients"] if patient["care_level"] == "icu"))
    patient["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 60}
    patient.pop("remaining_stay_template_id", None)
    data["patients"] = [patient]
    data["patient_resources"] = []
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
    synchronize_demand_summary(data)
    data["los_templates"].append(
        {
            "template_id": "OBSERVED-STEPDOWN-WARD",
            "purpose": "total_los",
            "family": "fixed",
            "fixed_minutes": 120,
            "minimum_minutes": 0,
            "description": "Separate future ward stage after observed ICU completion",
            "synthetic": True,
        }
    )
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["los_template_id"] = "OBSERVED-STEPDOWN-WARD"
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-BASIC", "weight": 1}]
    data["pathway_profiles"][0].update(icu_stepdown_probability=1, stepdown_ward_cohort_weights=[0, 1, 0])
    for assignment in data["assignments"]:
        if assignment["unit_id"] in {"UNIT-WARD-A", "UNIT-WARD-B", "UNIT-WARD-C"} and dt(
            assignment["start_at"]
        ) < dt(at(data, 180)) < dt(assignment["end_at"]):
            assignment["start_at"] = at(data, 180)
    return data


@pytest.mark.parametrize("mission,minute", [(False, 75), (True, 65), (True, 75)])
def test_observed_completed_icu_stage_resumes_ward_request_without_restarting_service(mission, minute):
    data = stepdown_source()
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-OXYGEN", "weight": 1}]
    original = run_replication(
        data,
        {
            "horizon_calendar_days": 1,
            "interventions": [{"kind": "partner_transfer"}] if mission else [],
        },
    )
    snapshot = state_at(original, minute)
    observed = copy.deepcopy(data)
    observed["snapshot_at"] = snapshot["at"]
    observed["patients"] = copy.deepcopy(snapshot["patients"])
    patient = observed["patients"][0]
    patient["source_type"] = "initial_census"
    assert patient["stage_status"] == "ready_to_exit"
    assert patient["care_level"] == patient["target_unit_kind"] == "ward"
    assert patient["cohort_template_id"] == data["patients"][0]["cohort_template_id"]
    assert patient["admission_requested_at"] == at(data, 60)
    assert patient["current_stage_started_at"] == data["patients"][0]["current_stage_started_at"]
    assert not patient.get("remaining_stage_spec")
    # The transition was observed already. A reset must not draw it again even
    # if the current future-transition probability is now zero.
    observed["pathway_profiles"][0]["icu_stepdown_probability"] = 0
    for cohort in observed["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-BASIC", "weight": 1}]
    transfer = patient.get("pending_transfer")
    if transfer:
        assert transfer["remaining_stage_minutes"] == 120
        if patient["state"] == "transfer_reserved":
            transfer["remaining_stage_minutes"] = 0
        else:
            transfer.pop("remaining_stage_minutes")
    validation = validate_dataset(observed)
    assert validation["valid"], validation["errors"]
    continued = run_replication(
        observed,
        {
            "start_at": observed["snapshot_at"],
            "end_at": original["end_at"],
            "state_origin": "observed_reset",
            "horizon_calendar_days": 1,
            "base_seed": 824,
        },
    )
    waiting = state_at(continued, 0)
    assert waiting["inpatient_queue"] == 1
    active = waiting["patients"][0]
    assert active["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert active["inpatient_resource_requirements"] == ["WARD_OXYGEN"]
    assert active["admission_requested_at"] == at(data, 60)
    assert active["current_stage_started_at"] == data["patients"][0]["current_stage_started_at"]
    assert active["cohort_template_id"] == patient["cohort_template_id"]
    if active["state"] != "in_transit":
        assert active["unit_id"] == "UNIT-ICU"
        assert active["resource_requirements"] == data["patients"][0]["resource_requirements"]
        assert (
            sum(
                pool["in_use"]
                for pool in waiting["equipment_pools"]
                if pool["capability_code"] == "ICU_MONITOR"
            )
            == 1
        )
    else:
        assert active["unit_id"] is None and not active["resource_requirements"]
        assert (
            sum(
                pool["in_use"]
                for pool in waiting["equipment_pools"]
                if pool["capability_code"] == "ICU_MONITOR"
            )
            == 0
        )
    enter_at = transfer["planned_arrival_at"] if transfer else at(data, 180)
    entry = (dt(enter_at) - dt(observed["snapshot_at"])).total_seconds() / 60
    assert state_at(continued, entry - 0.1)["inpatient_queue"] == 1
    ward_state = state_at(continued, entry)
    ward = ward_state["patients"][0]
    assert ward["state"] == "inpatient" and ward["unit_id"] != "UNIT-ICU"
    assert ward["stage_status"] == "in_service" and ward["sampled_stage_minutes"] == 120
    assert ward["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert (
        sum(
            pool["in_use"]
            for pool in ward_state["equipment_pools"]
            if pool["capability_code"] == "WARD_OXYGEN"
        )
        == 1
    )
    if mission:
        assert (
            sum(
                pool["reserved"]
                for pool in waiting["equipment_pools"]
                if pool["capability_code"] == "WARD_OXYGEN"
            )
            == 1
        )
        assert (
            sum(
                pool["in_use"]
                for pool in ward_state["equipment_pools"]
                if pool["capability_code"] == "WARD_OXYGEN"
            )
            == 1
        )
    assert (
        ward["cohort_template_id"]
        == [cohort for cohort in data["cohorts"] if cohort["care_level"] == "ward"][1]["cohort_id"]
    )
    assert ward["current_stage_started_at"] == enter_at
    assert ward_state["inpatient_queue"] == 0
    assert (
        sum(
            pool["in_use"]
            for pool in ward_state["equipment_pools"]
            if pool["capability_code"] == "ICU_MONITOR"
        )
        == 0
    )
    assert state_at(continued, entry + 119)["patients"]
    assert not state_at(continued, entry + 120)["patients"]
    assert continued["scalar_metrics"]["inpatient_waiting_patient_hours"] == pytest.approx(entry / 60)
    assert continued["scalar_metrics"]["patient_conservation_ok"]
    assert sum(event["event_type"] == "queue_entry" for event in continued["events"]) == 1
    assert sum(event["event_type"] == "discharge" for event in continued["events"]) == 1
    if transfer:
        departures = [
            event["occurred_at"]
            for event in continued["events"]
            if event["event_type"] == "transfer_departed"
        ]
        assert departures == (
            [transfer["planned_departure_at"]] if patient["state"] == "transfer_reserved" else []
        )


def test_observed_ongoing_transfer_pauses_remaining_service_and_keeps_known_oxygen_profile():
    data = generate_dataset(days=3)
    patient = copy.deepcopy(
        next(
            patient
            for patient in data["patients"]
            if patient["care_level"] == "ward"
            and any(
                requirement["capability_code"] == "WARD_OXYGEN"
                for requirement in patient["resource_requirements"]
            )
        )
    )
    patient["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 300}
    patient.pop("remaining_stay_template_id", None)
    data["patients"] = [patient]
    data["patient_resources"] = []
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
    synchronize_demand_summary(data)
    original = run_replication(
        data,
        {
            "horizon_calendar_days": 1,
            "interventions": [{"kind": "partner_transfer", "include_inpatients": True}],
        },
    )
    departure = next(event for event in original["events"] if event["event_type"] == "transfer_departed")
    snapshot = state_at(original, departure["elapsed_minutes"] + 1)
    observed = copy.deepcopy(data)
    observed["snapshot_at"] = snapshot["at"]
    observed["patients"] = copy.deepcopy(snapshot["patients"])
    observed["patients"][0]["source_type"] = "initial_census"
    observed_patient = observed["patients"][0]
    transfer = observed_patient["pending_transfer"]
    assert observed_patient["state"] == "in_transit" and not observed_patient["resource_requirements"]
    assert observed_patient["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert transfer["remaining_stage_minutes"] == 300 - departure["elapsed_minutes"]
    # Explicit current receiving requirements survive different future profile weights.
    for cohort in observed["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-BASIC", "weight": 1}]
    validation = validate_dataset(observed)
    assert validation["valid"], validation["errors"]
    continued = run_replication(observed, {"horizon_calendar_days": 1, "base_seed": 824})
    waiting = state_at(continued, 0)
    assert (
        sum(pool["in_use"] for pool in waiting["equipment_pools"] if pool["capability_code"] == "WARD_OXYGEN")
        == 0
    )
    assert (
        sum(
            pool["reserved"]
            for pool in waiting["equipment_pools"]
            if pool["capability_code"] == "WARD_OXYGEN"
        )
        == 1
    )
    arrival = (dt(transfer["planned_arrival_at"]) - dt(observed["snapshot_at"])).total_seconds() / 60
    admitted = state_at(continued, arrival)
    assert admitted["patients"][0]["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert admitted["patients"][0]["resource_requirements"] == [
        {"capability_code": "WARD_OXYGEN", "quantity": 1}
    ]
    assert admitted["patients"][0]["sampled_stage_minutes"] == transfer["remaining_stage_minutes"]
    assert (
        sum(
            pool["in_use"] for pool in admitted["equipment_pools"] if pool["capability_code"] == "WARD_OXYGEN"
        )
        == 1
    )
    assert not state_at(continued, arrival + transfer["remaining_stage_minutes"])["patients"]
    assert continued["scalar_metrics"]["patient_conservation_ok"]
