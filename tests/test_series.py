import math

from surge_api.series import visible_series


def test_visible_points_preserve_peaks_bands_and_hard_bound():
    rows = [
        {
            "elapsed_minutes": i * 60,
            "inpatient_queue": {"p10": math.sin(i / 17), "p50": math.sin(i / 11), "p90": math.sin(i / 7)},
            "ward_staffed": {"p10": 80, "p50": 90, "p90": 100},
        }
        for i in range(8784)
    ]
    rows[5503]["inpatient_queue"]["p90"] = 999
    rows[1201]["ward_staffed"]["p10"] = 0
    rows[8555]["inpatient_queue"]["p50"] = -100
    for maximum in (200, 2000):
        chosen = visible_series(rows, maximum)
        assert len(chosen) <= maximum
        assert {0, 1201, 5503, 8555, 8783} <= set(chosen)
        assert chosen == sorted(set(chosen))
    assert visible_series(rows[:20]) == list(range(20))


def test_comparison_points_share_timestamps_and_preserve_each_plans_peak():
    from surge_api.series import bound_comparison_series

    plans = []
    for plan in range(3):
        rows = [{"at": f"{i:05}", "queue": {"p10": 0, "p50": i % 13, "p90": i % 17}} for i in range(8760)]
        rows[1234 + plan * 1301]["queue"]["p90"] = 1000 + plan
        plans.append(
            {
                "metrics": {
                    "series": rows,
                    "unit_series": {"ward": {"fields": {"occupied": {"p50": list(range(8760))}}}},
                    "scalar_metrics": {"peak": 1000 + plan},
                }
            }
        )
    bound_comparison_series(plans, 2000)
    assert len(plans[0]["metrics"]["series"]) <= 2000
    times = [r["at"] for r in plans[0]["metrics"]["series"]]
    for plan in plans:
        metrics = plan["metrics"]
        assert [r["at"] for r in metrics["series"]] == times
        assert max(r["queue"]["p90"] for r in metrics["series"]) == metrics["scalar_metrics"]["peak"]
        assert metrics["unit_series"]["ward"]["fields"]["occupied"]["p50"] == [int(t) for t in times]


def test_period_end_census_uses_final_bucket_instead_of_average():
    from surge_api.worker import period_aggregation

    rows = [
        {
            "local_date": f"2026-10-{16 + i}",
            "start_at": f"2026-10-{16 + i}T05:00:00Z",
            "end_at": f"2026-10-{17 + i}T05:00:00Z",
            "ward_end_occupied": 10 + 10 * i,
            "ward_occupied_hours": 240 + 240 * i,
            "ward_staffed_hours": 480,
            "capacity_shortfall_hours": i,
        }
        for i in range(2)
    ]
    week = period_aggregation([{"daily": rows}], "week")
    assert week[0]["ward_end_occupied"]["p50"] == 20
    assert week[0]["ward_utilization"]["p50"] == 0.75
    assert week[0]["capacity_shortfall_hours"]["p50"] == 1
