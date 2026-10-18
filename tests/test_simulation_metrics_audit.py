"""Independent downstream audit using real engine trajectories and API projections.

Oracles read patient/event timelines, not the metrics recorder or aggregation
helpers under test. Everything runs locally against generated data; no saved
application scenarios, database, or production service is modified.
"""

from __future__ import annotations

import copy
import json
from collections import defaultdict
from datetime import timedelta
from functools import lru_cache
from itertools import pairwise
from statistics import mean, median
from zoneinfo import ZoneInfo

import pytest
from surge_api.bottlenecks import ensemble_bottlenecks
from surge_api.comparisons import paired_summary, rank_plans
from surge_engine import aggregate_results, generate_dataset
from surge_engine.common import dt, iso
from surge_engine.simulation import HospitalSimulation


@lru_cache(maxsize=1)
def source():
    return generate_dataset("hospital_baseline", days=35)


def supplies(**changes):
    return {
        "initial_percent": 100,
        "capacity": 12,
        "usage_per_patient_day": 24,
        "refill_every_days": 1,
        "refill_percent": 100,
        **changes,
    }


def pause(data, begin, end, identity="pause"):
    start = dt(data["snapshot_at"])
    return {
        "id": identity,
        "start_at": iso(start + timedelta(hours=begin)),
        "end_at": iso(start + timedelta(hours=end)),
    }


def oracle_access(trace, scenario):
    """Integrate each new patient's recorded queue intervals and first-care event."""
    lower = (
        dt(scenario.get("measurement_start_at") or trace["start_at"]) - dt(trace["start_at"])
    ).total_seconds() / 60
    upper = trace["horizon_elapsed_minutes"]
    arrivals = {
        row["patient_id"]: row["elapsed_minutes"]
        for row in trace["events"]
        if row["event_type"] == "arrival" and row["elapsed_minutes"] >= lower
    }
    first_care = {}
    for row in trace["events"]:
        if row.get("patient_id") in arrivals and row["event_type"] in {"assessment_start", "admission"}:
            first_care.setdefault(row["patient_id"], row["elapsed_minutes"])
    waiting_minutes = 0
    unfinished_wait_minutes = 0
    for patient in trace["patients"]:
        if patient["patient_id"] not in arrivals:
            continue
        for interval in patient["state_intervals"]:
            if interval["state"] not in {"ed_waiting", "ed_boarding", "direct_waiting"}:
                continue
            begin = max(lower, arrivals[patient["patient_id"]], interval["start_elapsed_minutes"])
            end = min(upper, interval.get("end_elapsed_minutes", upper))
            duration = max(0, end - begin)
            waiting_minutes += duration
            if end == upper and duration:
                unfinished_wait_minutes += duration
    eligible = [pid for pid, at in arrivals.items() if pid in first_care or upper - at >= 24 * 60]
    timely = [pid for pid in eligible if pid in first_care and first_care[pid] - arrivals[pid] <= 24 * 60]
    return {
        "average_wait_per_patient_hours": waiting_minutes / 60 / len(arrivals) if arrivals else None,
        "success_score_percent": 100 * len(timely) / len(eligible) if eligible else None,
        "success_eligible_patients": len(eligible),
        "success_treated_within_24h": len(timely),
        "success_arrivals_with_insufficient_followup": len(arrivals) - len(eligible),
        "unfinished_waiting_hours": unfinished_wait_minutes / 60,
        "arrivals": len(arrivals),
    }


def oracle_queue_hours(trace, states):
    """Sum time spent in recorded queues, including starting census and censoring."""
    lower = (dt(trace["bottleneck_evidence"]["start_at"]) - dt(trace["start_at"])).total_seconds() / 60
    horizon = trace["horizon_elapsed_minutes"]
    return sum(
        max(
            0,
            min(horizon, interval.get("end_elapsed_minutes", horizon))
            - max(lower, interval["start_elapsed_minutes"]),
        )
        / 60
        for patient in trace["patients"]
        for interval in patient["state_intervals"]
        if interval["state"] in states
    )


def oracle_constraint_hours(trace):
    """Intersect each queued person's intervals with broad recorded blocker history."""
    lower = (dt(trace["bottleneck_evidence"]["start_at"]) - dt(trace["start_at"])).total_seconds() / 60
    horizon = trace["horizon_elapsed_minutes"]
    result = defaultdict(float)
    union = 0.0
    for patient in trace["patients"]:
        for interval in patient["state_intervals"]:
            if interval["state"] not in {"ed_waiting", "ed_boarding", "direct_waiting"}:
                continue
            begin, end = (
                max(lower, interval["start_elapsed_minutes"]),
                min(horizon, interval.get("end_elapsed_minutes", horizon)),
            )
            history = trace["blocker_history"].get(interval.get("queue_group"), [])
            covered = 0
            for index, blocker in enumerate(history):
                stop = history[index + 1]["start_elapsed_minutes"] if index + 1 < len(history) else horizon
                minutes = max(0, min(end, stop) - max(begin, blocker["start_elapsed_minutes"]))
                if blocker.get("reasons"):
                    covered += minutes
                for reason in set(blocker.get("reasons", [])):
                    result[reason] += minutes / 60
            union += covered / 60
    return dict(result), union


def oracle_supplies(trace, dataset, scenario):
    """Reconstruct stock from active care intervals and calendar refill rules.

    Does not read recorded stock levels, supply averages, or the operations
    controller. Piecewise care counts determine consumption and exact areas.
    """
    config = scenario.get("hospital_operations", {}).get("supplies")
    if not config:
        return None
    start = dt(trace["start_at"])
    horizon = trace["horizon_elapsed_minutes"]
    local_start = start.astimezone(ZoneInfo(dataset["timezone"]))
    boundaries = [
        (local_start + timedelta(days=day)).astimezone(start.tzinfo)
        for day in range(scenario["horizon_calendar_days"] + 1)
    ]
    minutes = [(point - start).total_seconds() / 60 for point in boundaries]
    assert minutes[-1] == horizon
    assert [(row["start_at"], row["end_at"]) for row in trace["daily"]] == [
        (iso(a), iso(b)) for a, b in pairwise(boundaries)
    ]
    refills = {
        minutes[day]
        for day in range(config["refill_every_days"], len(minutes) - 1, config["refill_every_days"])
    }
    care = []
    for patient in trace["patients"]:
        for interval in patient["state_intervals"]:
            if interval["state"] in {"inpatient", "ed_assessment", "clinic_assessment"} and not interval.get(
                "care_paused"
            ):
                care.append((interval["start_elapsed_minutes"], interval.get("end_elapsed_minutes", horizon)))
    points = sorted(
        set(minutes) | refills | {max(0, min(horizon, point)) for interval in care for point in interval}
    )
    stock = config["capacity"] * config["initial_percent"] / 100
    area = [0.0] * scenario["horizon_calendar_days"]
    refill_amounts = []
    for begin, end in pairwise(points):
        if begin in refills:
            added = min(config["capacity"] - stock, config["capacity"] * config["refill_percent"] / 100)
            stock += added
            refill_amounts.append((begin, added))
        midpoint = (begin + end) / 2
        active = sum(a <= midpoint < b for a, b in care)
        consumed = active * config["usage_per_patient_day"] * (end - begin) / 1440
        ending = stock - consumed
        assert ending >= -1e-6, "Recorded active care cannot consume unavailable supply stock"
        ending = max(0, ending)
        day = next(day for day in range(len(minutes) - 1) if minutes[day] <= midpoint < minutes[day + 1])
        area[day] += (stock + ending) / 2 * (end - begin) / config["capacity"] * 100
        stock = ending
    return {
        "average": sum(area) / horizon,
        "daily": [value / (b - a) for value, a, b in zip(area, minutes, minutes[1:])],
        "refills": refill_amounts,
        "hours_per_day": [(b - a) / 60 for a, b in pairwise(minutes)],
    }


CASES = (
    "quiet",
    "no_arrivals_initial",
    "staff_blocked",
    "overlapping_disruptions",
    "equipment_icu",
    "supplies",
    "supplies_dst",
    "supply_and_disruption",
)


def run_case(name, index=0):
    data = copy.deepcopy(source())
    data["patients"] = []
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
    scenario = {
        "id": f"audit-{name}",
        "name": f"Audit {name}",
        "dataset_version_id": data["dataset_version_id"],
        "start_at": data["snapshot_at"],
        "timezone": data["timezone"],
        "horizon_calendar_days": 2,
        "base_seed": 43121,
        "replications": 3,
        "conditions": [],
        "interventions": [],
    }
    arrivals = [("ed", 0), ("direct_ward", 6), ("ed", 30), ("direct_ward", 47)]
    if name == "no_arrivals_initial":
        data["patients"] = copy.deepcopy(source()["patients"])
        arrivals = []
    elif name == "staff_blocked":
        data["assignments"] = []
    elif name == "overlapping_disruptions":
        scenario["hospital_operations"] = {
            "disruptions": [pause(data, 0, 30), pause(data, 12, 40, "overlap")]
        }
    elif name == "equipment_icu":
        arrivals = [("ed", 0), ("ed", 2), ("ed", 4)]
        for path in data["pathway_profiles"]:
            if path["entry_stream_id"] == "ED_MAIN":
                path["ed_disposition_weights"] = {"icu": 1}
        for pool in data["equipment_pools"]:
            if pool["unit_id"] == "UNIT-ICU":
                pool["quantity"] = 0
    elif name in {"supplies", "supplies_dst"}:
        patient = copy.deepcopy(
            next(p for p in source()["patients"] if p["state"] == "inpatient" and p["care_level"] == "ward")
        )
        patient["remaining_stage_spec"] = {
            "kind": "fixed_minutes",
            "minutes": (40 if name == "supplies_dst" else 20) * 60,
        }
        data["patients"] = [patient]
        arrivals = []
        if name == "supplies_dst":
            data["snapshot_at"] = scenario["start_at"] = "2026-10-31T05:00:00Z"
            scenario["horizon_calendar_days"] = 3
        scenario["hospital_operations"] = {
            "supplies": supplies(initial_percent=50, capacity=24, refill_percent=50)
            if name == "supplies_dst"
            else supplies()
        }
    elif name == "supply_and_disruption":
        scenario["hospital_operations"] = {
            "supplies": supplies(initial_percent=0, capacity=100, usage_per_patient_day=2),
            "disruptions": [pause(data, 20, 30)],
        }
    sim = HospitalSimulation(data, scenario, index, True)
    for number, (entry_type, hour) in enumerate(arrivals):
        stream = next(s for s in data["entry_streams"] if s["entry_type"] == entry_type)
        sim.schedule(
            hour * 60,
            "arrival",
            {"patient_id": f"AUDIT-{name}-{number}", "source": "baseline_arrival", "stream": stream},
            2,
        )
    return data, scenario, sim.run()


@pytest.fixture(scope="module")
def actual_cases():
    return {name: [run_case(name, index) for index in range(3)] for name in CASES}


@pytest.mark.parametrize("name", CASES)
def test_access_metrics_match_independent_patient_timeline_oracle(actual_cases, name):
    for _data, scenario, trace in actual_cases[name]:
        expected = oracle_access(trace, scenario)
        for key in (
            "average_wait_per_patient_hours",
            "success_score_percent",
            "success_eligible_patients",
            "success_treated_within_24h",
            "success_arrivals_with_insufficient_followup",
            "arrivals",
        ):
            actual = trace["scalar_metrics"][key]
            assert actual is None if expected[key] is None else actual == pytest.approx(expected[key])
        assert trace["scalar_metrics"]["patient_conservation_ok"]


@pytest.mark.parametrize("name", CASES)
def test_queue_burdens_and_patient_accounting_follow_recorded_timelines(actual_cases, name):
    for data, _scenario, trace in actual_cases[name]:
        scalar = trace["scalar_metrics"]
        assert scalar["inpatient_waiting_patient_hours"] == pytest.approx(
            oracle_queue_hours(trace, {"direct_waiting", "ed_boarding"})
        )
        assert scalar["ed_waiting_patient_hours"] == pytest.approx(oracle_queue_hours(trace, {"ed_waiting"}))
        arrivals = sum(row["event_type"] == "arrival" for row in trace["events"])
        discharges = sum(row["event_type"] == "discharge" for row in trace["events"])
        active = sum(patient["state"] != "discharged" for patient in trace["patients"])
        assert len(data["patients"]) + arrivals == active + discharges
        assert scalar["active_at_horizon"] == active
        assert scalar["discharges"] == discharges
        assert scalar["initial_patients"] == len(data["patients"])


@pytest.mark.parametrize("name", CASES)
def test_constraint_burdens_match_independent_patient_blocker_intersections(actual_cases, name):
    for _data, _scenario, trace in actual_cases[name]:
        expected, union = oracle_constraint_hours(trace)
        actual = {row["reason"]: row["patient_hours"] for row in trace["bottleneck_evidence"]["categories"]}
        assert actual == pytest.approx({reason: value for reason, value in expected.items() if value > 0})
        assert all(value <= union + 1e-8 for value in actual.values())
        assert trace["bottleneck_evidence"]["non_additive"]


@pytest.mark.parametrize("name", ["supplies", "supplies_dst", "supply_and_disruption"])
def test_stock_percentages_follow_care_consumption_and_calendar_refills(actual_cases, name):
    for data, scenario, trace in actual_cases[name]:
        expected = oracle_supplies(trace, data, scenario)
        assert trace["scalar_metrics"]["medical_supply_average_percent"] == pytest.approx(expected["average"])
        assert [row["medical_supply_average_percent"] for row in trace["daily"]] == pytest.approx(
            expected["daily"]
        )
        events = [row for row in trace["events"] if row["event_type"] == "medical_supplies_refilled"]
        assert [(row["elapsed_minutes"], row["payload"]["added_units"]) for row in events] == pytest.approx(
            expected["refills"]
        )
        assert all(0 <= percentage <= 100 for percentage in expected["daily"])
    if name == "supplies_dst":
        assert expected["hours_per_day"] == [24, 25, 24]
        assert expected["refills"][1][0] == 49 * 60


@pytest.mark.parametrize("name", CASES)
def test_ensemble_and_api_project_independently_calculated_scalar_medians_and_first_source(
    actual_cases, name
):
    traces = [trace for _, _, trace in actual_cases[name]]
    scenario = actual_cases[name][0][1]
    aggregate = aggregate_results(traces, scenario)
    expected = [oracle_access(trace, scenario) for trace in traces]
    for key in ("average_wait_per_patient_hours", "success_score_percent"):
        values = [row[key] for row in expected if row[key] is not None]
        if values:
            assert aggregate["scalar_metrics"][key]["p50"] == pytest.approx(median(values))
            assert aggregate["scalar_metrics"][key]["mean"] == pytest.approx(mean(values))
        else:
            assert key not in aggregate["scalar_metrics"]
    evidence = ensemble_bottlenecks(traces, f"audit-{name}")
    assert evidence["evidence_available"]
    for row in evidence["categories"]:
        originals = [
            (trace["replication_index"], match)
            for trace in traces
            for match in trace["bottleneck_evidence"]["categories"]
            if match["reason"] == row["reason"]
        ]
        actual_index, earliest = min(originals, key=lambda item: (item[1]["first_at"], item[0]))
        assert row["first_at"] == earliest["first_at"]
        assert row["first_replication_id"] == f"audit-{name}_rep_{actual_index:04d}"
        samples = [
            next(
                (
                    item["patient_hours"]
                    for item in trace["bottleneck_evidence"]["categories"]
                    if item["reason"] == row["reason"]
                ),
                0,
            )
            for trace in traces
        ]
        assert row["patient_hours"]["mean"] == pytest.approx(mean(samples))
        assert row["patient_hours"]["p50"] == pytest.approx(median(samples))


def test_overlap_is_not_a_partition_and_equipment_does_not_become_a_nurse_shortage(actual_cases):
    trace = actual_cases["staff_blocked"][0][2]
    values, union = oracle_constraint_hours(trace)
    assert len(values) >= 2
    assert sum(values.values()) > union
    equipment = actual_cases["equipment_icu"][0][2]["bottleneck_evidence"]["resources"]
    assert any(row["kind"] == "equipment" and row["code"] == "ICU_MONITOR" for row in equipment)
    assert not any(
        row["kind"] == "staff" and row["code"] == "rn" and row["unit_id"] == "UNIT-ICU" for row in equipment
    )


def test_unfinished_waits_count_but_recent_untreated_arrivals_do_not_become_failures(actual_cases):
    _data, scenario, trace = actual_cases["staff_blocked"][0]
    expected = oracle_access(trace, scenario)
    assert expected["unfinished_waiting_hours"] == 109
    assert expected["average_wait_per_patient_hours"] == 109 / 4
    assert expected["success_eligible_patients"] == 2
    assert expected["success_arrivals_with_insufficient_followup"] == 2
    assert expected["success_score_percent"] == 0
    quiet = oracle_access(actual_cases["quiet"][0][2], actual_cases["quiet"][0][1])
    assert quiet["success_score_percent"] == 100
    assert quiet["success_eligible_patients"] == 4


@lru_cache(maxsize=1)
def actual_comparison():
    from surge_engine import run_replication

    data = copy.deepcopy(source())
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
    scenario = {
        "id": "audit-comparison",
        "name": "Audit comparison",
        "dataset_version_id": data["dataset_version_id"],
        "start_at": data["snapshot_at"],
        "timezone": data["timezone"],
        "horizon_calendar_days": 2,
        "base_seed": 43121,
        "replications": 3,
        "conditions": [
            {
                "id": "matched-arrivals",
                "kind": "arrival_batch",
                "at": data["snapshot_at"],
                "entry_stream_id": "DIRECT_WARD_MAIN",
                "count": 30,
                "spread_minutes": 30,
            }
        ],
        "interventions": [],
    }
    intervention = {
        "id": "additional-nursing",
        "kind": "staff_existing",
        "name": "Add two ward nurses",
        "facility_id": "FAC-MAIN",
        "unit_id": "UNIT-WARD-A",
        "nurses": 2,
        "start_at": data["snapshot_at"],
        "activation_minutes": 0,
    }
    reference = [run_replication(data, scenario, index) for index in range(3)]
    candidate = [
        run_replication(data, {**scenario, "interventions": [intervention]}, index) for index in range(3)
    ]
    plans = [
        {
            "id": "reference",
            "name": "Current plan",
            "reference": True,
            "status": "SUCCEEDED",
            "feasibility": {"feasible": True},
            "interventions": [],
            "metrics": aggregate_results(reference, scenario),
        },
        {
            "id": "two-nurses",
            "name": "Add two ward nurses",
            "reference": False,
            "status": "SUCCEEDED",
            "feasibility": {"feasible": True},
            "interventions": [intervention],
            "metrics": aggregate_results(candidate, scenario),
            "improvement": paired_summary(reference, candidate),
        },
    ]
    for rank, plan in enumerate(rank_plans(plans, scenario), 1):
        plan["rank"] = rank
    return data, scenario, reference, candidate, plans


def test_actual_comparison_reduction_uses_paired_wait_burdens_and_expected_ranking():
    _data, _scenario, reference, candidate, plans = actual_comparison()
    reductions = [
        oracle_queue_hours(a, {"direct_waiting", "ed_boarding"})
        - oracle_queue_hours(b, {"direct_waiting", "ed_boarding"})
        for a, b in zip(reference, candidate)
    ]
    expected_relative = [
        100 * change / oracle_queue_hours(a, {"direct_waiting", "ed_boarding"})
        for change, a in zip(reductions, reference)
    ]
    improvement = plans[1]["improvement"]
    assert improvement["absolute_change"]["p50"] == pytest.approx(median(reductions))
    assert improvement["relative_change_percent"]["p50"] == pytest.approx(median(expected_relative))
    assert improvement["probability_of_improvement"] == sum(value > 0 for value in reductions) / len(
        reductions
    )
    assert plans[1]["rank"] == 1 and plans[0]["rank"] == 2
    assert all(value > 0 for value in reductions)
    for original, response in zip(reference, candidate):
        assert [
            (row["patient_id"], row["occurred_at"])
            for row in original["events"]
            if row["event_type"] == "arrival"
        ] == [
            (row["patient_id"], row["occurred_at"])
            for row in response["events"]
            if row["event_type"] == "arrival"
        ]


def compact_sample(name, data, scenario, traces):
    """Actual values plus virtual API ownership IDs; no persisted runs are created."""
    group_id = f"audit-{name}-run"
    frozen = {**scenario, "revision": 1}
    context = {
        "run_group_id": group_id,
        "scenario_id": scenario["id"],
        "scenario_revision_id": f"{scenario['id']}-revision-1",
        "dataset_version_id": scenario["dataset_version_id"],
    }
    metrics = aggregate_results(traces, scenario)
    metrics["context"] = context
    metrics.pop("unit_series", None)
    metrics["series"] = []  # The audit cannot accidentally infer peaks from interpolated chart points.
    metrics["daily"] = [
        {
            key: value
            for key, value in row.items()
            if key
            in {"local_date", "start_at", "end_at", "blocker_patient_hours", "medical_supply_average_percent"}
        }
        for row in metrics["daily"]
    ]
    evidence = {**ensemble_bottlenecks(traces, group_id), "context": context}
    return {
        "scenario": frozen,
        "units": data["units"],
        "run": {
            "id": group_id,
            "status": "SUCCEEDED",
            "scenario_id": scenario["id"],
            "dataset_version_id": scenario["dataset_version_id"],
            "source_draft_revision": 1,
            "scenario_revision_id": context["scenario_revision_id"],
            "replications_completed": len(traces),
            "replications_requested": len(traces),
            "selected_replication_id": f"{group_id}_rep_{metrics['selected_replication_index']:04d}",
            "scenario_context": frozen,
        },
        "metrics": metrics,
        "evidence": evidence,
        "independent_access": [oracle_access(trace, scenario) for trace in traces],
        "independent_supplies": [oracle_supplies(trace, data, scenario) for trace in traces],
        "recorded_sources": {
            f"{group_id}_rep_{trace['replication_index']:04d}": {
                "categories": trace["bottleneck_evidence"]["categories"],
                "units": trace["bottleneck_evidence"]["units"],
                "resources": trace["bottleneck_evidence"]["resources"],
            }
            for trace in traces
        },
    }


def frontend_samples():
    samples = {}
    for name in CASES:
        cases = [run_case(name, index) for index in range(3)]
        data, scenario, _trace = cases[0]
        samples[name] = compact_sample(name, data, scenario, [trace for _, _, trace in cases])
    data, scenario, reference, candidate, plans = actual_comparison()
    samples["comparison"] = compact_sample("comparison", data, scenario, reference)
    samples["comparison"]["comparison"] = {
        "id": "audit-comparison-projection",
        "scenario_id": scenario["id"],
        "source_draft_revision": 1,
        "source_scenario_snapshot": {**scenario, "revision": 1},
        "status": "SUCCEEDED",
        "no_plan_improves": False,
        "plans": plans,
    }
    for plan in plans:
        plan["metrics"].pop("unit_series", None)
        plan["metrics"]["series"] = []
        plan["metrics"]["daily"] = []
    samples["comparison"]["independent_reductions"] = [
        a["scalar_metrics"]["inpatient_waiting_patient_hours"]
        - b["scalar_metrics"]["inpatient_waiting_patient_hours"]
        for a, b in zip(reference, candidate)
    ]
    return samples


if __name__ == "__main__":
    print(json.dumps(frontend_samples(), separators=(",", ":"), allow_nan=False))
