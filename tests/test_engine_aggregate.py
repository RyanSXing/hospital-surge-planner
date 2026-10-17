import math

import numpy as np
import pytest
from surge_engine.aggregate import aggregate_results, stats


@pytest.mark.parametrize("count", [1, 2, 3, 10, 100, 500])
def test_percentile_bands_preserve_scalar_quantile_interpolation(count):
    values = np.random.default_rng(173).normal(size=count).tolist()
    # Missing/invalid and Boolean fields must not become zero observations.
    actual = stats(values + [None, float("nan"), float("inf"), True, "3"])
    for percentile in (10, 50, 90):
        assert actual[f"p{percentile}"] == float(np.percentile(values, percentile))
    assert actual["min"] <= actual["p10"] <= actual["p50"] <= actual["p90"] <= actual["max"]
    assert actual["mean"] == float(np.mean(values))
    assert all(value is None for value in stats([None, True, math.nan]).values())


def test_unit_bands_preserve_replication_axis_and_selected_realization():
    arrays = [[7, 10, 1], [2, 20, 4], [9, 10, 7], [1, 8, 20]]
    results = [
        {
            "replication_index": i,
            "replication_id": f"R{i}",
            "scalar_metrics": {"inpatient_waiting_patient_hours": i * 10},
            "unit_series": {"U": {"fields": {"occupied": values}}},
        }
        for i, values in enumerate(arrays)
    ]
    summary = aggregate_results(results)
    assert summary["selected_replication_index"] == 1
    band = summary["unit_series"]["U"]["fields"]["occupied"]
    for percentile in (10, 50, 90):
        assert band[f"p{percentile}"] == np.percentile(arrays, percentile, axis=0).tolist()
    assert band["mean"] == np.mean(arrays, axis=0).tolist()
