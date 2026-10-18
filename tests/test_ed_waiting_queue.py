"""ED waiting is a current queue: it shrinks when assessment places free up.

An isolated twelve-person burst, one-hour assessment, and immediate turnover
give independently predictable queues. No saved scenario or result is changed.
"""

import copy

import pytest
from surge_api.replay import bounded_state, exact_state
from surge_engine import generate_dataset
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
        if stream["entry_type"] == "ed":
            stream["disposition_weights"] = {"discharge": 1}
    for path in data["pathway_profiles"]:
        if path["entry_stream_id"] == "ED_MAIN":
            path["ed_disposition_weights"] = {"discharge": 1}
    for cohort in data["cohorts"]:
        if cohort["care_level"] == "ambulatory":
            cohort["resource_profile_weights"] = [{"resource_profile_id": "RP-ED-BASIC", "weight": 1}]
    template = next(row for row in data["los_templates"] if row["template_id"] == "ED-ASSESSMENT")
    template.update(family="fixed", fixed_minutes=60)
    next(unit for unit in data["units"] if unit["kind"] == "ed")["turnover_minutes"] = 0
    return data


@pytest.mark.parametrize("days", [7, 14, 30])
@pytest.mark.parametrize("capacity", [0, 2])
def test_exact_ed_queue_drains_with_capacity_and_survives_backward_seeks(hospital, days, capacity):
    data = copy.deepcopy(hospital)
    before = digest(data)
    scenario = {
        "id": f"ed-drain-audit-{days}-{capacity}",
        "horizon_calendar_days": days,
        "base_seed": 83123,
        "conditions": [{
            "kind": "unit_configuration", "unit_id": "UNIT-ED",
            "physical_capacity": 2, "enabled_capacity": 2,
            "staffed_capacity": capacity,
            "staff_counts": {"rn": 1, "provider": 2, "support": 1},
        }],
    }
    simulation = HospitalSimulation(data, scenario, 0, True)
    stream = next(row for row in data["entry_streams"] if row["entry_type"] == "ed")
    for index in range(12):
        simulation.schedule(0, "arrival", {
            "patient_id": f"ED-BURST-{index:02d}", "source": "baseline_arrival", "stream": stream,
        }, 2)
    trace = simulation.run()
    starts = [row for row in trace["events"] if row["event_type"] == "assessment_start"]
    expected_starts = [60 * (index // capacity) for index in range(12)] if capacity else []
    assert sorted(row["elapsed_minutes"] for row in starts) == expected_starts

    # Deliberately seek forward, backward and across exact completion times.
    moments = [0, 59, 60, 61, 120, 300, 360, trace["horizon_elapsed_minutes"], 120, 0]
    for minute in moments:
        current = exact_state(trace, minute)
        sampled = bounded_state(current, trace["replication_id"], maximum=1)
        expected_waiting = max(0, 12 - capacity * (int(minute // 60) + 1))
        expected_departed = min(12, capacity * int(minute // 60))
        expected_assessing = 12 - expected_waiting - expected_departed
        ed = next(unit for unit in current["units"] if unit["unit_id"] == "UNIT-ED")
        assert current["ed_queue"] == expected_waiting
        assert sampled["queue_counts"].get("FAC-MAIN", {}).get("ed", 0) == expected_waiting
        assert current["patient_counts"]["by_state"].get("ed_waiting", 0) == expected_waiting
        assert current["patient_counts"]["by_state"].get("ed_assessment", 0) == expected_assessing
        assert ed["occupied"] == expected_assessing <= capacity
        assert sampled["flow_counts"]["FAC-MAIN"] == {"arrivals": 12, "discharges": expected_departed}
        assert sampled["patient_total"] == 12 - expected_departed
    assert trace["scalar_metrics"]["ed_unserved_at_horizon"] == (0 if capacity else 12)
    expected_wait_hours = sum(expected_starts) / 60 if capacity else 12 * trace["horizon_elapsed_minutes"] / 60
    assert trace["scalar_metrics"]["ed_waiting_patient_hours"] == pytest.approx(expected_wait_hours)
    assert trace["scalar_metrics"]["patient_conservation_ok"]
    assert digest(data) == before
