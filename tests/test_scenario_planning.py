"""Synthetic future inputs retain their own provenance and validate before jobs exist."""

import copy

import pytest
from pydantic import ValidationError
from surge_api.domain import normalize_conditions, scenario_defaults, validate_scenario
from surge_api.schemas import ScenarioPatch
from surge_api.updates import payload_errors
from surge_engine import generate_dataset, run_replication, state_at


@pytest.fixture(scope="module")
def fixture():
    return generate_dataset(days=3)


def scenario(dataset):
    result = scenario_defaults({}, dataset)
    result.update(horizon_calendar_days=2, replications=1, conditions=[], interventions=[], updates=[])
    return result


@pytest.mark.parametrize(
    "kind,payload",
    [
        ("capacity_change", {"unit_id": "UNIT-ICU", "enabled_capacity": 17}),
        ("advertised_capacity_change", {"unit_id": "UNIT-ICU", "advertised_staffed_capacity": 1}),
        ("equipment_change", {"equipment_pool_id": "MISSING", "quantity": 1, "operation": "fail"}),
        ("route_change", {"route_id": "MISSING", "unavailable": True}),
        ("staff_unavailable", {"staff_ids": ["MISSING"], "until": "2026-10-17T05:00:00Z"}),
    ],
)
def test_invalid_planned_resource_payload_rejected_before_simulation(fixture, kind, payload):
    value = scenario(fixture)
    value["updates"] = [
        {
            "type": kind,
            "effective_at": fixture["snapshot_at"],
            "input_kind": "planned_assumption",
            "source": "user_assumption",
            "payload": payload,
        }
    ]
    check = validate_scenario(value, fixture)
    assert not check["valid"]
    assert any(e["field"].startswith("updates.0.payload") for e in check["errors"])


def test_planned_events_require_canonical_typed_shape_and_no_observation_origin(fixture):
    with pytest.raises(ValidationError):
        ScenarioPatch.model_validate(
            {"updates": [{"type": "invented", "effective_at": fixture["snapshot_at"], "payload": {}}]}
        )
    with pytest.raises(ValidationError):
        ScenarioPatch.model_validate(
            {
                "updates": [
                    {
                        "type": "equipment_change",
                        "effective_at": fixture["snapshot_at"],
                        "payload": {"equipment_pool_id": "EQ-ICU-VENT", "quantity": True},
                    }
                ]
            }
        )
    value = scenario(fixture)
    value["updates"] = [
        {
            "type": "capacity_change",
            "effective_at": fixture["snapshot_at"],
            "input_kind": "planned_assumption",
            "state_origin": "observed_reset",
            "payload": {"unit_id": "UNIT-ICU", "enabled_capacity": 12},
        }
    ]
    assert any(e["field"] == "updates.0.state_origin" for e in validate_scenario(value, fixture)["errors"])


def test_incidents_have_explicit_mix_stream_and_horizon(fixture):
    value = scenario(fixture)
    for bad in [
        {"care_mix": {"icu": 2}},
        {"entry_stream_id": "MISSING"},
        {"at": "2027-01-01T00:00:00Z"},
        {"spread_minutes": 3000},
    ]:
        value["conditions"] = [
            {
                "id": "incident",
                "kind": "arrival_batch",
                "at": fixture["snapshot_at"],
                "count": 3,
                "care_mix": {"ward": 1},
                "entry_stream_id": "ED_MAIN",
                **bad,
            }
        ]
        assert not validate_scenario(value, fixture)["valid"]


def test_synthetic_incident_and_reported_batch_keep_distinct_provenance_and_exact_counts(fixture):
    dataset = copy.deepcopy(fixture)
    dataset["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    dataset["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    value = scenario(dataset)
    value["conditions"] = [
        {
            "id": "planned",
            "kind": "arrival_batch",
            "at": fixture["snapshot_at"],
            "count": 7,
            "care_mix": {"ward": 1},
            "entry_stream_id": "ED_MAIN",
        }
    ]
    value["conditions"].append(
        {
            "id": "cohort",
            "kind": "care_mix_override",
            "entry_stream_id": "ED_MAIN",
            "start_at": fixture["snapshot_at"],
            "end_at": "2026-10-18T05:00:00Z",
            "care_mix_override": {"icu": 1},
        }
    )
    value["updates"] = [
        {
            "update_id": "reported",
            "type": "arrival_batch",
            "effective_at": fixture["snapshot_at"],
            "payload": {
                "facility_id": "FAC-MAIN",
                "count": 3,
                "care_mix": {"ward": 1},
                "entry_stream_id": "ED_MAIN",
            },
        }
    ]
    assert validate_scenario(value, dataset)["valid"]
    result = run_replication(dataset, value)
    assert result["scalar_metrics"]["arrivals"] == 10
    patients = result["patients"]
    assert len([p for p in patients if p.get("arrival_origin") == "synthetic_incident"]) == 7
    assert len([p for p in patients if p.get("source_type") == "reported_batch"]) == 3
    assert all(
        p["care_level"] == "ward"
        for p in patients
        if p.get("arrival_origin") == "synthetic_incident" or p.get("source_type") == "reported_batch"
    )
    assert result["scalar_metrics"]["patient_conservation_ok"]


def test_arrival_volume_condition_without_mix_cannot_erase_explicit_cohort_override(fixture):
    value = scenario(fixture)
    value["conditions"] = [
        {
            "kind": "care_mix_override",
            "entry_stream_id": "ED_MAIN",
            "start_at": fixture["snapshot_at"],
            "end_at": "2026-10-18T05:00:00Z",
            "care_mix_override": {"discharge": 1},
        },
        {"kind": "arrival_multiplier", "entry_stream_id": "ED_MAIN", "surge_percent": 70},
    ]
    result = run_replication(fixture, value)
    arrivals = [
        p
        for p in result["patients"]
        if p.get("source_type") in {"baseline_arrival", "surge_arrival"}
        and p.get("arrival_origin") != "synthetic_incident"
        and p["entry_type"] == "ed"
    ]
    assert arrivals
    assert all(p["care_level"] == "ambulatory" for p in arrivals)


@pytest.mark.parametrize(
    "delay,end_at,duration",
    [
        (360, "2026-10-16T11:00:00Z", None),
        (720, "2026-10-16T11:00:00Z", None),
        (None, "2026-10-16T11:00:00Z", None),
        (360, None, 120),
    ],
)
def test_activation_must_precede_plan_end_in_validation_and_engine(fixture, delay, end_at, duration):
    value = scenario(fixture)
    plan = {"kind": "clinic", "unit_id": "UNIT-CLINIC-NORTH", "start_at": value["start_at"]}
    if delay is not None:
        plan["activation_minutes"] = delay
    if end_at:
        plan["end_at"] = end_at
    if duration is not None:
        plan["duration_minutes"] = duration
    value["interventions"] = [plan]
    report = validate_scenario(value, fixture)
    assert any(e["field"] == "interventions.0.activation_minutes" for e in report["errors"])
    with pytest.raises(ValueError, match="readiness must occur before"):
        run_replication(fixture, value)


@pytest.mark.parametrize("kind", ["staff_absence", "staff_unavailability"])
def test_legacy_or_canonical_staff_percentage_reduces_actual_staffed_capacity(fixture, kind):
    value = scenario(fixture)
    value["conditions"] = [
        {
            "kind": kind,
            "unit_id": "UNIT-WARD-A",
            "absence_percent": 50,
            "start_at": value["start_at"],
            "end_at": "2026-10-17T05:00:00Z",
        }
    ]
    normalized = normalize_conditions(value, fixture)
    baseline = next(u for u in fixture["units"] if u["unit_id"] == "UNIT-WARD-A")["baseline_staff"]["rn"]
    assert normalized["conditions"][0]["kind"] == "staff_unavailability"
    assert normalized["conditions"][0]["count"] == baseline // 2
    assert validate_scenario(normalized, fixture)["valid"]
    for inputs in (value, normalized):
        trace = run_replication(fixture, inputs)
        unit = next(u for u in state_at(trace, 1)["units"] if u["unit_id"] == "UNIT-WARD-A")
        assert unit["staff_by_role"]["rn"] == baseline / 2
        assert unit["staffed"] == 16


@pytest.mark.parametrize("outcome", ["discharge", "icu", "RP-ICU-VENTILATED", "COHORT-ICU-STANDARD"])
def test_direct_ward_override_rejects_nonward_disposition_profiles_and_cohorts(fixture, outcome):
    value = scenario(fixture)
    value["conditions"] = [
        {
            "kind": "care_mix_override",
            "entry_stream_id": "DIRECT_WARD_MAIN",
            "start_at": value["start_at"],
            "end_at": "2026-10-17T05:00:00Z",
            "care_mix_override": {outcome: 1},
        }
    ]
    assert any(
        e["field"] == "conditions.0.care_mix_override" for e in validate_scenario(value, fixture)["errors"]
    )


def test_direct_ward_mixed_ward_profiles_and_cohorts_execute_and_batches_validate(fixture):
    value = scenario(fixture)
    value["conditions"] = [
        {
            "kind": "care_mix_override",
            "entry_stream_id": "DIRECT_WARD_MAIN",
            "start_at": value["start_at"],
            "end_at": "2026-10-18T05:00:00Z",
            "care_mix_override": {"ward": 0.4, "RP-WARD-OXYGEN": 0.3, "COHORT-WARD-SHORT": 0.3, "icu": 0},
        }
    ]
    assert validate_scenario(value, fixture)["valid"]
    result = run_replication(fixture, value)
    patients = [
        p
        for p in result["patients"]
        if p.get("entry_type") == "direct_ward" and p.get("source_type") != "initial_census"
    ]
    assert patients and all(p["care_level"] == "ward" for p in patients)
    record = {
        "type": "arrival_batch",
        "effective_at": value["start_at"],
        "payload": {
            "entry_stream_id": "DIRECT_WARD_MAIN",
            "facility_id": "FAC-MAIN",
            "count": 2,
            "care_mix": {"icu": 1},
        },
    }
    assert any(e["field"] == "payload.care_mix" for e in payload_errors(record, fixture))
    record["payload"]["care_mix"] = {"ward": 1, "icu": 0}
    assert not payload_errors(record, fixture)


def test_capacity_change_counts_installed_slots_even_when_planned_ids_sort_first(fixture):
    dataset = copy.deepcopy(fixture)
    planned = copy.deepcopy(next(s for s in dataset["slots"] if s["unit_id"] == "UNIT-WARD-A"))
    planned.update(slot_id="AAA-PLANNED-BEFORE-INSTALLED", installation_status="planned", enabled=False)
    dataset["slots"].append(planned)
    value = scenario(dataset)
    value["updates"] = [
        {
            "type": "capacity_change",
            "effective_at": value["start_at"],
            "payload": {"unit_id": "UNIT-WARD-A", "enabled_capacity": 20},
        }
    ]
    trace = run_replication(dataset, value)
    state = state_at(trace, 1)
    unit = next(u for u in state["units"] if u["unit_id"] == "UNIT-WARD-A")
    assert unit["enabled"] == 20
    assert unit["physical"] == 40
    slots = [s for s in state["slots"] if s["unit_id"] == "UNIT-WARD-A"]
    assert sum(s["enabled"] for s in slots if s["installation_status"] == "installed") == 20
    assert not next(s for s in slots if s["slot_id"] == planned["slot_id"])["enabled"]
