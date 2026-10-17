"""Constrained discrete-event hospital flow, scheduled by SimPy.

All allocation is atomic at one explicit manager. SimPy controls simulated time;
no mutable Resource capacity or hidden repair of an impossible census is used.
"""

from __future__ import annotations

import bisect
import copy
import heapq
import itertools
import math
from collections import Counter, defaultdict
from datetime import timedelta
from zoneinfo import ZoneInfo

import numpy as np
import simpy
from scipy.stats import gamma as gamma_distribution

from .common import *
from .equipment_planning import apply_planned_equipment
from .pathways import (
    apply_stage_profile,
    begin_stepdown,
    choose_cohort,
    choose_profile,
    compatible,
    configure_path,
    equipment,
    pathway,
    prepare_stepdown,
    queue_profile,
    queue_spec,
    stage_profile,
)


class SimulationCancelled(Exception):
    pass


class SimulationLimitExceeded(ValueError):
    pass


def _public_patient(p):
    return {k: copy.deepcopy(v) for k, v in p.items() if not k.startswith("_")}


class HospitalSimulation:
    def __init__(self, dataset, scenario, index, keep_trace, cancel_check=None):
        self.data = dataset
        self.scenario = scenario
        self.index = index
        self.keep = keep_trace
        self.cancel = cancel_check
        self.start = dt(scenario.get("start_at", dataset["snapshot_at"]))
        self.zone = scenario.get("timezone", dataset.get("timezone", ZONE))
        self.days = int(scenario.get("horizon_calendar_days", 30))
        if not 1 <= self.days <= 365:
            raise ValueError("Horizon must be 1–365 local calendar days")
        self.end = endpoint(self.start, self.days, self.zone)
        self.horizon = (self.end - self.start).total_seconds() / 60
        if scenario.get("end_at") and dt(scenario["end_at"]) != self.end:
            if scenario.get("state_origin") == "observed_reset":
                self.end = dt(scenario["end_at"])
                self.horizon = (self.end - self.start).total_seconds() / 60
                if not 0 < self.horizon <= 527100:
                    raise ValueError("Observed reset end must be after snapshot and within 365 calendar days")
            else:
                raise ValueError("end_at does not match calendar horizon")
        self.seed = int(scenario.get("base_seed", 20261016))
        self.branch_at = (
            (dt(scenario["branch_at"]) - self.start).total_seconds() / 60
            if scenario.get("branch_strategy") == "selected_replication" and scenario.get("branch_at")
            else None
        )
        self.parent_index = int(scenario.get("branch_replication_index", index))
        self.repseed = int(rng(self.seed, index, "replication").integers(0, 2**31))
        self.rid = f"RUN-{digest([self.seed, index, scenario.get('id', scenario.get('scenario_revision_id', 'scenario'))])[:20]}"
        self.env = simpy.Environment()
        self.now = 0.0
        self.heap = []
        self.next_seq = 0
        self.event_seq = 0
        self.event_count = 0
        self.event_limit = int(scenario.get("max_events_per_replication", 2_000_000))
        self.patients = {}
        self.queues = {"ed": set(), "ward": set(), "icu": set()}
        self.qheap = defaultdict(list)
        self.queue_members = defaultdict(set)
        self.blocker_history = defaultdict(list)
        self.current_blockers = {}
        self._blocker_inputs = {}
        self.blocker_patient_hours = Counter()
        self.admission_pending = set()
        self.ed_pending = set()
        self.transfer_pending = set()
        self.units = {
            u["unit_id"]: dict(
                copy.deepcopy(u),
                occupants=set(),
                reservations={},
                cleaning={},
                slots=[],
                active_staff={},
                staffed=0,
                gate=True,
                active=next(
                    (
                        f.get("status") == "active"
                        for f in dataset["facilities"]
                        if f["facility_id"] == u["facility_id"]
                    ),
                    False,
                ),
            )
            for u in dataset["units"]
        }
        # Unit identities, kinds and capacity modes are fixed by the validated
        # dataset. Interventions change their live capacity, never this inventory.
        self._ordered_units = tuple(sorted(self.units.values(), key=lambda u: u["unit_id"]))
        self._staff_units_by_kind = {
            kind: tuple(
                u for u in self.units.values() if u["kind"] == kind and u["capacity_mode"] == "staff_derived"
            )
            for kind in ("ward", "icu", "ed")
        }
        self._ordered_staff_units_by_kind = {
            kind: tuple(
                u for u in self._ordered_units if u["kind"] == kind and u["capacity_mode"] == "staff_derived"
            )
            for kind in ("ward", "icu", "ed")
        }
        main_facility = dataset.get("entry_streams", [{"destination_facility_id": "FAC-MAIN"}])[0].get(
            "destination_facility_id", "FAC-MAIN"
        )
        self._main_care_units = tuple(
            u
            for u in self.units.values()
            if u["facility_id"] == main_facility and u["kind"] in ("ward", "icu", "ed")
        )
        self.slots = {s["slot_id"]: copy.deepcopy(s) for s in dataset["slots"]}
        for slot in self.slots.values():
            self.units[slot["unit_id"]]["slots"].append(slot["slot_id"])
        for u in self.units.values():
            self.refresh_slots(u)
        self.policies = {p["capacity_policy_id"]: p for p in dataset.get("capacity_policies", [])}
        self.staff = {p["staff_id"]: p for p in dataset["staff"]}
        self.active_assignments = {}
        self.absences = []
        self.active_plans = {}
        self.intervention_results = []
        self.pools = {
            p["equipment_pool_id"]: dict(
                copy.deepcopy(p),
                source_equipment_pool_id=p["equipment_pool_id"],
                created_in_trajectory=False,
                in_use={},
                reserved={},
                pending_decommission=0,
                failed=p.get("unserviceable_quantity", 0),
            )
            for p in dataset["equipment_pools"]
        }
        for p in dataset.get("partner_equipment", []):
            self.pools[p["advertisement_id"]] = {
                "equipment_pool_id": p["advertisement_id"],
                "source_equipment_pool_id": p["advertisement_id"],
                "created_in_trajectory": False,
                "unit_id": p["unit_id"],
                "facility_id": p["facility_id"],
                "capability_code": p["capability_code"],
                "quantity": p["quantity"],
                "in_use": {},
                "reserved": {},
                "pending_decommission": 0,
                "failed": 0,
                "portable": False,
            }
        self._equipment_index = None
        self.vehicles = {
            v["vehicle_id"]: dict(
                copy.deepcopy(v), location=v["home_facility_id"], available_at=0.0, mission=None
            )
            for v in dataset.get("vehicles", [])
        }
        self.routes = {
            (r["from_facility_id"], r["to_facility_id"]): copy.deepcopy(r) for r in dataset.get("routes", [])
        }
        self.route_overrides = defaultdict(list)
        self.base_routes = copy.deepcopy(self.routes)
        self.templates = {t["template_id"]: t for t in dataset["los_templates"]}
        self.cohorts = {c["cohort_id"]: c for c in dataset["cohorts"]}
        self.events = []
        self.series = []
        self.checkpoints = []
        self.unit_history = defaultdict(list)
        self.vehicle_history = defaultdict(list)
        self.slot_history = defaultdict(list)
        self.equipment_pool_history = defaultdict(list)
        self.unit_series = {
            uid: {
                "unit_id": uid,
                "fields": {
                    k: []
                    for k in (
                        "physical",
                        "enabled",
                        "staffed",
                        "occupied",
                        "reserved",
                        "cleaning",
                        "ready",
                        "available",
                        "capacity_deficit",
                    )
                },
            }
            for uid in self.units
        }
        self.metrics = Counter()
        self.first_shortage = None
        self.peak = 0
        self.peak_at = 0.0
        self.completed_waits = []
        self.daily = {}
        self.measure_start = (
            (
                dt(scenario.get("measurement_start_at") or scenario.get("branch_at")) - self.start
            ).total_seconds()
            / 60
            if scenario.get("measurement_start_at") or scenario.get("branch_at")
            else 0.0
        )
        self.measure_initial = len(dataset["patients"])
        self.current_day = None
        self.last_unit_snapshots = {}
        self.last_vehicle_snapshots = {}
        self.last_slot_snapshots = {}
        self.last_equipment_pool_snapshots = {}
        self._unit_snapshot_inputs = {}
        self._slot_snapshot_inputs = {}
        self._vehicle_snapshot_inputs = {}
        self._equipment_pool_snapshot_inputs = {}
        # All spaces are declared before a run. Capacity updates enable/install
        # these same records; references let unchanged groups compare in C.
        self._unit_slot_records = {
            uid: [self.slots[sid] for sid in unit["slots"]] for uid, unit in self.units.items()
        }
        self.conditions = copy.deepcopy(scenario.get("conditions", []))
        self.normalize_conditions()
        self.initialize()

    def at(self, minute):
        return iso(self.start + timedelta(minutes=float(minute)))

    def minute(self, t):
        return (dt(t) - self.start).total_seconds() / 60

    def schedule(self, when, kind, payload=None, phase=1):
        when = float(when)
        if when < -1e-7:
            return
        if when > self.horizon + 1e-7:
            return
        self.next_seq += 1
        heapq.heappush(self.heap, (max(0.0, when), phase, self.next_seq, kind, payload))

    def stream_index(self, time):
        if self.branch_at is None:
            return self.index
        return (
            self.parent_index
            if time < self.branch_at
            else ("branch", self.parent_index, self.index, self.branch_at)
        )

    def random(self, pid, name):
        return rng(
            self.seed, self.patients.get(pid, {}).get("_random_index", self.stream_index(self.now)), name, pid
        )

    def emit(self, kind, p=None, source=None, dest=None, reason=None, payload=None, resources=None):
        self.event_seq += 1
        if not self.keep:
            return
        self.events.append(
            {
                "event_id": f"{self.rid}-E{self.event_seq:08}",
                "run_group_id": self.scenario.get("run_group_id"),
                "replication_id": self.rid,
                "replication_index": self.index,
                "sequence_number": self.event_seq,
                "occurred_at": self.at(self.now),
                "elapsed_minutes": round(self.now, 8),
                "event_type": kind,
                "patient_id": p["patient_id"] if p else None,
                "from_unit_id": source,
                "to_unit_id": dest,
                "resource_ids": resources or [],
                "reason_code": reason,
                "payload": payload or {},
            }
        )

    def normalize_conditions(self):
        seen = []
        for c in self.conditions:
            kind = c.get("kind", c.get("type"))
            if kind in {"staff_absence", "staff_unavailability"}:
                c["kind"] = "staff_unavailability"
                if "absence_percent" in c and "count" not in c and not c.get("staff_ids"):
                    percent = c["absence_percent"]
                    if (
                        isinstance(percent, bool)
                        or not isinstance(percent, (int, float))
                        or not math.isfinite(percent)
                        or not 0 <= percent <= 100
                    ):
                        raise ValueError("Staff absence percent must be between zero and 100")
                    unit = self.units.get(c.get("unit_id"))
                    if unit is None:
                        raise ValueError("Staff absence requires a declared unit")
                    c["count"] = math.ceil(unit.get("baseline_staff", {}).get("rn", 0) * percent / 100)
            if kind == "arrival_multiplier":
                stream = c.get("entry_stream_id", "ED_MAIN")
                points = c.get("control_points")
                if not points:
                    mult = 1 + float(c.get("surge_percent", 70)) / 100
                    if c.get("shape") == "wave":
                        points = [
                            {"at": self.at(0), "multiplier": 1},
                            {
                                "at": iso(endpoint(self.start, min(10, self.days), self.zone)),
                                "multiplier": mult,
                            },
                            {"at": self.at(self.horizon), "multiplier": 1},
                        ]
                        c["shape"] = "piecewise_linear"
                    else:
                        points = [
                            {"at": c.get("start_at", self.at(0)), "multiplier": mult},
                            {"at": c.get("end_at", self.at(self.horizon)), "multiplier": mult},
                        ]
                        c["shape"] = "step"
                vals = [(self.minute(p["at"]), float(p["multiplier"])) for p in points]
                if any(not math.isfinite(v) or v < 0 for _, v in vals):
                    raise ValueError("Arrival multipliers must be finite and nonnegative")
                if len(vals) < 2 or any(b[0] <= a[0] for a, b in itertools.pairwise(vals)):
                    raise ValueError("Control-point times must be strictly increasing")
                if any(s == stream and max(a, vals[0][0]) < min(b, vals[-1][0]) for s, a, b in seen):
                    raise ValueError("Overlapping arrival multiplier conditions")
                seen.append((stream, vals[0][0], vals[-1][0]))
                c["_points"] = vals

    def multiplier(self, stream, a, b):
        total = b - a
        for c in self.conditions:
            if c.get("kind") != "arrival_multiplier" or c.get("entry_stream_id", "ED_MAIN") != stream:
                continue
            pts = c["_points"]
            left, right = max(a, pts[0][0]), min(b, pts[-1][0])
            if left >= right:
                continue
            cuts = sorted({left, right, *[t for t, _ in pts if left < t < right]})
            area = 0
            for x, y in itertools.pairwise(cuts):
                i = max(0, min(len(pts) - 2, bisect.bisect_right([p[0] for p in pts], x) - 1))
                t0, v0 = pts[i]
                t1, v1 = pts[i + 1]
                if c.get("shape") == "piecewise_linear":
                    vx = v0 + (v1 - v0) * (x - t0) / (t1 - t0)
                    vy = v0 + (v1 - v0) * (y - t0) / (t1 - t0)
                    area += (vx + vy) / 2 * (y - x)
                else:
                    area += v0 * (y - x)
            total += area - (right - left)
        return total / (b - a)

    def duration(self, pid, template, stage="service"):
        t = self.templates[template]
        g = self.random(pid, stage + "-duration")
        value = t["fixed_minutes"] if t["family"] == "fixed" else g.gamma(t["shape"], t["scale_hours"] * 60)
        return max(t.get("minimum_minutes", 30), round(float(value)))

    def remaining(self, p):
        spec = p.get("remaining_stage_spec")
        if not spec:
            if p.get("remaining_stay_minutes") is not None:
                spec = {"kind": "fixed_minutes", "minutes": p["remaining_stay_minutes"]}
            elif p.get("assessment_remaining_minutes") is not None:
                spec = {"kind": "fixed_minutes", "minutes": p["assessment_remaining_minutes"]}
            elif p.get("remaining_stay_template_id"):
                spec = {"kind": "remaining_distribution", "distribution_id": p["remaining_stay_template_id"]}
            else:
                raise ValueError(f"Missing remaining stage for {p['patient_id']}")
        if spec["kind"] == "fixed_minutes":
            return float(spec["minutes"])
        if spec["kind"] == "expected_end":
            value = self.minute(spec["expected_end_at"])
            if value <= 0:
                raise ValueError("Expected stage end must be after snapshot")
            return value
        if spec["kind"] == "remaining_distribution":
            return self.duration(p["patient_id"], spec["distribution_id"], "remaining")
        t = self.templates[spec["distribution_id"]]
        elapsed = spec["elapsed_minutes"]
        sf = gamma_distribution.sf(elapsed, a=t["shape"], scale=t["scale_hours"] * 60)
        if sf < 1e-12:
            raise ValueError("Conditional remaining-stay tail mass is numerically negligible")
        value = (
            gamma_distribution.isf(
                sf * (1 - self.random(p["patient_id"], "conditional").random()),
                a=t["shape"],
                scale=t["scale_hours"] * 60,
            )
            - elapsed
        )
        return max(1, round(float(value)))

    def choose_path(self, p, stream=None):
        configure_path(self, p, stream)

    def transition(self, p, state, unit=None, slot=None):
        old_unit = p.get("unit_id")
        if self.keep and p.get("state_intervals"):
            p["state_intervals"][-1]["end_at"] = self.at(self.now)
            p["state_intervals"][-1]["end_elapsed_minutes"] = self.now
        p.update(state=state, unit_id=unit, slot_id=slot, state_entered_at=self.at(self.now))
        if unit or state in ("in_transit", "discharged"):
            p["queue_location_id"] = None
        if unit:
            p["facility_id"] = self.units[unit]["facility_id"]
            if unit != old_unit or not p.get("unit_entered_at"):
                p["unit_entered_at"] = self.at(self.now)
        elif state in ("discharged", "in_transit", "ed_waiting", "direct_waiting"):
            p["unit_entered_at"] = None
        if self.keep:
            p.setdefault("state_intervals", []).append(
                {
                    "start_at": self.at(self.now),
                    "start_elapsed_minutes": self.now,
                    "end_at": None,
                    "end_elapsed_minutes": None,
                    "state": state,
                    "unit_entered_at": p.get("unit_entered_at"),
                    "current_stage_started_at": p.get("current_stage_started_at"),
                    "admission_requested_at": p.get("admission_requested_at"),
                    "admitted_at": p.get("admitted_at"),
                    "queue_entered_at": p.get("queue_entered_at"),
                    "queue_location_id": p.get("queue_location_id"),
                    "expected_stage_end_at": self.at(p["_service_end"])
                    if p.get("_service_end")
                    and (
                        state == "inpatient"
                        or (
                            state == "transfer_reserved"
                            and (p.get("pending_transfer") or {}).get("prior_state") == "inpatient"
                        )
                    )
                    else None,
                    "unit_id": unit,
                    "slot_id": slot,
                    "facility_id": p.get("facility_id"),
                    "care_level": p.get("care_level"),
                    "stage_status": p.get("stage_status"),
                    "cohort_template_id": p.get("cohort_template_id"),
                    "acuity_rank": p.get("acuity_rank"),
                    "sampled_stage_minutes": p.get("sampled_stage_minutes"),
                    "resource_profile_id": p.get("resource_profile_id"),
                    "clinic_policy_id": p.get("clinic_policy_id"),
                    "required_transport_capability": p.get("required_transport_capability"),
                    "target_unit_kind": p.get("target_unit_kind"),
                    "admission_pending": p["patient_id"] in self.admission_pending,
                    "vehicle_id": (p.get("pending_transfer") or {}).get("vehicle_id"),
                    "resource_requirements": copy.deepcopy(p.get("resource_requirements", [])),
                    "allocated_resource_ids": ([slot] if slot else [])
                    + [a[0] for a in p.get("_allocations", [])],
                    "pending_transfer": copy.deepcopy(p.get("pending_transfer")),
                    "eligible_for_transfer": p.get("eligible_for_transfer", False),
                    "eligible_for_clinic_diversion": p.get("eligible_for_clinic_diversion", False),
                    "needs_advanced_transport": p.get("needs_advanced_transport", False),
                    "queue_group": p["_queue_group"][0] + ":" + ",".join(p["_queue_group"][1])
                    if p.get("_queue_group")
                    else None,
                    "inpatient_resource_requirements": copy.deepcopy(p.get("_inpatient_requirements", []))
                    if state
                    in ("ed_boarding", "direct_waiting", "inpatient", "transfer_reserved", "in_transit")
                    else [],
                }
            )

    def queue(self, p, kind):
        pid = p["patient_id"]
        self.queues[kind].add(pid)
        requested = (
            self.minute(p.get("admission_requested_at", p["arrival_at"]))
            if kind != "ed"
            else self.minute(p["arrival_at"])
        )
        profile = queue_profile(self, p, kind)
        p["_queue_group"] = (kind, profile)
        self.queue_members[(kind, profile)].add(pid)
        heapq.heappush(self.qheap[(kind, profile)], (p.get("acuity_rank", 4), requested, pid))
        if kind == "ed":
            self.ed_pending.add(pid)
        else:
            self.admission_pending.add(pid)
            p.setdefault("_wait_started", max(0, requested))
        p["queue_entered_at"] = self.at(requested)
        self.emit("queue_entry", p, reason=kind + "_placement")

    def initialize(self):
        # Every shift boundary is batched before one allocation pass.
        changes = defaultdict(lambda: {"add": [], "remove": []})
        for a in self.data.get("assignments", self.data.get("staff_assignments", [])):
            if a.get("status") == "unavailable":
                continue
            start, end = self.minute(a["start_at"]), self.minute(a["end_at"])
            if start <= 0 < end:
                self.active_assignments[a["staff_id"]] = a
            if 0 < start < self.horizon:
                changes[start]["add"].append(a)
            if 0 < end < self.horizon:
                changes[end]["remove"].append(a)
        for t, payload in changes.items():
            self.schedule(t, "shift", payload, 0)
        self.reconcile_staff()
        transfers = []
        for row in self.data["patients"]:
            p = copy.deepcopy(row)
            p["_random_index"] = self.stream_index(-1)
            p["_token"] = 0
            p["_allocations"] = []
            p["_request_pending"] = p["state"] in ("ed_boarding", "direct_waiting")
            p["state_intervals"] = []
            self.patients[p["patient_id"]] = p
            awaiting_stepdown = (
                p.get("stage_status") == "ready_to_exit" and p.get("target_unit_kind") == "ward"
            )
            if awaiting_stepdown:
                self.restore_stepdown(p)
            elif p["state"] in ("ed_assessment", "ed_waiting"):
                old_priority = p.get("acuity_rank", 4)
                old_eligible = p.get("eligible_for_clinic_diversion", False)
                self.choose_path(p)
                p["acuity_rank"] = old_priority
                p["eligible_for_clinic_diversion"] = old_eligible
            elif p["care_level"] in ("ward", "icu"):
                p["_outcome"] = p["care_level"]
                p["_cohort"] = p["cohort_template_id"]
                p["_inpatient_duration"] = self.duration(
                    p["patient_id"], self.cohorts[p["cohort_template_id"]]["los_template_id"], "inpatient"
                )
                profile = choose_profile(
                    self, self.cohorts[p["_cohort"]], self.random(p["patient_id"], "future-profile")
                )
                p["_inpatient_profile_id"] = profile["resource_profile_id"]
                p["_inpatient_requirements"] = equipment(profile)
                source_stream = next(
                    (
                        stream
                        for stream in self.data.get("entry_streams", [])
                        if stream["entry_type"] == p.get("entry_type", "ed")
                    ),
                    {},
                )
                prepare_stepdown(self, p, pathway(self, source_stream.get("entry_stream_id", "ED_MAIN")))
                if "eligible_for_transfer" in p:
                    p["_declared_transfer_eligible"] = p["eligible_for_transfer"]
            if p["state"] == "inpatient" and not awaiting_stepdown:
                p["_inpatient_requirements"] = [
                    r["capability_code"]
                    for r in p.get("resource_requirements", [])
                    for _ in range(r.get("quantity", 1))
                ]
                declared = next(
                    (
                        profile
                        for profile in self.data["resource_profiles"]
                        if profile["resource_profile_id"] == p.get("resource_profile_id")
                    ),
                    None,
                )
                if declared is None:
                    declared = next(
                        (
                            profile
                            for profile in self.data["resource_profiles"]
                            if profile["stage_kind"] == p["care_level"]
                            and sorted(equipment(profile)) == sorted(p["_inpatient_requirements"])
                        ),
                        None,
                    )
                if declared:
                    p["_inpatient_profile_id"] = declared["resource_profile_id"]
                    apply_stage_profile(self, p, p["care_level"])
            if p.get("inpatient_resource_requirements") is not None and not awaiting_stepdown:
                p["_inpatient_requirements"] = [
                    r if isinstance(r, str) else r["capability_code"]
                    for r in p["inpatient_resource_requirements"]
                    for _ in range(1 if isinstance(r, str) else r.get("quantity", 1))
                ]
            if p["care_level"] in ("ward", "icu") and p["state"] != "inpatient" and not awaiting_stepdown:
                declared = next(
                    (
                        profile
                        for profile in self.data["resource_profiles"]
                        if profile["resource_profile_id"] == p.get("resource_profile_id")
                        and profile["stage_kind"] == p["care_level"]
                    ),
                    None,
                )
                if declared:
                    p["_inpatient_profile_id"] = declared["resource_profile_id"]
                    if p.get("inpatient_resource_requirements") is None:
                        p["_inpatient_requirements"] = equipment(declared)
                apply_stage_profile(self, p, p["care_level"])
            if p["slot_id"]:
                u = self.units[p["unit_id"]]
                u["occupants"].add(p["patient_id"])
                self.slots[p["slot_id"]]["patient_id"] = p["patient_id"]
                u["_ready"].discard(p["slot_id"])
                self.allocate_equipment(p, p["unit_id"], p.get("resource_requirements", []), initial=True)
            prior = (p.get("pending_transfer") or {}).get("prior_state")
            if (
                awaiting_stepdown
                or p["state"] in ("ed_boarding", "direct_waiting")
                or (
                    p["state"] in ("transfer_reserved", "in_transit")
                    and prior in ("ed_boarding", "direct_waiting")
                )
            ):
                self.queue(p, p["care_level"])
            if p["state"] in ("transfer_reserved", "in_transit"):
                transfers.append(p)
            if p["state"] == "ed_waiting":
                self.queue(p, "ed")
            self.transition(p, p["state"], p["unit_id"], p["slot_id"])
            p["unit_entered_at"] = row.get("unit_entered_at")
            p["current_stage_started_at"] = row.get("current_stage_started_at", row.get("unit_entered_at"))
            if not awaiting_stepdown and (
                p["state"] in ("inpatient", "ed_assessment", "clinic_assessment")
                or p["state"] == "transfer_reserved"
                and prior == "inpatient"
            ):
                self.start_service(p, self.remaining(p), initial=True)
        for p in transfers:
            self.restore_transfer(p)
        self.record_state()
        if self.measure_start > 0:
            self.schedule(self.measure_start, "measurement_start", None, -1)
        for c in self.conditions:
            if c.get("kind") == "staff_unavailability":
                self.schedule(max(0, self.minute(c["start_at"])), "absence_start", c, 0)
                self.schedule(self.minute(c["end_at"]), "absence_end", c, 0)
            elif c.get("kind") == "arrival_batch":
                self.schedule_batch(
                    c.get("id", "BATCH-CONDITION"), c.get("at", self.at(0)), c, source="synthetic_incident"
                )
        for i, intervention in enumerate(self.scenario.get("interventions", [])):
            if intervention.get("enabled", True):
                self.schedule_intervention(intervention, i)
        self.schedule_updates()
        self.generate_arrivals()
        for a, b, date in day_intervals(self.start, self.end, self.zone):
            self.daily[date] = {
                "local_date": date,
                "start_at": iso(a),
                "end_at": iso(b),
                "inpatient_waiting_patient_hours": 0.0,
                "ed_waiting_patient_hours": 0.0,
                "peak_inpatient_queue": 0,
                "arrivals": 0,
                "discharges": 0,
                "transfers": 0,
                "capacity_deficit_hours": 0.0,
                "staff_deficit_hours": 0.0,
                "equipment_deficit_hours": 0.0,
                "blocker_patient_hours": {},
                **{
                    f"{kind}_{metric}_occupied": 0
                    for kind in ("ward", "icu", "ed")
                    for metric in ("peak", "end")
                },
                "ward_occupied_hours": 0.0,
                "ward_staffed_hours": 0.0,
                "icu_occupied_hours": 0.0,
                "icu_staffed_hours": 0.0,
                "ed_occupied_hours": 0.0,
                "ed_staffed_hours": 0.0,
            }
            self.schedule(self.minute(a), "day_boundary", date, 3)
        for t in np.arange(0, self.horizon, 60):
            self.schedule(float(t), "sample", None, 3)
        self.schedule(self.horizon, "end", None, 4)

    def restore_stepdown(self, p):
        """Restore a completed ICU source stage without restarting its clock."""
        transfer = p.get("pending_transfer") or {}
        source = self.units.get(p.get("unit_id") or transfer.get("source_unit_id"))
        if (
            p["care_level"] != "ward"
            or not source
            or source["kind"] != "icu"
            or p["state"] not in ("inpatient", "transfer_reserved", "in_transit")
            or (transfer and transfer.get("prior_state") != "inpatient")
            or not p.get("admission_requested_at")
        ):
            raise ValueError("Observed stepdown requires a completed ICU source and an existing ward request")
        stream = next(
            (
                stream
                for stream in self.data.get("entry_streams", [])
                if stream["entry_type"] == p.get("entry_type", "ed")
            ),
            {},
        )
        path = pathway(self, stream.get("entry_stream_id", "ED_MAIN"))
        cohort = choose_cohort(
            self,
            "ward",
            self.random(p["patient_id"], "stepdown-cohort"),
            path.get("stepdown_ward_cohort_weights"),
        )
        committed_profile = next(
            (
                profile
                for profile in self.data["resource_profiles"]
                if profile["resource_profile_id"] == p.get("resource_profile_id")
                and profile["stage_kind"] == "ward"
            ),
            None,
        )
        profile = committed_profile or choose_profile(
            self, cohort, self.random(p["patient_id"], "stepdown-profile")
        )
        p["_outcome"] = "ward"
        p["_stepdown_started"] = True
        p["_awaiting_new_stage"] = True
        p["_cohort"] = cohort["cohort_id"]
        p["_inpatient_profile_id"] = profile["resource_profile_id"]
        p["_inpatient_requirements"] = equipment(profile)
        if p.get("inpatient_resource_requirements") is not None:
            p["_inpatient_requirements"] = [
                requirement if isinstance(requirement, str) else requirement["capability_code"]
                for requirement in p["inpatient_resource_requirements"]
                for _ in range(1 if isinstance(requirement, str) else requirement.get("quantity", 1))
            ]
        p["_inpatient_duration"] = self.duration(
            p["patient_id"], cohort["los_template_id"], "stepdown-inpatient"
        )
        # The old stage ended when the ward request was observed. No completion
        # event is scheduled, and no future ward time is consumed while waiting.
        p["_service_end"] = self.minute(p["admission_requested_at"])
        apply_stage_profile(self, p, "ward")

    def restore_transfer(self, p):
        """Resume explicitly observed commitments without resampling their remaining service."""
        tr = p.get("pending_transfer") or {}
        if tr.get("prior_state") == "ed_waiting" or tr.get("clinic_policy_id"):
            self.restore_clinic_transfer(p)
            return
        if tr.get("prior_state") not in ("inpatient", "ed_boarding", "direct_waiting"):
            raise ValueError("Imported transfer requires explicit prior_state")
        expected = "departed" if p["state"] == "in_transit" else "reserved"
        if tr.get("status") != expected:
            raise ValueError("Imported patient and transfer status disagree")
        u = self.units.get(tr.get("destination_unit_id"))
        sid = tr.get("destination_slot_id") or tr.get("reservation_id")
        vehicle = self.vehicles.get(tr.get("vehicle_id"))
        if not u or sid not in u["_ready"] or not vehicle or vehicle["mission"]:
            raise ValueError("Imported transfer must reconcile one free receiving slot and one vehicle")
        if u["kind"] != p["care_level"]:
            raise ValueError("Imported transfer destination has incompatible care level")
        arrival = self.minute(tr["planned_arrival_at"])
        if p.get("_awaiting_new_stage"):
            tr["remaining_stage_minutes"] = p["_inpatient_duration"]
        if (
            arrival <= 0
            or not isinstance(tr.get("remaining_stage_minutes"), (int, float))
            or tr["remaining_stage_minutes"] <= 0
        ):
            raise ValueError(
                "Imported transfer requires future arrival and explicit positive remaining stage"
            )
        requirements = [{"capability_code": cap, "quantity": 1} for cap in p["_inpatient_requirements"]]
        self.allocate_equipment(p, u["unit_id"], requirements, initial=True, reserved=True)
        u["_ready"].discard(sid)
        u["reservations"][p["patient_id"]] = sid
        self.slots[sid]["reservation_id"] = p["patient_id"]
        tr["destination_slot_id"] = sid
        p["_inpatient_duration"] = tr["remaining_stage_minutes"]
        p["_transfer_requested"] = max(0, self.minute(tr["requested_at"]))
        self.transfer_pending.add(p["patient_id"])
        vehicle["mission"] = p["patient_id"]
        vehicle["location"] = p.get("facility_id") or vehicle["location"]
        vehicle["available_at"] = arrival + vehicle.get("turnaround_minutes", 10)
        if expected == "reserved":
            depart = self.minute(tr["planned_departure_at"])
            expiry = self.minute(tr.get("expiry_at", tr["planned_arrival_at"]))
            if not 0 <= depart < arrival or expiry <= 0:
                raise ValueError("Imported reserved transfer has invalid departure or expiry")
            self.schedule(depart, "transfer_depart", (p["patient_id"], tr["request_id"]), 1)
            self.schedule(expiry, "transfer_expire", (p["patient_id"], tr["request_id"]), 1)
        self.schedule(arrival, "transfer_arrive", (p["patient_id"], tr["request_id"]), 1)
        self.schedule(
            vehicle["available_at"],
            "vehicle_ready",
            (vehicle["vehicle_id"], p["patient_id"], vehicle["available_at"]),
            0,
        )
        self.transition(p, p["state"], p.get("unit_id"), p.get("slot_id"))

    def restore_clinic_transfer(self, p):
        """Reconcile an unstarted clinic stage and its observed transport commitment."""
        transfer = p["pending_transfer"]
        expected = "departed" if p["state"] == "in_transit" else "reserved"
        unit = self.units.get(transfer.get("destination_unit_id"))
        slot = transfer.get("destination_slot_id")
        vehicle = self.vehicles.get(transfer.get("vehicle_id"))
        if (
            transfer.get("prior_state") != "ed_waiting"
            or transfer.get("status") != expected
            or p["care_level"] != "ambulatory"
            or p.get("unit_id")
            or p.get("slot_id")
            or p.get("resource_requirements")
            or transfer.get("source_unit_id")
            or not unit
            or unit["kind"] != "clinic"
        ):
            raise ValueError("Imported clinic mission requires an unoccupied ambulatory ED source")
        policy = self.clinic_policy(
            {"destination_unit_id": unit["unit_id"], "clinic_policy_id": transfer.get("clinic_policy_id")}
        )
        if not transfer.get("clinic_policy_id") or not policy.get("transport_required"):
            raise ValueError("Imported clinic mission requires its declared transport policy")
        profile_id = transfer.get("clinic_resource_profile_id")
        profile = next(
            (
                profile
                for profile in self.data["resource_profiles"]
                if profile["resource_profile_id"] == profile_id
            ),
            None,
        )
        capability = (profile.get("required_transport_capability") or "BASIC_TRANSPORT") if profile else None
        if (
            not profile
            or profile.get("stage_kind") != "clinic"
            or not compatible(self, profile, unit)
            or slot not in unit["_ready"]
            or profile["required_site_capability"] not in self.slots[slot].get("capabilities", [])
            or not vehicle
            or vehicle["mission"]
            or capability not in vehicle["capabilities"]
            or vehicle.get("patient_capacity", 1) < 1
        ):
            raise ValueError("Imported clinic mission must reconcile a compatible slot, profile and vehicle")
        departure = self.minute(transfer["planned_departure_at"])
        arrival = self.minute(transfer["planned_arrival_at"])
        requested = self.minute(transfer["requested_at"])
        expiry = self.minute(transfer["expiry_at"])
        if (
            not requested <= 0 < arrival
            or not requested <= departure < arrival < expiry
            or (expected == "reserved" and departure < 0)
            or (expected == "departed" and departure > 0)
            or requested < self.minute(policy["admission_start_at"])
            or arrival >= self.minute(policy["admission_end_at"])
        ):
            raise ValueError(
                "Imported clinic mission timestamps disagree with its state or admission interval"
            )
        requirements = self.unit_requirements(unit["unit_id"], profile["required_equipment"])
        if self.equipment_bundle(unit["unit_id"], requirements) is None:
            raise ValueError("Imported clinic mission cannot reconcile its destination equipment bundle")

        # Waiting ED service is a future stage after a reset, not a partially
        # consumed inpatient stay. Retain known source profile/priority/queue.
        if expected == "reserved":
            known = {
                key: p.get(key)
                for key in (
                    "resource_profile_id",
                    "cohort_template_id",
                    "acuity_rank",
                    "eligible_for_clinic_diversion",
                    "queue_location_id",
                )
            }
            self.choose_path(p)
            source_profile = next(
                (
                    profile
                    for profile in self.data["resource_profiles"]
                    if profile["resource_profile_id"] == known["resource_profile_id"]
                    and profile["stage_kind"] == "ed"
                ),
                None,
            )
            if source_profile:
                p["_ed_profile_id"] = source_profile["resource_profile_id"]
                p["_ed_requirements"] = equipment(source_profile)
            if known["cohort_template_id"]:
                p["_ed_cohort"] = known["cohort_template_id"]
            p.update({key: value for key, value in known.items() if value is not None})
        p["_clinic_profile_id"] = profile_id
        p["_clinic_policy"] = policy
        p["clinic_policy_id"] = policy["clinic_policy_id"]
        p["target_unit_kind"] = "clinic"
        self.allocate_equipment(p, unit["unit_id"], requirements, initial=True, reserved=True)
        unit["_ready"].discard(slot)
        unit["reservations"][p["patient_id"]] = slot
        self.slots[slot]["reservation_id"] = p["patient_id"]
        self.transfer_pending.add(p["patient_id"])
        vehicle["mission"] = p["patient_id"]
        vehicle["location"] = p["facility_id"]
        vehicle["available_at"] = arrival + vehicle.get("turnaround_minutes", 10)
        if expected == "reserved":
            self.schedule(departure, "clinic_transfer_depart", p["patient_id"], 1)
        self.schedule(arrival, "clinic_transfer_arrive", p["patient_id"], 1)
        self.schedule(
            vehicle["available_at"],
            "vehicle_ready",
            (vehicle["vehicle_id"], p["patient_id"], vehicle["available_at"]),
            0,
        )
        self.transition(p, p["state"])

    def schedule_intervention(self, intervention, index):
        plan = copy.deepcopy(intervention)
        kind = plan.get("kind", plan.get("template_kind"))
        kind = {
            "staff_existing_beds": "staff_existing",
            "activate_clinic": "clinic",
            "activate_overflow": "staffed_overflow",
        }.get(kind, kind)
        plan["kind"] = kind
        plan["id"] = plan.get("intervention_id", plan.get("id", f"PLAN-{index}"))
        if kind not in (
            "staff_existing",
            "physical_overflow",
            "staffed_overflow",
            "clinic",
            "partner_transfer",
        ):
            raise ValueError(f"Unsupported intervention: {kind}")
        start = self.minute(plan.get("start_at", self.at(0)))
        delay = float(
            plan.get(
                "activation_minutes",
                {"clinic": 360, "staffed_overflow": 720, "physical_overflow": 720}.get(kind, 0),
            )
        )
        plan["_start"] = max(0, start + delay)
        plan["_end"] = (
            self.minute(plan["end_at"])
            if plan.get("end_at")
            else min(self.horizon, start + float(plan.get("duration_minutes", self.horizon)))
        )
        if plan["_start"] >= plan["_end"]:
            raise ValueError("Intervention readiness must occur before the plan ends")
        if kind == "clinic":
            policy = self.clinic_policy(plan)
            plan["_clinic_policy"] = policy
            plan["_start"] = max(plan["_start"], self.minute(policy["admission_start_at"]))
            plan["_end"] = min(
                plan["_end"], self.minute(policy.get("admission_end_at", self.at(self.horizon)))
            )
            if plan["_start"] >= plan["_end"] or plan["_start"] >= self.horizon:
                self.intervention_results.append(
                    {
                        "id": plan["id"],
                        "kind": kind,
                        "status": "inactive",
                        "reason": "No clinic admission interval overlaps this plan",
                    }
                )
                return
        self.schedule(plan["_start"], "plan_start", plan, 0)
        if plan["_end"] < self.horizon:
            self.schedule(plan["_end"], "plan_end", plan, 0)

    def schedule_updates(self):
        updates = copy.deepcopy(self.scenario.get("updates", []))
        by_id = {
            key: u
            for i, u in enumerate(updates)
            for key in (u.get("idempotency_key"), u.get("update_id"), u.get("id"), str(i))
            if key
        }
        for u in updates:
            if u.get("type") == "retract_or_correct" and u.get("status", "active") == "active":
                payload = u.get("payload", {})
                ref = payload.get("referenced_update_id", payload.get("update_id"))
                original = by_id.get(ref)
                if original:
                    if payload.get("replacement_payload") is None:
                        original["status"] = "retracted"
                    else:
                        original["payload"] = payload["replacement_payload"]
                u["status"] = "superseded"
        seen = set()
        for i, u in enumerate(updates):
            key = u.get("idempotency_key") or u.get("update_id") or u.get("id") or str(i)
            if key in seen or u.get("status", "active") != "active":
                continue
            seen.add(key)
            kind = u.get("type")
            payload = u.get("payload", {})
            if kind == "arrival_batch":
                self.schedule_batch(
                    key,
                    u["effective_at"],
                    payload,
                    "synthetic_incident" if u.get("input_kind") == "planned_assumption" else "reported_batch",
                )
            else:
                self.schedule(max(0, self.minute(u["effective_at"])), "update", u, 0)

    def schedule_batch(self, key, at, payload, source="reported_batch"):
        count = int(payload.get("count", 0))
        spread = float(payload.get("spread_minutes", 0))
        time = self.minute(at)
        if count < 0 or count > 50000 or spread < 0:
            raise ValueError("Arrival batch exceeds configured limits")
        stream = next(
            (
                s
                for s in self.data.get("entry_streams", [])
                if s["entry_stream_id"] == payload.get("entry_stream_id", "ED_MAIN")
            ),
            None,
        )
        stream = copy.deepcopy(stream or {"entry_stream_id": "ED_MAIN", "entry_type": "ed"})
        if payload.get("facility_id") is not None and payload["facility_id"] != stream.get(
            "destination_facility_id", "FAC-MAIN"
        ):
            raise ValueError("Arrival batch facility must match its declared entry stream destination")
        if payload.get("care_mix"):
            stream["disposition_weights"] = payload["care_mix"]
        if payload.get("resource_profile_mix") is not None:
            stream["resource_profile_mix"] = copy.deepcopy(payload["resource_profile_mix"])
        times = self.random(key, "batch-times").uniform(0, spread, count) if spread else np.zeros(count)
        for i in range(count):
            t = time + float(times[i])
            self.schedule(
                t,
                "arrival",
                {
                    "patient_id": f"PAT-REPORT-{key}-{i:06}",
                    "stream": stream,
                    "source": "surge_arrival" if source == "synthetic_incident" else source,
                    **(
                        {"arrival_origin": "synthetic_incident", "input_kind": "planned_assumption"}
                        if source == "synthetic_incident"
                        else {}
                    ),
                },
                2,
            )

    def arrival_exposures(self):
        baseline = self.data.get("arrival_profiles", self.data.get("baseline"))
        streams = self.data.get("entry_streams", [])
        if not streams:
            streams = [
                {
                    "entry_stream_id": "ED_MAIN",
                    "entry_type": "ed",
                    "expected_arrivals_per_local_day": baseline["ed_arrivals_per_local_day"],
                },
                {
                    "entry_stream_id": "DIRECT_WARD_MAIN",
                    "entry_type": "direct_ward",
                    "expected_arrivals_per_local_day": baseline["direct_ward_arrivals_per_local_day"],
                    "disposition_weights": {"ward": 1},
                },
            ]
        for stream in streams:
            if not stream.get("enabled", True):
                continue
            sid = stream["entry_stream_id"]
            rate = float(
                baseline[
                    "ed_arrivals_per_local_day"
                    if stream["entry_type"] == "ed"
                    else "direct_ward_arrivals_per_local_day"
                ]
            )
            hours = stream.get("hour_weights", baseline["hour_weights"])
            week = stream.get("weekday_weights", baseline["weekday_weights"])
            if rate < 0 or not math.isfinite(rate):
                raise ValueError("Arrival rates must be finite and nonnegative")
            for a, b, date in day_intervals(self.start, self.end, self.zone):
                daily = rate * week[a.astimezone(ZoneInfo(self.zone)).weekday()]
                for hour_start, hour_end, weight in actual_hours(a, b, hours, self.zone):
                    left, right = self.minute(hour_start), self.minute(hour_end)
                    base = daily * weight
                    mult = self.multiplier(sid, left, right)
                    yield stream, date, hour_start, left, right, base, mult

    def generate_arrivals(self):
        total_expected = 0
        for stream, date, hour_start, left, right, base, mult in self.arrival_exposures():
            sid = stream["entry_stream_id"]
            total_expected += base * mult
            if total_expected > int(self.scenario.get("max_expected_arrivals", 400000)):
                raise SimulationLimitExceeded("Expected patient count exceeds per-replication quota")
            stream_indexes = [self.stream_index(left)]
            if self.branch_at is not None and left < self.branch_at < right:
                stream_indexes.append(self.stream_index(self.branch_at))
            for random_index in stream_indexes:
                for source, lam in [
                    ("baseline_arrival", base),
                    ("surge_arrival", base * max(0, mult - 1)),
                ]:
                    g = rng(self.seed, random_index, "arrivals", sid, date, iso(hour_start), source)
                    count = int(g.poisson(lam))
                    times = g.uniform(left, right, count)
                    for j, t in enumerate(times):
                        if self.stream_index(float(t)) != random_index:
                            continue
                        if (
                            source == "baseline_arrival"
                            and mult < 1
                            and float(
                                rng(
                                    self.seed, random_index, "thinning", sid, date, iso(hour_start), j
                                ).random()
                            )
                            >= mult
                        ):
                            continue
                        suffix = "-BR" if isinstance(random_index, tuple) else ""
                        pid = f"PAT-{sid}-{date.replace('-', '')}-{int(left):06}-{source[0]}-{j:04}{suffix}"
                        self.schedule(
                            float(t),
                            "arrival",
                            {
                                "patient_id": pid,
                                "stream": stream,
                                "source": source,
                                "random_index": random_index,
                            },
                            2,
                        )
        self.metrics["expected_arrivals"] = total_expected

    def reconcile_staff(self):
        for u in self.units.values():
            u["active_staff"] = {}
            u["gate"] = True
        reserve = []
        unavailable = set()
        for c in self.absences:
            unavailable.update(c.get("staff_ids", []))
            if c.get("unit_id"):
                eligible = sorted(
                    sid
                    for sid, a in self.active_assignments.items()
                    if a.get("unit_id") == c["unit_id"] and self.staff[sid]["role"] == "rn"
                )
                unavailable.update(eligible[: int(c.get("count", 0))])
        for sid, a in self.active_assignments.items():
            if sid in unavailable:
                continue
            if a.get("unit_id"):
                self.units[a["unit_id"]]["active_staff"][sid] = a.get("allocation_fraction", 1)
            elif a.get("reserve_pool_id"):
                reserve.append(sid)
        available = {
            sid for sid in reserve if self.active_assignments[sid].get("allocation_fraction", 1) >= 1
        }
        requests, matches = [], {}
        plans = sorted(
            self.active_plans.items(), key=lambda item: ("assigned_staff_ids" not in item[1], item[0])
        )
        for key, plan in plans:
            needs = plan.get("_staff_needs")
            if not needs:
                continue
            proposed = []
            explicit = plan.get("assigned_staff_ids")
            roles = (
                [(self.staff[sid]["role"], sid) for sid in explicit]
                if explicit is not None
                else [(role, None) for role, n in needs.items() for _ in range(n)]
            )
            nurse_index = 0
            for role, sid in roles:
                target = plan.get("_target_unit")
                if plan["kind"] == "staff_existing" and not target:
                    targets = plan.get("_nurse_units", [])
                    target = targets[nurse_index] if nurse_index < len(targets) else None
                    nurse_index += int(role == "rn")
                if not target:
                    continue
                unit = self.units[target]
                policy = self.policies.get(unit.get("capacity_policy_id"), {})
                capability = (
                    policy.get("nurse_capability", unit["kind"].upper() + "_NURSING")
                    if role == "rn"
                    else unit["kind"].upper() + "_PROVIDER"
                    if role == "provider"
                    else "GENERAL_SUPPORT"
                )
                candidates = {
                    person
                    for person in available
                    if self.staff[person]["role"] == role
                    and capability in self.staff[person].get("capabilities", [])
                    and (sid is None or person == sid)
                }
                proposed.append((target, candidates))
            candidate_requests = requests + proposed
            candidate_matches = {}

            def claim(
                index, visited, candidate_requests=candidate_requests, candidate_matches=candidate_matches
            ):
                for person in sorted(candidate_requests[index][1]):
                    if person in visited:
                        continue
                    visited.add(person)
                    if person not in candidate_matches or claim(candidate_matches[person], visited):
                        candidate_matches[person] = index
                        return True
                return False

            feasible = len(proposed) == len(roles) and all(
                claim(i, set())
                for i in sorted(range(len(candidate_requests)), key=lambda i: len(candidate_requests[i][1]))
            )
            plan["_staff_feasible"] = feasible
            if feasible:
                requests, matches = candidate_requests, candidate_matches
        for person, index in matches.items():
            self.units[requests[index][0]]["active_staff"][person] = 1
        for u in self.units.values():
            if u["capacity_mode"] == "advertised_aggregate":
                u["staffed"] = min(self.enabled(u), u.get("advertised_staffed_capacity", 0))
                continue
            policy = self.policies.get(u.get("capacity_policy_id"), {})
            kind = u["kind"]
            nurse_cap = policy.get("nurse_capability", kind.upper() + "_NURSING")
            provider_cap = kind.upper() + "_PROVIDER"
            nurses = sum(
                v
                for sid, v in u["active_staff"].items()
                if nurse_cap in self.staff[sid].get("capabilities", [])
            )
            providers = sum(
                v
                for sid, v in u["active_staff"].items()
                if provider_cap in self.staff[sid].get("capabilities", [])
            )
            support = sum(
                v
                for sid, v in u["active_staff"].items()
                if "GENERAL_SUPPORT" in self.staff[sid].get("capabilities", [])
            )
            u["gate"] = providers >= policy.get(
                "minimum_provider_count", 2 if kind == "ed" else 1
            ) and support >= policy.get("minimum_support_count", 1)
            u["staffed"] = (
                min(
                    self.enabled(u),
                    math.floor(nurses * policy.get("slots_per_nurse", 2 if kind == "icu" else 4)),
                )
                if u["active"]
                else 0
            )
            blanket = Counter()
            for requirement in policy.get("per_slot_resources", []):
                blanket[requirement["capability_code"]] += requirement["quantity"]
            for capability, quantity in blanket.items():
                u["staffed"] = min(
                    u["staffed"],
                    sum(
                        max(0, p["quantity"] - p["failed"] - p["pending_decommission"])
                        for p in self.pools.values()
                        if p.get("unit_id") == u["unit_id"] and p["capability_code"] == capability
                    )
                    // quantity,
                )
        self._reserve_staff_count = sum(
            sum(self.staff[s]["employment_pool"] == "reserve" for s in u["active_staff"])
            for u in self.units.values()
        )

    def refresh_slots(self, u):
        background = set(u["slots"][: u.get("background_occupied", 0)])
        u["_physical"] = sum(self.slots[s]["installation_status"] == "installed" for s in u["slots"])
        u["_enabled"] = sum(
            self.slots[s]["installation_status"] == "installed" and self.slots[s]["enabled"]
            for s in u["slots"]
        )
        u["_ready"] = {
            sid
            for sid in u["slots"]
            if self.slots[sid]["installation_status"] == "installed"
            and self.slots[sid]["enabled"]
            and not self.slots[sid].get("patient_id")
            and not self.slots[sid].get("reservation_id")
            and sid not in u["cleaning"]
            and sid not in background
        }

    def enabled(self, u):
        return u["_enabled"]

    def physical(self, u):
        return u["_physical"]

    def occupancy(self, u):
        return len(u["occupants"]) + u.get("background_occupied", 0)

    def free(self, u):
        if not u["active"] or not u["gate"]:
            return 0
        return max(0, min(len(u["_ready"]), u["staffed"] - self.occupancy(u) - len(u["reservations"])))

    def slot_ready(self, sid):
        return sid in self.units[self.slots[sid]["unit_id"]]["_ready"]

    def equipment_candidates(self, unit, cap):
        if self._equipment_index is None:
            index = defaultdict(list)
            for pool in sorted(self.pools.values(), key=lambda p: p["equipment_pool_id"]):
                index[(pool.get("unit_id"), pool["capability_code"])].append(pool)
            self._equipment_index = index
        # Entries reference live pools; quantity/availability changes need no
        # rebuild. Creating a relocated pool explicitly invalidates the index.
        return self._equipment_index.get((unit, cap), ())

    def equipment_available(self, pool):
        return max(
            0,
            pool["quantity"]
            - pool["failed"]
            - sum(pool["in_use"].values())
            - sum(pool["reserved"].values())
            - pool["pending_decommission"],
        )

    def unit_requirements(self, unit, requirements):
        requested = Counter()
        for requirement in requirements:
            requested[requirement["capability_code"]] += requirement.get("quantity", 1)
        policy = self.policies.get(self.units[unit].get("capacity_policy_id"), {})
        blanket = Counter()
        for requirement in policy.get("per_slot_resources", []):
            blanket[requirement["capability_code"]] += requirement["quantity"]
        for capability, quantity in blanket.items():
            requested[capability] = max(requested[capability], quantity)
        return [
            {"capability_code": capability, "quantity": quantity}
            for capability, quantity in requested.items()
        ]

    def equipment_bundle(self, unit, requirements):
        result = []
        requested = Counter()
        for req in self.unit_requirements(unit, requirements):
            requested[req["capability_code"]] += req.get("quantity", 1)
        for cap, need in requested.items():
            for pool in self.equipment_candidates(unit, cap):
                count = min(need, self.equipment_available(pool))
                need -= count
                if count:
                    result.append((pool["equipment_pool_id"], count))
                if need == 0:
                    break
            if need:
                return None
        return result

    def allocate_equipment(self, p, unit, requirements, initial=False, reserved=False):
        requirements = self.unit_requirements(unit, requirements)
        bundle = self.equipment_bundle(unit, requirements)
        if bundle is None:
            if initial:
                raise ValueError(f"Initial equipment cannot be reconciled for {p['patient_id']}")
            return False
        for pid, count in bundle:
            self.pools[pid]["reserved" if reserved else "in_use"][p["patient_id"]] = count
        if reserved:
            p["_reserved_allocations"] = bundle
        else:
            p["_allocations"] = bundle
            p["resource_requirements"] = requirements
        return True

    def release_equipment(self, p, reserved=False):
        field = "_reserved_allocations" if reserved else "_allocations"
        for poolid, count in p.get(field, []):
            pool = self.pools[poolid]
            pool["reserved" if reserved else "in_use"].pop(p["patient_id"], None)
            if pool["pending_decommission"]:
                released = min(count, pool["pending_decommission"])
                pool["quantity"] -= released
                pool["pending_decommission"] -= released
        p[field] = []

    def release_slot(self, p):
        if not p.get("slot_id"):
            return
        unit = p["unit_id"]
        sid = p["slot_id"]
        u = self.units[unit]
        u["occupants"].discard(p["patient_id"])
        self.slots[sid].pop("patient_id", None)
        self.release_equipment(p)
        delay = u.get("turnover_minutes", 30)
        u["cleaning"][sid] = self.now + delay
        self.schedule(self.now + delay, "clean", {"unit": unit, "slot": sid}, 0)
        self.emit(
            "slot_cleaning_start",
            p,
            source=unit,
            payload={"slot_id": sid, "end_at": self.at(self.now + delay)},
        )
        p["slot_id"] = None
        p["unit_id"] = None

    def place(self, p, u, kind, reserved=False):
        if not compatible(
            self, self.clinic_profile(p) if kind == "clinic" else stage_profile(self, p, kind), u
        ):
            return False
        requirements = [
            {"capability_code": c, "quantity": 1}
            for c in (
                p["_ed_requirements"]
                if kind == "ed"
                else ["CLINIC_KIT"]
                if kind == "clinic"
                else p["_inpatient_requirements"]
            )
        ]
        if kind == "clinic":
            requirements = copy.deepcopy(self.clinic_profile(p)["required_equipment"])
        requirements = self.unit_requirements(u["unit_id"], requirements)
        if self.free(u) < 1 or self.equipment_bundle(u["unit_id"], requirements) is None:
            return False
        sid = next(
            (
                s
                for s in sorted(u["slots"])
                if self.slot_ready(s)
                and (
                    kind != "clinic"
                    or self.clinic_profile(p)["required_site_capability"]
                    in self.slots[s].get("capabilities", [])
                )
            ),
            None,
        )
        if not sid:
            return False
        u["_ready"].discard(sid)
        if reserved:
            self.allocate_equipment(p, u["unit_id"], requirements, reserved=True)
            self.slots[sid]["reservation_id"] = p["patient_id"]
            u["reservations"][p["patient_id"]] = sid
            return sid
        old = p.get("unit_id")
        self.release_slot(p)
        self.allocate_equipment(p, u["unit_id"], requirements)
        u["occupants"].add(p["patient_id"])
        self.slots[sid]["patient_id"] = p["patient_id"]
        p["resource_requirements"] = requirements
        self.queues.get(kind, set()).discard(p["patient_id"])
        if p.get("_queue_group"):
            self.queue_members[p["_queue_group"]].discard(p["patient_id"])
        if kind == "ed":
            self.ed_pending.discard(p["patient_id"])
            p["care_level"] = "ambulatory"
            p["cohort_template_id"] = p.get("_ed_cohort", p["cohort_template_id"])
            apply_stage_profile(self, p, "ed")
            p["stage_status"] = "in_service"
            self.transition(p, "ed_assessment", u["unit_id"], sid)
            self.start_service(p, p["_assessment_duration"])
        elif kind == "clinic":
            self.start_clinic_service(p, u, sid)
        else:
            self.admit(p, u, sid)
            self.start_service(p, p["_inpatient_duration"])
        self.emit(
            "assessment_start" if kind == "ed" else "clinic_start" if kind == "clinic" else "admission",
            p,
            source=old,
            dest=u["unit_id"],
            resources=[sid] + [a[0] for a in p["_allocations"]],
        )
        return True

    def admit(self, p, u, sid):
        pid = p["patient_id"]
        self.admission_pending.discard(pid)
        if p.get("_queue_group"):
            self.queue_members[p["_queue_group"]].discard(pid)
        self.queues.get(p.get("target_unit_kind") or p.get("care_level"), set()).discard(pid)
        if p.get("_wait_started") is not None:
            self.completed_waits.append(
                max(0, self.now - max(p["_wait_started"], self.measure_start))
            ) if self.now >= self.measure_start else None
            p.pop("_wait_started", None)
        p["care_level"] = u["kind"]
        p["target_unit_kind"] = None
        p["admitted_at"] = p.get("admitted_at") or self.at(self.now)
        p["cohort_template_id"] = p.get("_cohort", p["cohort_template_id"])
        p["eligible_for_clinic_diversion"] = False
        p["eligible_for_transfer"] = True
        apply_stage_profile(self, p, u["kind"])
        p["stage_status"] = "in_service"
        p["queue_entered_at"] = None
        self.transition(p, "inpatient", u["unit_id"], sid)

    def start_service(self, p, duration, initial=False):
        if not initial:
            p.pop("_awaiting_new_stage", None)
        for c in self.conditions:
            if (
                not initial
                and c.get("kind") == "stage_duration_multiplier"
                and c.get("stage_kind") == ("ed" if p["state"] == "ed_assessment" else p.get("care_level"))
                and self.minute(c["start_at"]) <= self.now < self.minute(c["end_at"])
            ):
                duration *= float(c["multiplier"])
        p["_token"] = p.get("_token", 0) + 1
        p["_service_end"] = self.now + duration
        p["sampled_stage_minutes"] = duration
        p["current_stage_started_at"] = (
            (p.get("current_stage_started_at") or p.get("unit_entered_at")) if initial else self.at(self.now)
        )
        if self.keep and p.get("state_intervals"):
            p["state_intervals"][-1].update(
                current_stage_started_at=p["current_stage_started_at"],
                sampled_stage_minutes=duration,
                expected_stage_end_at=self.at(self.now + duration),
                remaining_stage_spec=copy.deepcopy(p.get("remaining_stage_spec")) if initial else None,
            )
        self.schedule(self.now + duration, "complete", (p["patient_id"], p["_token"]), 0)

    def complete(self, p, token):
        if p.get("_token") != token or p["state"] in ("discharged", "in_transit"):
            return
        if p.get("pending_transfer"):
            self.cancel_transfer(p, "service_completed_before_pickup")
        if p["state"] == "ed_assessment":
            self.emit("assessment_end", p, source=p["unit_id"])
            outcome = p["_outcome"]
            if outcome == "discharge":
                self.discharge(p)
            else:
                p["care_level"] = outcome
                p["target_unit_kind"] = outcome
                p["cohort_template_id"] = p["_cohort"]
                p["admission_requested_at"] = self.at(self.now)
                p["eligible_for_clinic_diversion"] = False
                p["eligible_for_transfer"] = True
                apply_stage_profile(self, p, outcome)
                p["needs_advanced_transport"] = bool(p["_inpatient_requirements"])
                p["stage_status"] = "not_started"
                self.queue(p, outcome)
                self.transition(p, "ed_boarding", p["unit_id"], p["slot_id"])
                self.emit("admission_request", p, source=p["unit_id"], reason=outcome)
        elif p["state"] == "inpatient" and begin_stepdown(self, p):
            return
        else:
            self.discharge(p)

    def discharge(self, p):
        source = p.get("unit_id")
        if p.get("_queue_group"):
            self.queue_members[p["_queue_group"]].discard(p["patient_id"])
        self.release_slot(p)
        self.admission_pending.discard(p["patient_id"])
        self.ed_pending.discard(p["patient_id"])
        self.transfer_pending.discard(p["patient_id"])
        for q in self.queues.values():
            q.discard(p["patient_id"])
        p["departure_at"] = self.at(self.now)
        p["departure_kind"] = "discharge"
        p["resource_requirements"] = []
        self.transition(p, "discharged")
        self.metrics["discharges"] += int(self.now >= self.measure_start)
        if self.current_day:
            self.daily[self.current_day]["discharges"] += int(self.now >= self.measure_start)
        for key, plan in list(self.active_plans.items()):
            if (
                plan.get("_draining")
                and plan.get("_target_unit") == source
                and not self.units[source]["occupants"]
                and not self.units[source]["reservations"]
            ):
                self.active_plans.pop(key)
                self.units[source]["active"] = False
                self.reconcile_staff()
                self.emit("site_closed", source=source, reason="service_drained")
        self.emit("discharge", p, source=source)

    def clinic_profile(self, patient):
        ident = patient.get("_clinic_profile_id")
        available = [p for p in self.data.get("resource_profiles", []) if p["stage_kind"] == "clinic"]
        if not ident:
            ident = (
                "RP-CLINIC-BASIC"
                if any(p["resource_profile_id"] == "RP-CLINIC-BASIC" for p in available)
                else available[0]["resource_profile_id"]
                if len(available) == 1
                else None
            )
        profile = next(
            (p for p in self.data.get("resource_profiles", []) if p["resource_profile_id"] == ident), None
        )
        if not profile or profile.get("stage_kind") != "clinic":
            raise ValueError(f"Clinic diversion requires a declared clinic-stage profile: {ident}")
        return profile

    def clinic_policy(self, plan):
        target = plan.get("destination_unit_id") or plan.get("unit_id")
        site = self.units.get(target, {}).get("facility_id") or plan.get("facility_id")
        site = site or self.units.get("UNIT-CLINIC-NORTH", {}).get("facility_id")
        policies = [
            p
            for p in self.data.get("clinic_policies", [])
            if p.get("site_id") == site
            and (not plan.get("clinic_policy_id") or p["clinic_policy_id"] == plan["clinic_policy_id"])
        ]
        if len(policies) > 1 and not plan.get("clinic_policy_id"):
            ed_streams = {
                stream["entry_stream_id"]
                for stream in self.data.get("entry_streams", [])
                if stream["entry_type"] == "ed"
            }
            preferred = {
                path.get("clinic_policy_id")
                for path in self.data.get("pathway_profiles", [])
                if path["entry_stream_id"] in ed_streams
            }
            selected = [policy for policy in policies if policy["clinic_policy_id"] in preferred]
            if len(selected) == 1:
                policies = selected
        if len(policies) != 1:
            raise ValueError("Clinic activation requires one declared policy for its destination site")
        policy = policies[0]
        if (
            policy.get("routing_mode") != "new_arrivals_only"
            or policy.get("eligibility_tag") != "eligible_for_clinic_diversion"
        ):
            raise ValueError("Clinic policy must use explicitly eligible new arrivals only")
        if policy.get("service_template_id") not in self.templates:
            raise ValueError("Clinic policy references an unknown service template")
        if not policy.get("admission_start_at") or (
            policy.get("admission_end_at")
            and dt(policy["admission_end_at"]) <= dt(policy["admission_start_at"])
        ):
            raise ValueError("Clinic policy requires an increasing admission interval")
        return policy

    def start_clinic_service(self, p, unit, slot):
        profile = self.clinic_profile(p)
        p["care_level"] = "ambulatory"
        p["stage_status"] = "in_service"
        p["target_unit_kind"] = "clinic"
        p["resource_profile_id"] = profile["resource_profile_id"]
        p["resource_requirements"] = self.unit_requirements(unit["unit_id"], profile["required_equipment"])
        p["required_transport_capability"] = profile.get("required_transport_capability")
        p["eligible_for_transfer"] = profile.get("transfer_allowed", False)
        p["acuity_rank"] = profile.get("acuity_rank", 4)
        p["eligible_for_clinic_diversion"] = False
        self.transition(p, "clinic_assessment", unit["unit_id"], slot)
        self.start_service(
            p, self.duration(p["patient_id"], p["_clinic_policy"]["service_template_id"], "clinic")
        )
        self.metrics["temporary_site_patients_served"] += int(self.now >= self.measure_start)

    def clinic_fallback(self, p, policy, reason, unit):
        self.emit(
            "clinic_diversion_rejected",
            p,
            dest=unit["unit_id"],
            reason=reason,
            payload={
                "clinic_policy_id": policy["clinic_policy_id"],
                "hospital_fallback": policy.get("hospital_fallback", True),
            },
        )
        if not policy.get("hospital_fallback", True):
            raise ValueError(f"Clinic diversion infeasible without hospital fallback: {reason}")

    def divert_to_clinic(self, p, stream):
        # This is called exactly once, at the new arrival. Existing ED patients
        # are never reconsidered, and failure must leave their ED bundle intact.
        if not p.get("eligible_for_clinic_diversion") or p.get("_outcome") != "discharge":
            return False
        profile = None
        candidates = sorted(
            (
                plan
                for plan in self.active_plans.values()
                if plan["kind"] == "clinic" and plan.get("_target_unit") and not plan.get("_draining")
            ),
            key=lambda plan: plan["_target_unit"],
        )
        for plan in candidates:
            unit = self.units[plan["_target_unit"]]
            policy = plan["_clinic_policy"]
            if not (plan["_start"] <= self.now < plan["_end"]):
                continue
            profile = profile or self.clinic_profile(p)
            facility = next(f for f in self.data["facilities"] if f["facility_id"] == unit["facility_id"])
            required = profile["required_site_capability"]
            filters = plan.get("patient_eligibility_filter", {})
            if (
                not compatible(self, profile, unit)
                or unit["kind"] not in profile["allowed_unit_kinds"]
                or required not in facility.get("capabilities", [])
                or required not in unit.get("capabilities", [])
                or (filters.get("care_levels") and "ambulatory" not in filters["care_levels"])
                or (
                    filters.get("allowed_profile_ids")
                    and profile["resource_profile_id"] not in filters["allowed_profile_ids"]
                )
                or profile["resource_profile_id"] in filters.get("excluded_profile_ids", [])
                or (filters.get("require_transfer_eligible") and not p.get("eligible_for_transfer"))
            ):
                self.clinic_fallback(p, policy, "incompatible_clinic_capability_or_eligibility", unit)
                continue
            transport = None
            if policy.get("transport_required", False):
                transport = self.clinic_transport(p, unit, plan, profile)
                if not transport:
                    self.clinic_fallback(p, policy, "clinic_transport_unavailable", unit)
                    continue
            if (
                self.free(unit) < 1
                or not any(required in self.slots[s].get("capabilities", []) for s in unit["_ready"])
                or self.equipment_bundle(unit["unit_id"], profile["required_equipment"]) is None
            ):
                self.clinic_fallback(p, policy, "clinic_bundle_unavailable", unit)
                continue
            p["_clinic_policy"] = policy
            p["clinic_policy_id"] = policy["clinic_policy_id"]
            if transport:
                self.reserve_clinic_transport(p, unit, transport, plan)
                return True
            if self.place(p, unit, "clinic"):
                return True
            # place() is atomic; a failed attempt does not change ED requirements.
            p.pop("_clinic_policy", None)
            p.pop("clinic_policy_id", None)
            self.clinic_fallback(p, policy, "clinic_bundle_unavailable", unit)
        return False

    def clinic_transport(self, p, unit, plan, profile):
        source = p["facility_id"]
        route = self.routes.get((source, unit["facility_id"]))
        if not route or route.get("unavailable"):
            return None
        capability = profile.get("required_transport_capability") or "BASIC_TRANSPORT"
        for vehicle in sorted(self.vehicles.values(), key=lambda v: v["vehicle_id"]):
            if (
                vehicle["mission"] is not None
                or vehicle["available_at"] > self.now
                or capability not in vehicle["capabilities"]
                or vehicle.get("patient_capacity", 1) < 1
            ):
                continue
            reposition = (
                self.routes.get((vehicle["location"], source)) if vehicle["location"] != source else None
            )
            if vehicle["location"] != source and (not reposition or reposition.get("unavailable")):
                continue
            departure = (
                self.now
                + (reposition["travel_minutes"] if reposition else 0)
                + route.get("loading_minutes", 10)
            )
            arrival = departure + route["travel_minutes"] + route.get("unloading_minutes", 10)
            if arrival >= plan["_end"]:
                continue
            return vehicle, departure, arrival
        return None

    def reserve_clinic_transport(self, p, unit, transport, plan):
        vehicle, departure, arrival = transport
        slot = self.place(p, unit, "clinic", reserved=True)
        if not slot:
            raise ValueError("Clinic transport reservation lost its prechecked atomic bundle")
        transfer = {
            "request_id": f"CLINIC-TRANSFER-{p['patient_id']}-{self.event_seq}",
            "status": "reserved",
            "destination_unit_id": unit["unit_id"],
            "destination_slot_id": slot,
            "vehicle_id": vehicle["vehicle_id"],
            "requested_at": self.at(self.now),
            "planned_departure_at": self.at(departure),
            "planned_arrival_at": self.at(arrival),
            "expiry_at": self.at(plan["_end"]),
            "prior_state": "ed_waiting",
            "source_unit_id": None,
            "clinic_policy_id": plan["_clinic_policy"]["clinic_policy_id"],
            "clinic_resource_profile_id": self.clinic_profile(p)["resource_profile_id"],
        }
        p["resource_profile_id"] = p["_ed_profile_id"]
        p["cohort_template_id"] = p["_ed_cohort"]
        p["target_unit_kind"] = "clinic"
        p["pending_transfer"] = transfer
        self.transfer_pending.add(p["patient_id"])
        vehicle["mission"] = p["patient_id"]
        vehicle["available_at"] = arrival + vehicle.get("turnaround_minutes", 10)
        vehicle["location"] = p["facility_id"]
        self.transition(p, "transfer_reserved")
        self.emit(
            "transfer_accepted",
            p,
            dest=unit["unit_id"],
            payload=copy.deepcopy(transfer),
            resources=[slot, vehicle["vehicle_id"]] + [a[0] for a in p["_reserved_allocations"]],
        )
        self.schedule(departure, "clinic_transfer_depart", p["patient_id"], 1)
        self.schedule(arrival, "clinic_transfer_arrive", p["patient_id"], 1)
        self.schedule(
            vehicle["available_at"],
            "vehicle_ready",
            (vehicle["vehicle_id"], p["patient_id"], vehicle["available_at"]),
            0,
        )

    def clinic_transfer(self, patient_id, arrived=False):
        p = self.patients[patient_id]
        transfer = p.get("pending_transfer")
        if not transfer or transfer["status"] != ("departed" if arrived else "reserved"):
            return
        unit = self.units[transfer["destination_unit_id"]]
        if not arrived:
            if (
                not unit["active"]
                or not unit["gate"]
                or self.occupancy(unit) + len(unit["reservations"]) > unit["staffed"]
            ):
                self.cancel_transfer(p, "clinic_capacity_lost_before_departure")
                return
            transfer["status"] = "departed"
            self.transition(p, "in_transit")
            self.emit("transfer_departed", p, dest=unit["unit_id"], payload=copy.deepcopy(transfer))
            return
        slot = unit["reservations"].pop(patient_id)
        self.slots[slot].pop("reservation_id", None)
        self.slots[slot]["patient_id"] = patient_id
        unit["occupants"].add(patient_id)
        for pool_id, count in p.get("_reserved_allocations", []):
            self.pools[pool_id]["reserved"].pop(patient_id, None)
            self.pools[pool_id]["in_use"][patient_id] = count
        p["_allocations"] = p.pop("_reserved_allocations", [])
        p["resource_requirements"] = copy.deepcopy(self.clinic_profile(p)["required_equipment"])
        self.vehicles[transfer["vehicle_id"]]["location"] = unit["facility_id"]
        p["pending_transfer"] = None
        self.transfer_pending.discard(patient_id)
        self.start_clinic_service(p, unit, slot)
        self.emit("transfer_arrived", p, dest=unit["unit_id"], payload=transfer)
        self.emit(
            "clinic_start", p, dest=unit["unit_id"], resources=[slot] + [a[0] for a in p["_allocations"]]
        )

    def arrival(self, payload):
        pid = payload["patient_id"]
        if pid in self.patients:
            return
        s = payload["stream"]
        entry = s.get("entry_type", "ed")
        p = {
            "patient_id": pid,
            "arrival_at": self.at(self.now),
            "facility_id": s.get("destination_facility_id", "FAC-MAIN"),
            "unit_id": None,
            "slot_id": None,
            "state": "ed_waiting" if entry == "ed" else "direct_waiting",
            "care_level": "ambulatory" if entry == "ed" else "ward",
            "entry_type": entry,
            "source_type": payload["source"],
            "cohort_template_id": "COHORT-ED",
            "admitted_at": None,
            "resource_requirements": [],
            "queue_location_id": s.get("initial_queue_location_id"),
            "stage_status": "not_started",
            "eligible_for_transfer": entry != "ed",
            "needs_advanced_transport": False,
            "_token": 0,
            "_allocations": [],
            "state_intervals": [],
        }
        for field in ("arrival_origin", "input_kind"):
            if field in payload:
                p[field] = payload[field]
        p["_random_index"] = payload.get("random_index", self.stream_index(self.now))
        self.patients[pid] = p
        self.choose_path(p, s)
        p["cohort_template_id"] = p.get("_ed_cohort", p["cohort_template_id"])
        self.metrics["arrivals"] += int(self.now >= self.measure_start)
        if self.current_day:
            self.daily[self.current_day]["arrivals"] += int(self.now >= self.measure_start)
        self.emit(
            "arrival",
            p,
            payload={
                "entry_type": entry,
                "source_type": payload["source"],
                **{key: p[key] for key in ("arrival_origin", "input_kind") if key in p},
            },
        )
        if entry == "ed":
            if self.divert_to_clinic(p, s):
                return
            self.queue(p, "ed")
            self.transition(p, "ed_waiting")
        else:
            p["care_level"] = "ward"
            p["target_unit_kind"] = "ward"
            p["admission_requested_at"] = self.at(self.now)
            p["cohort_template_id"] = p["_cohort"]
            apply_stage_profile(self, p, "ward")
            self.queue(p, "ward")
            self.transition(p, "direct_waiting")

    def allocate(self):
        for kind in ("icu", "ward", "ed"):
            candidates = [u for u in self._ordered_staff_units_by_kind[kind] if self.free(u) > 0]
            if not candidates:
                continue
            groups = [(profile, heap) for (care, profile), heap in self.qheap.items() if care == kind]
            while any(self.free(u) > 0 for u in candidates):
                choices = []
                for profile, heap in groups:
                    while heap and (
                        heap[0][2] not in self.queues[kind]
                        or self.patients[heap[0][2]]["state"] in ("transfer_reserved", "in_transit")
                    ):
                        heapq.heappop(heap)
                    if not heap:
                        continue
                    required, declared = queue_spec(self, profile, kind)
                    requirements = [{"capability_code": c, "quantity": 1} for c in required]
                    destination = next(
                        (
                            u
                            for u in candidates
                            if self.free(u) > 0
                            and compatible(self, declared, u)
                            and self.equipment_bundle(u["unit_id"], requirements) is not None
                        ),
                        None,
                    )
                    if destination:
                        choices.append((heap[0], heap, destination))
                if not choices:
                    break
                entry, heap, destination = min(choices, key=lambda x: x[0])
                heapq.heappop(heap)
                self.place(self.patients[entry[2]], destination, kind)
        if any(x["kind"] == "partner_transfer" for x in self.active_plans.values()):
            self.allocate_transfers()
        self.update_blockers()
        queue_count = len(self.admission_pending)
        if self.now < self.measure_start:
            return
        if queue_count > self.peak:
            self.peak = queue_count
            self.peak_at = self.now
        if self.current_day:
            daily = self.daily[self.current_day]
            for kind in ("ward", "icu", "ed"):
                occupied = sum(len(u["occupants"]) for u in self._staff_units_by_kind[kind])
                daily[kind + "_peak_occupied"] = max(daily[kind + "_peak_occupied"], occupied)
            scoped = self._main_care_units
            ratios = [self.occupancy(u) / u["staffed"] for u in scoped if u["staffed"] > 0]
            daily["peak_staffed_utilization"] = (
                max([daily.get("peak_staffed_utilization") or 0, *ratios])
                if ratios
                else daily.get("peak_staffed_utilization")
            )
            daily["zero_capacity"] = daily.get("zero_capacity", False) or any(
                u["staffed"] == 0 for u in scoped
            )
            self.daily[self.current_day]["peak_inpatient_queue"] = max(
                self.daily[self.current_day]["peak_inpatient_queue"], queue_count
            )
        if self.first_shortage is None and (self.admission_pending or self.ed_pending):
            self.first_shortage = self.now
            self.emit("shortage_start", reason="compatible_resources_unavailable")

    def update_blockers(self):
        # Reasons depend on resource availability, not the identity/number of
        # waiting patients. Counts still update on every event for integration.
        equipment = defaultdict(list)
        for pool in self.pools.values():
            equipment[pool.get("unit_id")].append((pool["capability_code"], self.equipment_available(pool)))
        resources = defaultdict(list)
        for unit in self._ordered_units:
            if unit["capacity_mode"] != "staff_derived":
                continue
            occupied = self.occupancy(unit)
            resources[unit["kind"]].append(
                (
                    unit["unit_id"],
                    unit["active"],
                    self.enabled(unit) == 0,
                    not unit["_ready"],
                    bool(unit["cleaning"]),
                    bool(unit["reservations"]),
                    occupied >= self.enabled(unit),
                    occupied + len(unit["reservations"]) >= unit["staffed"],
                    unit["gate"],
                    tuple(equipment[unit["unit_id"]]),
                )
            )
        for (kind, profile), members in self.queue_members.items():
            required, declared = queue_spec(self, profile, kind)
            key = kind + ":" + ",".join(profile)
            count = len(members) - sum(pid in members for pid in self.transfer_pending)
            inputs = (bool(count), tuple(resources[kind]))
            if inputs == self._blocker_inputs.get(key):
                self.current_blockers[key]["patient_count"] = count
                continue
            self._blocker_inputs[key] = inputs
            details = []
            if count > 0:
                for unit in self._ordered_units:
                    if unit["kind"] != kind or unit["capacity_mode"] != "staff_derived":
                        continue
                    reasons = []
                    if not compatible(self, declared, unit):
                        reasons.append("unsupported_care_capability")
                    if not unit["active"]:
                        reasons.append("destination_inactive")
                    if self.enabled(unit) == 0:
                        reasons.append("no_matching_physical_place")
                    elif len(unit["_ready"]) == 0:
                        if unit["cleaning"]:
                            reasons.append("place_turnover")
                        if unit["reservations"]:
                            reasons.append("incoming_reservation")
                        if self.occupancy(unit) >= self.enabled(unit):
                            reasons.append("no_matching_physical_place")
                    if self.occupancy(unit) + len(unit["reservations"]) >= unit["staffed"]:
                        reasons.append("nursing_capacity")
                    if not unit["gate"]:
                        reasons.append("minimum_operating_team")
                    if (
                        self.equipment_bundle(
                            unit["unit_id"], [{"capability_code": cap, "quantity": 1} for cap in required]
                        )
                        is None
                    ):
                        reasons.append("required_equipment_unavailable")
                    if reasons:
                        details.append({"unit_id": unit["unit_id"], "reasons": sorted(set(reasons))})
            reasons = sorted({r for detail in details for r in detail["reasons"]})
            if count and not details:
                reasons = ["unsupported_care_capability"]
            current = {"reasons": reasons, "units": details, "patient_count": count}
            self.current_blockers[key] = current
            if not self.keep:
                continue
            history = self.blocker_history[key]
            previous = history[-1] if history else None
            if previous and previous["reasons"] == reasons and previous["units"] == details:
                continue
            if previous:
                previous["end_elapsed_minutes"] = self.now
                previous["end_at"] = self.at(self.now)
            history.append(
                {
                    "queue_group": key,
                    "start_elapsed_minutes": self.now,
                    "start_at": self.at(self.now),
                    "end_elapsed_minutes": None,
                    "end_at": None,
                    "reasons": reasons,
                    "units": details,
                }
            )
            self.emit(
                "blockers_changed", reason="resource_constraints", payload={"queue_group": key, **current}
            )

    def allocate_transfers(self):
        plans = [p for p in self.active_plans.values() if p["kind"] == "partner_transfer"]
        # Prioritize unresolved requests; inpatient relocation may be enabled explicitly.
        eligible = [
            self.patients[p]
            for p in self.admission_pending
            if self.patients[p]["state"] in ("ed_boarding", "direct_waiting")
            or self.patients[p]["state"] == "inpatient"
            and self.patients[p].get("stage_status") == "ready_to_exit"
        ]
        if any(p.get("include_inpatients", False) for p in plans):
            eligible += [
                p
                for p in self.patients.values()
                if p["state"] == "inpatient" and p.get("facility_id") == "FAC-MAIN"
            ]
        if not any(v["mission"] is None and v["available_at"] <= self.now for v in self.vehicles.values()):
            return
        for p in sorted(
            eligible,
            key=lambda p: (
                p["acuity_rank"],
                p.get("admission_requested_at", p["arrival_at"]),
                p["patient_id"],
            ),
        ):
            if not p.get("eligible_for_transfer") or p.get("pending_transfer"):
                continue
            plan = plans[0]
            if plan.get("max_patients") is not None and plan.get("_count", 0) >= int(plan["max_patients"]):
                continue
            f = plan.get("patient_eligibility_filter", {})
            if f.get("care_levels") and p["care_level"] not in f["care_levels"]:
                continue
            profile_id = p.get("_inpatient_profile_id", p.get("resource_profile_id"))
            if f.get("allowed_profile_ids") and profile_id not in f["allowed_profile_ids"]:
                continue
            if profile_id in f.get("excluded_profile_ids", []):
                continue
            remaining = (
                p.get("_inpatient_duration", 0)
                if p.get("_awaiting_new_stage") or p["state"] != "inpatient"
                else max(0, p.get("_service_end", self.now) - self.now)
            )
            if remaining < f.get("minimum_remaining_stage_minutes", 0):
                continue
            requirements = p.get("_inpatient_requirements", [])
            advanced = bool(requirements) or p["care_level"] == "icu"
            cap = p.get("required_transport_capability") or (
                "ADVANCED_TRANSPORT" if advanced else "BASIC_TRANSPORT"
            )
            vehicles = [
                v
                for v in self.vehicles.values()
                if v["mission"] is None and v["available_at"] <= self.now and cap in v["capabilities"]
            ]
            if not vehicles:
                continue
            destinations = sorted(
                (
                    u
                    for u in self.units.values()
                    if u["capacity_mode"] == "advertised_aggregate"
                    and u["kind"] == p["care_level"]
                    and (not plan.get("destination_unit_id") or u["unit_id"] == plan["destination_unit_id"])
                ),
                key=lambda u: u["unit_id"],
            )
            for u in destinations:
                source = p.get("facility_id", "FAC-MAIN")
                route = self.routes.get((source, u["facility_id"]))
                if not route or route.get("unavailable"):
                    continue
                vehicle = min(vehicles, key=lambda v: v["vehicle_id"])
                reposition = (
                    self.routes.get((vehicle["location"], source)) if vehicle["location"] != source else None
                )
                if vehicle["location"] != source and (not reposition or reposition.get("unavailable")):
                    continue
                reposition_minutes = reposition["travel_minutes"] if reposition else 0
                depart = self.now + reposition_minutes + route.get("loading_minutes", 10)
                expiry = self.now + float(plan.get("reservation_expiry_minutes", 120))
                if depart >= expiry:
                    continue
                sid = self.place(p, u, p["care_level"], reserved=True)
                if not sid:
                    continue
                prior = p["state"]
                arrival = depart + route["travel_minutes"] + route.get("unloading_minutes", 10)
                transfer = {
                    "request_id": f"TRANSFER-{p['patient_id']}-{self.event_seq}",
                    "status": "reserved",
                    "destination_unit_id": u["unit_id"],
                    "destination_slot_id": sid,
                    "vehicle_id": vehicle["vehicle_id"],
                    "requested_at": self.at(self.now),
                    "planned_departure_at": self.at(depart),
                    "planned_arrival_at": self.at(arrival),
                    "expiry_at": self.at(expiry),
                    "prior_state": prior,
                    "source_unit_id": p.get("unit_id"),
                    "remaining_stage_minutes": max(0, p.get("_service_end", self.now) - depart)
                    if prior == "inpatient" and not p.get("_awaiting_new_stage")
                    else p["_inpatient_duration"],
                }
                p["pending_transfer"] = transfer
                p["target_unit_kind"] = u["kind"]
                p["_transfer_requested"] = self.now
                self.transfer_pending.add(p["patient_id"])
                vehicle["mission"] = p["patient_id"]
                vehicle["available_at"] = arrival + vehicle.get("turnaround_minutes", 10)
                vehicle["location"] = source
                self.transition(p, "transfer_reserved", p.get("unit_id"), p.get("slot_id"))
                self.emit("transfer_accepted", p, dest=u["unit_id"], payload=transfer)
                self.schedule(depart, "transfer_depart", (p["patient_id"], transfer["request_id"]), 1)
                self.schedule(expiry, "transfer_expire", (p["patient_id"], transfer["request_id"]), 1)
                self.schedule(arrival, "transfer_arrive", (p["patient_id"], transfer["request_id"]), 1)
                self.schedule(
                    vehicle["available_at"],
                    "vehicle_ready",
                    (vehicle["vehicle_id"], p["patient_id"], vehicle["available_at"]),
                    0,
                )
                plan["_count"] = plan.get("_count", 0) + 1
                break

    def cancel_transfer(self, p, reason):
        transfer = p.get("pending_transfer")
        if not transfer or transfer["status"] == "departed":
            return
        u = self.units[transfer["destination_unit_id"]]
        sid = u["reservations"].pop(p["patient_id"], None)
        if sid:
            self.slots[sid].pop("reservation_id", None)
            if self.slots[sid]["enabled"]:
                u["_ready"].add(sid)
        self.release_equipment(p, reserved=True)
        vehicle = self.vehicles[transfer["vehicle_id"]]
        vehicle["mission"] = None
        vehicle["available_at"] = self.now
        p["pending_transfer"] = None
        self.transfer_pending.discard(p["patient_id"])
        if transfer["prior_state"] == "inpatient" and not p.get("_awaiting_new_stage"):
            p["target_unit_kind"] = None
        if p["patient_id"] in self.admission_pending:
            profile = queue_profile(self, p, p["care_level"])
            heapq.heappush(
                self.qheap[(p["care_level"], profile)],
                (p.get("acuity_rank", 4), self.minute(p["admission_requested_at"]), p["patient_id"]),
            )
        self.transition(p, transfer["prior_state"], p.get("unit_id"), p.get("slot_id"))
        self.emit("transfer_cancelled", p, reason=reason)
        if transfer.get("clinic_policy_id"):
            self.clinic_fallback(p, p["_clinic_policy"], reason, u)
            p.pop("_clinic_policy", None)
            p.pop("clinic_policy_id", None)
            p["target_unit_kind"] = None
            if not p.get("queue_location_id"):
                p["queue_location_id"] = next(
                    (
                        stream["initial_queue_location_id"]
                        for stream in self.data["entry_streams"]
                        if stream["entry_type"] == "ed"
                        and stream["destination_facility_id"] == p["facility_id"]
                    ),
                    None,
                )
            self.queue(p, "ed")
            self.transition(p, "ed_waiting")

    def transfer_depart(self, p):
        tr = p.get("pending_transfer")
        if not tr or tr["status"] != "reserved":
            return
        u = self.units[tr["destination_unit_id"]]
        if not u["active"] or not u["gate"] or self.occupancy(u) + len(u["reservations"]) > u["staffed"]:
            self.cancel_transfer(p, "destination_capacity_lost")
            return
        tr["status"] = "departed"
        tr["remaining_stage_minutes"] = (
            max(0, p.get("_service_end", self.now) - self.now)
            if tr["prior_state"] == "inpatient" and not p.get("_awaiting_new_stage")
            else p["_inpatient_duration"]
        )
        p["_token"] += 1
        source = p.get("unit_id")
        self.release_slot(p)
        p["resource_requirements"] = []
        self.transition(p, "in_transit")
        self.emit("transfer_departed", p, source=source, dest=u["unit_id"], payload=tr)

    def transfer_arrive(self, p):
        tr = p.get("pending_transfer")
        if not tr or tr["status"] != "departed":
            return
        u = self.units[tr["destination_unit_id"]]
        sid = u["reservations"].pop(p["patient_id"])
        self.slots[sid].pop("reservation_id", None)
        self.slots[sid]["patient_id"] = p["patient_id"]
        u["occupants"].add(p["patient_id"])
        for poolid, count in p.get("_reserved_allocations", []):
            self.pools[poolid]["reserved"].pop(p["patient_id"], None)
            self.pools[poolid]["in_use"][p["patient_id"]] = count
        p["_allocations"] = p.pop("_reserved_allocations", [])
        p["resource_requirements"] = [
            {"capability_code": self.pools[k]["capability_code"], "quantity": q} for k, q in p["_allocations"]
        ]
        self.admit(p, u, sid)
        self.start_service(p, tr["remaining_stage_minutes"])
        vehicle = self.vehicles[tr["vehicle_id"]]
        vehicle["location"] = u["facility_id"]
        p["pending_transfer"] = None
        self.transfer_pending.discard(p["patient_id"])
        self.metrics["patients_transferred"] += int(self.now >= self.measure_start)
        if self.current_day:
            self.daily[self.current_day]["transfers"] += int(self.now >= self.measure_start)
        self.emit("transfer_arrived", p, dest=u["unit_id"], payload=tr)

    def plan_start(self, plan):
        kind = plan["kind"]
        target = plan.get("destination_unit_id") or plan.get("unit_id")
        if not target and plan.get("facility_id"):
            target = next(
                (
                    u["unit_id"]
                    for u in self.units.values()
                    if u["facility_id"] == plan["facility_id"]
                    and u["kind"] == ("clinic" if kind == "clinic" else "ward")
                ),
                None,
            )
        if not target and kind in ("clinic", "physical_overflow", "staffed_overflow"):
            target = "UNIT-CLINIC-NORTH" if kind == "clinic" else "UNIT-OVERFLOW-SOUTH"
        if target and target not in self.units:
            raise ValueError("Intervention references unknown unit")
        if (
            target
            and kind in ("clinic", "physical_overflow", "staffed_overflow")
            and self.units[target]["kind"] != ("clinic" if kind == "clinic" else "ward")
        ):
            raise ValueError("Intervention target has incompatible care capability")
        plan["_target_unit"] = target
        if kind == "clinic" and "_clinic_policy" not in plan:
            # Timestamped site-ready updates use this entry point directly.
            policy = self.clinic_policy(plan)
            plan["_clinic_policy"] = policy
            plan["_start"] = max(self.now, self.minute(policy["admission_start_at"]))
            plan["_end"] = min(
                self.horizon, self.minute(policy.get("admission_end_at", self.at(self.horizon)))
            )
            if plan["_start"] >= plan["_end"]:
                raise ValueError("Clinic readiness falls outside its admission interval")
            if plan["_end"] < self.horizon:
                self.schedule(plan["_end"], "plan_end", plan, 0)
            if plan["_start"] > self.now:
                self.schedule(plan["_start"], "plan_start", plan, 0)
                return
        nurses = int(plan.get("nurses", 2 if kind == "clinic" else 5))
        providers = int(plan.get("providers", 1))
        support = int(plan.get("support", 1))
        if "assigned_staff_ids" in plan:
            explicit = plan["assigned_staff_ids"]
            if not target or len(explicit) != len(set(explicit)):
                raise ValueError("Explicit site staffing requires a target and unique staff IDs")
            claimed = {sid for u in self.units.values() for sid in u["active_staff"]}
            absent = {sid for absence in self.absences for sid in absence.get("staff_ids", [])}
            for sid in explicit:
                if (
                    sid not in self.staff
                    or sid in claimed
                    or sid in absent
                    or not self.active_assignments.get(sid, {}).get("reserve_pool_id")
                ):
                    raise ValueError(
                        "Site-ready staff must be currently available, qualified reserve staff without another assignment"
                    )
                role = self.staff[sid]["role"]
                cap = (
                    ("CLINIC" if kind == "clinic" else "WARD") + ("_NURSING" if role == "rn" else "_PROVIDER")
                    if role in ("rn", "provider")
                    else "GENERAL_SUPPORT"
                )
                if cap not in self.staff[sid].get("capabilities", []):
                    raise ValueError("Site-ready staff lacks the destination capability")
            counts = Counter(self.staff[sid]["role"] for sid in explicit)
            nurses, providers, support = counts["rn"], counts["provider"], counts["support"]
        if min(nurses, providers, support) < 0:
            raise ValueError("Staff allocation counts must be nonnegative")
        needs = (
            {"rn": nurses, "provider": providers, "support": support}
            if kind in ("clinic", "staffed_overflow")
            else {"rn": nurses, "provider": 0, "support": 0}
            if kind == "staff_existing"
            else None
        )
        plan["_staff_needs"] = needs
        if needs:
            total = {
                r: n
                + sum(
                    p.get("_staff_needs", {}).get(r, 0)
                    for p in self.active_plans.values()
                    if p.get("_staff_needs")
                )
                for r, n in needs.items()
            }
            available = {
                r: sum(
                    self.staff[s]["role"] == r
                    for s, a in self.active_assignments.items()
                    if a.get("reserve_pool_id")
                )
                for r in needs
            }
            if any(total[r] > available[r] for r in needs):
                self.intervention_results.append(
                    {
                        "id": plan["id"],
                        "kind": kind,
                        "status": "infeasible",
                        "reason": "Reserve staff assignments would overlap",
                    }
                )
                self.emit(
                    "intervention_failed",
                    reason="reserve_contention",
                    payload={k: v for k, v in plan.items() if not k.startswith("_")},
                )
                return
        if kind == "staff_existing" and not target:
            plan["_nurse_units"] = []
            for unit in sorted(self.units.values(), key=lambda u: u["unit_id"]):
                if unit["kind"] != "ward" or unit["capacity_mode"] != "staff_derived" or not unit["active"]:
                    continue
                ratio = self.policies.get(unit.get("capacity_policy_id"), {}).get("slots_per_nurse", 4)
                needed = max(0, math.ceil((self.enabled(unit) - unit["staffed"]) / ratio))
                plan["_nurse_units"].extend([unit["unit_id"]] * needed)
            plan["_nurse_units"] = plan["_nurse_units"][:nurses]
        if kind in ("physical_overflow", "staffed_overflow", "clinic"):
            unit = self.units[target]
            count = int(
                plan.get(
                    "enabled_slots",
                    plan.get(
                        "quantity",
                        plan.get(
                            "spaces",
                            nurses
                            * self.policies.get(unit.get("capacity_policy_id"), {}).get("slots_per_nurse", 4)
                            if kind == "clinic"
                            else len(unit["slots"]),
                        ),
                    ),
                )
            )
            if not 0 <= count <= len(unit["slots"]):
                raise ValueError("Requested spaces exceed declared installed/planned slot records")
            allocations = plan.get("equipment_allocations")
            requested = Counter()
            if allocations is not None:
                for allocation in allocations:
                    poolid, amount = allocation.get("equipment_pool_id"), allocation.get("quantity")
                    if (
                        poolid not in self.pools
                        or not isinstance(amount, int)
                        or isinstance(amount, bool)
                        or amount < 0
                    ):
                        raise ValueError("Invalid site-ready equipment allocation")
                    requested[poolid] += amount
                for poolid, amount in requested.items():
                    pool = self.pools[poolid]
                    if pool.get("unit_id") != target and (
                        not pool.get("portable") or self.equipment_available(pool) < amount
                    ):
                        raise ValueError("Site-ready equipment allocation exceeds free portable inventory")
                if kind == "clinic":
                    available = sum(
                        self.equipment_available(pool)
                        for pool in self.pools.values()
                        if pool.get("unit_id") == target and pool["capability_code"] == "CLINIC_KIT"
                    )
                    available += sum(
                        amount
                        for poolid, amount in requested.items()
                        if self.pools[poolid].get("unit_id") != target
                        and self.pools[poolid]["capability_code"] == "CLINIC_KIT"
                    )
                    if available < count:
                        raise ValueError(
                            "Site-ready clinic requires one explicitly allocated kit per enabled treatment place"
                        )
            if kind == "clinic":
                existing = sum(
                    p["quantity"]
                    for p in self.pools.values()
                    if p.get("unit_id") == target and p["capability_code"] == "CLINIC_KIT"
                )
                needed = max(0, count - existing)
                sources = [
                    p
                    for p in self.pools.values()
                    if p.get("portable") and p.get("unit_id") is None and p["capability_code"] == "CLINIC_KIT"
                ]
                if allocations is None and sum(self.equipment_available(p) for p in sources) < needed:
                    self.intervention_results.append(
                        {
                            "id": plan["id"],
                            "kind": kind,
                            "status": "infeasible",
                            "reason": "Insufficient clinic kits",
                        }
                    )
                    self.emit("intervention_failed", reason="insufficient_equipment")
                    return
            unit["active"] = True
            for i, sid in enumerate(sorted(unit["slots"])):
                if i < count:
                    self.slots[sid]["installation_status"] = "installed"
                self.slots[sid]["enabled"] = i < count
            self.refresh_slots(unit)
            if allocations is not None:
                for poolid, amount in requested.items():
                    self.relocate_equipment(poolid, target, amount)
            elif kind in ("clinic", "staffed_overflow"):
                capability = "CLINIC_KIT" if kind == "clinic" else "WARD_OXYGEN"
                existing = sum(
                    p["quantity"]
                    for p in self.pools.values()
                    if p.get("unit_id") == target and p["capability_code"] == capability
                )
                remaining = max(0, (count if kind == "clinic" else min(8, count)) - existing)
                for pool in sorted(self.pools.values(), key=lambda p: p["equipment_pool_id"]):
                    if (
                        not pool.get("portable")
                        or pool.get("unit_id") is not None
                        or pool["capability_code"] != capability
                    ):
                        continue
                    amount = min(remaining, self.equipment_available(pool))
                    remaining -= amount
                    if not amount:
                        continue
                    self.relocate_equipment(pool["equipment_pool_id"], target, amount)
        self.active_plans[plan["id"]] = plan
        self.reconcile_staff()
        self.intervention_results.append(
            {
                "id": plan["id"],
                "kind": kind,
                "status": "active",
                "ready_at": self.at(self.now),
                "unit_id": target,
                "staff": needs,
            }
        )
        self.emit("intervention_ready", payload={k: v for k, v in plan.items() if not k.startswith("_")})

    def relocate_equipment(self, poolid, target, amount):
        pool = self.pools[poolid]
        if not amount or pool.get("unit_id") == target:
            return
        pool["quantity"] -= amount
        newid = poolid + "-" + target
        if newid in self.pools:
            self.pools[newid]["quantity"] += amount
        else:
            self.pools[newid] = dict(
                copy.deepcopy(pool),
                equipment_pool_id=newid,
                source_equipment_pool_id=pool.get("source_equipment_pool_id", poolid),
                created_in_trajectory=True,
                facility_id=self.units[target]["facility_id"],
                unit_id=target,
                quantity=amount,
                in_use={},
                reserved={},
                failed=0,
                pending_decommission=0,
            )
        self._equipment_index = None

    def refresh_route(self, route_id):
        for key, base in self.base_routes.items():
            if base["route_id"] == route_id:
                self.routes[key] = copy.deepcopy(base)
                for override in self.route_overrides[route_id]:
                    self.routes[key].update(override["changes"])
                break

    def update(self, u):
        kind = u["type"]
        p = u.get("payload", {})
        if kind in ("staff_unavailable", "staff_unavailability"):
            absence = copy.deepcopy(p)
            absence["id"] = u.get("update_id")
            self.absences.append(absence)
            if p.get("until"):
                self.schedule(self.minute(p["until"]), "absence_end", absence, 0)
        elif kind == "staff_available":
            ids = set(p.get("staff_ids", []))
            self.absences = [a for a in self.absences if not ids.intersection(a.get("staff_ids", []))]
        elif kind == "capacity_change":
            unit = self.units[p["unit_id"]]
            n = int(p["enabled_capacity"])
            if not 0 <= n <= self.physical(unit):
                raise ValueError("Enabled capacity exceeds installed capacity")
            installed = sorted(
                sid for sid in unit["slots"] if self.slots[sid].get("installation_status") == "installed"
            )
            for i, sid in enumerate(installed):
                self.slots[sid]["enabled"] = i < n
            self.refresh_slots(unit)
        elif kind == "advertised_capacity_change":
            unit = self.units[p["unit_id"]]
            value = int(p["advertised_staffed_capacity"])
            if unit["capacity_mode"] != "advertised_aggregate" or not 0 <= value <= self.enabled(unit):
                raise ValueError("Invalid advertised staffed capacity")
            unit["advertised_staffed_capacity"] = value
        elif kind == "equipment_change":
            pool = self.pools[p.get("equipment_pool_id", p.get("pool_id"))]
            op = p.get("operation", "add" if p.get("quantity_delta", 0) >= 0 else "decommission")
            quantity = abs(int(p.get("quantity", p.get("quantity_delta", 0))))
            if u.get("input_kind") == "planned_assumption":
                exact = p.get("quantity", abs(p.get("quantity_delta", 0)))
                if not isinstance(exact, int) or isinstance(exact, bool) or exact < 0:
                    raise ValueError("Planned equipment quantity must be a nonnegative integer")
                apply_planned_equipment(pool, op, exact)
            elif op == "add":
                pool["quantity"] += quantity
            elif op == "fail":
                pool["failed"] = min(pool["quantity"], pool["failed"] + quantity)
            elif op == "repair":
                pool["failed"] = max(0, pool["failed"] - quantity)
            elif op == "decommission":
                immediate = min(quantity, self.equipment_available(pool))
                pool["quantity"] -= immediate
                pool["pending_decommission"] += min(
                    quantity - immediate, sum(pool["in_use"].values()) + sum(pool["reserved"].values())
                )
            else:
                raise ValueError("Unsupported equipment operation")
        elif kind == "patient_departure":
            patient = self.patients.get(p["patient_id"])
            if not patient:
                raise ValueError("Departure references unknown patient")
            self.cancel_transfer(patient, "observed_departure")
            self.discharge(patient)
        elif kind == "site_ready":
            self.plan_start(
                dict(
                    p,
                    id=u.get("update_id", "SITE-READY"),
                    kind="clinic"
                    if any(
                        x["facility_id"] == p["facility_id"] and x["kind"] == "clinic"
                        for x in self.units.values()
                    )
                    else "staffed_overflow",
                )
            )
        elif kind == "route_change":
            route = next((r for r in self.routes.values() if r["route_id"] == p["route_id"]), None)
            if not route:
                raise ValueError("Unknown route")
            override = {
                "update_id": u.get("update_id"),
                "changes": {k: v for k, v in p.items() if k in ("travel_minutes", "unavailable")},
            }
            self.route_overrides[p["route_id"]].append(override)
            self.refresh_route(p["route_id"])
            if p.get("until"):
                self.schedule(self.minute(p["until"]), "route_restore", (p["route_id"], override), 0)
        elif kind == "census_replacement":
            raise ValueError(
                "Observed reset must be supplied as a validated replacement dataset with matching scenario start_at"
            )
        else:
            raise ValueError(f"Unsupported operational update: {kind}")
        self.reconcile_staff()
        for patient in list(self.patients.values()):
            tr = patient.get("pending_transfer")
            if tr and tr["status"] == "reserved":
                unit = self.units[tr["destination_unit_id"]]
                if self.occupancy(unit) + len(unit["reservations"]) > unit["staffed"] or not unit["gate"]:
                    self.cancel_transfer(patient, "destination_capacity_lost")
        self.emit("operational_update", payload=u)

    def totals(self):
        result = {}
        for kind in ("ward", "icu", "ed"):
            units = self._staff_units_by_kind[kind]
            result[kind + "_occupied"] = sum(len(u["occupants"]) for u in units)
            result[kind + "_staffed"] = sum(u["staffed"] for u in units)
            result[kind + "_physical"] = sum(self.physical(u) for u in units)
            result[kind + "_available"] = sum(self.free(u) for u in units)
            result[kind + "_reserved"] = sum(len(u["reservations"]) for u in units)
            result[kind + "_cleaning"] = sum(len(u["cleaning"]) for u in units)
        result.update(
            inpatient_queue=len(self.admission_pending),
            ward_queue=len(self.queues["ward"]),
            icu_queue=len(self.queues["icu"]),
            ed_queue=len(self.ed_pending),
            waiting_patient_hours=self.metrics["inpatient_waiting_minutes"] / 60,
        )
        return result

    def integrate(self, next_time):
        elapsed = next_time - max(self.now, self.measure_start)
        if elapsed <= 0:
            return
        # Integration only consumes occupied/staffed counts. Avoid constructing
        # unrelated physical, available, reserved and cleaning sample fields.
        totals = {kind + suffix: 0 for kind in ("ward", "icu", "ed") for suffix in ("_occupied", "_staffed")}
        for unit in self.units.values():
            kind = unit["kind"]
            if unit["capacity_mode"] == "staff_derived" and kind in ("ward", "icu", "ed"):
                totals[kind + "_occupied"] += len(unit["occupants"])
                totals[kind + "_staffed"] += unit["staffed"]
        hours = elapsed / 60
        self.metrics["inpatient_waiting_minutes"] += len(self.admission_pending) * elapsed
        self.metrics["ed_waiting_minutes"] += len(self.ed_pending) * elapsed
        self.metrics["transfer_waiting_minutes"] += len(self.transfer_pending) * elapsed
        if self.admission_pending:
            self.metrics["shortage_minutes"] += elapsed
        deficits = sum(max(0, self.occupancy(u) - u["staffed"]) for u in self.units.values())
        self.metrics["over_capacity_patient_hours"] += deficits * hours
        self.metrics["staff_deficit_hours"] += deficits * hours
        equipment_deficit = sum(
            max(0, sum(p["in_use"].values()) + sum(p["reserved"].values()) - (p["quantity"] - p["failed"]))
            for p in self.pools.values()
        )
        self.metrics["equipment_deficit_hours"] += equipment_deficit * hours
        for k in ("ward", "icu", "ed"):
            self.metrics[k + "_occupied_hours"] += totals[k + "_occupied"] * hours
            self.metrics[k + "_staffed_hours"] += totals[k + "_staffed"] * hours
        self.metrics["additional_staff_hours"] += self._reserve_staff_count * hours
        for blocker in self.current_blockers.values():
            for reason in blocker["reasons"]:
                self.blocker_patient_hours[reason] += blocker["patient_count"] * hours
        if self.current_day:
            daily = self.daily[self.current_day]
            daily["inpatient_waiting_patient_hours"] += len(self.admission_pending) * hours
            daily["ed_waiting_patient_hours"] += len(self.ed_pending) * hours
            daily["capacity_deficit_hours"] += deficits * hours
            daily["staff_deficit_hours"] += deficits * hours
            daily["equipment_deficit_hours"] += equipment_deficit * hours
            for blocker in self.current_blockers.values():
                for reason in blocker["reasons"]:
                    daily["blocker_patient_hours"][reason] = (
                        daily["blocker_patient_hours"].get(reason, 0) + blocker["patient_count"] * hours
                    )
            daily["capacity_shortfall_hours"] = daily.get("capacity_shortfall_hours", 0) + hours * bool(
                self.admission_pending
            )
            for k in ("ward", "icu", "ed"):
                daily[k + "_occupied_hours"] += totals[k + "_occupied"] * hours
                daily[k + "_end_occupied"] = totals[k + "_occupied"]
                daily[k + "_staffed_hours"] += totals[k + "_staffed"] * hours

    def unit_snapshot(self, u):
        equipment = {}
        for p in self.pools.values():
            if p.get("unit_id") == u["unit_id"]:
                e = equipment.setdefault(
                    p["capability_code"],
                    {"quantity": 0, "in_use": 0, "reserved": 0, "available": 0, "deficit": 0},
                )
                e["quantity"] += p["quantity"]
                e["in_use"] += sum(p["in_use"].values())
                e["reserved"] += sum(p["reserved"].values())
                e["available"] += self.equipment_available(p)
                e["deficit"] += max(
                    0, sum(p["in_use"].values()) + sum(p["reserved"].values()) - p["quantity"] + p["failed"]
                )
        return {
            "unit_id": u["unit_id"],
            "facility_id": u["facility_id"],
            "kind": u["kind"],
            "physical": self.physical(u),
            "enabled": self.enabled(u),
            "staffed": u["staffed"],
            "occupied": self.occupancy(u),
            "modeled_occupied": len(u["occupants"]),
            "background_occupied": u.get("background_occupied", 0),
            "reserved": len(u["reservations"]),
            "cleaning": len(u["cleaning"]),
            "ready": len(u["_ready"]),
            "available": self.free(u),
            "staff_by_role": dict(Counter(self.staff[s]["role"] for s in u["active_staff"])),
            "active_staff_ids": sorted(u["active_staff"]),
            "equipment": equipment,
            "admission_gate": u["gate"],
            "active": u["active"],
            "capacity_deficit": max(0, self.occupancy(u) + len(u["reservations"]) - u["staffed"]),
        }

    def record_state(self):
        if not self.keep:
            return
        equipment_inputs = defaultdict(list)
        for pool in self.pools.values():
            equipment_inputs[pool.get("unit_id")].append(
                (
                    pool["capability_code"],
                    pool["quantity"],
                    sum(pool["in_use"].values()),
                    sum(pool["reserved"].values()),
                    pool["failed"],
                    pool["pending_decommission"],
                )
            )
        for uid, u in self.units.items():
            inputs = (
                u["facility_id"],
                u["kind"],
                u["_physical"],
                u["_enabled"],
                u["staffed"],
                len(u["occupants"]),
                u.get("background_occupied", 0),
                len(u["reservations"]),
                len(u["cleaning"]),
                len(u["_ready"]),
                tuple(u["active_staff"]),
                u["gate"],
                u["active"],
                tuple(equipment_inputs[uid]),
            )
            if inputs != self._unit_snapshot_inputs.get(uid):
                snap = self.unit_snapshot(u)
                if snap != self.last_unit_snapshots.get(uid):
                    self.unit_history[uid].append(
                        dict(at=self.at(self.now), elapsed_minutes=self.now, **snap)
                    )
                    self.last_unit_snapshots[uid] = snap
                self._unit_snapshot_inputs[uid] = inputs

            # A slot's visible state depends on its own fields plus these three
            # unit collections. Compare copied source values, not only occupied
            # counts: same-count bed swaps/reservations must remain observable.
            slots = self._unit_slot_records[uid]
            previous = self._slot_snapshot_inputs.get(uid)
            background = u.get("background_occupied", 0)
            if previous and (
                background == previous[0]
                and u["cleaning"] == previous[1]
                and u["_ready"] == previous[2]
                and slots == previous[3]
            ):
                continue
            for slot in slots:
                sid = slot["slot_id"]
                snap = self.slot_snapshot(slot)
                if snap != self.last_slot_snapshots.get(sid):
                    self.slot_history[sid].append(
                        dict(at=self.at(self.now), elapsed_minutes=self.now, **snap)
                    )
                    self.last_slot_snapshots[sid] = snap
            self._slot_snapshot_inputs[uid] = (
                background,
                u["cleaning"].copy(),
                u["_ready"].copy(),
                [slot.copy() for slot in slots],
            )
        for vid, v in self.vehicles.items():
            inputs = (v["location"], v["available_at"], v["mission"])
            if inputs == self._vehicle_snapshot_inputs.get(vid):
                continue
            snap = {
                "vehicle_id": vid,
                "location": v["location"],
                "available_at": self.at(v["available_at"]),
                "mission": v["mission"],
            }
            if snap != self.last_vehicle_snapshots.get(vid):
                self.vehicle_history[vid].append(dict(at=self.at(self.now), elapsed_minutes=self.now, **snap))
                self.last_vehicle_snapshots[vid] = snap
            self._vehicle_snapshot_inputs[vid] = inputs

        # Equipment pools may be split by an activating site and their available
        # quantities also change with reservations, use, failures, and deferred
        # decommissioning. Preserve every current pool ID in a compact interval
        # ledger so selected-time consumers never infer inventory from a source
        # snapshot or from unit-level totals.
        for poolid, pool in sorted(self.pools.items()):
            inputs = (
                pool.get("source_equipment_pool_id", poolid),
                pool.get("created_in_trajectory", False),
                pool.get("facility_id"),
                pool.get("unit_id"),
                pool.get("capability_code"),
                bool(pool.get("portable", False)),
                pool["quantity"],
                tuple(sorted(pool["in_use"].items())),
                tuple(sorted(pool["reserved"].items())),
                pool["failed"],
                pool["pending_decommission"],
            )
            if inputs == self._equipment_pool_snapshot_inputs.get(poolid):
                continue
            snap = self.equipment_pool_snapshot(pool)
            if snap != self.last_equipment_pool_snapshots.get(poolid):
                self.equipment_pool_history[poolid].append(
                    dict(at=self.at(self.now), elapsed_minutes=self.now, **snap)
                )
                self.last_equipment_pool_snapshots[poolid] = snap
            self._equipment_pool_snapshot_inputs[poolid] = inputs

    def equipment_pool_snapshot(self, pool):
        in_use = sum(pool["in_use"].values())
        reserved = sum(pool["reserved"].values())
        return {
            "equipment_pool_id": pool["equipment_pool_id"],
            "source_equipment_pool_id": pool.get("source_equipment_pool_id", pool["equipment_pool_id"]),
            "created_in_trajectory": bool(pool.get("created_in_trajectory", False)),
            "facility_id": pool.get("facility_id"),
            "unit_id": pool.get("unit_id"),
            "capability_code": pool.get("capability_code"),
            "portable": bool(pool.get("portable", False)),
            "quantity": pool["quantity"],
            "in_use": in_use,
            "reserved": reserved,
            "failed": pool["failed"],
            "unserviceable_quantity": pool["failed"],
            "pending_decommission": pool["pending_decommission"],
            "available": self.equipment_available(pool),
        }

    def slot_snapshot(self, s):
        u = self.units[s["unit_id"]]
        sid = s["slot_id"]
        background = sid in u["slots"][: u.get("background_occupied", 0)]
        status = (
            "occupied"
            if s.get("patient_id") or background
            else "reserved"
            if s.get("reservation_id")
            else "cleaning"
            if sid in u["cleaning"]
            else "ready"
            if sid in u["_ready"]
            else "disabled"
        )
        return {
            "slot_id": sid,
            "unit_id": s["unit_id"],
            "slot_kind": s["slot_kind"],
            "status": status,
            "installation_status": s["installation_status"],
            "enabled": s["enabled"],
            "patient_id": s.get("patient_id"),
            "background_occupied": background,
            "reservation_id": s.get("reservation_id"),
            "cleaning_end_at": self.at(u["cleaning"][sid]) if sid in u["cleaning"] else None,
            "layout_x": s.get("layout_x"),
            "layout_y": s.get("layout_y"),
            "display_label": s.get("display_label"),
        }

    def sample(self):
        for uid, u in self.units.items():
            values = {
                "physical": self.physical(u),
                "enabled": self.enabled(u),
                "staffed": u["staffed"],
                "occupied": self.occupancy(u),
                "reserved": len(u["reservations"]),
                "cleaning": len(u["cleaning"]),
                "ready": len(u["_ready"]),
                "available": self.free(u),
                "capacity_deficit": max(0, self.occupancy(u) + len(u["reservations"]) - u["staffed"]),
            }
            for key, value in values.items():
                self.unit_series[uid]["fields"][key].append(value)
        row = dict(at=self.at(self.now), elapsed_minutes=self.now, **self.totals())
        if self.keep:
            # record_state runs immediately before each sample. Its snapshot
            # values are immutable and already describe this exact timestamp.
            row["units"] = list(self.last_unit_snapshots.values())
        self.series.append(row)
        if self.keep:
            # Checkpoint state is encoded by the shared interval ledger. Repeating
            # every queued patient's complete history here grows quadratically.
            self.checkpoints.append(
                {
                    "at": row["at"],
                    "elapsed_minutes": self.now,
                    "event_sequence": self.event_seq,
                    "state_encoding": "interval-ledger-v1",
                }
            )

    def handle(self, kind, payload):
        if kind == "measurement_start":
            self.measure_initial = sum(p["state"] != "discharged" for p in self.patients.values())
        elif kind == "arrival":
            self.arrival(payload)
        elif kind == "complete":
            p = self.patients.get(payload[0])
            if p:
                self.complete(p, payload[1])
        elif kind == "clean":
            unit = self.units[payload["unit"]]
            unit["cleaning"].pop(payload["slot"], None)
            if self.slots[payload["slot"]]["enabled"]:
                unit["_ready"].add(payload["slot"])
            self.emit("slot_cleaning_end", dest=payload["unit"], payload=payload)
        elif kind == "shift":
            for a in payload["remove"]:
                if self.active_assignments.get(a["staff_id"], {}).get("assignment_id") == a["assignment_id"]:
                    self.active_assignments.pop(a["staff_id"], None)
            for a in payload["add"]:
                self.active_assignments[a["staff_id"]] = a
            self.reconcile_staff()
            self.emit("staffing_change", reason="scheduled_shift")
        elif kind == "absence_start":
            self.absences.append(payload)
            self.reconcile_staff()
            self.emit("staffing_change", reason="staff_unavailable", payload=payload)
        elif kind == "absence_end":
            if payload in self.absences:
                self.absences.remove(payload)
            self.reconcile_staff()
            self.emit("staffing_change", reason="staff_available")
        elif kind == "plan_start":
            self.plan_start(payload)
        elif kind == "plan_end":
            active = self.active_plans.get(payload["id"])
            target = payload.get("_target_unit")
            if (
                active
                and payload["kind"] == "clinic"
                and target
                and (self.units[target]["occupants"] or self.units[target]["reservations"])
            ):
                if not active["_clinic_policy"].get("drain_after_close", True):
                    raise ValueError(
                        "Hard clinic closure is infeasible while patients or reservations remain"
                    )
                active["_draining"] = True
                self.emit("site_admissions_closed", source=target, reason="drain_after_close")
            else:
                self.active_plans.pop(payload["id"], None)
                if payload["kind"] == "clinic" and target:
                    self.units[target]["active"] = False
                self.reconcile_staff()
                self.emit(
                    "intervention_ended", payload={k: v for k, v in payload.items() if not k.startswith("_")}
                )
        elif kind == "update":
            self.update(payload)
        elif kind == "route_restore":
            route_id, override = payload
            self.route_overrides[route_id].remove(override)
            self.refresh_route(route_id)
            self.emit(
                "route_restored", payload={"route_id": route_id, "expired_update_id": override["update_id"]}
            )
        elif kind in ("clinic_transfer_depart", "clinic_transfer_arrive"):
            self.clinic_transfer(payload, arrived=kind == "clinic_transfer_arrive")
        elif kind in ("transfer_depart", "transfer_arrive", "transfer_expire"):
            p = self.patients[payload[0]]
            tr = p.get("pending_transfer")
            if tr and tr["request_id"] == payload[1]:
                if kind == "transfer_depart":
                    self.transfer_depart(p)
                elif kind == "transfer_arrive":
                    self.transfer_arrive(p)
                elif tr["status"] == "reserved":
                    self.cancel_transfer(p, "reservation_expired")
        elif kind == "vehicle_ready":
            vehicle = self.vehicles[payload[0]]
            if vehicle["mission"] == payload[1] and vehicle["available_at"] == payload[2]:
                vehicle["mission"] = None
        elif kind == "day_boundary":
            self.current_day = payload
            self.daily[payload]["start_occupancy"] = self.totals()

    def process(self):
        while self.heap:
            time = self.heap[0][0]
            yield self.env.timeout(max(0, time - self.env.now))
            self.integrate(time)
            self.now = time
            if self.now >= self.horizon:
                break
            sampling = False
            # All release/capacity/arrival events at this instant precede allocation.
            while self.heap and abs(self.heap[0][0] - time) < 1e-9:
                _, _, _, kind, payload = heapq.heappop(self.heap)
                if kind == "sample":
                    sampling = True
                    continue
                self.handle(kind, payload)
                self.event_count += 1
                if self.event_count > self.event_limit:
                    raise SimulationLimitExceeded("Per-replication event budget exceeded")
                if self.event_count % 256 == 0 and self.cancel and self.cancel():
                    raise SimulationCancelled("Simulation cancelled")
            self.allocate()
            self.record_state()
            if sampling:
                self.sample()
        if self.now < self.horizon:
            self.integrate(self.horizon)
            self.now = self.horizon

    def run(self):
        self.env.process(self.process())
        self.env.run()
        self.record_state()
        self.sample()
        scalar = {
            "inpatient_waiting_patient_hours": self.metrics["inpatient_waiting_minutes"] / 60,
            "ed_waiting_patient_hours": self.metrics["ed_waiting_minutes"] / 60,
            "peak_inpatient_queue": self.peak,
            "peak_inpatient_queue_at": self.at(self.peak_at),
            "first_shortage_at": self.at(self.first_shortage) if self.first_shortage is not None else None,
            "time_to_first_shortage_hours": (self.first_shortage - self.measure_start) / 60
            if self.first_shortage is not None
            else None,
            "hours_with_unmet_placement_demand": self.metrics["shortage_minutes"] / 60,
            "patients_transferred": self.metrics["patients_transferred"],
            "transfer_waiting_hours": self.metrics["transfer_waiting_minutes"] / 60,
            "temporary_site_patients_served": self.metrics["temporary_site_patients_served"],
            "unserved_at_horizon": len(self.admission_pending),
            "ed_unserved_at_horizon": len(self.ed_pending),
            "over_capacity_patient_hours": self.metrics["over_capacity_patient_hours"],
            "staff_deficit_hours": self.metrics["staff_deficit_hours"],
            "equipment_deficit_hours": self.metrics["equipment_deficit_hours"],
            "additional_staff_hours": self.metrics["additional_staff_hours"],
            "arrivals": self.metrics["arrivals"],
            "discharges": self.metrics["discharges"],
            "initial_patients": self.measure_initial,
            "active_at_horizon": sum(p["state"] != "discharged" for p in self.patients.values()),
            "expected_arrivals": self.metrics["expected_arrivals"],
            "completed_admissions": len(self.completed_waits),
            "completed_wait_median_hours": float(np.median(self.completed_waits)) / 60
            if self.completed_waits
            else None,
            "completed_wait_p90_hours": float(np.percentile(self.completed_waits, 90)) / 60
            if self.completed_waits
            else None,
        }
        scalar["patient_conservation_ok"] = (
            scalar["initial_patients"] + scalar["arrivals"]
            == scalar["active_at_horizon"] + scalar["discharges"]
        )
        for kind in ("ward", "icu", "ed"):
            scalar[kind + "_utilization"] = (
                self.metrics[kind + "_occupied_hours"] / self.metrics[kind + "_staffed_hours"]
                if self.metrics[kind + "_staffed_hours"]
                else None
            )
        daily = []
        for row in self.daily.values():
            hours = (dt(row["end_at"]) - dt(row["start_at"])).total_seconds() / 3600
            for kind in ("ward", "icu", "ed"):
                row[kind + "_occupied"] = row[kind + "_occupied_hours"] / hours
                row[kind + "_staffed"] = row[kind + "_staffed_hours"] / hours
            daily.append(row)
        for history in self.blocker_history.values():
            if history and history[-1]["end_at"] is None:
                history[-1]["end_at"] = self.at(self.horizon)
                history[-1]["end_elapsed_minutes"] = self.horizon
        patients = []
        if self.keep:
            for p in self.patients.values():
                p["censored"] = p["state"] != "discharged"
                if p.get("state_intervals") and p["state_intervals"][-1]["end_at"] is None:
                    p["state_intervals"][-1]["end_at"] = self.at(self.horizon)
                    p["state_intervals"][-1]["end_elapsed_minutes"] = self.horizon
                patients.append(_public_patient(p))
        return {
            "replication_id": self.rid,
            "replication_index": self.index,
            "seed": self.repseed,
            "base_seed": self.seed,
            "model_version": MODEL_VERSION,
            "rng_implementation": "NumPy PCG64 " + np.__version__,
            "input_sha256": digest(
                {
                    "dataset": self.data.get("input_sha256", self.data.get("id")),
                    "scenario": {k: v for k, v in self.scenario.items() if not k.startswith("_")},
                }
            ),
            "status": "SUCCEEDED",
            "measurement_start_at": self.at(self.measure_start),
            "start_at": iso(self.start),
            "end_at": iso(self.end),
            "timezone": self.zone,
            "horizon_elapsed_minutes": self.horizon,
            "scalar_metrics": scalar,
            "series": self.series,
            "daily": daily,
            "events": self.events,
            "checkpoints": self.checkpoints,
            "patients": patients,
            "unit_history": dict(self.unit_history),
            "vehicle_history": dict(self.vehicle_history),
            "slot_history": dict(self.slot_history),
            "equipment_pool_history": dict(self.equipment_pool_history),
            "blocker_history": dict(self.blocker_history),
            "blocker_patient_hours": dict(self.blocker_patient_hours),
            "unit_series": self.unit_series,
            "interventions": self.intervention_results,
            "warnings": ["Synthetic assumptions; simulation ranges are not clinical predictions."],
        }


def estimate_expected_arrivals(dataset, scenario):
    """Expected exogenous arrivals without constructing patients or consuming RNG.

    Uses the same local-day exposure and piecewise multiplier integration as the
    simulation. Explicit arrival batches and initial census are separate inputs.
    """
    model = HospitalSimulation.__new__(HospitalSimulation)
    model.data, model.scenario = dataset, scenario
    model.start = dt(scenario.get("start_at", dataset["snapshot_at"]))
    model.zone = scenario.get("timezone", dataset.get("timezone", ZONE))
    model.days = int(scenario.get("horizon_calendar_days", 30))
    model.end = (
        dt(scenario["end_at"]) if scenario.get("end_at") else endpoint(model.start, model.days, model.zone)
    )
    model.horizon = (model.end - model.start).total_seconds() / 60
    model.conditions = copy.deepcopy(scenario.get("conditions", []))
    model.normalize_conditions()
    expected = 0.0
    for _, _, _, _, _, base, mult in model.arrival_exposures():
        expected += base * mult
    return expected


def run_replication(dataset, scenario, replication_index=0, keep_trace=True, cancel_check=None):
    return HospitalSimulation(dataset, scenario, replication_index, keep_trace, cancel_check).run()


def state_at(trace, at):
    minute = (
        float(at) if isinstance(at, (int, float)) else (dt(at) - dt(trace["start_at"])).total_seconds() / 60
    )
    if not 0 <= minute <= trace["horizon_elapsed_minutes"]:
        raise ValueError("Replay time outside replication interval")
    patients = []
    for p in trace.get("patients", []):
        intervals = p.get("state_intervals", [])
        starts = [i["start_elapsed_minutes"] for i in intervals]
        index = bisect.bisect_right(starts, minute) - 1
        if index < 0:
            continue
        stage = intervals[index]
        if stage["state"] == "discharged":
            continue
        patients.append(
            {
                "patient_id": p["patient_id"],
                "entry_type": p.get("entry_type"),
                "source_type": p.get("source_type"),
                **{key: p[key] for key in ("arrival_origin", "input_kind") if key in p},
                "arrival_at": p.get("arrival_at"),
                "acuity_rank": p.get("acuity_rank"),
                "cohort_template_id": p.get("cohort_template_id"),
                **copy.deepcopy(stage),
            }
        )
    blockers = {}
    for group, history in trace.get("blocker_history", {}).items():
        index = bisect.bisect_right([h["start_elapsed_minutes"] for h in history], minute) - 1
        if index >= 0:
            blockers[group] = history[index]
    for patient in patients:
        blocker = blockers.get(patient.get("queue_group"), {})
        if patient["state"] in ("in_transit", "transfer_reserved"):
            patient["blockers"] = [
                "in_transit" if patient["state"] == "in_transit" else "awaiting_transport_pickup"
            ]
        elif patient.get("admission_pending") or patient["state"] == "ed_waiting":
            patient["blockers"] = blocker.get("reasons", [])
            patient["blocker_units"] = blocker.get("units", [])
        else:
            patient["blockers"] = []
    units = []
    for history in trace.get("unit_history", {}).values():
        index = bisect.bisect_right([x["elapsed_minutes"] for x in history], minute) - 1
        if index >= 0:
            units.append(copy.deepcopy(history[index]))
    slots = []
    for history in trace.get("slot_history", {}).values():
        index = bisect.bisect_right([x["elapsed_minutes"] for x in history], minute) - 1
        if index >= 0:
            slots.append(copy.deepcopy(history[index]))
    vehicles = []
    for history in trace.get("vehicle_history", {}).values():
        index = bisect.bisect_right([x["elapsed_minutes"] for x in history], minute) - 1
        if index >= 0:
            vehicles.append(copy.deepcopy(history[index]))
    equipment_pools = []
    for history in trace.get("equipment_pool_history", {}).values():
        index = bisect.bisect_right([x["elapsed_minutes"] for x in history], minute) - 1
        if index >= 0:
            equipment_pools.append(copy.deepcopy(history[index]))
    equipment_pools.sort(key=lambda pool: pool["equipment_pool_id"])
    return {
        "at": iso(dt(trace["start_at"]) + timedelta(minutes=minute)),
        "elapsed_minutes": minute,
        "replication_id": trace["replication_id"],
        "patients": patients,
        "units": units,
        "vehicles": vehicles,
        "slots": slots,
        "equipment_pools": equipment_pools,
        "equipment_pool_state_available": "equipment_pool_history" in trace,
        "inpatient_queue": sum(p.get("admission_pending", False) for p in patients),
        "ed_queue": sum(p["state"] == "ed_waiting" for p in patients),
        "source": "selected_replication",
    }


# Explicit descriptive alias for external replay consumers.
reconstruct_state = state_at
