"""Recorded scope, mean-burden ranking and missing-data readback regression tests."""

import copy

import pytest
from surge_api.sunfire import evidence_view
from surge_api.sunfire_results import (
    bottleneck_summary,
    recorded_main_constraint,
    whole_horizon_bottleneck_intent,
)


def recorded():
    def row(reason, mean, median, unit=None, at="2026-10-18T15:30:00Z"):
        return {
            "reason": reason,
            "patient_hours": {"mean": mean, "p50": median},
            "peak_waiting": {"mean": 5, "p50": 4},
            "first_at": at,
            "first_replication_id": "run-current_rep_0001",
            **({"unit_id": unit, "unit_kind": "ward"} if unit else {}),
        }

    return {
        "available": True,
        "answer_focus": "bottleneck",
        "source": {
            "scope": "ensemble",
            "run_group_id": "run-current",
            "timezone": "America/Chicago",
            "matches_current_draft": True,
            "evidence_label": "Recorded ensemble results",
        },
        "unit_names": {"UNIT-A": "Ward A", "UNIT-B": "Ward B"},
        "scalar_metrics": {
            "average_wait_per_patient_hours": {"p50": 7.6},
            "peak_inpatient_queue": {"p50": 19},
        },
        "bottlenecks": {
            "evidence_available": True,
            "scope": "ensemble",
            "categories": [row("medical_supplies", 20, 20), row("nursing_capacity", 100, 1)],
            # The first and globally largest unit is a different reason. Unit
            # attribution must follow the greatest MEAN category, not row order,
            # the median category, or an overlapping sum of candidates.
            "units": [
                row("medical_supplies", 500, 20, "UNIT-A"),
                row("nursing_capacity", 10, 1, "UNIT-A"),
                row("nursing_capacity", 40, 1, "UNIT-B"),
            ],
            "resources": [],
        },
    }


def test_main_constraint_uses_maximum_mean_category_then_matching_unit_and_its_exact_replay_time():
    value = recorded()
    main = recorded_main_constraint(value)
    assert main["reason"] == "nursing_capacity" and main["unit"] == "Ward B"
    answer = evidence_view("read_results", value, 0)
    assert "no staffed bed available in Ward B" in answer["summary"]
    assert "Oct 18, 2026, 10:30 AM CDT" in answer["summary"]
    assert "earliest occurrence across simulations" in answer["summary"]
    assert "Median peak queue for this constraint: 4 patients" in answer["summary"]
    assert "7.6 hours (median across simulations)" in answer["summary"]
    assert answer["links"][-1] == {
        "kind": "replay",
        "label": "View recorded bottleneck",
        "run_group_id": "run-current",
        "replication_id": "run-current_rep_0001",
        "at": "2026-10-18T15:30:00Z",
    }
    assert "500" not in answer["summary"] and "UNIT-" not in answer["summary"]


@pytest.mark.parametrize(
    "missing", ["unavailable", "missing_categories", "nonnumeric_burden", "missing_units"]
)
def test_missing_recorded_evidence_never_becomes_no_shortage_or_zero_wait(missing):
    value = recorded()
    if missing == "unavailable":
        value["bottlenecks"]["evidence_available"] = False
    elif missing == "missing_categories":
        value["bottlenecks"].pop("categories")
    elif missing == "nonnumeric_burden":
        value["bottlenecks"]["categories"][0]["patient_hours"] = None
    else:
        value["bottlenecks"]["units"] = None
    value["scalar_metrics"]["average_wait_per_patient_hours"] = None
    assert recorded_main_constraint(value) is None
    text = bottleneck_summary(value, None)
    assert "unavailable" in text and "no resource constraint" not in text and "0 hours" not in text


def test_known_empty_constraint_ledger_does_not_claim_that_nobody_waited():
    value = recorded()
    value["bottlenecks"].update(categories=[], units=[], resources=[])
    main = recorded_main_constraint(value)
    assert main == {"no_attributed_constraint": True}
    text = bottleneck_summary(value, main)
    assert "no resource constraint had a positive recorded waiting burden" in text
    assert "does not establish that nobody waited" in text and "7.6 hours" in text
    assert not any(link["kind"] == "replay" for link in evidence_view("read_results", value, 0)["links"])


def test_example_run_is_labelled_and_missing_unit_time_and_wait_are_not_invented():
    value = recorded()
    value["source"].update(scope="example_run", replication_id="one-rep", matches_current_draft=False)
    value["bottlenecks"] = {
        "evidence_available": True,
        "categories": [{"reason": "medical_supplies", "patient_hours": 20, "peak_waiting": 8}],
        "units": [],
        "resources": [],
    }
    value["scalar_metrics"] = {"average_wait_per_patient_hours": None}
    main = recorded_main_constraint(value)
    assert main["unit"] is None and main["replication_id"] == "one-rep"
    text = bottleneck_summary(value, main)
    assert "one example run (not ensemble evidence)" in text
    assert "medical supplies were exhausted" in text and "affected unit is unavailable" in text
    assert "time is unavailable" in text and "8 patients" in text
    assert "Average wait" not in text and "differ from the current unsaved draft" in text


@pytest.mark.parametrize(
    "qualifier",
    [
        "on 2026-10-18",
        "on October 18",
        "today",
        "on day 2",
        "at 10:30 AM",
        "at the selected time",
        "in this example run",
        "in the previous saved results",
        "between the comparison plans",
    ],
)
def test_explicit_human_day_exact_example_or_history_scope_is_not_replaced(qualifier):
    assert not whole_horizon_bottleneck_intent("Where is the main bottleneck " + qualifier + "?")


def test_unqualified_main_bottleneck_scope_is_full_horizon_and_ranking_is_read_only():
    assert whole_horizon_bottleneck_intent(
        "Where is the main bottleneck in the saved results for this scenario?"
    )
    value = recorded()
    before = copy.deepcopy(value)
    evidence_view("read_results", value, 0)
    assert value == before
