"""Versioned clocks and keyed random streams used throughout the simulator."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

MODEL_VERSION = "1.1.0"
GENERATOR_VERSION = "1.1.0"
T0 = "2026-10-16T05:00:00Z"
ZONE = "America/Chicago"


def dt(value):
    if isinstance(value, datetime):
        result = value
    else:
        result = datetime.fromisoformat(str(value))
    if result.tzinfo is None:
        raise ValueError("Timestamp must have an explicit timezone offset")
    return result.astimezone(UTC)


def iso(value):
    return dt(value).isoformat(timespec="auto").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def rng(seed, *keys):
    material = "|".join(map(str, (seed,) + keys)).encode()
    entropy = int.from_bytes(hashlib.sha256(material).digest()[:16], "little")
    return np.random.Generator(np.random.PCG64(entropy))


def endpoint(start, days, zone=ZONE):
    return (dt(start).astimezone(ZoneInfo(zone)) + timedelta(days=int(days))).astimezone(UTC)


def day_intervals(start, end, zone=ZONE):
    current, finish = dt(start), dt(end)
    tz = ZoneInfo(zone)
    while current < finish:
        local = current.astimezone(tz)
        next_midnight = (
            (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
        )
        nxt = min(next_midnight, finish)
        yield current, nxt, local.date().isoformat()
        current = nxt


def actual_hours(start, end, hour_weights, zone=ZONE):
    """Normalize each complete local day, then clip its exposure to the run interval."""
    tz = ZoneInfo(zone)
    begin, finish = dt(start), dt(end)
    midnight = begin.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    boundary = (midnight + timedelta(days=1)).astimezone(UTC)
    rows, cursor = [], midnight.astimezone(UTC)
    while cursor < boundary:
        nxt = min(cursor + timedelta(hours=1), boundary)
        rows.append((cursor, nxt, float(hour_weights[cursor.astimezone(tz).hour])))
        cursor = nxt
    total = sum(r[2] for r in rows)
    return (
        [
            (
                max(a, begin),
                min(b, finish),
                w / total * (min(b, finish) - max(a, begin)).total_seconds() / (b - a).total_seconds(),
            )
            for a, b, w in rows
            if a < finish and b > begin
        ]
        if total
        else []
    )
