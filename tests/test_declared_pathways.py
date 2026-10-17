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
    synchronize_demand_summary(data)
    return data


def at(data, minutes):
    return iso(dt(data["snapshot_at"]) + timedelta(minutes=minutes))


def fixed(data, ident, minutes, purpose="inpatient_stay"):
    data["los_templates"].append(
        {
            "template_id": ident,
            "purpose": purpose,
            "family": "fixed",
            "fixed_minutes": minutes,
            "minimum_minutes": 0,
        }
    )
    return ident


def batch(data, care, count=1):
    return {
        "horizon_calendar_days": 1,
        "base_seed": 17,
        "conditions": [
            {
                "id": "DECLARED",
                "kind": "arrival_batch",
                "entry_stream_id": "ED_MAIN",
                "at": at(data, 0),
                "count": count,
                "spread_minutes": 0,
                "care_mix": {care: 1},
            }
        ],
    }


def test_arbitrary_profile_and_cohort_ids_are_resolved_without_prefixes(source):
    data = copy.deepcopy(source)
    profile = next(p for p in data["resource_profiles"] if p["resource_profile_id"] == "RP-WARD-OXYGEN")
    profile["resource_profile_id"] = "oxygen-support"
    profile["required_equipment"][0]["quantity"] = 2
    cohort = next(c for c in data["cohorts"] if c["care_level"] == "ward")
    cohort["cohort_id"] = "short-stay"
    cohort["resource_profile_weights"] = [{"resource_profile_id": "oxygen-support", "weight": 1}]
    cohort["los_template_id"] = fixed(data, "declared-stay", 600)
    for care in ("oxygen-support", "short-stay"):
        result = run_replication(data, batch(data, care))
        inpatient = next(i for i in result["patients"][0]["state_intervals"] if i["state"] == "inpatient")
        assert inpatient["resource_profile_id"] == "oxygen-support"
        assert sum(r["quantity"] for r in inpatient["resource_requirements"]) == 2
        assert result["scalar_metrics"]["patient_conservation_ok"]


def test_declared_resource_mixture_and_assessment_template_control_actual_stages(source):
    data = copy.deepcopy(source)
    stream = next(s for s in data["entry_streams"] if s["entry_type"] == "ed")
    stream["assessment_template_id"] = fixed(data, "assessment-37", 37, "ed_assessment")
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-OXYGEN", "weight": 1}]
    result = run_replication(data, batch(data, "ward", 5))
    for patient in result["patients"]:
        assessment = next(i for i in patient["state_intervals"] if i["state"] == "ed_assessment")
        inpatient = next(i for i in patient["state_intervals"] if i["state"] == "inpatient")
        assert assessment["sampled_stage_minutes"] == 37
        assert inpatient["start_elapsed_minutes"] == 37
        assert inpatient["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_pathway_disposition_and_cohort_weights_override_stream_defaults(source):
    data = copy.deepcopy(source)
    stream = next(s for s in data["entry_streams"] if s["entry_type"] == "ed")
    stream["expected_arrivals_per_local_day"] = 30
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 30
    path = next(p for p in data["pathway_profiles"] if p["entry_stream_id"] == stream["entry_stream_id"])
    path.update(ed_disposition_weights={"ward": 1}, ward_cohort_weights=[0, 0, 1])
    result = run_replication(data, {"horizon_calendar_days": 1, "base_seed": 17})
    assert len(result["patients"]) > 10
    assessed = [p for p in result["patients"] if any(i["state"] == "inpatient" for i in p["state_intervals"])]
    assert assessed
    assert all(p["cohort_template_id"] == "COHORT-WARD-EXTENDED" for p in assessed)


def test_direct_ward_arrival_does_not_require_an_ed_cohort(source):
    data = copy.deepcopy(source)
    data["history"] = []
    data["historical_daily_summaries"] = []
    data["cohorts"] = [c for c in data["cohorts"] if c["care_level"] != "ambulatory"]
    assert validate_dataset(data)["valid"]
    scenario = batch(data, "ward")
    scenario["conditions"][0]["entry_stream_id"] = "DIRECT_WARD_MAIN"
    result = run_replication(data, scenario)
    patient = result["patients"][0]
    assert not any(i["state"].startswith("ed_") for i in patient["state_intervals"])
    assert any(i["state"] == "inpatient" for i in patient["state_intervals"])
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_placement_preview_honors_profile_capability_and_transport(source):
    from surge_api.eligibility import check_placement

    data = copy.deepcopy(source)
    profile = next(p for p in data["resource_profiles"] if p["resource_profile_id"] == "RP-WARD-BASIC")
    profile.update(
        required_site_capability="ISOLATION",
        transfer_allowed=False,
        required_transport_capability="CUSTOM_TRANSPORT",
    )
    site = next(f for f in data["facilities"] if f["facility_id"] == "FAC-EAST")
    patient = {
        "patient_id": "P1",
        "facility_id": "FAC-MAIN",
        "state": "direct_waiting",
        "care_level": "ward",
        "eligible_for_transfer": True,
        "resource_profile_id": "RP-WARD-BASIC",
    }
    result = check_placement(data, {}, site, "ward", [], patient)
    assert not result["eligible"]
    assert any("unsupported care capability" in reason for reason in result["reasons"])
    assert any("does not allow transfer" in reason for reason in result["reasons"])
    assert result["transport"]["required_capability"] == "CUSTOM_TRANSPORT"


def test_snapshot_placement_derives_rosters_without_optional_capacity_cache(source):
    from surge_api.eligibility import check_placement, snapshot_units

    data = copy.deepcopy(source)
    for unit in data["units"]:
        unit.pop("staffed_capacity", None)
    assert validate_dataset(data)["valid"]
    units = snapshot_units(data)
    assert next(u for u in units if u["unit_id"] == "UNIT-WARD-A")["staffed"] == 32
    site = next(f for f in data["facilities"] if f["facility_id"] == "FAC-MAIN")
    assert check_placement(data, {}, site, "ward", [])["eligible"]
    next(p for p in data["capacity_policies"] if p["unit_kind"] == "ward")["allowed_patient_care_levels"] = []
    # Even a supplied positive headroom ledger must not bypass a policy gate.
    result = check_placement(data, {}, site, "ward", [], state={"units": units})
    assert not result["eligible"]
    assert any("capacity policy" in reason for reason in result["reasons"])


@pytest.mark.parametrize("kind,stream", [("ed", "ED_MAIN"), ("ward", "DIRECT_WARD_MAIN")])
def test_declared_virtual_queue_is_retained_until_actual_service_entry(source, kind, stream):
    data = copy.deepcopy(source)
    arrival = next(s for s in data["entry_streams"] if s["entry_stream_id"] == stream)
    old = arrival["initial_queue_location_id"]
    next(q for q in data["virtual_locations"] if q["location_id"] == old)["location_id"] = "CUSTOM-QUEUE"
    arrival["initial_queue_location_id"] = "CUSTOM-QUEUE"
    for assignment in data["assignments"]:
        unit = next((u for u in data["units"] if u["unit_id"] == assignment["unit_id"]), {})
        if unit.get("kind") == kind and dt(assignment["start_at"]) < dt(at(data, 180)) < dt(
            assignment["end_at"]
        ):
            assignment["start_at"] = at(data, 180)
    if kind == "ed":
        arrival["assessment_template_id"] = fixed(data, "assessment-400", 400, "assessment")
    scenario = batch(data, "ward")
    scenario["conditions"][0]["entry_stream_id"] = stream
    result = run_replication(data, scenario)
    assert state_at(result, 100)["patients"][0]["queue_location_id"] == "CUSTOM-QUEUE"
    assert state_at(result, 200)["patients"][0]["queue_location_id"] is None


def test_reported_profile_mix_controls_exact_stage_equipment(source):
    data = copy.deepcopy(source)
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["los_template_id"] = fixed(data, "stay-" + cohort["cohort_id"], 2000)
    next(p for p in data["resource_profiles"] if p["resource_profile_id"] == "RP-WARD-OXYGEN")[
        "required_equipment"
    ][0]["quantity"] = 2
    scenario = {
        "horizon_calendar_days": 1,
        "updates": [
            {
                "update_id": "MIX",
                "type": "arrival_batch",
                "effective_at": at(data, 0),
                "payload": {
                    "facility_id": "FAC-MAIN",
                    "entry_stream_id": "ED_MAIN",
                    "count": 1,
                    "care_mix": {"ward": 1},
                    "resource_profile_mix": {"ward": {"RP-WARD-OXYGEN": 1}},
                    "spread_minutes": 0,
                },
            }
        ],
    }
    result = run_replication(data, scenario)
    patient = state_at(result, 1000)["patients"][0]
    assert patient["resource_profile_id"] == "RP-WARD-OXYGEN"
    assert patient["resource_requirements"] == [{"capability_code": "WARD_OXYGEN", "quantity": 2}]
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_accepted_rounding_tolerance_is_normalized_before_profile_sampling(source):
    from surge_api.updates import payload_errors

    data = copy.deepcopy(source)
    payload = {
        "facility_id": "FAC-MAIN",
        "entry_stream_id": "DIRECT_WARD_MAIN",
        "count": 1,
        "spread_minutes": 0,
        "care_mix": {"ward": 0.9999995},
        "resource_profile_mix": {"ward": {"RP-WARD-BASIC": 0.9999995}},
    }
    update = {
        "type": "arrival_batch",
        "update_id": "ROUNDING",
        "effective_at": at(data, 0),
        "payload": payload,
    }
    assert payload_errors(update, data) == []
    result = run_replication(data, {"horizon_calendar_days": 1, "updates": [update]})
    assert result["patients"][0]["resource_profile_id"] == "RP-WARD-BASIC"
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_profile_site_capability_blocks_placement_and_transfer_flag_is_honored(source):
    data = copy.deepcopy(source)
    profile = next(p for p in data["resource_profiles"] if p["resource_profile_id"] == "RP-WARD-BASIC")
    profile.update(required_site_capability="ISOLATION", transfer_allowed=False)
    result = run_replication(
        data, {**batch(data, "RP-WARD-BASIC"), "interventions": [{"kind": "partner_transfer"}]}
    )
    patient = result["patients"][0]
    assert patient["state"] == "ed_boarding"
    assert not patient["eligible_for_transfer"]
    assert result["scalar_metrics"]["patients_transferred"] == 0
    assert result["scalar_metrics"]["unserved_at_horizon"] == 1


def test_configured_blanket_resource_quantity_limits_supported_places(source):
    data = copy.deepcopy(source)
    policy = next(p for p in data["capacity_policies"] if p["unit_kind"] == "icu")
    policy["per_slot_resources"] = [{"capability_code": "ICU_MONITOR", "quantity": 2}]
    result = run_replication(data, {"horizon_calendar_days": 1})
    unit = next(u for u in state_at(result, 0)["units"] if u["unit_id"] == "UNIT-ICU")
    assert unit["staffed"] == 8
    assert result["scalar_metrics"]["patient_conservation_ok"]
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "icu":
            cohort["los_template_id"] = fixed(data, "long-" + cohort["cohort_id"], 2000)
    occupied = run_replication(data, batch(data, "RP-ICU-MONITORED"))
    patient = state_at(occupied, 1000)["patients"][0]
    assert patient["state"] == "inpatient"
    assert patient["resource_requirements"] == [{"capability_code": "ICU_MONITOR", "quantity": 2}]
    pool = next(
        p for p in state_at(occupied, 1000)["equipment_pools"] if p["equipment_pool_id"] == "EQ-ICU-MONITOR"
    )
    assert pool["in_use"] == 2


def test_policy_disallowed_care_blocks_new_admission(source):
    data = copy.deepcopy(source)
    next(p for p in data["capacity_policies"] if p["unit_kind"] == "ward")["allowed_patient_care_levels"] = []
    result = run_replication(data, batch(data, "ward"))
    assert result["patients"][0]["state"] == "ed_boarding"
    assert result["scalar_metrics"]["unserved_at_horizon"] == 1


@pytest.mark.parametrize(
    "filters",
    [
        {"allowed_profile_ids": ["RP-WARD-BASIC"]},
        {"excluded_profile_ids": ["RP-WARD-OXYGEN"]},
        {"minimum_remaining_stage_minutes": 601},
        {},
    ],
)
def test_structured_transfer_filters_use_actual_required_profile_and_stage(source, filters):
    data = copy.deepcopy(source)
    for assignment in data["assignments"]:
        if assignment["unit_id"] in {"UNIT-WARD-A", "UNIT-WARD-B", "UNIT-WARD-C"}:
            assignment["status"] = "unavailable"
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["los_template_id"] = fixed(data, "stay-" + cohort["cohort_id"], 600)
    scenario = batch(data, "RP-WARD-OXYGEN")
    scenario["conditions"][0]["entry_stream_id"] = "DIRECT_WARD_MAIN"
    scenario["interventions"] = [{"kind": "partner_transfer", "patient_eligibility_filter": filters}]
    result = run_replication(data, scenario)
    assert result["scalar_metrics"]["patients_transferred"] == (0 if filters else 1)
    assert result["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize("transfer", [False, True])
def test_stepdown_retains_icu_then_starts_separate_ward_clock(source, transfer):
    data = copy.deepcopy(source)
    census = generate_dataset(days=1)
    patient = copy.deepcopy(next(p for p in census["patients"] if p["care_level"] == "icu"))
    patient["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 60}
    patient.pop("remaining_stay_template_id", None)
    data["patients"] = [patient]
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            cohort["los_template_id"] = fixed(data, "ward-" + cohort["cohort_id"], 120)
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-BASIC", "weight": 1}]
    path = data["pathway_profiles"][0]
    path.update(icu_stepdown_probability=1, stepdown_ward_cohort_weights=[1, 0, 0])
    # All ward staff become available at minute 180; ICU service completes at 60.
    for assignment in data["assignments"]:
        if assignment["unit_id"] in {"UNIT-WARD-A", "UNIT-WARD-B", "UNIT-WARD-C"} and dt(
            assignment["start_at"]
        ) < dt(at(data, 180)) < dt(assignment["end_at"]):
            assignment["start_at"] = at(data, 180)
    result = run_replication(
        data,
        {"horizon_calendar_days": 1, "interventions": [{"kind": "partner_transfer"}] if transfer else []},
    )
    waiting = next(p for p in state_at(result, 65)["patients"] if p["patient_id"] == patient["patient_id"])
    assert (
        waiting["state"] in {"inpatient", "transfer_reserved"} and waiting["stage_status"] == "ready_to_exit"
    )
    assert waiting["unit_id"] == "UNIT-ICU"
    assert waiting["target_unit_kind"] == "ward"
    assert state_at(result, 65)["inpatient_queue"] == 1
    assert waiting["current_stage_started_at"] == patient["current_stage_started_at"]
    end = result["patients"][0]
    ward = next(i for i in end["state_intervals"] if i["state"] == "inpatient" and i["unit_id"] != "UNIT-ICU")
    if not transfer:
        assert ward["start_elapsed_minutes"] == 180
    else:
        assert result["scalar_metrics"]["patients_transferred"] == 1
        assert 60 < ward["start_elapsed_minutes"] < 180
    assert ward["sampled_stage_minutes"] == 120
    assert end["departure_at"] == at(data, ward["start_elapsed_minutes"] + 120)
    assert (
        result["scalar_metrics"]["inpatient_waiting_patient_hours"]
        == (ward["start_elapsed_minutes"] - 60) / 60
    )
    assert result["scalar_metrics"]["patient_conservation_ok"]
