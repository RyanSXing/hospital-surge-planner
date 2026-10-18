"""Operational result reductions retain their physical meaning and unknowns."""

import pytest
from surge_api.patients import remaining_summary
from surge_api.worker import period_aggregation


def test_supply_period_reductions_use_consumption_sums_minimum_and_last_stock():
    days = [
        ("2026-10-31", "2026-10-31T05:00:00Z", "2026-11-01T05:00:00Z", 100, 75, 80, 2),
        ("2026-11-01", "2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z", 0, 0, 20, 3),
    ]
    rows = [
        {
            "local_date": day,
            "start_at": start,
            "end_at": end,
            "medical_supply_average_percent": average,
            "medical_supply_min_percent": minimum,
            "medical_supply_end_percent": ending,
            "medical_supply_consumed_units": used,
            "medical_supply_refilled_units": used + 1,
            "medical_supplies_shortage_hours": 1,
            "blocker_patient_hours": {"medical_supplies": used},
        }
        for day, start, end, average, minimum, ending, used in days
    ]
    # Calendar month boundaries split these rows, while week aggregation joins them.
    week = period_aggregation([{"daily": rows}], "week")[0]
    assert week["medical_supply_average_percent"]["p50"] == pytest.approx(100 * 24 / 49)
    assert week["medical_supply_min_percent"]["p50"] == 0
    assert week["medical_supply_end_percent"]["p50"] == 20
    assert week["medical_supply_consumed_units"]["p50"] == 5
    assert week["medical_supply_refilled_units"]["p50"] == 7
    assert week["blocker_patient_hours"]["medical_supplies"]["p50"] == 5


def test_patient_remaining_care_time_stays_fixed_during_a_disruption():
    patient = {
        "state": "inpatient",
        "care_paused": True,
        "remaining_stage_spec": {"kind": "fixed_minutes", "minutes": 180},
    }
    for at in ("2026-10-17T06:00:00Z", "2026-10-17T18:00:00Z"):
        remaining = remaining_summary(patient, at, simulated=True)
        assert remaining["hours"] == 3
        assert remaining["basis"] == "paused_trajectory"


def test_missing_paused_residual_never_becomes_zero():
    assert (
        remaining_summary(
            {"state": "inpatient", "care_paused": True}, "2026-10-17T18:00:00Z", simulated=True
        )["hours"]
        is None
    )
