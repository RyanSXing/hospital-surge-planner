"""Daily disruption chance changes care, never the independent arrival streams."""

# ruff: noqa: F811 -- shared pytest fixture is injected by name.
import copy
from datetime import timedelta

import pytest
from surge_engine import aggregate_results, run_replication, state_at
from surge_engine.common import dt, endpoint, iso
from surge_engine.hospital_operations import validate_hospital_operations
from surge_engine.simulation import HospitalSimulation
from test_hospital_operations import (  # noqa: F401
    discharge_time,
    disruption,
    empty_hospital,
    hospital,
    initial_patient,
    mix,
    model,
)


@pytest.mark.parametrize("chance", [-1, 101, True, "25", None, float("nan"), float("inf")])
def test_probability_rejects_invalid_or_coerced_values(hospital, chance):
    start = dt(hospital["snapshot_at"])
    with pytest.raises(ValueError, match="Daily disruption chance"):
        validate_hospital_operations(
            {"disruption_chance_percent": chance}, start, endpoint(start, 3, hospital["timezone"])
        )


def test_zero_probability_draws_nothing_and_keeps_legacy_clinical_history(hospital, monkeypatch):
    import surge_engine.hospital_operations as operations

    data, _ = initial_patient(hospital, hours=4)
    plain = model(data, arrivals=(1, 8, 26)).run()

    def unexpected(*_args):
        raise AssertionError("Disabled probability consumed a disruption random stream")

    monkeypatch.setattr(operations, "rng", unexpected)
    zero = model(data, {"disruption_chance_percent": 0}, arrivals=(1, 8, 26)).run()
    assert zero["events"] == plain["events"]
    assert zero["scalar_metrics"] == plain["scalar_metrics"]
    assert zero["daily"] == plain["daily"]
    assert "sampled_disruption_days" not in zero


def test_one_hundred_percent_pauses_whole_horizon_without_false_midnight_treatment(hospital):
    data, initial = initial_patient(hospital, hours=4)
    trace = model(data, {"disruption_chance_percent": 100}, arrivals=(1, 26, 50)).run()
    assert [day["affected"] for day in trace["sampled_disruption_days"]] == [True] * 3
    assert [day["treatment_disruption_hours"] for day in trace["daily"]] == [24] * 3
    assert not any(
        event["event_type"] in {"admission", "assessment_start", "assessment_end", "discharge"}
        for event in trace["events"]
    )
    assert [event["elapsed_minutes"] for event in trace["events"] if event["event_type"] == "arrival"] == [
        60,
        26 * 60,
        50 * 60,
    ]
    for at in (12 * 60, 24 * 60, 48 * 60, 71 * 60):
        patient = next(p for p in state_at(trace, at)["patients"] if p["patient_id"] == initial)
        assert patient["care_paused"] is True
        assert patient["remaining_stage_spec"] == {"kind": "fixed_minutes", "minutes": 240}
    assert all("first_treatment_at" not in patient for patient in trace["patients"])
    assert trace["scalar_metrics"]["success_score_percent"] == 0
    assert trace["scalar_metrics"]["success_eligible_patients"] == 2
    assert trace["scalar_metrics"]["average_wait_per_patient_hours"] == pytest.approx(139 / 3)
    assert trace["scalar_metrics"]["patient_conservation_ok"] is True
    assert len(trace["operations_constraint_periods"]) == 1
    assert trace["operations_constraint_periods"][0]["end_elapsed_minutes"] == 72 * 60
    starts = [event for event in trace["events"] if event["event_type"] == "treatment_disruption_started"]
    assert len(starts) == 3
    assert all(event["payload"]["source"] == "daily_disruption_chance" for event in starts)


@pytest.mark.parametrize("days", [7, 14, 30])
def test_intermediate_chance_is_repeatable_distinct_by_replication_and_trace_independent(hospital, days):
    data = empty_hospital(hospital)
    scenario = {
        "base_seed": 43121,
        "horizon_calendar_days": days,
        "hospital_operations": {"disruption_chance_percent": 50},
    }
    first = run_replication(data, scenario, 0, keep_trace=True)
    same = run_replication(data, scenario, 0, keep_trace=False)
    second = run_replication(data, scenario, 1, keep_trace=True)
    assert first["sampled_disruption_days"] == same["sampled_disruption_days"]
    assert first["scalar_metrics"] == same["scalar_metrics"]
    assert first["daily"] == same["daily"]
    assert len(first["sampled_disruption_days"]) == days
    outcomes = [day["affected"] for day in first["sampled_disruption_days"]]
    assert any(outcomes) and not all(outcomes)
    assert outcomes != [day["affected"] for day in second["sampled_disruption_days"]]
    assert sum(day["treatment_disruption_hours"] for day in first["daily"]) == sum(
        (dt(day["end_at"]) - dt(day["start_at"])).total_seconds() / 3600
        for day in first["sampled_disruption_days"]
        if day["affected"]
    )
    assert [day["treatment_disruption_hours"] > 0 for day in first["daily"]] == outcomes
    aggregate = aggregate_results([first, second], scenario)
    for offset, day in enumerate(aggregate["daily"]):
        assert (
            day["treatment_disruption_hours"]["mean"]
            == (
                first["daily"][offset]["treatment_disruption_hours"]
                + second["daily"][offset]["treatment_disruption_hours"]
            )
            / 2
        )


def test_chance_does_not_resample_arrivals_severity_or_care_durations(hospital, monkeypatch):
    from surge_engine.hospital_operations import HospitalOperations

    data = empty_hospital(hospital)
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 4
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 1
    original = HospitalOperations.configure_arrival
    draws = {}

    def capture(self, patient):
        original(self, patient)
        draws.setdefault(self.disruption_chance, {})[patient["patient_id"]] = {
            key: copy.deepcopy(patient.get(key))
            for key in (
                "severity",
                "_outcome",
                "_assessment_duration",
                "_inpatient_duration",
                "_stepdown_selected",
                "_stepdown_duration",
                "sampled_inpatient_care_hours",
            )
        }

    monkeypatch.setattr(HospitalOperations, "configure_arrival", capture)
    base = {"base_seed": 43121, "horizon_calendar_days": 14}
    runs = [
        run_replication(
            data,
            {
                **base,
                "hospital_operations": {
                    "severity_mix": mix("medium", 36),
                    "disruption_chance_percent": chance,
                },
            },
        )
        for chance in (0, 50)
    ]
    assert draws[0] == draws[50]
    assert len(draws[0]) > 30
    arrivals = lambda trace: [
        (event["patient_id"], event["occurred_at"])
        for event in trace["events"]
        if event["event_type"] == "arrival"
    ]
    assert arrivals(runs[0]) == arrivals(runs[1])


@pytest.mark.parametrize(
    ("start", "hours"),
    [("2026-10-31T05:00:00Z", [24, 25, 24]), ("2026-03-07T06:00:00Z", [24, 23, 24])],
)
def test_full_local_days_obey_daylight_saving_boundaries(hospital, start, hours):
    data = empty_hospital(hospital)
    data["snapshot_at"] = start
    trace = model(data, {"disruption_chance_percent": 100}).run()
    assert [day["treatment_disruption_hours"] for day in trace["daily"]] == hours
    assert [
        (dt(day["end_at"]) - dt(day["start_at"])).total_seconds() / 3600
        for day in trace["sampled_disruption_days"]
    ] == hours
    assert not any(day["clipped_to_horizon"] for day in trace["sampled_disruption_days"])


def test_partial_first_and_last_local_days_are_sampled_once_and_clipped_honestly(hospital):
    data = empty_hospital(hospital)
    data["snapshot_at"] = "2026-10-31T17:00:00Z"
    scenario = {
        "horizon_calendar_days": 3,
        "state_origin": "observed_reset",
        "end_at": "2026-11-02T12:00:00Z",
        "hospital_operations": {"disruption_chance_percent": 100},
    }
    trace = run_replication(data, scenario)
    sampled = trace["sampled_disruption_days"]
    assert [day["local_date"] for day in sampled] == ["2026-10-31", "2026-11-01", "2026-11-02"]
    assert [day["clipped_to_horizon"] for day in sampled] == [True, False, True]
    assert sampled[0]["start_at"] == data["snapshot_at"]
    assert sampled[0]["local_day_start_at"] == "2026-10-31T05:00:00Z"
    assert sampled[-1]["end_at"] == scenario["end_at"]
    assert sampled[-1]["local_day_end_at"] == "2026-11-03T06:00:00Z"
    assert [day["treatment_disruption_hours"] for day in trace["daily"]] == [12, 25, 6]


def test_manual_schedules_are_preserved_and_union_with_sampled_days_without_double_counting(hospital):
    data, pid = initial_patient(hospital, hours=4)
    explicit = disruption(data, 1, 25)
    before = copy.deepcopy(explicit)
    trace = model(data, {"disruptions": [explicit], "disruption_chance_percent": 100}).run()
    assert explicit == before
    assert sum(day["treatment_disruption_hours"] for day in trace["daily"]) == 72
    assert len(trace["operations_constraint_periods"]) == 1
    assert not any(
        event["event_type"] == "discharge" and event["patient_id"] == pid for event in trace["events"]
    )
    assert any(
        event["event_type"] == "treatment_disruption_started" and event["payload"] == before
        for event in trace["events"]
    )


def test_no_sampled_shortage_never_fabricates_recorded_disruption_evidence(hospital):
    trace = model(empty_hospital(hospital), {"disruption_chance_percent": 0.000000001}).run()
    assert all(not day["affected"] for day in trace["sampled_disruption_days"])
    assert [day["treatment_disruption_hours"] for day in trace["daily"]] == [0, 0, 0]
    assert not trace["operations_constraint_periods"]
    assert not any(event["event_type"].startswith("treatment_disruption") for event in trace["events"])


@pytest.mark.parametrize("version", ["1.0", "1.1", "1.2"])
def test_historical_operations_models_reject_a_new_nonzero_probability(hospital, version):
    with pytest.raises(ValueError, match="requires hospital operations model 1.3"):
        run_replication(
            empty_hospital(hospital),
            {
                "horizon_calendar_days": 1,
                "hospital_operations": {"disruption_chance_percent": 50},
                "_hospital_operations_model_version": version,
            },
        )


def test_current_day_branch_decision_preserves_parent_and_future_dates_use_branch_stream(hospital):
    data = empty_hospital(hospital)
    scenario = {
        "horizon_calendar_days": 14,
        "base_seed": 43121,
        "hospital_operations": {"disruption_chance_percent": 50},
    }
    original = HospitalSimulation(data, scenario, 2, False)
    branched = HospitalSimulation(
        data,
        {
            **scenario,
            "branch_strategy": "selected_replication",
            "branch_at": iso(dt(data["snapshot_at"]) + timedelta(hours=30)),
            "branch_replication_index": 2,
        },
        5,
        False,
    )
    parent = original.operations.sampled_disruption_days
    child = branched.operations.sampled_disruption_days
    assert child[:2] == parent[:2]
    assert [day["affected"] for day in child[2:]] != [day["affected"] for day in parent[2:]]
