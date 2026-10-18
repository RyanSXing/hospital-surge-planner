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


def test_compact_summary_preserves_missing_waiting_instead_of_zero():
    from surge_api.comparisons import compact_summary

    result = compact_summary(
        [
            {"replication_index": 0, "scalar_metrics": {}},
            {"replication_index": 1, "scalar_metrics": {"inpatient_waiting_patient_hours": 0}},
            {
                "replication_index": 2,
                "status": "FAILED",
                "scalar_metrics": {"inpatient_waiting_patient_hours": 2},
            },
        ]
    )["paired_waits"]
    assert result[0]["scalar_metrics"]["inpatient_waiting_patient_hours"] is None
    assert result[1]["scalar_metrics"]["inpatient_waiting_patient_hours"] == 0
    assert result[2]["status"] == "FAILED"
    assert not paired_summary(result, result)["evidence_available"]


def test_missing_or_invalid_ranking_metrics_never_beat_measured_zero():
    scenario = {"start_at": "2026-10-16T05:00:00Z"}
    for invalid in (None, False, True, float("nan"), float("inf"), "0", {}):
        missing = {
            "id": "a-missing",
            "status": "SUCCEEDED",
            "metrics": {"scalar_metrics": {"inpatient_waiting_patient_hours": invalid}},
        }
        zero = {
            "id": "z-zero",
            "status": "SUCCEEDED",
            "metrics": {"scalar_metrics": {"inpatient_waiting_patient_hours": {"p50": 0}}},
        }
        assert [plan["id"] for plan in rank_plans([missing, zero], scenario)] == ["z-zero", "a-missing"]
        missing["metrics"]["scalar_metrics"]["inpatient_waiting_patient_hours"] = {"p50": invalid}
        assert rank_plans([missing, zero], scenario)[0]["id"] == "z-zero"
    assert rank_plans([{**missing, "metrics": None}, zero], scenario)[0]["id"] == "z-zero"


def test_malformed_or_partial_pairs_cannot_fabricate_an_improvement():
    valid = records([10, 20])
    cases = [
        ([], []),
        (valid, records([0])),
        (valid, [{**records([0])[0], "replication_index": 9}, records([1, 2])[1]]),
        (valid, [records([0])[0], records([0])[0]]),
        (valid, [{**valid[0], "status": "FAILED"}, valid[1]]),
        (valid, [{**valid[0], "status": "RUNNING"}, valid[1]]),
        (valid, [{"replication_index": 0, "scalar_metrics": {}}, valid[1]]),
        (valid, [{"replication_index": 0, "scalar_metrics": None}, valid[1]]),
        (valid, [None, valid[1]]),
        (None, valid),
    ]
    for invalid in (None, False, True, float("nan"), float("inf"), -1, "0"):
        cases.append((valid, records([invalid, 0])))
    for reference, candidate in cases:
        result = paired_summary(reference, candidate)
        assert result["evidence_available"] is False
        assert result["p50"] is None
        assert all(value is None for value in result["absolute_change"].values())
        assert result["probability_of_improvement"] is None
        assert result["probability_improvement"] is None
        assert result["percent_reduction"] is None
        assert result["relative_change_percent"] is None
        assert result["paired_replications"] == 0


def test_actual_zero_pairs_remain_valid_and_distinct_from_unavailable_results():
    result = paired_summary(records([0, 0]), records([0, 0]))
    assert result["evidence_available"]
    assert result["p50"] == 0
    assert result["probability_improvement"] == 0
    assert result["paired_replications"] == 2
    assert result["percent_reduction"] is None
    assert result["relative_undefined_replications"] == 2
