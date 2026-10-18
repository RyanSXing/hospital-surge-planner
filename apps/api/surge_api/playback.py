"""Bounded, immutable floor-plan playback from exact recorded change points.

The initial observation uses the existing exact-state reconstruction. Subsequent
frames sweep stored histories and patient transitions, so the client can advance
its clock locally without a request per event or fabricated intermediate beds.
"""

from __future__ import annotations

import copy
import math
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import timedelta

from surge_engine.common import dt, iso

from .db import canonical
from .replay import exact_state, flow_counter_for
from .treatment_status import treatment_index_for

MAX_WINDOW_MINUTES = 240
MAX_FRAMES = 10000
MAX_CHANGES = 100000
MAX_EVENTS = 25000
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MOTION_EVENTS = {"arrival", "assessment_start", "clinic_start", "admission", "transfer_arrived", "discharge"}
QUEUE_FIELDS = ("total", "ward", "icu", "ed", "ed_boarding", "direct_waiting", "stepdown")
GROUP_FIELDS = (
    "state",
    "care_level",
    "facility_id",
    "unit_id",
    "prior_state",
    "target_unit_kind",
    "admission_pending",
    "eligible_for_transfer",
)


class PlaybackWindowError(ValueError):
    def __init__(self, message, code="invalid_playback_window", status=422):
        super().__init__(message)
        self.code, self.status = code, status


def _too_large():
    raise PlaybackWindowError(
        "This recorded playback window is too large. Request a shorter interval.",
        "playback_window_too_large",
        413,
    )


def playback_bounds(trace, start_at, end_at):
    """Validate explicit, offset-aware times against the frozen trace horizon."""
    try:
        origin, start, end = dt(trace["start_at"]), dt(start_at), dt(end_at)
        lower = (start - origin).total_seconds() / 60
        upper = (end - origin).total_seconds() / 60
        horizon = float(trace["horizon_elapsed_minutes"])
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise PlaybackWindowError("Invalid recorded playback timestamps.") from error
    if not all(math.isfinite(value) for value in (lower, upper, horizon)):
        raise PlaybackWindowError("Invalid recorded playback timestamps.")
    if lower < 0 or upper > horizon or upper <= lower:
        raise PlaybackWindowError(
            "Playback window must be inside the saved run and have a positive duration."
        )
    if upper - lower > MAX_WINDOW_MINUTES:
        _too_large()
    return iso(start), iso(end), lower, upper


def _current(history, minute, key):
    index = bisect_right([row[key] for row in history], minute) - 1
    return history[index] if index >= 0 else None


def _positive(counter):
    return {key: value for key, value in counter.items() if value > 0}


class _FloorCounters:
    """Incremental full-population counts; overlapping reasons stay separate."""

    def __init__(self, patients, units, blockers, flow_counter, treatment_counter):
        self.units, self.blockers = units, blockers
        self.flow_counter = flow_counter
        self.treatment_counter = treatment_counter
        self.main = self._main()
        self.patients, self.contributions = {}, {}
        self.members = defaultdict(set)
        self.by_state, self.by_care, self.by_facility, self.groups = (
            Counter(),
            Counter(),
            Counter(),
            Counter(),
        )
        self.queues, self.unit_blockers, self.site_blockers = (
            defaultdict(Counter),
            defaultdict(Counter),
            defaultdict(Counter),
        )
        self.unit_presence = Counter()
        for patient in patients:
            self.replace(patient["patient_id"], patient)

    def _main(self):
        return next(
            (unit["facility_id"] for unit in self.units.values() if unit.get("kind") == "ed"), "FAC-MAIN"
        )

    def _contribution(self, patient):
        state, care = patient["state"], patient.get("care_level")
        site = (
            patient.get("facility_id")
            or self.units.get(patient.get("unit_id"), {}).get("facility_id")
            or self.main
        )
        pending = bool(patient.get("admission_pending"))
        group = (
            state,
            care,
            site,
            patient.get("unit_id"),
            (patient.get("pending_transfer") or {}).get("prior_state") or patient.get("prior_state"),
            patient.get("target_unit_kind"),
            pending,
            patient.get("eligible_for_transfer"),
        )
        queue = Counter()
        if pending:
            queue["total"] += 1
            required = patient.get("target_unit_kind", care)
            if required in {"ward", "icu"}:
                queue[required] += 1
            if state in {"ed_boarding", "direct_waiting"}:
                queue[state] += 1
            if state == "inpatient":
                queue["stepdown"] += 1
        if state == "ed_waiting":
            queue["ed"] += 1
        blocker = self.blockers.get(patient.get("queue_group"), {})
        if state in {"in_transit", "transfer_reserved"}:
            reasons = {"in_transit" if state == "in_transit" else "awaiting_transport_pickup"}
            details = patient.get("blocker_units", [])
        elif pending or state == "ed_waiting":
            reasons, details = set(blocker.get("reasons", [])), blocker.get("units", [])
        else:
            reasons, details = set(), patient.get("blocker_units", [])
        affected = defaultdict(set)
        for detail in details:
            if detail.get("unit_id"):
                affected[detail["unit_id"]].update(detail.get("reasons", []))
        if patient.get("care_paused") and patient.get("unit_id"):
            affected[patient["unit_id"]].update(patient.get("care_pause_reasons", []))
        return state, care or "unknown", site, group, queue, affected, reasons

    def _count(self, contribution, sign):
        state, care, site, group, queue, affected, reasons = contribution
        self.by_state[state] += sign
        self.by_care[care] += sign
        self.by_facility[site] += sign
        self.groups[group] += sign
        for kind, value in queue.items():
            self.queues[site][kind] += sign * value
        for unit, unit_reasons in affected.items():
            self.unit_presence[unit] += sign
            for reason in unit_reasons:
                self.unit_blockers[unit][reason] += sign
        for reason in reasons:
            self.site_blockers[site][reason] += sign

    def replace(self, identity, patient):
        if identity in self.patients:
            old = self.patients.pop(identity)
            self.members[old.get("queue_group")].discard(identity)
            self._count(self.contributions.pop(identity), -1)
        if patient is not None and patient.get("state") != "discharged":
            self.patients[identity] = patient
            self.members[patient.get("queue_group")].add(identity)
            contribution = self._contribution(patient)
            self.contributions[identity] = contribution
            self._count(contribution, 1)

    def refresh(self, identities):
        for identity in identities:
            if identity in self.patients:
                self._count(self.contributions[identity], -1)
                contribution = self._contribution(self.patients[identity])
                self.contributions[identity] = contribution
                self._count(contribution, 1)

    def snapshot(self, trace, minute):
        groups = [
            {**dict(zip(GROUP_FIELDS, group, strict=True)), "count": count}
            for group, count in sorted(self.groups.items(), key=lambda item: repr(item[0]))
            if count > 0
        ]
        return {
            "patient_total": len(self.patients),
            "patient_counts": {
                "total": len(self.patients),
                "by_state": _positive(self.by_state),
                "by_facility": _positive(self.by_facility),
                "by_care_level": _positive(self.by_care),
            },
            "queue_counts": {
                site: {kind: counts[kind] for kind in QUEUE_FIELDS}
                for site, counts in self.queues.items()
                if any(value > 0 for value in counts.values())
            },
            "blocker_counts_by_unit": {
                unit: _positive(self.unit_blockers[unit])
                for unit, count in self.unit_presence.items()
                if count > 0
            },
            "blocker_summary": {
                site: _positive(counts) for site, counts in self.site_blockers.items() if _positive(counts)
            },
            "flow_counts": self.flow_counter(minute),
            "flow_counts_start_at": trace["start_at"],
            "treatment_status": self.treatment_counter(minute),
            "patient_groups": groups,
        }


def playback_window(trace, start_at, end_at):
    """Complete `(start, end]` changes, never a sampled or silently clipped feed."""
    start_at, end_at, lower, upper = playback_bounds(trace, start_at, end_at)
    origin, start, end = dt(trace["start_at"]), dt(start_at), dt(end_at)
    if not all(
        isinstance(trace.get(key), kind)
        for key, kind in (
            ("patients", list),
            ("unit_history", dict),
            ("slot_history", dict),
            ("events", list),
        )
    ):
        raise PlaybackWindowError(
            "This saved run does not contain complete recorded floor-plan playback.",
            "playback_window_unavailable",
            409,
        )
    timeline = defaultdict(
        lambda: {"slots": {}, "units": {}, "patients": {}, "blockers": {}, "operations": {}}
    )
    change_count = 0

    def add(minute, kind, identity, record):
        nonlocal change_count
        if lower < minute <= upper:
            timeline[minute][kind][identity] = record
            change_count += 1
            if len(timeline) > MAX_FRAMES or change_count > MAX_CHANGES:
                _too_large()

    for collection, kind in (("slot_history", "slots"), ("unit_history", "units")):
        for identity, history in trace[collection].items():
            for record in history:
                add(record["elapsed_minutes"], kind, identity, record)
    for patient in trace["patients"]:
        for record in patient.get("state_intervals", []):
            add(record["start_elapsed_minutes"], "patients", patient["patient_id"], record)
    blockers = {}
    for group, history in trace.get("blocker_history", {}).items():
        current = _current(history, lower, "start_elapsed_minutes")
        if current is not None:
            blockers[group] = current
        for record in history:
            add(record["start_elapsed_minutes"], "blockers", group, record)
    treatment_index = treatment_index_for(trace)
    for minute in treatment_index.changes(lower, upper):
        # Hospital-wide pause/resume remains observable with no patients and
        # without any unit, slot, queue or physical movement change.
        add(minute, "operations", "treatment_status", None)
    events = []
    for event in trace["events"]:
        # Flow counts use the exact same numeric trace index as /state.
        minute = event.get("elapsed_minutes")
        if (
            event.get("event_type") in {"arrival", "discharge"}
            and isinstance(minute, (int, float))
            and lower < minute <= upper
        ):
            timeline[minute]
        if event.get("event_type") in MOTION_EVENTS and start < dt(event["occurred_at"]) <= end:
            events.append(event)
            if len(events) > MAX_EVENTS:
                _too_large()
    timeline[upper]  # An explicit exact end boundary also covers empty windows.
    if len(timeline) > MAX_FRAMES:
        _too_large()
    index_units = {
        identity: record
        for identity, history in trace["unit_history"].items()
        if (record := _current(history, lower, "elapsed_minutes")) is not None
    }
    main = next(
        (unit["facility_id"] for unit in index_units.values() if unit.get("kind") == "ed"), "FAC-MAIN"
    )
    flow_counter = flow_counter_for(trace, main, index_units)
    initial = exact_state(trace, start_at, flow_counter=flow_counter, treatment_counter=treatment_index.at)
    units = {unit["unit_id"]: unit for unit in initial["units"]}
    counters = _FloorCounters(initial["patients"], units, blockers, flow_counter, treatment_index.at)
    initial_state = {
        "at": start_at,
        "elapsed_minutes": lower,
        "replication_id": trace["replication_id"],
        "source": "selected_replication",
        "units": initial["units"],
        "slots": initial["slots"],
        "patients": [],
        "partial_collections": ["patients"],
        **counters.snapshot(trace, lower),
    }
    frames = []
    for minute, changes in sorted(timeline.items()):
        refresh = set()
        changed_topology = any(
            (units.get(identity, {}).get("facility_id"), units.get(identity, {}).get("kind"))
            != (record.get("facility_id"), record.get("kind"))
            for identity, record in changes["units"].items()
        )
        units.update(changes["units"])
        counters.main = counters._main()
        if changed_topology:
            refresh.update(counters.patients)
        for group, record in changes["blockers"].items():
            blockers[group] = record
            refresh.update(counters.members[group])
        for identity, record in changes["patients"].items():
            counters.replace(identity, record)
            refresh.discard(identity)
        counters.refresh(refresh)
        frames.append(
            {
                "at": iso(origin + timedelta(minutes=minute)),
                "elapsed_minutes": minute,
                "slots": list(changes["slots"].values()),
                "units": list(changes["units"].values()),
                "aggregates": counters.snapshot(trace, minute),
            }
        )
    value = {
        "schema_version": "1.0",
        "complete": True,
        "replication_id": trace["replication_id"],
        "start_at": start_at,
        "end_at": end_at,
        "final_state_at": end_at,
        "initial_state": initial_state,
        "frames": frames,
        "events": sorted(
            events, key=lambda event: (dt(event["occurred_at"]), event.get("sequence_number", 0))
        ),
        "limits": {"max_window_minutes": MAX_WINDOW_MINUTES},
    }
    for field in ("model_version", "hospital_operations_model_version"):
        if field in trace:
            value[field] = trace[field]
    if len(canonical(value)) > MAX_RESPONSE_BYTES:
        _too_large()
    # Neither callers nor a JSON encoder can mutate the shared immutable cache.
    return copy.deepcopy(value)
