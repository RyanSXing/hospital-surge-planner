"""Bound chart payloads without averaging away peaks or altering result metrics."""

from __future__ import annotations

import math
import threading


def visible_series(rows, max_points=2000):
    """Return original points preserving every bucket's extrema in value/band columns.

    Buckets are sized from the number of displayed columns, so the union of
    minima/maxima is bounded. Original timestamps and quantiles remain paired.
    """
    if len(rows) <= max_points:
        return list(range(len(rows)))
    columns = []
    for key, value in rows[0].items():
        if key in {"elapsed_minutes", "replication_count", "at", "start_at", "end_at"}:
            continue
        if isinstance(value, dict):
            columns.extend((key, stat) for stat in ("p10", "p50", "p90", "mean") if stat in value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            columns.append((key, None))
    # All normal engine output fields fit; malformed/expanded schemas retain the
    # primary queue/capacity metrics first instead of exceeding the hard bound.
    columns.sort(
        key=lambda item: (
            not any(
                word in item[0]
                for word in ("queue", "occupied", "staffed", "capacity", "available", "waiting")
            ),
            item,
        )
    )
    columns = columns[: max(1, (max_points - 2) // 2)]
    if not columns:
        return sorted({round(i * (len(rows) - 1) / (max_points - 1)) for i in range(max_points)})
    bucket_count = max(1, (max_points - 2) // (2 * len(columns)))
    width = math.ceil(len(rows) / bucket_count)
    selected = {0, len(rows) - 1}
    for start in range(0, len(rows), width):
        end = min(len(rows), start + width)
        for key, stat in columns:
            values = []
            for index in range(start, end):
                value = rows[index].get(key)
                if stat:
                    value = value.get(stat) if isinstance(value, dict) else None
                if isinstance(value, (int, float)) and math.isfinite(value):
                    values.append((value, index))
            if values:
                selected.add(min(values)[1])
                selected.add(max(values)[1])
    return sorted(selected)


def bound_comparison_series(plans, max_points=2000):
    """Use one envelope across every plan so shared hover uses aligned instants."""
    results = [p["metrics"] for p in plans if p.get("metrics", {}).get("series")]
    if not results:
        return
    # Comparisons are evaluated on the same frozen horizon. Union timestamps
    # keeps a partial/recovered comparison honest if a series is incomplete.
    times = sorted({row["at"] for result in results for row in result["series"]})
    by_time = [{row["at"]: row for row in result["series"]} for result in results]
    combined = []
    for at in times:
        point = {"at": at}
        for index, rows in enumerate(by_time):
            point.update(
                {
                    f"plan{index}_{key}": value
                    for key, value in rows.get(at, {}).items()
                    if key not in {"at", "elapsed_minutes", "replication_count"}
                }
            )
        combined.append(point)
    chosen = visible_series(combined, max_points)
    selected_times = {times[i] for i in chosen}
    for result in results:
        original = result["series"]
        indices = [i for i, row in enumerate(original) if row["at"] in selected_times]
        result["series"] = [original[i] for i in indices]
        for unit in result.get("unit_series", {}).values():
            for statistics in unit.get("fields", {}).values():
                for statistic, values in statistics.items():
                    if isinstance(values, list):
                        statistics[statistic] = [values[i] for i in indices if i < len(values)]
        result["context"] = {
            **result.get("context", {}),
            "resolution": {
                "source_point_count": len(original),
                "returned_point_count": len(indices),
                "max_points": max_points,
                "source_indices": indices,
                "method": "shared_multivariate_minmax_envelope" if len(indices) < len(original) else "raw",
                "values_are_original_points": True,
                "aligned_across_plans": True,
                "detail_url_template": "/api/run-groups/{run_group_id}/metrics?start_at={start_at}&end_at={end_at}&grain=hour",
            },
        }


_period_cache = {}
_period_lock = threading.Lock()


def legacy_periods(metadata, grain):
    """Compatibility cache for completed runs created before period artifacts."""
    from .artifacts import ArtifactStore
    from .worker import period_aggregation

    store = ArtifactStore()
    key = (store.backend, str(store.root), metadata["object_key"], metadata["sha256"], grain)
    with _period_lock:
        if key not in _period_cache:
            value = period_aggregation(store.get_json(metadata), grain)
            if len(_period_cache) >= 16:
                _period_cache.pop(next(iter(_period_cache)))
            _period_cache[key] = value
        return _period_cache[key]
