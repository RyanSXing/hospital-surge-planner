"""Configured stock and rotating staff remain explicit, bounded and conserved."""

import copy
from collections import Counter

import pytest
from pydantic import ValidationError
from surge_api.domain import scenario_defaults, validate_scenario
from surge_api.schemas import ScenarioPatch, command_dict
from surge_engine import generate_dataset, run_replication, state_at
from surge_engine.common import digest, dt
from surge_engine.simulation import HospitalSimulation
from surge_engine.unit_configuration import apply_unit_configuration, unit_configuration_errors


@pytest.fixture(scope="module")
def hospital():
    return generate_dataset(fixture="hospital_baseline", days=3)


def scenario(data, **config):
    value = scenario_defaults({}, data)
    value.update(
        horizon_calendar_days=2,
        replications=1,
        conditions=[
            {"kind": "unit_configuration", "unit_id": "UNIT-ICU", "source": "user_assumption", **config}
        ],
        interventions=[],
        updates=[],
    )
    return value


def test_configured_capacity_and_all_roles_are_real_and_constant_across_shift_changes(hospital):
    original = digest(hospital)
    value = scenario(
        hospital,
        physical_capacity=20,
        enabled_capacity=18,
        staffed_capacity=15,
        staff_counts={"rn": 8, "provider": 2, "support": 3},
    )
    assert validate_scenario(value, hospital)["valid"]
    assert command_dict(ScenarioPatch(conditions=value["conditions"]))["conditions"] == value["conditions"]
    trace = run_replication(hospital, value)
    for minute in (0, 420, 720, 721, 1140, 1440, 2000, 2879):
        state = state_at(trace, minute)
        unit = next(u for u in state["units"] if u["unit_id"] == "UNIT-ICU")
        assert (unit["physical"], unit["enabled"], unit["staffed"]) == (20, 18, 15)
        assert unit["qualified_staff_by_role"] == {"rn": 8, "provider": 2, "support": 3}
        assert len(unit["active_staff_ids"]) == 13
    assert trace["scalar_metrics"]["patient_conservation_ok"]
    assert digest(hospital) == original


def test_new_staff_do_not_borrow_reserves_or_double_book_source_people(hospital):
    configured = apply_unit_configuration(hospital, scenario(hospital, staff_counts={"rn": 9, "provider": 2}))
    original_ids = {s["staff_id"] for s in hospital["staff"]}
    people = {s["staff_id"]: s for s in configured["staff"]}
    for at in ("2026-10-16T05:00:00Z", "2026-10-16T17:00:00Z", "2026-10-17T05:00:00Z"):
        active = [
            a
            for a in configured["assignments"]
            if a.get("status") != "unavailable" and dt(a["start_at"]) <= dt(at) < dt(a["end_at"])
        ]
        fractions = Counter()
        for assignment in active:
            fractions[assignment["staff_id"]] += assignment.get("allocation_fraction", 1)
        assert all(f <= 1 for f in fractions.values())
        icu = [a for a in active if a.get("unit_id") == "UNIT-ICU"]
        replacement = [a for a in icu if people[a["staff_id"]]["role"] in {"rn", "provider"}]
        assert len(replacement) == 11
        assert all(a["staff_id"] not in original_ids for a in replacement)
        reserve_before = {
            a["staff_id"]
            for a in hospital["assignments"]
            if a.get("reserve_pool_id") and dt(a["start_at"]) <= dt(at) < dt(a["end_at"])
        }
        assert reserve_before <= set(fractions)


def test_stock_reduction_keeps_patient_and_incoming_reservation_ids(hospital):
    data = copy.deepcopy(hospital)
    occupied = {p["slot_id"] for p in data["patients"] if p.get("unit_id") == "UNIT-ICU" and p.get("slot_id")}
    reserved = next(
        s["slot_id"] for s in data["slots"] if s["unit_id"] == "UNIT-ICU" and s["slot_id"] not in occupied
    )
    data["patients"].append(
        {
            "patient_id": "RESERVED",
            "state": "in_transit",
            "pending_transfer": {"destination_slot_id": reserved},
        }
    )
    minimum = len(occupied) + 1
    value = scenario(data, physical_capacity=minimum, enabled_capacity=minimum)
    configured = apply_unit_configuration(data, value)
    retained = {s["slot_id"] for s in configured["slots"] if s["unit_id"] == "UNIT-ICU" and s["enabled"]}
    assert retained == occupied | {reserved}
    value["conditions"][0]["physical_capacity"] = minimum - 1
    assert any("starting census" in e["message"] for e in unit_configuration_errors(data, value))


def test_zero_staff_is_a_modeled_shortage_not_an_impossible_census(hospital):
    value = scenario(hospital, staff_counts={"rn": 0, "provider": 0, "support": 0}, staffed_capacity=0)
    assert validate_scenario(value, hospital)["valid"]
    state = state_at(run_replication(hospital, value), 0)
    unit = next(u for u in state["units"] if u["unit_id"] == "UNIT-ICU")
    assert unit["staffed"] == 0 and not unit["admission_gate"]
    assert unit["occupied"] > 0 and unit["capacity_deficit"] == unit["occupied"]


@pytest.mark.parametrize(
    "change",
    [
        {"physical_capacity": None},
        {"enabled_capacity": None},
        {"staffed_capacity": None},
        {"physical_capacity": True},
        {"physical_capacity": 2.5},
        {"enabled_capacity": 17},
        {"staff_counts": {"rn": None}},
        {"staff_counts": {"provider": True}},
        {"staff_counts": {"rn": -1}},
        {"staff_counts": {"imaginary": 3}},
        {"staff_counts": {"support": 501}},
        {"unit_id": "UNIT-EAST-WARD"},
    ],
)
def test_invalid_configuration_is_rejected_before_jobs_or_engine_materialization(hospital, change):
    value = scenario(hospital, **change)
    assert not validate_scenario(value, hospital)["valid"]
    with pytest.raises(ValueError):
        apply_unit_configuration(hospital, value)


def test_schema_rejects_fractional_and_boolean_staff_counts():
    for count in (True, 1.5, -1, 501):
        with pytest.raises(ValidationError):
            ScenarioPatch(
                conditions=[{"kind": "unit_configuration", "unit_id": "U", "staff_counts": {"rn": count}}]
            )


def test_large_planned_roster_is_bounded_before_allocating_staff_rows(hospital):
    value = scenario(hospital, staff_counts={"rn": 500, "provider": 500, "support": 500})
    value["horizon_calendar_days"] = 365
    errors = unit_configuration_errors(hospital, value)
    assert any("100,000 shift assignments" in e["message"] for e in errors)
    with pytest.raises(ValueError, match="100,000"):
        apply_unit_configuration(hospital, value)


def test_no_configuration_returns_identical_dataset_and_duplicate_unit_is_rejected(hospital):
    assert apply_unit_configuration(hospital, {"conditions": []}) is hospital
    value = scenario(hospital, staff_counts={"rn": 8})
    value["conditions"].append(copy.deepcopy(value["conditions"][0]))
    assert not validate_scenario(value, hospital)["valid"]


def test_fractional_staffing_changes_are_recorded_even_when_capacity_is_unchanged(hospital):
    data = copy.deepcopy(hospital)
    at = dt(data["snapshot_at"])
    people = {s["staff_id"]: s for s in data["staff"]}
    assignment = next(
        a
        for a in data["assignments"]
        if a.get("unit_id") == "UNIT-ICU"
        and people[a["staff_id"]]["role"] == "rn"
        and dt(a["start_at"]) <= at < dt(a["end_at"])
    )
    assignment["allocation_fraction"] = 0.75
    model = HospitalSimulation(data, {**scenario_defaults({}, data), "horizon_calendar_days": 1}, 0, True)
    model.reconcile_staff()
    model.record_state()
    before = model.unit_history["UNIT-ICU"][-1]
    model.active_assignments[assignment["staff_id"]]["allocation_fraction"] = 0.8
    model.now = 1
    model.reconcile_staff()
    model.record_state()
    after = model.unit_history["UNIT-ICU"][-1]
    assert after["staffed"] == before["staffed"] == 11
    assert after["active_staff_ids"] == before["active_staff_ids"]
    assert after["qualified_staff_by_role"]["rn"] == pytest.approx(5.8)
    assert before["qualified_staff_by_role"]["rn"] == pytest.approx(5.75)
    assert after["elapsed_minutes"] == 1


@pytest.mark.parametrize("identity", [["UNIT-ICU"], {"unit": "ICU"}])
def test_configuration_rejects_non_string_unit_without_a_dataset(identity):
    assert unit_configuration_errors(
        None, {"conditions": [{"kind": "unit_configuration", "unit_id": identity}]}
    )
