from surge_api.comparisons import paired_summary, rank_plans


def records(values):
    return [
        {"replication_index": i, "scalar_metrics": {"inpatient_waiting_patient_hours": value}}
        for i, value in enumerate(values)
    ]


def test_relative_percent_uses_paired_percent_distribution_and_explicit_zero_na():
    result = paired_summary(records([1, 10, 100]), records([0, 9, 50]))
    assert result["p50"] == 1
    assert result["percent_reduction"] == 50
    assert result["percent_reduction"] != 100 * result["p50"] / 10
    zero = paired_summary(records([0, 10, 100]), records([0, 9, 50]))
    assert zero["relative_replications"] == 2 and zero["relative_undefined_replications"] == 1
    assert zero["percent_reduction"] == 30
    assert paired_summary(records([0, 0]), records([0, 1]))["percent_reduction"] is None


def test_rank_ties_use_achievable_activation_and_do_not_invent_missing_cost():
    scenario = {"start_at": "2026-10-16T05:00:00Z"}
    slow = {
        "id": "a-first-id",
        "status": "SUCCEEDED",
        "interventions": [{"kind": "staff_existing", "activation_minutes": 60}],
        "metrics": {"scalar_metrics": {}},
    }
    fast = {
        "id": "z-last-id",
        "status": "SUCCEEDED",
        "interventions": [{"kind": "staff_existing", "activation_minutes": 0}],
        "metrics": {"scalar_metrics": {}},
        "resource_cost": 10,
        "cost_currency": "USD",
    }
    assert [p["id"] for p in rank_plans([slow, fast], scenario)] == ["z-last-id", "a-first-id"]
    assert not fast["financial_cost_comparable"]
