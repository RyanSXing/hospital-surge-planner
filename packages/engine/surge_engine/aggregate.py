"""Ensemble summaries preserve per-replication metrics and paired improvements."""

from __future__ import annotations

import math

import numpy as np


def stats(values):
    valid = [
        v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    ]
    if not valid:
        return {"p10": None, "p50": None, "p90": None, "mean": None, "min": None, "max": None}
    a = np.asarray(valid, dtype=float)
    p10, p50, p90 = np.percentile(a, [10, 50, 90])
    return {
        "p10": float(p10),
        "p50": float(p50),
        "p90": float(p90),
        "mean": float(np.mean(a)),
        "min": float(np.min(a)),
        "max": float(np.max(a)),
    }


def aggregate_results(replications, scenario=None):
    if not replications:
        raise ValueError("At least one completed replication is required")
    if any(r.get("status", "SUCCEEDED") != "SUCCEEDED" for r in replications):
        raise ValueError("Incomplete replications cannot be presented as a completed forecast")
    scenario = scenario or {}
    keys = set().union(*(r["scalar_metrics"].keys() for r in replications))
    scalar = {
        k: stats([r["scalar_metrics"].get(k) for r in replications])
        for k in sorted(keys)
        if any(
            isinstance(r["scalar_metrics"].get(k), (int, float))
            and not isinstance(r["scalar_metrics"].get(k), bool)
            for r in replications
        )
    }
    waits = [r["scalar_metrics"]["inpatient_waiting_patient_hours"] for r in replications]
    median = float(np.median(waits))
    selected = min(
        replications,
        key=lambda r: (
            abs(r["scalar_metrics"]["inpatient_waiting_patient_hours"] - median),
            r["replication_index"],
        ),
    )

    def aggregate_rows(table, identity):
        indexed = {}
        for r in replications:
            for row in r.get(table, []):
                indexed.setdefault(row[identity], []).append(row)
        output = []
        for key, rows in sorted(indexed.items()):
            row = {identity: key}
            for field in ("at", "elapsed_minutes", "start_at", "end_at", "local_date"):
                if field in rows[0]:
                    row[field] = rows[0][field]
            fields = set().union(*(r.keys() for r in rows))
            for field in fields:
                if field in row:
                    continue
                if any(isinstance(r.get(field), (int, float)) for r in rows):
                    row[field] = stats([r.get(field) for r in rows])
            if table == "daily":
                reasons = set().union(*(r.get("blocker_patient_hours", {}).keys() for r in rows))
                row["blocker_patient_hours"] = {
                    reason: stats([r.get("blocker_patient_hours", {}).get(reason, 0) for r in rows])
                    for reason in sorted(reasons)
                }
                row["queue_probability"] = sum(r.get("peak_inpatient_queue", 0) > 0 for r in rows) / len(rows)
                row["zero_capacity_probability"] = sum(bool(r.get("zero_capacity")) for r in rows) / len(rows)
                row["zero_capacity"] = any(r.get("zero_capacity", False) for r in rows)
            row["replication_count"] = len(rows)
            output.append(row)
        return output

    unit_series = {}
    for uid, unit in selected.get("unit_series", {}).items():
        fields = {}
        for field in unit["fields"]:
            values = np.asarray([r["unit_series"][uid]["fields"][field] for r in replications], dtype=float)
            p10, p50, p90 = np.percentile(values, [10, 50, 90], axis=0)
            fields[field] = {
                key: array.tolist()
                for key, array in [
                    ("p10", p10),
                    ("p50", p50),
                    ("p90", p90),
                    ("mean", np.mean(values, axis=0)),
                ]
            }
        unit_series[uid] = {"unit_id": uid, "fields": fields}
    return {
        "unit_series": unit_series,
        "scalar_metrics": scalar,
        "series": aggregate_rows("series", "elapsed_minutes"),
        "daily": aggregate_rows("daily", "local_date"),
        "selected_replication_index": selected["replication_index"],
        "selected_replication_id": selected["replication_id"],
        "replications_completed": len(replications),
        "replications_requested": scenario.get("replications", len(replications)),
        "timezone": selected.get("timezone", "America/Chicago"),
        "start_at": selected.get("start_at"),
        "end_at": selected.get("end_at"),
        "uncertainty_label": "Simulation range under selected assumptions",
        "model_version": selected.get("model_version"),
        "warnings": selected.get("warnings", []),
    }


def paired_improvement(reference, candidate):
    base = {r["replication_index"]: r for r in reference}
    paired = []
    relative = []
    for r in candidate:
        index = r["replication_index"]
        if index not in base:
            raise ValueError("Comparisons require matching replication indexes")
        a = base[index]["scalar_metrics"]["inpatient_waiting_patient_hours"]
        b = r["scalar_metrics"]["inpatient_waiting_patient_hours"]
        paired.append(a - b)
        if a:
            relative.append(100 * (a - b) / a)
    return {
        "absolute_change": stats(paired),
        "relative_change_percent": stats(relative) if len(relative) == len(paired) else None,
        "probability_of_improvement": sum(v > 0 for v in paired) / len(paired),
        "paired_replications": len(paired),
    }
