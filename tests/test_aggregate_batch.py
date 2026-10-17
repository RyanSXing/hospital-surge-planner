"""Batched time rows preserve the previous scalar statistical contract exactly."""

import copy
import hashlib
import json
import math

import numpy as np
import pytest
from surge_engine.aggregate import aggregate_results


def scalar_stats(values):
    valid = [
        v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    ]
    if not valid:
        return dict.fromkeys(("p10", "p50", "p90", "mean", "min", "max"))
    values = np.asarray(valid, dtype=float)
    quantiles = np.percentile(values, [10, 50, 90])
    return {
        "p10": float(quantiles[0]),
        "p50": float(quantiles[1]),
        "p90": float(quantiles[2]),
        "mean": float(np.mean(values)),
        "min": float(np.min(values)),
        "max": float(np.max(values)),
    }


def scalar_rows(replications, table, identity):
    """Frozen c4 row algorithm; intentionally independent of batch preparation."""
    indexed = {}
    for replication in replications:
        for row in replication.get(table, []):
            indexed.setdefault(row[identity], []).append(row)
    output = []
    for key, rows in sorted(indexed.items()):
        row = {identity: key}
        for field in ("at", "elapsed_minutes", "start_at", "end_at", "local_date"):
            if field in rows[0]:
                row[field] = rows[0][field]
        for field in set().union(*(r.keys() for r in rows)):
            if field not in row and any(isinstance(r.get(field), (int, float)) for r in rows):
                row[field] = scalar_stats([r.get(field) for r in rows])
        if table == "daily":
            reasons = set().union(*(r.get("blocker_patient_hours", {}).keys() for r in rows))
            row["blocker_patient_hours"] = {
                reason: scalar_stats([r.get("blocker_patient_hours", {}).get(reason, 0) for r in rows])
                for reason in sorted(reasons)
            }
            row["queue_probability"] = sum(r.get("peak_inpatient_queue", 0) > 0 for r in rows) / len(rows)
            row["zero_capacity_probability"] = sum(bool(r.get("zero_capacity")) for r in rows) / len(rows)
            row["zero_capacity"] = any(r.get("zero_capacity", False) for r in rows)
        row["replication_count"] = len(rows)
        output.append(row)
    return output


def case(replications, irregular):
    rng = np.random.default_rng(20261017)
    result = []
    for index in range(replications):
        series, daily = [], []
        for step in range(67):
            row = {
                "at": f"instant-{step}",
                "elapsed_minutes": step * 60,
                "metric": float(rng.normal()),
                "integer": index * step,
                "signed_zero": -0.0 if index % 2 else 0.0,
                "wide_range": float(rng.choice([-1e100, -1e-100, 0, 1e-100, 1e100])),
                "optional": float(rng.normal()),
                "only_bool": bool(index % 2),
                "text": "ignored",
                "nested": {"ignored": 1},
                "replication_count": -99,
            }
            if irregular:
                row["optional"] = (None, True, False, "1.25", float("nan"), float("inf"), -float("inf"), 3.5)[
                    (index + step) % 8
                ]
                if (index + step) % 5 == 0:
                    row.pop("integer")
                if (index + step) % 7 == 0:
                    continue
            series.append(row)
            daily.append(
                {
                    **row,
                    "local_date": f"day-{step:02d}",
                    "start_at": "start",
                    "end_at": "end",
                    "peak_inpatient_queue": index % 3,
                    "zero_capacity": bool((index + step) % 2),
                    "queue_probability": -99,
                    "zero_capacity_probability": -99,
                    "blocker_patient_hours": {"staff": index / 3} if index % 2 else {"equipment": step / 7},
                }
            )
        result.append(
            {
                "replication_id": f"rep-{index}",
                "replication_index": index,
                "scalar_metrics": {"inpatient_waiting_patient_hours": index},
                "series": series,
                "daily": daily,
            }
        )
    return result


@pytest.mark.parametrize("count", [1, 2, 3, 10, 17, 100])
@pytest.mark.parametrize("irregular", [False, True])
def test_full_time_rows_match_scalar_contract_and_do_not_mutate_inputs(count, irregular):
    replications = case(count, irregular)
    before = copy.deepcopy(replications)
    # Input NaNs are intentional; compare their stable JSON representation.
    before_json = json.dumps(before, sort_keys=True)
    actual = aggregate_results(replications)
    for table, identity in (("series", "elapsed_minutes"), ("daily", "local_date")):
        expected = scalar_rows(replications, table, identity)
        assert actual[table] == expected
        # Catch signed-zero or representation differences hidden by float ==.
        encode = lambda value: json.dumps(value, sort_keys=True, allow_nan=False).encode()
        assert hashlib.sha256(encode(actual[table])).digest() == hashlib.sha256(encode(expected)).digest()
    assert json.dumps(replications, sort_keys=True) == before_json


def test_numeric_subclasses_keep_the_scalar_acceptance_rules():
    class CustomFloat(float):
        pass

    replications = case(3, False)
    for index, replication in enumerate(replications):
        for row in replication["series"]:
            row["metric"] = CustomFloat(index + 0.25)
            row["optional"] = np.float32(index) if index == 1 else float(index)
    actual = aggregate_results(replications)
    assert actual["series"] == scalar_rows(replications, "series", "elapsed_minutes")
