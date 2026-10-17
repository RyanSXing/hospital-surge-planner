"""Exact timeline annotations derived from one immutable replication trace."""

from collections import defaultdict
from datetime import timedelta

from .domain import date


def intervention_results(trace):
    """Enrich missing result times only from uniquely attributable actual events."""
    events = defaultdict(list)
    for event in trace.get("events", []):
        if event.get("event_type") not in {"intervention_ready", "intervention_failed"}:
            continue
        payload = event.get("payload") or {}
        identity = payload.get("id") or payload.get("intervention_id")
        if identity:
            events[(event["event_type"], identity)].append(event)
    results = []
    for original in trace.get("interventions", []):
        result = dict(original)
        if not result.get("ready_at") and not result.get("at"):
            event_type = (
                "intervention_failed" if result.get("status") == "infeasible" else "intervention_ready"
            )
            identity = result.get("id") or result.get("intervention_id")
            matches = [
                event
                for event in events.get((event_type, identity), [])
                if not event["payload"].get("kind") or event["payload"]["kind"] == result.get("kind")
            ]
            if len(matches) == 1:
                result["at"] = matches[0]["occurred_at"]
        results.append(result)
    return results


def shortage_periods(trace):
    """Union positive-duration admission-pending intervals, combining tied edges."""
    start = date(trace["start_at"])
    horizon = (date(trace["end_at"]) - start).total_seconds() / 60
    changes = defaultdict(int)
    patients = trace.get("patients", [])
    if isinstance(patients, dict):
        patients = patients.values()
    for patient in patients:
        for interval in patient.get("state_intervals", []):
            if not interval.get("admission_pending"):
                continue
            lower = max(0.0, float(interval["start_elapsed_minutes"]))
            upper = interval.get("end_elapsed_minutes")
            upper = min(horizon, float(upper) if upper is not None else horizon)
            if upper > lower:
                changes[lower] += 1
                changes[upper] -= 1
    periods = []
    count = 0
    opened = None
    for minute, change in sorted(changes.items()):
        previous, count = count, count + change
        if previous == 0 and count > 0:
            opened = minute
        elif previous > 0 and count == 0:
            periods.append(
                {
                    "start_at": (start + timedelta(minutes=opened)).isoformat().replace("+00:00", "Z"),
                    "end_at": (start + timedelta(minutes=minute)).isoformat().replace("+00:00", "Z"),
                    "start_elapsed_minutes": opened,
                    "end_elapsed_minutes": minute,
                }
            )
    return periods
