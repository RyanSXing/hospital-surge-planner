"""Optional operations controls change real care clocks and recorded stock."""

import copy
from datetime import timedelta

import pytest
from surge_engine import aggregate_results, generate_dataset, run_replication, state_at
from surge_engine.common import dt, endpoint, iso
from surge_engine.hospital_operations import validate_hospital_operations
from surge_engine.simulation import HospitalSimulation


@pytest.fixture(scope="module")
def hospital():
    return generate_dataset("hospital_baseline", days=35)


def empty_hospital(hospital):
    data = copy.deepcopy(hospital)
    data["patients"] = []
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    return data


def initial_patient(hospital, hours=4):
    data = empty_hospital(hospital)
    patient = copy.deepcopy(
        next(p for p in hospital["patients"] if p["state"] == "inpatient" and p["care_level"] == "ward")
    )
    patient["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": hours * 60}
    data["patients"] = [patient]
    return data, patient["patient_id"]


def mix(selected="low", mean=24):
    return {
        severity: {"percentage": 100 if severity == selected else 0, "average_stay_hours": mean}
        for severity in ("low", "medium", "high")
    }


def supplies(**changes):
    return {
        "initial_percent": 100,
        "capacity": 100,
        "usage_per_patient_day": 0,
        "refill_every_days": 1,
        "refill_percent": 100,
        **changes,
    }


def disruption(data, begin, end, identity="interruption"):
    start = dt(data["snapshot_at"])
    return {
        "id": identity,
        "start_at": iso(start + timedelta(hours=begin)),
        "end_at": iso(start + timedelta(hours=end)),
        "name": "Planned interruption",
    }


def model(data, operations=None, days=3, arrivals=(), keep_trace=True):
    scenario = {"horizon_calendar_days": days, "base_seed": 43121}
    if operations is not None:
        scenario["hospital_operations"] = operations
    sim = HospitalSimulation(data, scenario, 0, keep_trace)
    stream = next(s for s in data["entry_streams"] if s["entry_type"] == "direct_ward")
    for index, hour in enumerate(arrivals):
        sim.schedule(
            hour * 60,
            "arrival",
            {"patient_id": f"TEST-ARRIVAL-{index}", "source": "baseline_arrival", "stream": stream},
            2,
        )
    return sim


def discharge_time(trace, pid):
    return next(
        e["elapsed_minutes"]
        for e in trace["events"]
        if e["event_type"] == "discharge" and e["patient_id"] == pid
    )


@pytest.mark.parametrize(
    "bad",
    [
        {"severity_mix": {**mix(), "low": {"percentage": 99, "average_stay_hours": 24}}},
        {"severity_mix": {**mix(), "low": {"percentage": 100, "average_stay_hours": 0}}},
        {"severity_mix": {**mix(), "low": {"percentage": 100, "average_stay_hours": 48}}},
        {"supplies": supplies(initial_percent=-1)},
        {"supplies": supplies(capacity=0)},
        {"supplies": supplies(usage_per_patient_day=float("nan"))},
        {"supplies": supplies(refill_every_days=1.5)},
        {
            "disruptions": [
                {"id": "bad", "start_at": "2026-10-15T00:00:00Z", "end_at": "2026-10-16T07:00:00Z"}
            ]
        },
    ],
)
def test_rejects_impossible_operations_inputs(hospital, bad):
    start = dt(hospital["snapshot_at"])
    with pytest.raises(ValueError):
        validate_hospital_operations(bad, start, endpoint(start, 3, hospital["timezone"]))


def test_legacy_absence_and_null_keep_exact_result_and_missing_metrics(hospital):
    data, _ = initial_patient(hospital)
    scenario = {"horizon_calendar_days": 1, "base_seed": 43121}
    old = run_replication(data, scenario)
    disabled = run_replication(data, {**scenario, "hospital_operations": None})
    # Input hash reflects the submitted payload, while trajectories and metrics
    # remain byte-for-byte identical for a disabled optional model.
    assert old["events"] == disabled["events"]
    assert old["scalar_metrics"] == disabled["scalar_metrics"]
    assert "medical_supply_average_percent" not in old["scalar_metrics"]
    assert old["scalar_metrics"]["average_wait_per_patient_hours"] is None
    assert old["scalar_metrics"]["success_score_percent"] is None
    assert old["scalar_metrics"]["success_eligible_patients"] == 0
    assert "hospital_operations_model_version" not in old


def test_severity_changes_actual_stay_with_paired_randomness_and_preserves_arrivals(hospital):
    data = empty_hospital(hospital)
    low = model(data, {"severity_mix": mix("low", 12)}, arrivals=(0, 1, 2)).run()
    high = model(data, {"severity_mix": mix("high", 48)}, arrivals=(0, 1, 2)).run()
    repeated = model(data, {"severity_mix": mix("low", 12)}, arrivals=(0, 1, 2)).run()
    assert low["events"] == repeated["events"]
    assert low["scalar_metrics"] == repeated["scalar_metrics"]
    assert [(e["patient_id"], e["occurred_at"]) for e in low["events"] if e["event_type"] == "arrival"] == [
        (e["patient_id"], e["occurred_at"]) for e in high["events"] if e["event_type"] == "arrival"
    ]
    for first, second in zip(low["patients"], high["patients"]):
        assert first["severity"] == "low" and second["severity"] == "high"
        assert second["sampled_inpatient_care_hours"] == pytest.approx(
            first["sampled_inpatient_care_hours"] * 4
        )
        assert second["sampled_stage_minutes"] == pytest.approx(first["sampled_stage_minutes"] * 4)
    assert sum(row["ward_occupied"] for row in high["series"]) > sum(
        row["ward_occupied"] for row in low["series"]
    )


def test_initial_census_keeps_observed_residual_stay_when_severity_enabled(hospital):
    data, pid = initial_patient(hospital, hours=4)
    normal = model(data).run()
    changed = model(data, {"severity_mix": mix("high", 168)}).run()
    assert discharge_time(normal, pid) == discharge_time(changed, pid) == 4 * 60
    assert "severity" not in changed["patients"][0]
    assert "Initial census retains" in changed["metric_definitions"]["severity_stays"]


def test_disruption_pauses_existing_care_and_arrivals_continue_without_treatment(hospital):
    data, pid = initial_patient(hospital, hours=4)
    trace = model(data, {"disruptions": [disruption(data, 1, 25)]}, arrivals=(2,)).run()
    assert discharge_time(trace, pid) == 28 * 60
    assert any(e["event_type"] == "arrival" and e["elapsed_minutes"] == 120 for e in trace["events"])
    assert not any(
        e["event_type"] in ("admission", "assessment_start", "assessment_end", "discharge")
        and 60 <= e["elapsed_minutes"] < 25 * 60
        for e in trace["events"]
    )
    state = state_at(trace, 12 * 60)
    paused = next(p for p in state["patients"] if p["patient_id"] == pid)
    assert paused["care_paused"]
    assert paused["remaining_stage_spec"] == {"kind": "fixed_minutes", "minutes": 180}
    assert paused["expected_stage_end_at"] is None
    resumed = next(p for p in state_at(trace, 26 * 60)["patients"] if p["patient_id"] == pid)
    assert resumed["remaining_stage_spec"] == {
        "kind": "expected_end",
        "expected_end_at": iso(dt(data["snapshot_at"]) + timedelta(hours=28)),
    }
    assert (
        next(p for p in trace["patients"] if p["patient_id"] == "TEST-ARRIVAL-0")["first_treatment_at"]
        == trace["operations_constraint_periods"][0]["end_at"]
    )
    assert trace["blocker_patient_hours"]["treatment_disruption"] == pytest.approx(23)
    assert sum(row.get("treatment_disruption_hours", 0) for row in trace["daily"]) == 24
    assert "medical_supply_percent" not in trace["series"][0]
    assert "severity" not in trace["patients"][-1]
    assert trace["scalar_metrics"]["patient_conservation_ok"]


def test_overlapping_disruptions_pause_for_union_without_double_counting(hospital):
    data, pid = initial_patient(hospital, hours=4)
    trace = model(data, {"disruptions": [disruption(data, 1, 25), disruption(data, 10, 30, "second")]}).run()
    assert discharge_time(trace, pid) == 33 * 60
    periods = trace["operations_constraint_periods"]
    assert len(periods) == 1
    assert periods[0]["end_elapsed_minutes"] - periods[0]["start_elapsed_minutes"] == 29 * 60
    assert sum(row.get("treatment_disruption_hours", 0) for row in trace["daily"]) == 29


def test_supply_depletion_pauses_clock_and_blocks_new_treatment_until_refill(hospital):
    data, pid = initial_patient(hospital, hours=20)
    trace = model(
        data, {"supplies": supplies(capacity=12, usage_per_patient_day=24)}, days=3, arrivals=(20,)
    ).run()
    # First patient's remaining 8 hours resume at the day-2 refill. The arriving
    # second patient shares usage, consuming stock twice as fast thereafter.
    assert discharge_time(trace, pid) > 32 * 60
    empty = next(e for e in trace["events"] if e["event_type"] == "medical_supplies_depleted")
    assert empty["elapsed_minutes"] == pytest.approx(12 * 60)
    admitted = next(
        e for e in trace["events"] if e["event_type"] == "admission" and e["patient_id"] == "TEST-ARRIVAL-0"
    )
    assert admitted["elapsed_minutes"] == 24 * 60
    assert trace["blocker_patient_hours"]["medical_supplies"] >= 4
    assert all(0 <= row["medical_supply_percent"] <= 100 for row in trace["series"])
    assert all(row["medical_supply_stock"] >= 0 for row in trace["operations_history"])
    assert any(p["reason"] == "medical_supplies" for p in trace["operations_constraint_periods"])
    assert trace["daily"][1]["medical_supply_refilled_units"] == 12
    assert trace["scalar_metrics"]["patient_conservation_ok"]


def test_supply_linear_time_weighted_average_and_pause_occupancy(hospital):
    data, pid = initial_patient(hospital, hours=20)
    trace = model(data, {"supplies": supplies(capacity=12, usage_per_patient_day=24)}, days=2).run()
    assert discharge_time(trace, pid) == 32 * 60
    # Stock 12->0 over first12h, zero12h, refill12, then12->4 over8h,
    # then constant4 for16h: area =72+64+64 =200 stock-unit-hours.
    assert trace["scalar_metrics"]["medical_supply_average_percent"] == pytest.approx(200 / 48 / 12 * 100)
    assert trace["daily"][0]["medical_supply_average_percent"] == pytest.approx(25)
    assert trace["daily"][0]["medical_supplies_shortage_hours"] == 12
    assert next(row for row in trace["series"] if row["elapsed_minutes"] == 18 * 60)["ward_occupied"] == 1
    assert next(row for row in trace["series"] if row["elapsed_minutes"] == 18 * 60)["care_paused"]


def test_refills_add_fraction_of_capacity_and_cap_at_maximum(hospital):
    data = empty_hospital(hospital)
    trace = model(
        data, {"supplies": supplies(initial_percent=20, capacity=10, refill_percent=50)}, days=3
    ).run()
    refills = [e["payload"] for e in trace["events"] if e["event_type"] == "medical_supplies_refilled"]
    assert refills == [{"added_units": 5, "stock_percent": 70}, {"added_units": 3, "stock_percent": 100}]
    assert [day["medical_supply_refilled_units"] for day in trace["daily"]] == [0, 5, 3]
    assert trace["scalar_metrics"]["medical_supply_average_percent"] == pytest.approx((20 + 70 + 100) / 3)


def test_success_score_avoids_horizon_censoring_and_wait_mean_uses_observed_queue_time(hospital):
    data = empty_hospital(hospital)
    trace = model(data, {"disruptions": [disruption(data, 0, 48)]}, days=2, arrivals=(0, 12, 30)).run()
    scalar = trace["scalar_metrics"]
    assert scalar["success_score_percent"] == 0
    assert scalar["success_eligible_patients"] == 2
    assert scalar["success_arrivals_with_insufficient_followup"] == 1
    assert scalar["average_wait_per_patient_hours"] == 34
    assert all(not p.get("first_treatment_at") for p in trace["patients"])


def test_zero_arrivals_remain_unavailable_not_fabricated_zero_or_success(hospital):
    trace = model(empty_hospital(hospital), {"supplies": supplies(initial_percent=50)}).run()
    scalar = trace["scalar_metrics"]
    assert scalar["average_wait_per_patient_hours"] is None
    assert scalar["success_score_percent"] is None
    assert scalar["success_eligible_patients"] == 0
    assert scalar["medical_supply_average_percent"] == pytest.approx((50 + 100 + 100) / 3)
    aggregate = aggregate_results([trace])
    assert "success_score_percent" not in aggregate["scalar_metrics"]
    assert (
        aggregate["scalar_metrics"]["medical_supply_average_percent"]["p50"]
        == scalar["medical_supply_average_percent"]
    )


def test_exact_24h_treatment_is_timely_and_recent_treated_arrivals_are_eligible(hospital):
    data = empty_hospital(hospital)
    trace = model(data, {"disruptions": [disruption(data, 0, 24)]}, days=2, arrivals=(0, 47)).run()
    scalar = trace["scalar_metrics"]
    assert scalar["success_score_percent"] == 100
    assert scalar["success_eligible_patients"] == 2
    assert scalar["success_treated_within_24h"] == 2
    assert scalar["average_wait_per_patient_hours"] == 12


def test_refill_uses_local_calendar_days_across_dst(hospital):
    data = empty_hospital(hospital)
    data["snapshot_at"] = "2026-10-31T05:00:00Z"
    trace = model(data, {"supplies": supplies()}, days=3).run()
    events = [event for event in trace["events"] if event["event_type"] == "medical_supplies_refilled"]
    assert [event["occurred_at"] for event in events] == ["2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z"]
    assert [event["elapsed_minutes"] for event in events] == [24 * 60, 49 * 60]


def test_optional_model_has_same_metrics_with_and_without_replay_storage(hospital):
    data, _ = initial_patient(hospital, hours=20)
    scenario = {
        "horizon_calendar_days": 3,
        "base_seed": 43121,
        "hospital_operations": {
            "severity_mix": mix("medium", 36),
            "supplies": supplies(capacity=20, usage_per_patient_day=24),
            "disruptions": [disruption(data, 5, 29)],
        },
        "conditions": [
            {
                "id": "incident",
                "kind": "arrival_batch",
                "at": iso(dt(data["snapshot_at"]) + timedelta(hours=8)),
                "entry_stream_id": "DIRECT_WARD_MAIN",
                "count": 3,
                "spread_minutes": 0,
            }
        ],
    }
    detailed = run_replication(data, scenario, keep_trace=True)
    compact = run_replication(data, scenario, keep_trace=False)
    assert detailed["scalar_metrics"] == compact["scalar_metrics"]
    assert detailed["daily"] == compact["daily"]
    assert detailed["operations_constraint_periods"] == compact["operations_constraint_periods"]
    assert detailed["bottleneck_evidence"] == compact["bottleneck_evidence"]
    assert compact["scalar_metrics"]["patient_conservation_ok"]
    aggregate = aggregate_results([compact])
    assert aggregate["hospital_operations_model_version"] == "1.1"
    assert aggregate["metric_definitions"] == detailed["metric_definitions"]
    assert any(row["care_paused"]["mean"] == 1 for row in aggregate["series"])
    assert any(row["treatment_disrupted"]["mean"] == 1 for row in aggregate["series"])


@pytest.mark.parametrize("days", [14, 30])
def test_long_horizons_keep_operations_and_edited_arrivals_in_actual_results(hospital, days):
    data = empty_hospital(hospital)
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 6
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 1
    start = dt(data["snapshot_at"])
    last_day = endpoint(start, days - 1, data["timezone"])
    end = endpoint(start, days, data["timezone"])
    scenario = {
        "horizon_calendar_days": days,
        "base_seed": 43121,
        "hospital_operations": {
            "severity_mix": mix("medium", 12),
            "supplies": supplies(capacity=400, usage_per_patient_day=3, refill_every_days=7),
            "disruptions": [disruption(data, 8 * 24, 9 * 24)],
        },
    }
    normal = run_replication(data, scenario)
    edited = run_replication(
        data,
        {
            **scenario,
            "conditions": [
                {
                    "id": "last-day-edited",
                    "kind": "arrival_multiplier",
                    "entry_stream_id": "ED_MAIN",
                    "shape": "step",
                    "control_points": [
                        {"at": iso(last_day), "multiplier": 3},
                        {"at": iso(end), "multiplier": 3},
                    ],
                }
            ],
        },
    )
    arrivals = lambda trace: {
        e["patient_id"]: e["occurred_at"] for e in trace["events"] if e["event_type"] == "arrival"
    }
    normal_arrivals, edited_arrivals = arrivals(normal), arrivals(edited)
    assert normal_arrivals.items() <= edited_arrivals.items()
    assert len(edited_arrivals) > len(normal_arrivals)
    assert all(dt(at) >= last_day for pid, at in edited_arrivals.items() if pid not in normal_arrivals)
    assert len(edited["daily"]) == days
    assert all("medical_supply_average_percent" in day for day in edited["daily"])
    assert edited["daily"][8]["treatment_disruption_hours"] == 24
    assert edited["scalar_metrics"]["patient_conservation_ok"]
    assert 0 <= edited["scalar_metrics"]["medical_supply_average_percent"] <= 100
    assert edited["scalar_metrics"]["arrivals"] == len(edited_arrivals)


def test_combined_constraint_pauses_keep_historical_reasons_exact(hospital):
    data, pid = initial_patient(hospital, hours=20)
    trace = model(
        data, {"supplies": supplies(initial_percent=0), "disruptions": [disruption(data, 5, 10)]}, days=2
    ).run()
    patient = next(p for p in trace["patients"] if p["patient_id"] == pid)
    intervals = [row for row in patient["state_intervals"] if row.get("care_paused")]
    assert any(
        row["care_pause_reasons"] == ["medical_supplies"]
        and row["start_elapsed_minutes"] == 0
        and row["end_elapsed_minutes"] == 300
        for row in intervals
    )
    assert any(
        row["care_pause_reasons"] == ["treatment_disruption", "medical_supplies"]
        and row["start_elapsed_minutes"] == 300
        and row["end_elapsed_minutes"] == 600
        for row in intervals
    )
    assert discharge_time(trace, pid) == 44 * 60


def test_unconfigured_runs_record_generic_outcomes_without_enabling_operations(hospital):
    from types import SimpleNamespace

    data = empty_hospital(hospital)
    counted = model(data, days=2, arrivals=(0, 12, 30))
    unchanged = model(data, days=2, arrivals=(0, 12, 30))
    # The passive recorder can be removed without changing any event or resource
    # trajectory, demonstrating that generic accounting introduces no care model.
    unchanged.arrival_metrics = SimpleNamespace(
        arrival=lambda _: None,
        treatment_started=lambda _: None,
        integrate=lambda _: None,
        finalize=lambda _: None,
    )
    trace, original = counted.run(), unchanged.run()
    assert counted.operations is None
    assert "hospital_operations_model_version" not in trace
    assert "operations_history" not in trace
    assert trace["events"] == original["events"]
    assert trace["daily"] == original["daily"]
    assert trace["unit_series"] == original["unit_series"]
    additive = {
        "average_wait_per_patient_hours",
        "success_score_percent",
        "success_eligible_patients",
        "success_treated_within_24h",
        "success_arrivals_with_insufficient_followup",
    }
    assert {key: value for key, value in trace["scalar_metrics"].items() if key not in additive} == original[
        "scalar_metrics"
    ]
    assert trace["scalar_metrics"]["average_wait_per_patient_hours"] == 0
    assert trace["scalar_metrics"]["success_score_percent"] == 100
    assert trace["scalar_metrics"]["success_eligible_patients"] == 3
    assert "medical_supply_average_percent" not in trace["scalar_metrics"]
    aggregate = aggregate_results([trace])
    assert aggregate["metric_definitions"]["success_score_percent"]
    assert "hospital_operations_model_version" not in aggregate


def test_generic_unconfigured_metrics_match_compact_results_and_censor_untreated_arrivals(hospital):
    data = empty_hospital(hospital)
    # No qualified assignments means no treatment can start, without invoking
    # any of the optional severity, disruption or medical-supply features.
    data["assignments"] = []
    detailed = model(data, days=2, arrivals=(0, 12, 30), keep_trace=True).run()
    compact = model(data, days=2, arrivals=(0, 12, 30), keep_trace=False).run()
    assert detailed["scalar_metrics"] == compact["scalar_metrics"]
    assert detailed["scalar_metrics"]["success_score_percent"] == 0
    assert detailed["scalar_metrics"]["success_eligible_patients"] == 2
    assert detailed["scalar_metrics"]["success_arrivals_with_insufficient_followup"] == 1
    assert detailed["scalar_metrics"]["average_wait_per_patient_hours"] == 34
    assert "hospital_operations_model_version" not in compact
    assert "medical_supply_average_percent" not in compact["scalar_metrics"]


def test_generic_metrics_exclude_initial_queue_and_keep_no_arrivals_unavailable(hospital):
    data = empty_hospital(hospital)
    trace = model(data, days=1).run()
    assert trace["scalar_metrics"]["average_wait_per_patient_hours"] is None
    assert trace["scalar_metrics"]["success_score_percent"] is None
    assert trace["scalar_metrics"]["success_eligible_patients"] == 0
    assert trace["metric_definitions"]["average_wait_per_patient_hours"]
    assert "hospital_operations_model_version" not in trace


def mixed_severities():
    return {
        "low": {"percentage": 68.82, "average_stay_hours": 24},
        "medium": {"percentage": 24.18, "average_stay_hours": 72},
        "high": {"percentage": 7, "average_stay_hours": 168},
    }


def ed_model(hospital, disposition, operations=None, count=12, legacy=False, days=3):
    data = empty_hospital(hospital)
    for path in data["pathway_profiles"]:
        if path["entry_stream_id"] == "ED_MAIN":
            path["ed_disposition_weights"] = disposition
            path["icu_stepdown_probability"] = 1
    scenario = {"horizon_calendar_days": days, "base_seed": 43121}
    if operations:
        scenario["hospital_operations"] = operations
    if legacy:
        scenario["_hospital_operations_model_version"] = "1.0"
    sim = HospitalSimulation(data, scenario, 0, True)
    stream = next(s for s in data["entry_streams"] if s["entry_type"] == "ed")
    for index in range(count):
        sim.schedule(
            index * 60,
            "arrival",
            {"patient_id": f"ED-LEGACY-{index}", "source": "baseline_arrival", "stream": stream},
            2,
        )
    return sim


def test_frozen_model_1_0_reproduces_original_whole_path_trajectory(hospital):
    from surge_engine.common import digest

    # Recorded before the1.1 correction. This protects the actual previously
    # generated trajectory, not merely two executions of the new implementation.
    sim = ed_model(
        hospital,
        {"discharge": 0.5, "ward": 0.3, "icu": 0.2},
        {"severity_mix": mixed_severities()},
        legacy=True,
    )
    trace = sim.run()
    assert trace["hospital_operations_model_version"] == "1.0"
    assert (
        digest(
            {
                key: trace[key]
                for key in (
                    "events",
                    "scalar_metrics",
                    "patients",
                    "series",
                    "daily",
                    "unit_series",
                    "operations_history",
                    "operations_constraint_periods",
                )
            }
        )
        == "978b81e29d6ba19b5d35e7bc84ee86eccc9d6bfc9862ec43807d63334e13ae6f"
    )
    assert "total active care time" in trace["metric_definitions"]["severity_stays"]


def test_severity_does_not_change_ed_only_assessment_clocks_or_routing(hospital):
    normal = ed_model(hospital, {"discharge": 1}).run()
    changed = ed_model(hospital, {"discharge": 1}, {"severity_mix": mix("high", 168)}).run()
    assert normal["events"] == changed["events"]
    assert normal["scalar_metrics"] == changed["scalar_metrics"]
    assert normal["daily"] == changed["daily"]
    for baseline, severity in zip(normal["patients"], changed["patients"]):
        clinical_intervals = [
            {
                key: value
                for key, value in interval.items()
                if key not in {"care_paused", "care_pause_reasons"}
            }
            for interval in severity["state_intervals"]
        ]
        assert baseline["state_intervals"] == clinical_intervals
        assert baseline["sampled_stage_minutes"] == severity["sampled_stage_minutes"]
        assert severity["sampled_inpatient_care_hours"] is None
        assert severity["severity"] == "high"
        assert severity["severity_average_inpatient_stay_hours"] == 168
        assert "sampled_total_care_hours" not in severity


def test_severity_scales_inpatient_and_stepdown_but_preserves_assessment_and_pathway(hospital):
    baseline = ed_model(hospital, {"icu": 1}, count=1)
    changed = ed_model(hospital, {"icu": 1}, {"severity_mix": mix("high", 24)}, count=1)
    # Run arrival/allocation through the real engine; inspect sampled future
    # clocks before bed admission can replace the currently displayed stage.
    for sim in (baseline, changed):
        sim.env.process(sim.process())
        sim.env.run(until=1)
    original = baseline.patients["ED-LEGACY-0"]
    patient = changed.patients["ED-LEGACY-0"]
    assert patient["_assessment_duration"] == original["_assessment_duration"]
    assert patient["_service_end"] == original["_service_end"]
    for key in (
        "_outcome",
        "_cohort",
        "_inpatient_profile_id",
        "_inpatient_requirements",
        "_stepdown_selected",
        "_stepdown_cohort",
        "_stepdown_profile",
    ):
        assert patient[key] == original[key]
    assert patient["_stepdown_selected"]
    assert patient["_inpatient_duration"] / patient["_stepdown_duration"] == pytest.approx(
        original["_inpatient_duration"] / original["_stepdown_duration"]
    )
    assert patient["_inpatient_duration"] + patient["_stepdown_duration"] == pytest.approx(
        patient["sampled_inpatient_care_hours"] * 60
    )
    assert patient["_inpatient_duration"] != original["_inpatient_duration"]


def test_corrected_severity_does_not_manufacture_an_ed_queue_in_a_roomy_hospital(hospital):
    data = empty_hospital(hospital)
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 100
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    for path in data["pathway_profiles"]:
        if path["entry_stream_id"] == "ED_MAIN":
            path["ed_disposition_weights"] = {"discharge": 1}
    scenario = {"horizon_calendar_days": 14, "base_seed": 43121}
    original = run_replication(data, scenario)
    corrected = run_replication(
        data, {**scenario, "hospital_operations": {"severity_mix": mixed_severities()}}
    )
    assert corrected["scalar_metrics"] == original["scalar_metrics"]
    assert corrected["events"] == original["events"]
    assert corrected["scalar_metrics"]["average_wait_per_patient_hours"] < 0.1
    assert corrected["scalar_metrics"]["success_score_percent"] == 100
    assert corrected["scalar_metrics"]["patient_conservation_ok"]


def test_corrected_inpatient_severity_still_pauses_for_disruption(hospital):
    data = empty_hospital(hospital)
    baseline = model(data, {"severity_mix": mix("medium", 12)}, days=3, arrivals=(0,)).run()
    end = 8
    paused = model(
        data,
        {"severity_mix": mix("medium", 12), "disruptions": [disruption(data, 0, end)]},
        days=3,
        arrivals=(0,),
    ).run()
    original_patient, paused_patient = baseline["patients"][0], paused["patients"][0]
    assert original_patient["sampled_inpatient_care_hours"] == paused_patient["sampled_inpatient_care_hours"]
    assert (
        discharge_time(paused, paused_patient["patient_id"])
        - discharge_time(baseline, original_patient["patient_id"])
        == end * 60
    )
    assert paused["scalar_metrics"]["average_wait_per_patient_hours"] == end
    assert paused["scalar_metrics"]["patient_conservation_ok"]
