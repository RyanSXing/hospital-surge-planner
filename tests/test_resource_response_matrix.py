"""Resource-response audit with independently predictable admission waves.

Twelve identical, oxygen-dependent ward patients arrive simultaneously into an
empty hospital. Two-hour care and immediate turnover make the exact expected
queue integral calculable without the engine's aggregation helpers. Only one
resource is varied at a time, including complete closure.
"""

import copy
from collections import Counter

import pytest
from surge_engine import generate_dataset, state_at
from surge_engine.common import digest
from surge_engine.simulation import HospitalSimulation


@pytest.fixture(scope="module")
def hospital():
    data = generate_dataset("hospital_baseline", days=35)
    data["patients"] = []
    for key in ("ed_arrivals_per_local_day", "direct_ward_arrivals_per_local_day"):
        data["arrival_profiles"][key] = 0
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 0
    ward_los = set()
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ward":
            ward_los.add(cohort["los_template_id"])
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-WARD-OXYGEN", "weight": 1}]
    for template in data["los_templates"]:
        if template["template_id"] in ward_los:
            template.update(family="fixed", fixed_minutes=120)
    for unit in data["units"]:
        unit["turnover_minutes"] = 0
    return data


CASES = [
    ("beds-closed", {"beds": 0}, 0, "no_matching_physical_place"),
    ("one-bed", {"beds": 1}, 1, "no_matching_physical_place"),
    ("three-beds", {"beds": 3}, 3, "no_matching_physical_place"),
    ("staffed-limit-zero", {"staffed": 0}, 0, "nursing_capacity"),
    ("staffed-limit-two", {"staffed": 2}, 2, "nursing_capacity"),
    ("no-nurses", {"rn": 0}, 0, "nursing_capacity"),
    ("one-nurse-four-beds", {"rn": 1}, 4, "nursing_capacity"),
    ("no-provider", {"provider": 0}, 0, "minimum_operating_team"),
    ("no-support", {"support": 0}, 0, "minimum_operating_team"),
    ("no-oxygen", {"oxygen": 0}, 0, "required_equipment_unavailable"),
    ("one-oxygen-unit", {"oxygen": 1}, 1, "required_equipment_unavailable"),
    ("ample-resources", {}, 12, None),
]


@pytest.mark.parametrize("days", [7, 14, 30])
@pytest.mark.parametrize("name,changes,capacity,cause", CASES, ids=[row[0] for row in CASES])
def test_resource_changes_have_exact_waiting_and_access_consequences(hospital, days, name, changes, capacity, cause):
    data = copy.deepcopy(hospital)
    values = {"beds": 12, "staffed": 12, "rn": 3, "provider": 1, "support": 1, "oxygen": 12, **changes}
    conditions = []
    for unit in data["units"]:
        if unit["kind"] != "ward":
            continue
        selected = unit["unit_id"] == "UNIT-WARD-A"
        beds = values["beds"] if selected else 0
        conditions.append({
            "kind": "unit_configuration", "unit_id": unit["unit_id"],
            "physical_capacity": beds, "enabled_capacity": beds,
            "staffed_capacity": min(beds, values["staffed"]) if selected else 0,
            "staff_counts": {role: values[role] if selected else 0 for role in ("rn", "provider", "support")},
        })
    for pool in data["equipment_pools"]:
        if pool["equipment_pool_id"] == "EQ-WARD-O2-A":
            pool["quantity"] = values["oxygen"]
    original = digest(data)
    simulation = HospitalSimulation(data, {"horizon_calendar_days": days, "base_seed": 83123,
                                           "conditions": conditions}, 0, True)
    stream = next(row for row in data["entry_streams"] if row["entry_type"] == "direct_ward")
    for index in range(12):
        simulation.schedule(0, "arrival", {"patient_id": f"AUDIT-{index:02d}",
                                           "source": "baseline_arrival", "stream": stream}, 2)
    trace = simulation.run()
    metrics = trace["scalar_metrics"]
    arrivals = [event for event in trace["events"] if event["event_type"] == "arrival"]
    starts = [event for event in trace["events"] if event["event_type"] == "admission"]
    departures = [event for event in trace["events"] if event["event_type"] == "discharge"]
    expected_start_times = [120 * (index // capacity) for index in range(12)] if capacity else []
    assert sorted(event["elapsed_minutes"] for event in starts) == expected_start_times
    expected_wait_hours = sum(expected_start_times) / 60 / 12 if capacity else trace["horizon_elapsed_minutes"] / 60
    assert metrics["average_wait_per_patient_hours"] == pytest.approx(expected_wait_hours)
    assert metrics["inpatient_waiting_patient_hours"] == pytest.approx(expected_wait_hours * 12)
    assert metrics["ed_waiting_patient_hours"] == 0
    assert metrics["success_score_percent"] == (100 if capacity else 0)
    assert metrics["success_eligible_patients"] == 12
    assert metrics["arrivals"] == len(arrivals) == 12
    assert len(departures) == (12 if capacity else 0)
    assert metrics["active_at_horizon"] == (0 if capacity else 12)
    assert metrics["patient_conservation_ok"]
    if cause:
        assert trace["blocker_patient_hours"][cause] > 0
    else:
        assert not any(trace["blocker_patient_hours"].values())
        assert metrics["first_shortage_at"] is None
    for minute in [0, 1, 120, 121, 240, 720, 1440, trace["horizon_elapsed_minutes"]]:
        state = state_at(trace, minute)
        in_service = [patient for patient in state["patients"] if patient["state"] == "inpatient"]
        assert len(in_service) <= capacity
        assert all(patient["unit_id"] == "UNIT-WARD-A" for patient in in_service)
        allocated_slots = [patient["slot_id"] for patient in in_service]
        assert len(set(allocated_slots)) == len(allocated_slots)
        assert all(count == 1 for count in Counter(allocated_slots).values())
        assert len(arrivals) == len(state["patients"]) + sum(
            event["elapsed_minutes"] <= minute for event in departures
        )
    assert digest(data) == original, f"{name}: simulation mutated source inputs"
