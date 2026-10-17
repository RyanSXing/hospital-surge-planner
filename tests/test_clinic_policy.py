import copy
from datetime import timedelta

import pytest
from surge_api.demand_summary import synchronize_demand_summary
from surge_engine import generate_dataset, run_replication, state_at, validate_dataset
from surge_engine.common import dt, iso


@pytest.fixture(scope="module")
def source():
    data = generate_dataset(days=3)
    data["patients"] = []
    data["patient_resources"] = []
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
        if stream["entry_type"] == "ed":
            stream["clinic_eligibility_probability_given_discharge"] = 1
    synchronize_demand_summary(data)
    return data


def at(data, minute):
    return iso(dt(data["snapshot_at"]) + timedelta(minutes=minute))


def scenario(data, minutes=(60,), **plan):
    return {
        "horizon_calendar_days": 1,
        "base_seed": 17,
        "interventions": [{"kind": "clinic", "activation_minutes": 0, **plan}],
        "conditions": [
            {
                "id": f"BATCH-{index}",
                "kind": "arrival_batch",
                "at": at(data, minute),
                "count": 1,
                "spread_minutes": 0,
                "entry_stream_id": "ED_MAIN",
                "care_mix": {"discharge": 1},
            }
            for index, minute in enumerate(minutes)
        ],
    }


def starts(result):
    return [event for event in result["events"] if event["event_type"] == "clinic_start"]


def test_pathway_binds_policy_when_site_has_multiple_declared_policies(source):
    from surge_engine import validate_dataset

    data = copy.deepcopy(source)
    extra = copy.deepcopy(data["clinic_policies"][0])
    extra["clinic_policy_id"] = "CLINIC-POLICY-2"
    data["clinic_policies"].append(extra)
    assert validate_dataset(data)["valid"]
    result = run_replication(data, scenario(data))
    assert len(starts(result)) == 1
    assert result["patients"][0]["clinic_policy_id"] == "CLINIC-POLICY"
    explicit = run_replication(data, scenario(data, clinic_policy_id="CLINIC-POLICY-2"))
    assert explicit["patients"][0]["clinic_policy_id"] == "CLINIC-POLICY-2"


def test_single_clinic_profile_accepts_a_declared_noncanonical_identity(source):
    data = copy.deepcopy(source)
    profile = next(p for p in data["resource_profiles"] if p["stage_kind"] == "clinic")
    profile["resource_profile_id"] = "outpatient-basic"
    result = run_replication(data, scenario(data))
    assert len(starts(result)) == 1
    assert result["patients"][0]["resource_profile_id"] == "outpatient-basic"


def test_declared_later_opening_prevents_early_activation_diversion(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["admission_start_at"] = at(data, 1440)
    result = run_replication(data, scenario(data, (60, 300, 1000)))
    assert result["scalar_metrics"]["temporary_site_patients_served"] == 0
    assert not starts(result)
    assert all(
        not pool["in_use"] and not pool["reserved"]
        for pool in state_at(result, 120)["equipment_pools"]
        if pool["capability_code"] == "CLINIC_KIT"
    )
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_half_open_policy_interval_and_draining_preserve_active_service(source):
    data = copy.deepcopy(source)
    policy = data["clinic_policies"][0]
    policy.update(admission_start_at=at(data, 60), admission_end_at=at(data, 180))
    result = run_replication(data, scenario(data, (30, 60, 179, 180)))
    assert [event["elapsed_minutes"] for event in starts(result)] == [60, 179]
    assert any(
        event["event_type"] == "site_admissions_closed" and event["elapsed_minutes"] == 180
        for event in result["events"]
    )
    late = starts(result)[-1]["patient_id"]
    patient = next(p for p in state_at(result, 200)["patients"] if p["patient_id"] == late)
    assert patient["state"] == "clinic_assessment"
    assert any(
        event["event_type"] == "discharge" and event["patient_id"] == late and event["elapsed_minutes"] == 269
        for event in result["events"]
    )
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_policy_service_template_controls_clinic_service(source):
    data = copy.deepcopy(source)
    data["los_templates"].append(
        {
            "template_id": "CUSTOM-CLINIC-SERVICE",
            "family": "fixed",
            "purpose": "clinic_service",
            "fixed_minutes": 37,
            "minimum_minutes": 0,
        }
    )
    data["clinic_policies"][0]["service_template_id"] = "CUSTOM-CLINIC-SERVICE"
    result = run_replication(data, scenario(data))
    patient = result["patients"][0]
    assert patient["resource_profile_id"] == "RP-CLINIC-BASIC"
    assert dt(patient["departure_at"]) - dt(patient["arrival_at"]) == timedelta(minutes=37)


def test_explicit_clinic_profile_retains_exact_resource_bundle(source):
    data = copy.deepcopy(source)
    profile = copy.deepcopy(
        next(p for p in data["resource_profiles"] if p["resource_profile_id"] == "RP-CLINIC-BASIC")
    )
    profile["resource_profile_id"] = "RP-CLINIC-TWO-KITS"
    profile["required_equipment"][0]["quantity"] = 2
    data["resource_profiles"].append(profile)
    planned = scenario(data)
    planned["conditions"][0]["care_mix"] = {"RP-CLINIC-TWO-KITS": 1}
    result = run_replication(data, planned)
    assert len(starts(result)) == 1
    patient = state_at(result, 61)["patients"][0]
    assert patient["resource_profile_id"] == "RP-CLINIC-TWO-KITS"
    assert patient["resource_requirements"] == [{"capability_code": "CLINIC_KIT", "quantity": 2}]


def test_unavailable_transport_preserves_exact_hospital_path_and_equipment(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    data["vehicles"] = []
    planned = scenario(data, (60, 90, 120))
    result = run_replication(data, planned)
    baseline = run_replication(data, {**planned, "interventions": []})
    assert not starts(result)
    assert any(event["reason_code"] == "clinic_transport_unavailable" for event in result["events"])
    assert result["patients"] == baseline["patients"]
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_required_transport_reserves_real_bundle_and_obeys_travel_time(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    data["vehicles"] = data["vehicles"][:1]
    result = run_replication(data, scenario(data))
    accepted = next(event for event in result["events"] if event["event_type"] == "transfer_accepted")
    departed = next(event for event in result["events"] if event["event_type"] == "transfer_departed")
    arrived = next(event for event in result["events"] if event["event_type"] == "transfer_arrived")
    assert accepted["payload"]["status"] == "reserved"
    assert accepted["elapsed_minutes"] < departed["elapsed_minutes"] < arrived["elapsed_minutes"]
    route = next(
        route
        for route in data["routes"]
        if route["from_facility_id"] == "FAC-MAIN" and route["to_facility_id"] == "FAC-CLINIC-NORTH"
    )
    assert arrived["elapsed_minutes"] - departed["elapsed_minutes"] == (
        route["travel_minutes"] + route["unloading_minutes"]
    )
    state = state_at(result, departed["elapsed_minutes"] + 0.1)
    patient = state["patients"][0]
    assert patient["state"] == "in_transit" and patient["slot_id"] is None
    clinic = next(unit for unit in state["units"] if unit["unit_id"] == "UNIT-CLINIC-NORTH")
    assert clinic["reserved"] == 1 and clinic["occupied"] == 0
    assert starts(result)[0]["elapsed_minutes"] == arrived["elapsed_minutes"]
    assert result["scalar_metrics"]["temporary_site_patients_served"] == 1
    assert result["scalar_metrics"]["patient_conservation_ok"]


def observed_clinic_snapshot(data, result, minute):
    """Export actual replay state into canonical observed input, not engine internals."""
    snapshot = state_at(result, minute)
    observed = copy.deepcopy(data)
    observed["snapshot_at"] = snapshot["at"]
    observed["patients"] = copy.deepcopy(snapshot["patients"])
    for patient in observed["patients"]:
        patient["source_type"] = "initial_census"
        patient.pop("inpatient_resource_requirements", None)
    observed["patient_resources"] = []
    for slot in observed["slots"]:
        current = next(item for item in snapshot["slots"] if item["slot_id"] == slot["slot_id"])
        # Reservation ownership is reconciled from pending_transfer exactly once.
        for field in ("installation_status", "enabled"):
            slot[field] = current[field]
    for unit in observed["units"]:
        current = next(item for item in snapshot["units"] if item["unit_id"] == unit["unit_id"])
        unit["enabled_capacity"] = current["enabled"]
        unit["physical_capacity"] = current["physical"]
    for facility in observed["facilities"]:
        if any(
            unit["facility_id"] == facility["facility_id"] and unit["active"] for unit in snapshot["units"]
        ):
            facility["status"] = "active"
    clinic = next(unit for unit in snapshot["units"] if unit["kind"] == "clinic")
    for assignment in observed["staff_assignments"]:
        if assignment["staff_id"] in clinic["active_staff_ids"] and dt(assignment["start_at"]) <= dt(
            snapshot["at"]
        ) < dt(assignment["end_at"]):
            assignment["unit_id"] = clinic["unit_id"]
            assignment["facility_id"] = clinic["facility_id"]
            assignment["reserve_pool_id"] = None
    source_pools = {pool["equipment_pool_id"]: pool for pool in data["equipment_pools"]}
    observed["equipment_pools"] = []
    for pool in snapshot["equipment_pools"]:
        original = source_pools.get(pool["source_equipment_pool_id"])
        if original:
            observed["equipment_pools"].append(
                {
                    **original,
                    **{
                        field: pool[field]
                        for field in (
                            "equipment_pool_id",
                            "facility_id",
                            "unit_id",
                            "quantity",
                            "unserviceable_quantity",
                            "portable",
                        )
                    },
                }
            )
    return observed


@pytest.mark.parametrize("minute,state", [(65, "transfer_reserved"), (75, "in_transit")])
def test_observed_clinic_mission_reconciles_and_resumes_at_actual_entry(source, minute, state):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    clinic_profile = next(
        profile for profile in data["resource_profiles"] if profile["stage_kind"] == "clinic"
    )
    clinic_profile["resource_profile_id"] = "DECLARED-CLINIC-TWO-KITS"
    clinic_profile["required_equipment"][0]["quantity"] = 2
    service = next(
        template for template in data["los_templates"] if template["template_id"] == "CLINIC-SERVICE"
    )
    service["fixed_minutes"] = 37
    original = run_replication(data, scenario(data))
    observed = observed_clinic_snapshot(data, original, minute)
    patient = observed["patients"][0]
    transfer = patient["pending_transfer"]
    assert patient["state"] == state and patient["clinic_policy_id"] == "CLINIC-POLICY"
    assert transfer["clinic_resource_profile_id"] == clinic_profile["resource_profile_id"]
    assert "remaining_stage_minutes" not in transfer and "remaining_stage_spec" not in patient
    assert "clinic_service_minutes" not in transfer and patient["sampled_stage_minutes"] is None
    valid = validate_dataset(observed)
    assert valid["valid"], valid["errors"]
    reconciled = next(
        row for row in valid["capacity_reconciliation"] if row["unit_id"] == "UNIT-CLINIC-NORTH"
    )
    assert reconciled["reserved"] == 1
    continued = run_replication(
        observed,
        {
            "start_at": observed["snapshot_at"],
            "end_at": original["end_at"],
            "state_origin": "observed_reset",
            "horizon_calendar_days": 1,
            "base_seed": 999,
        },
    )
    arrival = (dt(transfer["planned_arrival_at"]) - dt(observed["snapshot_at"])).total_seconds() / 60
    before = state_at(continued, 0)
    assert before["patients"][0]["state"] == state
    assert before["inpatient_queue"] == before["ed_queue"] == 0
    assert (
        sum(pool["reserved"] for pool in before["equipment_pools"] if pool["capability_code"] == "CLINIC_KIT")
        == 2
    )
    assert (
        sum(pool["in_use"] for pool in before["equipment_pools"] if pool["capability_code"] == "CLINIC_KIT")
        == 0
    )
    assert sum(vehicle["mission"] == patient["patient_id"] for vehicle in before["vehicles"]) == 1
    assert state_at(continued, arrival - 0.1)["patients"][0]["state"] == "in_transit"
    entered = state_at(continued, arrival)
    active = entered["patients"][0]
    assert active["state"] == "clinic_assessment"
    assert active["resource_profile_id"] == clinic_profile["resource_profile_id"]
    assert active["sampled_stage_minutes"] == 37
    assert active["current_stage_started_at"] == transfer["planned_arrival_at"]
    assert (
        sum(pool["in_use"] for pool in entered["equipment_pools"] if pool["capability_code"] == "CLINIC_KIT")
        == 2
    )
    assert not any(
        pool["reserved"] for pool in entered["equipment_pools"] if pool["capability_code"] == "CLINIC_KIT"
    )
    assert not state_at(continued, arrival + 37)["patients"]
    assert at(observed, starts(continued)[0]["elapsed_minutes"]) == transfer["planned_arrival_at"]
    departed = [event for event in continued["events"] if event["event_type"] == "transfer_departed"]
    assert [at(observed, event["elapsed_minutes"]) for event in departed] == (
        [transfer["planned_departure_at"]] if state == "transfer_reserved" else []
    )
    assert continued["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize("ed_available", [False, True])
def test_observed_reserved_clinic_cancellation_releases_bundle_and_retains_ed_profile(source, ed_available):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    original = run_replication(data, scenario(data))
    observed = observed_clinic_snapshot(data, original, 65)
    patient = observed["patients"][0]
    patient["resource_profile_id"] = "RP-ED-MONITORED"
    patient["queue_location_id"] = None
    # Keep the ED queue visible after fallback so its restored virtual location
    # is checked independently of subsequent assessment placement.
    for facility in observed["facilities"]:
        if facility["facility_id"] == "FAC-MAIN" and not ed_available:
            facility["status"] = "unavailable"
    validation = validate_dataset(observed)
    assert validation["valid"], validation["errors"]
    continued = run_replication(
        observed,
        {
            "horizon_calendar_days": 1,
            "updates": [
                {
                    "update_id": "CLOSE-OBSERVED-CLINIC",
                    "type": "capacity_change",
                    "effective_at": at(observed, 1),
                    "payload": {"unit_id": "UNIT-CLINIC-NORTH", "enabled_capacity": 0},
                }
            ],
        },
    )
    cancelled = state_at(continued, 2)
    assert cancelled["patients"][0]["state"] == ("ed_assessment" if ed_available else "ed_waiting")
    assert cancelled["patients"][0]["resource_profile_id"] == "RP-ED-MONITORED"
    if ed_available:
        assert cancelled["patients"][0]["queue_location_id"] is None
        assert cancelled["patients"][0]["resource_requirements"] == [
            {"capability_code": "ED_MONITOR", "quantity": 1}
        ]
        assert (
            sum(
                pool["in_use"]
                for pool in cancelled["equipment_pools"]
                if pool["capability_code"] == "ED_MONITOR"
            )
            == 1
        )
    else:
        assert cancelled["patients"][0]["queue_location_id"] == next(
            stream["initial_queue_location_id"]
            for stream in observed["entry_streams"]
            if stream["entry_type"] == "ed"
        )
    assert cancelled["patients"][0]["pending_transfer"] is None
    assert cancelled["ed_queue"] == int(not ed_available) and cancelled["inpatient_queue"] == 0
    assert all(vehicle["mission"] is None for vehicle in cancelled["vehicles"])
    assert not any(
        pool["reserved"] or pool["in_use"]
        for pool in cancelled["equipment_pools"]
        if pool["capability_code"] == "CLINIC_KIT"
    )
    assert not starts(continued)
    assert continued["scalar_metrics"]["patient_conservation_ok"]


def test_observed_in_transit_clinic_mission_retains_commitment_after_capacity_loss(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    original = run_replication(data, scenario(data))
    observed = observed_clinic_snapshot(data, original, 75)
    transfer = observed["patients"][0]["pending_transfer"]
    assert validate_dataset(observed)["valid"]
    continued = run_replication(
        observed,
        {
            "horizon_calendar_days": 1,
            "updates": [
                {
                    "update_id": "CLOSE-IN-TRANSIT-CLINIC",
                    "type": "capacity_change",
                    "effective_at": at(observed, 1),
                    "payload": {"unit_id": "UNIT-CLINIC-NORTH", "enabled_capacity": 0},
                }
            ],
        },
    )
    committed = state_at(continued, 2)
    assert committed["patients"][0]["state"] == "in_transit"
    assert (
        sum(
            pool["reserved"]
            for pool in committed["equipment_pools"]
            if pool["capability_code"] == "CLINIC_KIT"
        )
        == 1
    )
    assert not any(event["event_type"] == "transfer_cancelled" for event in continued["events"])
    assert starts(continued)[0]["occurred_at"] == transfer["planned_arrival_at"]
    arrival = (dt(transfer["planned_arrival_at"]) - dt(observed["snapshot_at"])).total_seconds() / 60
    assert state_at(continued, arrival)["patients"][0]["state"] == "clinic_assessment"
    assert not state_at(continued, arrival + 90)["patients"]
    assert continued["scalar_metrics"]["patient_conservation_ok"]


def test_transport_failure_without_fallback_is_explicitly_infeasible(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0].update(transport_required=True, hospital_fallback=False)
    data["vehicles"] = []
    with pytest.raises(ValueError, match="without hospital fallback: clinic_transport_unavailable"):
        run_replication(data, scenario(data))


def test_concurrent_diversions_cannot_share_the_vehicle(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    data["vehicles"] = data["vehicles"][:1]
    result = run_replication(data, scenario(data, (60, 60)))
    assert len(starts(result)) == 1
    assert sum(event["event_type"] == "transfer_accepted" for event in result["events"]) == 1
    fallback = next(
        event["patient_id"]
        for event in result["events"]
        if event["reason_code"] == "clinic_transport_unavailable"
    )
    patient = next(p for p in result["patients"] if p["patient_id"] == fallback)
    assert any(interval["state"] == "ed_assessment" for interval in patient["state_intervals"])
    assert not any(
        interval["state"] in ("in_transit", "transfer_reserved") for interval in patient["state_intervals"]
    )


def test_predeparture_capacity_loss_releases_clinic_and_vehicle_then_falls_back(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0]["transport_required"] = True
    planned = scenario(data)
    planned["updates"] = [
        {
            "update_id": "CLOSE-CLINIC",
            "type": "capacity_change",
            "effective_at": at(data, 65),
            "payload": {"unit_id": "UNIT-CLINIC-NORTH", "enabled_capacity": 0},
        }
    ]
    result = run_replication(data, planned)
    assert not starts(result)
    assert any(event["event_type"] == "transfer_cancelled" for event in result["events"])
    state = state_at(result, 66)
    clinic = next(unit for unit in state["units"] if unit["unit_id"] == "UNIT-CLINIC-NORTH")
    assert clinic["reserved"] == 0
    assert all(vehicle["mission"] is None for vehicle in state["vehicles"])
    assert all(
        not pool["in_use"] and not pool["reserved"]
        for pool in state["equipment_pools"]
        if pool["capability_code"] == "CLINIC_KIT"
    )
    assert state["patients"][0]["state"] == "ed_assessment"
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_hard_closure_cannot_drop_patients(source):
    data = copy.deepcopy(source)
    data["clinic_policies"][0].update(admission_end_at=at(data, 80), drain_after_close=False)
    with pytest.raises(ValueError, match="Hard clinic closure is infeasible"):
        run_replication(data, scenario(data))


def test_clinic_capability_is_required_before_any_resources_are_claimed(source):
    data = copy.deepcopy(source)
    next(f for f in data["facilities"] if f["facility_id"] == "FAC-CLINIC-NORTH")["capabilities"] = [
        "SHELTER_ONLY"
    ]
    result = run_replication(data, scenario(data))
    assert not starts(result)
    assert any(
        event["reason_code"] == "incompatible_clinic_capability_or_eligibility" for event in result["events"]
    )
    assert result["scalar_metrics"]["patient_conservation_ok"]
