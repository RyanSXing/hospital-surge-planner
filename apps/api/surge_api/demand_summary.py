"""Maintain derived demand summaries without changing authoritative entry streams."""

# Draft validation exposes one ValueError contract for atomic HTTP 422 handling.
# ruff: noqa: TRY004

from __future__ import annotations

import math


def _nonnegative(value):
    try:
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value >= 0
        )
    except OverflowError:
        return False


def _weights(values, count, total, field):
    if (
        not isinstance(values, list)
        or len(values) != count
        or any(not _nonnegative(value) for value in values)
    ):
        raise ValueError(f"{field}: expected {count} finite nonnegative weights")
    resolved_total = sum(values)
    if not _nonnegative(resolved_total) or not math.isclose(resolved_total, total, rel_tol=0, abs_tol=1e-6):
        raise ValueError(f"{field}: weights must sum to {total}")
    return values


def _profile_rows(existing, position, value_key, values):
    metadata = (
        {
            row[position]: row
            for row in existing
            if isinstance(row, dict)
            and isinstance(row.get(position), int)
            and not isinstance(row[position], bool)
        }
        if isinstance(existing, list)
        else {}
    )
    return [
        {**metadata.get(index, {}), position: index, value_key: value} for index, value in enumerate(values)
    ]


def synchronize_demand_summary(dataset: dict) -> None:
    """Derive rates, dispositions, temporal and cohort summaries atomically in place.

    Validate computational stream fields and cohort weights; ordinary draft foreign-key
    review remains the canonical validator's responsibility. Invalid demand
    raises ValueError with an entry_streams[ID].field path before any mutation.
    At zero total demand use enabled profiles equally, then all declared
    profiles, then valid existing summary profiles (or uniform defaults).
    Cohort totals may remain incomplete while a draft is edited row by row;
    canonical validation still requires normalized totals before publication.
    """
    if not isinstance(dataset, dict):
        raise ValueError("dataset: expected an object")
    summaries = []
    for key in ("arrival_profiles", "baseline"):
        if key in dataset:
            if not isinstance(dataset[key], dict):
                raise ValueError(f"{key}: expected a demand summary object")
            summaries.append(dataset[key])
    if not summaries:
        raise ValueError("arrival_profiles: expected a demand summary object")
    cohorts = dataset.get("cohorts")
    if not isinstance(cohorts, list):
        raise ValueError("cohorts: expected an array")
    cohort_mix = {"ward": [], "icu": []}
    for index, cohort in enumerate(cohorts):
        if not isinstance(cohort, dict):
            raise ValueError(f"cohorts[{index}]: expected a cohort object")
        care = cohort.get("care_level")
        if care not in ("ward", "icu"):
            continue
        weight = cohort.get("selection_weight")
        if not _nonnegative(weight) or weight > 1:
            raise ValueError(
                f"cohorts[{cohort.get('cohort_id', index)}].selection_weight: expected a finite weight from 0 to 1"
            )
        cohort_mix[care].append(weight)
    streams = dataset.get("entry_streams")
    if not isinstance(streams, list):
        raise ValueError("entry_streams: expected an array")
    identities = set()
    for index, stream in enumerate(streams):
        field = f"entry_streams[{index}]"
        if not isinstance(stream, dict):
            raise ValueError(f"{field}: expected a stream object")
        identity = stream.get("entry_stream_id")
        if not isinstance(identity, str) or not identity.strip():
            raise ValueError(f"{field}.entry_stream_id: expected a nonempty identifier")
        field = f"entry_streams[{identity}]"
        if identity in identities:
            raise ValueError(f"{field}.entry_stream_id: duplicate identifier")
        identities.add(identity)
        if stream.get("entry_type") not in ("ed", "direct_ward"):
            raise ValueError(f"{field}.entry_type: expected ed or direct_ward")
        if not isinstance(stream.get("enabled"), bool):
            raise ValueError(f"{field}.enabled: expected a boolean")
        if not _nonnegative(stream.get("expected_arrivals_per_local_day")):
            raise ValueError(f"{field}.expected_arrivals_per_local_day: expected a finite nonnegative rate")
        _weights(stream.get("hour_weights"), 24, 1, field + ".hour_weights")
        _weights(stream.get("weekday_weights"), 7, 7, field + ".weekday_weights")
        disposition = stream.get("disposition_weights")
        if (
            not isinstance(disposition, dict)
            or not disposition
            or any(key not in {"discharge", "ward", "icu"} for key in disposition)
        ):
            raise ValueError(f"{field}.disposition_weights: expected discharge/ward/ICU weights")
        _weights(list(disposition.values()), len(disposition), 1, field + ".disposition_weights")
        if stream["entry_type"] == "direct_ward" and any(
            value != 0 for key, value in disposition.items() if key != "ward"
        ):
            raise ValueError(f"{field}.disposition_weights: direct ward demand must resolve to ward")

    active = [stream for stream in streams if stream["enabled"]]
    ed = [stream for stream in active if stream["entry_type"] == "ed"]
    direct = [stream for stream in active if stream["entry_type"] == "direct_ward"]
    rate_key = "expected_arrivals_per_local_day"
    ed_rate = sum(stream[rate_key] for stream in ed)
    direct_rate = sum(stream[rate_key] for stream in direct)
    total_rate = ed_rate + direct_rate
    if not _nonnegative(total_rate):
        raise ValueError("entry_streams.expected_arrivals_per_local_day: combined rate must be finite")
    admitted = sum(
        stream[rate_key]
        * (stream["disposition_weights"].get("ward", 0) + stream["disposition_weights"].get("icu", 0))
        for stream in ed
    )
    icu = sum(stream[rate_key] * stream["disposition_weights"].get("icu", 0) for stream in ed)
    if not _nonnegative(admitted) or not _nonnegative(icu):
        raise ValueError("entry_streams.disposition_weights: combined disposition rates must be finite")
    resolved = {
        "ed_arrivals_per_local_day": ed_rate,
        "direct_ward_arrivals_per_local_day": direct_rate,
        "ed_admission_probability": admitted / ed_rate if ed_rate else 0,
        "icu_fraction_of_admissions": icu / admitted if admitted else 0,
        "cohort_mix": cohort_mix,
    }
    for key, count, total in (("hour_weights", 24, 1), ("weekday_weights", 7, 7)):
        if total_rate:
            values = [
                sum((stream[rate_key] / total_rate) * stream[key][index] for stream in active)
                for index in range(count)
            ]
        elif active or streams:
            contributors = active or streams
            values = [
                sum(stream[key][index] / len(contributors) for stream in contributors)
                for index in range(count)
            ]
        else:
            values = [total / count] * count
            for summary in summaries:
                try:
                    values = list(_weights(summary.get(key), count, total, key))
                    break
                except ValueError:
                    continue
        resolved[key] = values
    hour_rows = _profile_rows(dataset.get("hour_of_day_baseline"), "hour", "weight", resolved["hour_weights"])
    weekday_rows = _profile_rows(
        dataset.get("weekday_baseline"), "weekday", "multiplier", resolved["weekday_weights"]
    )
    # Assign fresh arrays: a generated baseline may share its old arrays with
    # entry streams, and mutating those arrays would edit authoritative inputs.
    for summary in summaries:
        summary.update(
            {key: list(value) if isinstance(value, list) else value for key, value in resolved.items()}
        )
    dataset["hour_of_day_baseline"] = hour_rows
    dataset["weekday_baseline"] = weekday_rows
