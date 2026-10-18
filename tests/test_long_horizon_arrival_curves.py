"""Late daily curve edits affect generated arrivals throughout the actual run.

Expected intensity is deterministic. Patient counts are Poisson samples, so a
40% edit must not be asserted to produce exactly 40% as many patients. Paired
seeds instead preserve every unchanged arrival identity/time and expose the
engine's additive-surge and baseline-thinning behavior on the edited days.
"""

from collections import defaultdict
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pytest
from surge_engine import generate_dataset
from surge_engine.common import digest, dt, iso
from surge_engine.simulation import HospitalSimulation


@pytest.fixture(scope="module")
def hospital():
    data = generate_dataset("hospital_baseline", days=30)
    # Keep this a fast full-engine regression with real hospital care pathways,
    # nonuniform hourly/weekday profiles, initial census and scheduled staffing.
    rates = {"ed": 18, "direct_ward": 2}
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = rates["ed"]
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = rates["direct_ward"]
    for stream in data["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = rates[stream["entry_type"]]
    return data


def daily_conditions(data, changes):
    start = dt(data["snapshot_at"]).astimezone(ZoneInfo(data["timezone"]))
    return [
        {
            "id": f"edited-daily-arrivals-{index + 1}",
            "kind": "arrival_multiplier",
            "entry_stream_id": "ED_MAIN",
            "shape": "step",
            "start_at": iso(start + timedelta(days=index)),
            "end_at": iso(start + timedelta(days=index + 1)),
            "control_points": [
                {"at": iso(start + timedelta(days=index)), "multiplier": multiplier},
                {"at": iso(start + timedelta(days=index + 1)), "multiplier": multiplier},
            ],
            "source": "user_assumption",
        }
        for index, multiplier in changes.items()
    ]


def arrivals_by_day(trace):
    result = defaultdict(dict)
    zone = ZoneInfo(trace["timezone"])
    for event in trace["events"]:
        if event["event_type"] != "arrival":
            continue
        local_date = dt(event["occurred_at"]).astimezone(zone).date().isoformat()
        key = (event["payload"]["entry_type"], local_date)
        result[key][event["patient_id"]] = event["occurred_at"]
    return result


@pytest.mark.parametrize(
    ("days", "changes"),
    [
        (14, {9: 1.75, 12: 0, 13: 0.35}),
        # Day 17 is the 25-hour local day at the fall DST transition. Day 30
        # protects the horizon's final day, well beyond both earlier weeks.
        (30, {9: 1.75, 16: 0.35, 20: 0, 29: 2.5}),
    ],
    ids=["two-weeks", "one-month-through-dst"],
)
def test_late_daily_edits_reach_exact_intensity_and_actual_arrivals(hospital, days, changes):
    original = digest(hospital)
    baseline = {"horizon_calendar_days": days, "base_seed": 20261017, "conditions": []}
    edited = {**baseline, "conditions": daily_conditions(hospital, changes)}
    models = [
        HospitalSimulation(hospital, scenario, index=0, keep_trace=True) for scenario in (baseline, edited)
    ]
    zone = ZoneInfo(hospital["timezone"])
    first = dt(hospital["snapshot_at"]).astimezone(zone).date()
    expected = []
    for model, changed in zip(models, (False, True)):
        exposure = defaultdict(float)
        hour_counts = defaultdict(int)
        for stream, local_date, _, _, _, base, multiplier in model.arrival_exposures():
            index = (date.fromisoformat(local_date) - first).days
            factor = changes.get(index, 1) if changed and stream["entry_type"] == "ed" else 1
            assert multiplier == pytest.approx(factor), (days, index, stream["entry_stream_id"])
            exposure[(stream["entry_type"], local_date)] += base * multiplier
            hour_counts[(stream["entry_type"], local_date)] += 1
        total = 0
        for index in range(days):
            current = first + timedelta(days=index)
            for stream in hospital["entry_streams"]:
                entry = stream["entry_type"]
                factor = changes.get(index, 1) if changed and entry == "ed" else 1
                # Full local-day exposure normalizes hourly weights, including
                # both occurrences of the repeated DST hour. Weekday effects
                # and the edited multiplier still apply to that day's rate.
                amount = (
                    stream["expected_arrivals_per_local_day"]
                    * stream["weekday_weights"][current.weekday()]
                    * factor
                )
                assert exposure[(entry, current.isoformat())] == pytest.approx(amount)
                total += amount
        if days == 30:
            assert hour_counts[("ed", "2026-11-01")] == 25
        expected.append(total)

    # These execute the hospital's full event loop, rather than only estimating
    # or inspecting frozen scenario conditions.
    traces = [model.run() for model in models]
    actual = [arrivals_by_day(trace) for trace in traces]
    for index in range(days):
        current = (first + timedelta(days=index)).isoformat()
        normal = actual[0][("ed", current)]
        changed = actual[1][("ed", current)]
        factor = changes.get(index, 1)
        assert actual[1][("direct_ward", current)] == actual[0][("direct_ward", current)]
        if factor == 1:
            assert changed == normal, f"Unedited day {index + 1} must retain identical sampled arrivals"
        elif factor == 0:
            assert normal and not changed, f"Day {index + 1} must have no generated ED arrivals"
        elif factor > 1:
            assert normal.items() <= changed.items(), "Increased demand preserves common baseline arrivals"
            assert len(changed) > len(normal), f"Day {index + 1} must receive sampled surge arrivals"
        else:
            assert changed.items() < normal.items(), "Reduced demand thins the same baseline identities/times"
        for trace, arrivals in zip(traces, actual):
            daily = trace["daily"][index]
            assert dt(daily["start_at"]).astimezone(zone).date().isoformat() == current
            assert daily["arrivals"] == len(arrivals[("ed", current)]) + len(
                arrivals[("direct_ward", current)]
            )
    for trace, total, arrivals in zip(traces, expected, actual):
        assert trace["status"] == "SUCCEEDED"
        assert trace["scalar_metrics"]["expected_arrivals"] == pytest.approx(total)
        assert trace["scalar_metrics"]["arrivals"] == sum(len(values) for values in arrivals.values())
        assert trace["scalar_metrics"]["patient_conservation_ok"]
    assert digest(hospital) == original
