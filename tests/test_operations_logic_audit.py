"""Adversarial operations audit using isolated generated hospital fixtures.

These assertions reconstruct outcomes from public event/interval ledgers rather
than trusting the summary counters being tested. No production state is used.
"""

import copy
from collections import Counter
from datetime import timedelta

import pytest
from surge_engine import generate_dataset, state_at
from surge_engine.common import digest, dt, iso
from surge_engine.hospital_operations import OPERATIONS_MODEL_VERSION
from surge_engine.simulation import HospitalSimulation
from test_hospital_operations import (
    discharge_time,
    disruption,
    empty_hospital,
    initial_patient,
    supplies,
)


@pytest.fixture(scope="module")
def hospital():
    return generate_dataset("hospital_baseline", days=35)


def execute_with_version(data, operations, version, days=2):
    return HospitalSimulation(
        data,
        {
            "horizon_calendar_days": days,
            "base_seed": 43121,
            "hospital_operations": operations,
            "_hospital_operations_model_version": version,
        },
        0,
        True,
    ).run()


@pytest.mark.parametrize("version", ["1.0", "1.1", "1.2"])
@pytest.mark.parametrize("constraint", ["supplies", "disruption"])
def test_exact_completion_boundary_has_no_remaining_care_to_pause(hospital, version, constraint):
    data, pid = initial_patient(hospital, hours=12)
    operations = (
        {"supplies": supplies(capacity=12, usage_per_patient_day=24)}
        if constraint == "supplies"
        else {"disruptions": [disruption(data, 12, 24)]}
    )
    trace = execute_with_version(data, operations, version)
    assert discharge_time(trace, pid) == (12 if version == "1.2" else 24) * 60
    assert trace["hospital_operations_model_version"] == version
    intervals = next(p for p in trace["patients"] if p["patient_id"] == pid)["state_intervals"]
    zero_pauses = [
        row for row in intervals if row.get("care_paused") and row["remaining_stage_spec"]["minutes"] == 0
    ]
    assert bool(zero_pauses) == (version != "1.2")
    assert trace["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize("constraint", ["supplies", "disruption"])
@pytest.mark.parametrize("hours", [11.999, 12.001])
def test_completion_just_before_or_after_shortage_boundary(hospital, constraint, hours):
    data, pid = initial_patient(hospital, hours=hours)
    operations = (
        {"supplies": supplies(capacity=12, usage_per_patient_day=24)}
        if constraint == "supplies"
        else {"disruptions": [disruption(data, 12, 24)]}
    )
    trace = execute_with_version(data, operations, "1.2")
    expected = hours if hours < 12 else hours + 12
    assert discharge_time(trace, pid) == pytest.approx(expected * 60)
    if hours > 12:
        paused = next(p for p in state_at(trace, 18 * 60)["patients"] if p["patient_id"] == pid)
        assert paused["remaining_stage_spec"]["minutes"] == pytest.approx(0.001 * 60)


def one_bed_queue(hospital, operations):
    data = empty_hospital(hospital)
    ward_templates = {
        cohort["los_template_id"] for cohort in data["cohorts"] if cohort["care_level"] == "ward"
    }
    for template in data["los_templates"]:
        if template["template_id"] in ward_templates:
            template.update(family="fixed", fixed_minutes=12 * 60)
    conditions = [
        {
            "kind": "unit_configuration",
            "unit_id": unit["unit_id"],
            "enabled_capacity": 1 if unit["unit_id"] == "UNIT-WARD-A" else 0,
            "staffed_capacity": 1 if unit["unit_id"] == "UNIT-WARD-A" else 0,
            "staff_counts": {"rn": 1, "provider": 1, "support": 1},
        }
        for unit in data["units"]
        if unit["kind"] == "ward"
    ]
    sim = HospitalSimulation(
        data,
        {
            "horizon_calendar_days": 3,
            "base_seed": 43121,
            "conditions": conditions,
            "hospital_operations": operations,
        },
        0,
        True,
    )
    stream = next(s for s in data["entry_streams"] if s["entry_type"] == "direct_ward")
    for index, hour in enumerate((0, 2, 14)):
        sim.schedule(
            hour * 60,
            "arrival",
            {"patient_id": f"QUEUE-AUDIT-{index}", "source": "baseline_arrival", "stream": stream},
            2,
        )
    return sim.run()


@pytest.mark.parametrize("constraint", ["supplies", "disruption", "overlap"])
def test_new_patient_completion_releases_bed_but_cannot_start_queued_care_while_blocked(hospital, constraint):
    operations = {}
    if constraint in ("supplies", "overlap"):
        operations["supplies"] = supplies(capacity=12, usage_per_patient_day=24)
    if constraint in ("disruption", "overlap"):
        operations["disruptions"] = [disruption(hospital, 12, 24)]
    trace = one_bed_queue(hospital, operations)
    assert discharge_time(trace, "QUEUE-AUDIT-0") == 12 * 60
    starts = [event for event in trace["events"] if event["event_type"] == "admission"]
    assert [event["elapsed_minutes"] for event in starts[:2]] == [0, 24 * 60]
    assert not any(12 * 60 <= event["elapsed_minutes"] < 24 * 60 for event in starts)
    state = state_at(trace, 20 * 60)
    ward = next(unit for unit in state["units"] if unit["unit_id"] == "UNIT-WARD-A")
    assert ward["occupied"] == 0 and ward["available"] == 1
    assert sum(patient.get("admission_pending", False) for patient in state["patients"]) == 2
    assert trace["scalar_metrics"]["patient_conservation_ok"]
    if constraint in ("supplies", "overlap"):
        assert [discharge_time(trace, f"QUEUE-AUDIT-{i}") for i in range(3)] == [12 * 60, 36 * 60, 60 * 60]
        assert trace["daily"][0]["medical_supply_consumed_units"] == pytest.approx(12)


def actual_care_minutes(trace):
    """Actual unpaused stage intervals, excluding boarding and completed ICU waits."""
    return sum(
        row["end_elapsed_minutes"] - row["start_elapsed_minutes"]
        for patient in trace["patients"]
        for row in patient["state_intervals"]
        if row["state"] in {"inpatient", "ed_assessment", "clinic_assessment"}
        and row.get("stage_status") == "in_service"
        and not row.get("care_paused")
    )


def assert_ledger_invariants(trace, dataset, usage):
    metrics = trace["scalar_metrics"]
    assert metrics["patient_conservation_ok"]
    arrivals = [event for event in trace["events"] if event["event_type"] == "arrival"]
    discharges = [event for event in trace["events"] if event["event_type"] == "discharge"]
    initial = len(dataset["patients"])
    assert initial + len(arrivals) == metrics["active_at_horizon"] + len(discharges)
    for row in trace["series"]:
        minute = row["elapsed_minutes"]
        patients = state_at(trace, minute)["patients"]
        assert initial + sum(event["elapsed_minutes"] <= minute for event in arrivals) == len(patients) + sum(
            event["elapsed_minutes"] <= minute for event in discharges
        )
        per_unit = Counter(patient.get("unit_id") for patient in patients if patient.get("unit_id"))
        for unit in row["units"]:
            assert unit["modeled_occupied"] == per_unit[unit["unit_id"]]
            assert unit["occupied"] + unit["reserved"] <= unit["physical"]
            assert unit["occupied"] + unit["reserved"] <= unit["staffed"]
            assert all(
                equipment["deficit"] == 0 and equipment["available"] >= 0
                for equipment in unit["equipment"].values()
            )
        assert 0 <= row["medical_supply_percent"] <= 100
    consumed = sum(day["medical_supply_consumed_units"] for day in trace["daily"])
    assert consumed == pytest.approx(actual_care_minutes(trace) / 1440 * usage)
    initial_stock = trace["operations_history"][0]["medical_supply_stock"]
    refilled = sum(
        event["payload"]["added_units"]
        for event in trace["events"]
        if event["event_type"] == "medical_supplies_refilled"
    )
    assert trace["operations_history"][-1]["medical_supply_stock"] == pytest.approx(
        initial_stock + refilled - consumed, abs=1e-7
    )
    daily_minutes = [(dt(day["end_at"]) - dt(day["start_at"])).total_seconds() / 60 for day in trace["daily"]]
    assert metrics["medical_supply_average_percent"] == pytest.approx(
        sum(
            day["medical_supply_average_percent"] * minutes
            for day, minutes in zip(trace["daily"], daily_minutes)
        )
        / sum(daily_minutes)
    )
    waiting = sum(
        row["end_elapsed_minutes"] - row["start_elapsed_minutes"]
        for patient in trace["patients"]
        if patient["patient_id"] in {event["patient_id"] for event in arrivals}
        for row in patient["state_intervals"]
        if row.get("admission_pending") or row["state"] == "ed_waiting"
    )
    assert metrics["average_wait_per_patient_hours"] == pytest.approx(waiting / 60 / len(arrivals))
    first_care = {}
    for event in trace["events"]:
        if event["event_type"] in {"assessment_start", "clinic_start", "admission"}:
            first_care.setdefault(event["patient_id"], event["elapsed_minutes"])
    eligible = [
        event
        for event in arrivals
        if event["patient_id"] in first_care
        or trace["horizon_elapsed_minutes"] - event["elapsed_minutes"] >= 1440
    ]
    timely = sum(
        event["patient_id"] in first_care
        and first_care[event["patient_id"]] - event["elapsed_minutes"] <= 1440
        for event in eligible
    )
    assert metrics["success_score_percent"] == pytest.approx(100 * timely / len(eligible))


@pytest.mark.parametrize("days", [7, 14, 30])
@pytest.mark.parametrize("stock_mode", ["ample", "scarce"])
def test_horizon_matrix_conserves_patients_resources_stock_and_exact_metric_definitions(
    hospital, days, stock_mode
):
    data = copy.deepcopy(hospital)
    data["patients"] = [
        copy.deepcopy(patient) for patient in hospital["patients"] if patient["state"] == "inpatient"
    ][:4]
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 10
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 2
    supply = (
        supplies(capacity=10000, usage_per_patient_day=1, refill_every_days=7, refill_percent=70)
        if stock_mode == "ample"
        else supplies(initial_percent=30, capacity=10, usage_per_patient_day=24, refill_percent=50)
    )
    operations = {
        "severity_mix": {
            "low": {"percentage": 60, "average_stay_hours": 12},
            "medium": {"percentage": 30, "average_stay_hours": 36},
            "high": {"percentage": 10, "average_stay_hours": 72},
        },
        "supplies": supply,
        "disruptions": [disruption(data, 48, 72), disruption(data, 60, 84, "overlapping")],
    }
    original = digest(data)
    trace = HospitalSimulation(
        data, {"horizon_calendar_days": days, "base_seed": 43121, "hospital_operations": operations}, 0, True
    ).run()
    assert digest(data) == original
    assert trace["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    assert_ledger_invariants(trace, data, supply["usage_per_patient_day"])
    assert sum(day["treatment_disruption_hours"] for day in trace["daily"]) == 36
    for event in trace["events"]:
        if event["event_type"] in {"admission", "assessment_start", "clinic_start"}:
            assert not 48 * 60 <= event["elapsed_minutes"] < 84 * 60
        elif event["event_type"] in {"discharge", "assessment_end"}:
            assert not 48 * 60 < event["elapsed_minutes"] < 84 * 60
    if stock_mode == "scarce":
        assert sum(day["medical_supplies_shortage_hours"] for day in trace["daily"]) > 0
    else:
        assert sum(day["medical_supplies_shortage_hours"] for day in trace["daily"]) == 0
    if days == 30:
        assert trace["horizon_elapsed_minutes"] == 721 * 60


def schedule_direct(sim, data, arrivals=(0,)):
    stream = next(s for s in data["entry_streams"] if s["entry_type"] == "direct_ward")
    for index, hour in enumerate(arrivals):
        sim.schedule(
            hour * 60,
            "arrival",
            {"patient_id": f"RESOURCE-AUDIT-{index}", "source": "baseline_arrival", "stream": stream},
            2,
        )


@pytest.mark.parametrize("missing", ["beds", "rn", "provider", "support", "medical_supplies"])
def test_resource_gate_rejects_new_care_without_fabricating_treatment_or_success(hospital, missing):
    data = empty_hospital(hospital)
    conditions = []
    for unit in data["units"]:
        if unit["kind"] != "ward":
            continue
        conditions.append(
            {
                "kind": "unit_configuration",
                "unit_id": unit["unit_id"],
                "enabled_capacity": 0 if missing == "beds" else 10,
                "staffed_capacity": 0 if missing == "beds" else 10,
                "staff_counts": {
                    "rn": 0 if missing == "rn" else 10,
                    "provider": 0 if missing == "provider" else 1,
                    "support": 0 if missing == "support" else 1,
                },
            }
        )
    operations = (
        {"supplies": supplies(initial_percent=0, refill_percent=0)} if missing == "medical_supplies" else None
    )
    scenario = {"horizon_calendar_days": 1, "base_seed": 43121, "conditions": conditions}
    if operations:
        scenario["hospital_operations"] = operations
    sim = HospitalSimulation(data, scenario, 0, True)
    schedule_direct(sim, data)
    trace = sim.run()
    assert not any(
        event["event_type"] in {"admission", "assessment_start", "clinic_start", "discharge"}
        for event in trace["events"]
    )
    assert trace["scalar_metrics"]["average_wait_per_patient_hours"] == 24
    assert trace["scalar_metrics"]["success_score_percent"] == 0
    assert trace["scalar_metrics"]["success_eligible_patients"] == 1
    assert trace["scalar_metrics"]["unserved_at_horizon"] == 1
    reason = {
        "beds": "no_matching_physical_place",
        "rn": "nursing_capacity",
        "provider": "minimum_operating_team",
        "support": "minimum_operating_team",
        "medical_supplies": "medical_supplies",
    }[missing]
    assert trace["blocker_patient_hours"][reason] == 24
    named = trace["bottleneck_evidence"]["resources"]
    if missing in {"rn", "provider", "support"}:
        assert any(row["kind"] == "staff" and row["code"] == missing for row in named)
    assert trace["scalar_metrics"]["patient_conservation_ok"]


def test_required_equipment_recovery_unblocks_real_admission_and_records_queue_exposure(hospital):
    data = empty_hospital(hospital)
    direct = next(s for s in data["entry_streams"] if s["entry_type"] == "direct_ward")
    direct["resource_profile_mix"] = {"ward": {"RP-WARD-OXYGEN": 1}}
    for pool in data["equipment_pools"]:
        if pool["capability_code"] == "WARD_OXYGEN":
            pool["quantity"] = 0
    start = dt(data["snapshot_at"])
    scenario = {
        "horizon_calendar_days": 1,
        "base_seed": 43121,
        "updates": [
            {
                "update_id": "RESTORE-OXYGEN",
                "idempotency_key": "RESTORE-OXYGEN",
                "type": "equipment_change",
                "effective_at": iso(start + timedelta(hours=6)),
                "payload": {"equipment_pool_id": "EQ-WARD-O2-A", "operation": "add", "quantity": 1},
            }
        ],
    }
    sim = HospitalSimulation(data, scenario, 0, True)
    schedule_direct(sim, data)
    trace = sim.run()
    first_admission = next(event for event in trace["events"] if event["event_type"] == "admission")
    assert first_admission["elapsed_minutes"] == 6 * 60
    assert trace["scalar_metrics"]["average_wait_per_patient_hours"] == 6
    assert trace["blocker_patient_hours"]["required_equipment_unavailable"] == 6
    assert trace["scalar_metrics"]["patient_conservation_ok"]
    assert all(
        pool["available"] >= 0 and pool["deficit"] == 0
        for row in trace["series"]
        for unit in row["units"]
        for pool in unit["equipment"].values()
    )


@pytest.mark.parametrize(("days", "seed"), [(7, 101), (14, 202), (30, 303)])
def test_independent_severity_extremes_change_bed_care_without_rerolling_patients(hospital, days, seed):
    data = empty_hospital(hospital)
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 12
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 3
    models, traces = [], []
    for selected, mean in (("low", 12), ("high", 72)):
        mix = {
            severity: {"percentage": 100 if severity == selected else 0, "average_stay_hours": mean}
            for severity in ("low", "medium", "high")
        }
        sim = HospitalSimulation(
            data,
            {
                "horizon_calendar_days": days,
                "base_seed": seed,
                "hospital_operations": {
                    "severity_mix": mix,
                    "supplies": supplies(capacity=1_000_000, usage_per_patient_day=1, refill_every_days=365),
                },
            },
            0,
            True,
        )
        traces.append(sim.run())
        models.append(sim)
    baseline, changed = traces
    arrivals = lambda trace: [
        (event["patient_id"], event["occurred_at"], event["payload"])
        for event in trace["events"]
        if event["event_type"] == "arrival"
    ]
    assert arrivals(baseline) == arrivals(changed)
    for pid, original in models[0].patients.items():
        patient = models[1].patients[pid]
        for key in (
            "_outcome",
            "_assessment_duration",
            "_ed_profile_id",
            "_inpatient_profile_id",
            "_stepdown_selected",
        ):
            assert patient.get(key) == original.get(key)
        if original.get("sampled_inpatient_care_hours") is not None:
            assert patient["sampled_inpatient_care_hours"] == pytest.approx(
                original["sampled_inpatient_care_hours"] * 6
            )
    occupied_hours = lambda trace: sum(
        row["ward_occupied_hours"] + row["icu_occupied_hours"] for row in trace["daily"]
    )
    assert occupied_hours(changed) > occupied_hours(baseline)
    assert (
        changed["scalar_metrics"]["medical_supply_average_percent"]
        < baseline["scalar_metrics"]["medical_supply_average_percent"]
    )
    for trace in traces:
        assert_ledger_invariants(trace, data, usage=1)
