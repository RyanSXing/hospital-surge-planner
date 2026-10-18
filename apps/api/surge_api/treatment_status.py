"""Indexed, read-only treatment status from immutable operations observations.

Stock movement alone is not a status change. Unknown observations break both
continuity and any claim about the most recent resumption; scenario inputs and
patient samples are never substitutes for a recorded hospital-wide observation.
"""

from __future__ import annotations

import math
import threading
from bisect import bisect_right
from collections import OrderedDict
from dataclasses import dataclass

from surge_engine.common import dt, iso

_lock = threading.RLock()
_indexes = OrderedDict()
MAX_CACHED_HISTORIES = 4
MAX_CACHED_OBSERVATIONS = 250000


@dataclass(frozen=True)
class _Status:
    paused: bool
    disrupted: bool
    reasons: tuple[str, ...]
    since: str
    resumed: str | None

    def public(self):
        return {
            "care_paused": self.paused,
            "treatment_disrupted": self.disrupted,
            "reasons": list(self.reasons),
            "since_at": self.since,
            "last_resumed_at": self.resumed,
        }


@dataclass(frozen=True)
class TreatmentStatusIndex:
    times: tuple[float, ...] = ()
    states: tuple[_Status | None, ...] = ()

    def at(self, minute):
        position = bisect_right(self.times, minute) - 1
        status = self.states[position] if position >= 0 else None
        return status.public() if status is not None else None

    def changes(self, lower, upper):
        return self.times[bisect_right(self.times, lower) : bisect_right(self.times, upper)]


_UNAVAILABLE = TreatmentStatusIndex()


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _observation(row, origin):
    """Locate malformed observations where possible, so they create real gaps."""
    if not isinstance(row, dict):
        return None
    minute = row.get("elapsed_minutes")
    valid_minute = _number(minute)
    try:
        at = dt(row["at"])
    except (KeyError, TypeError, ValueError, OverflowError):
        at = None
    if at is not None:
        # Public timestamps have microsecond precision. Use the same recorded
        # boundary for ISO /state requests and the continuous playback feed.
        recorded_minute = (at - origin).total_seconds() / 60
    elif valid_minute:
        recorded_minute = float(minute)
    else:
        return None
    paused, disrupted = row.get("care_paused"), row.get("treatment_disrupted")
    valid = (
        valid_minute
        and at is not None
        and abs(recorded_minute - minute) <= 1e-7
        and type(paused) is bool
        and type(disrupted) is bool
        and not (disrupted and not paused)
    )
    if not valid:
        return recorded_minute, None
    reasons = []
    if disrupted:
        reasons.append("treatment_disruption")
    stock = row.get("medical_supply_stock")
    exhausted = _number(stock) and 0 <= stock <= 1e-9
    if exhausted:
        if not paused:
            return recorded_minute, None
        reasons.append("medical_supplies")
    return recorded_minute, (paused, disrupted, tuple(reasons), iso(at))


def _build(history, origin):
    observations = {}
    for row in history:
        observation = _observation(row, origin)
        if observation is None:
            # Its time is unknown: no safe interval can be assigned to the gap.
            return _UNAVAILABLE
        minute, value = observation
        observations[minute] = value  # Last observation wins at equal time.
    times, states = [], []
    previous = None
    resumed = None
    for minute, value in sorted(observations.items()):
        if value is None:
            if previous is not None or not times:
                times.append(minute)
                states.append(None)
            previous, resumed = None, None
            continue
        paused, disrupted, reasons, at = value
        signature = (paused, disrupted, reasons)
        if previous is not None and signature == previous[:3]:
            continue
        if previous is not None and previous[0] and not paused:
            resumed = at
        status = _Status(paused, disrupted, reasons, at, resumed)
        times.append(minute)
        states.append(status)
        previous = signature
    return TreatmentStatusIndex(tuple(times), tuple(states))


def treatment_index_for(trace):
    """Pin one immutable index per window; bounded cache makes warm seeks O(log n)."""
    history = trace.get("operations_history")
    if not isinstance(history, list) or not history:
        return _UNAVAILABLE
    try:
        origin = dt(trace["start_at"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return _UNAVAILABLE
    key = (
        trace.get("replication_id"),
        trace.get("model_version"),
        trace.get("hospital_operations_model_version"),
        trace["start_at"],
        id(history),
    )
    with _lock:
        entry = _indexes.get(key)
        if entry is not None and entry[0] is history:
            _indexes.move_to_end(key)
            return entry[1]
        index = _build(history, origin)
        if len(history) <= MAX_CACHED_OBSERVATIONS:
            while _indexes and (
                len(_indexes) >= MAX_CACHED_HISTORIES
                or sum(len(value[0]) for value in _indexes.values()) + len(history) > MAX_CACHED_OBSERVATIONS
            ):
                _indexes.popitem(last=False)
            # Keep only the source history (not its potentially huge trace).
            # The identity check cannot hit a recycled Python list address.
            _indexes[key] = (history, index)
        return index
