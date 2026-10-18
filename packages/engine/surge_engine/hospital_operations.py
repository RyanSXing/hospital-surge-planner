"""Optional severity, interruption and consumable-stock planning model.

The controller is absent for legacy scenarios. It uses independent keyed random
streams and pauses stage clocks without removing patients from their beds.
"""

from __future__ import annotations

import copy
import math
from datetime import timedelta
from zoneinfo import ZoneInfo

from .common import dt, endpoint

OPERATIONS_MODEL_VERSION = "1.2"
SUPPORTED_OPERATIONS_MODEL_VERSIONS = frozenset({"1.0", "1.1", "1.2"})
SEVERITIES = ("low", "medium", "high")


ACCESS_METRIC_DEFINITIONS = {
    "average_wait_per_patient_hours": "Recorded ED-assessment and admission queue waiting for arrivals during the measured period, divided by those arrivals. Includes unfinished waiting observed up to the horizon; initial census excluded.",
    "success_score_percent": "Percentage of eligible measured arrivals whose first treatment starts within 24 elapsed hours. Untreated arrivals with less than 24 hours of follow-up are excluded; initial census excluded. This is an access target, not a clinical outcome.",
}


class ArrivalAccessMetrics:
    """Passive measured-arrival accounting; never schedules events or draws RNG."""

    def __init__(self, sim):
        self.sim = sim
        self.arrivals = set()
        self.first_treatments = {}
        self.wait_minutes = 0.0

    def arrival(self, patient):
        if self.sim.now >= self.sim.measure_start:
            self.arrivals.add(patient["patient_id"])

    def treatment_started(self, patient):
        pid = patient["patient_id"]
        if pid in self.arrivals and pid not in self.first_treatments:
            self.first_treatments[pid] = self.sim.now
            patient["first_treatment_at"] = self.sim.at(self.sim.now)

    def integrate(self, next_time):
        elapsed = next_time - max(self.sim.now, self.sim.measure_start)
        if elapsed > 0 and self.arrivals:
            queued = len(self.arrivals.intersection(self.sim.ed_pending)) + len(
                self.arrivals.intersection(self.sim.admission_pending)
            )
            self.wait_minutes += queued * elapsed

    def finalize(self, scalar):
        eligible = timely = 0
        for pid in self.arrivals:
            arrival = self.sim.minute(self.sim.patients[pid]["arrival_at"])
            treatment = self.first_treatments.get(pid)
            if treatment is not None or self.sim.horizon - arrival >= 1440:
                eligible += 1
                timely += treatment is not None and treatment - arrival <= 1440
        scalar.update(
            average_wait_per_patient_hours=self.wait_minutes / 60 / len(self.arrivals)
            if self.arrivals
            else None,
            success_score_percent=100 * timely / eligible if eligible else None,
            success_eligible_patients=eligible,
            success_treated_within_24h=timely,
            success_arrivals_with_insufficient_followup=len(self.arrivals) - eligible,
        )


def validate_hospital_operations(config, start, end):
    """Validate without repairing values or enabling unrelated features."""
    if config is None:
        return None
    if not isinstance(config, dict):
        raise ValueError("Hospital operations must be an object")  # noqa: TRY004 -- public validation uses ValueError
    if set(config) - {"severity_mix", "disruptions", "supplies"}:
        raise ValueError("Unknown hospital operations setting")

    def number(value, label, minimum=0, maximum=None, positive=False):
        if (
            type(value) not in (int, float)
            or not math.isfinite(value)
            or value < minimum
            or positive
            and value <= 0
            or maximum is not None
            and value > maximum
        ):
            raise ValueError(f"{label} must be a finite number in its allowed range")
        return float(value)

    mix = config.get("severity_mix")
    if mix is not None:
        if not isinstance(mix, dict) or set(mix) != set(SEVERITIES):
            raise ValueError("Patient severity requires low, medium and high groups")
        percentages, means = [], []
        for severity in SEVERITIES:
            group = mix[severity]
            if not isinstance(group, dict):
                raise ValueError("Each severity requires a percentage and average stay")  # noqa: TRY004 -- public validation uses ValueError
            percentages.append(number(group.get("percentage"), "Severity percentage", maximum=100))
            means.append(
                number(group.get("average_stay_hours"), "Average stay hours", maximum=87600, positive=True)
            )
        if abs(sum(percentages) - 100) > 1e-6:
            raise ValueError("Patient severity percentages must sum to 100")
        if means != sorted(means):
            raise ValueError("Average stays must increase or stay equal from low to high severity")
    supplies = config.get("supplies")
    if supplies is not None:
        if not isinstance(supplies, dict):
            raise ValueError("Medical supplies must be an object")
        number(supplies.get("initial_percent"), "Initial supply percentage", maximum=100)
        number(supplies.get("refill_percent"), "Supply refill percentage", maximum=100)
        number(supplies.get("capacity"), "Supply capacity", maximum=1e12, positive=True)
        number(supplies.get("usage_per_patient_day"), "Supply usage per patient day", maximum=1e9)
        interval = supplies.get("refill_every_days")
        if type(interval) is not int or not 1 <= interval <= 365:
            raise ValueError("Supply refill interval must be 1–365 whole calendar days")
    disruptions = config.get("disruptions", [])
    if not isinstance(disruptions, list):
        raise ValueError("Disruptions must be an array")  # noqa: TRY004 -- public validation uses ValueError
    if len(disruptions) > 365:
        raise ValueError("At most 365 disruptions can be configured")
    seen = set()
    for disruption in disruptions:
        if not isinstance(disruption, dict):
            raise ValueError("Each disruption must be an object")  # noqa: TRY004 -- public validation uses ValueError
        identity = disruption.get("id")
        if not isinstance(identity, str) or not identity.strip() or identity in seen:
            raise ValueError("Each disruption needs a unique identifier")
        seen.add(identity)
        try:
            a, b = dt(disruption["start_at"]), dt(disruption["end_at"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("Disruptions require start and end timestamps") from exc
        if not start <= a < b <= end:
            raise ValueError("Disruptions must have positive duration within the simulation horizon")
    return copy.deepcopy(config)


class HospitalOperations:
    def __init__(self, sim, config):
        self.sim = sim
        self.model_version = sim.scenario.get("_hospital_operations_model_version", OPERATIONS_MODEL_VERSION)
        if self.model_version not in SUPPORTED_OPERATIONS_MODEL_VERSIONS:
            raise ValueError("Unsupported hospital operations model version")
        self.config = validate_hospital_operations(config, sim.start, sim.end)
        self.mix = self.config.get("severity_mix")
        self.supplies = self.config.get("supplies")
        self.disruptions = self.config.get("disruptions", [])
        self.stock = (
            self.supplies["capacity"] * self.supplies["initial_percent"] / 100 if self.supplies else None
        )
        self.services = set()
        self.active_disruptions = {
            d["id"] for d in self.disruptions if sim.minute(d["start_at"]) <= 0 < sim.minute(d["end_at"])
        }
        self.rate = 0.0
        self.supply_token = 0
        self.history = []
        self.periods = []
        self.open_periods = {}
        self.supply_percent_minutes = 0.0
        self.supply_measured_minutes = 0.0
        self.last_depletion_schedule = None

    @property
    def reasons(self):
        result = []
        if self.active_disruptions:
            result.append("treatment_disruption")
        if self.supplies and self.stock <= 1e-9:
            result.append("medical_supplies")
        return result

    @property
    def can_treat(self):
        return not self.reasons

    def setup(self):
        sim = self.sim
        for disruption in self.disruptions:
            sim.schedule(sim.minute(disruption["start_at"]), "operations_disruption_start", disruption, -3)
            sim.schedule(sim.minute(disruption["end_at"]), "operations_disruption_end", disruption, -3)
        if self.supplies:
            interval = self.supplies["refill_every_days"]
            for day in range(interval, sim.days + 1, interval):
                at = sim.minute(endpoint(sim.start, day, sim.zone))
                if at < sim.horizon:
                    sim.schedule(at, "operations_supply_refill", None, -3)
        self.reconcile()
        self.record()

    def configure_arrival(self, patient):
        """Scale inpatient bed care, preserving independent assessment clocks.

        Frozen model1.0 runs retain their original whole-path interpretation.
        Initial census is never resampled in either model version.
        """
        if not self.mix:
            return
        draw = self.sim.random(patient["patient_id"], "operations-severity").random() * 100
        cumulative = 0.0
        selected = SEVERITIES[-1]
        for severity in SEVERITIES:
            cumulative += self.mix[severity]["percentage"]
            if draw < cumulative:
                selected = severity
                break
        mean = self.mix[selected]["average_stay_hours"]
        legacy = self.model_version == "1.0"
        fields = []
        if legacy and patient.get("entry_type") == "ed":
            fields.append("_assessment_duration")
        if patient.get("_outcome") in ("ward", "icu"):
            fields.append("_inpatient_duration")
        if patient.get("_stepdown_selected"):
            fields.append("_stepdown_duration")
        if not legacy:
            patient["severity"] = selected
            patient["severity_average_inpatient_stay_hours"] = mean
            patient["sampled_inpatient_care_hours"] = None
            if not fields:
                # An ED-only or clinic visit has no inpatient bed stay. Its
                # original assessment/service distribution remains authoritative.
                return
        # Independent keyed draws preserve care routing and the unit-mean stay
        # draw between response plans. Version1.0 deliberately keeps its exact
        # previous arithmetic and public patient metadata for frozen replays.
        target = (
            max(1e-6, float(self.sim.random(patient["patient_id"], "operations-stay").gamma(2, 0.5)))
            * mean
            * 60
        )
        original = sum(patient.get(field, 0) for field in fields)
        if original <= 0:
            raise ValueError("Severity stay requires a declared positive inpatient care path")
        for field in fields:
            patient[field] *= target / original
        if legacy:
            patient["severity"] = selected
            patient["severity_average_stay_hours"] = mean
            patient["sampled_total_care_hours"] = target / 60
        else:
            patient["sampled_inpatient_care_hours"] = target / 60

    def service_remaining(self, patient, at=None):
        if patient.get("care_paused"):
            return patient.get("_operations_remaining", 0.0)
        return max(0.0, patient.get("_service_end", self.sim.now) - (self.sim.now if at is None else at))

    def after_service_start(self, patient):
        self.services.add(patient["patient_id"])
        if self.can_treat:
            self._first_treatment(patient)
        else:
            self.pause(patient)

    def _first_treatment(self, patient):
        self.sim.arrival_metrics.treatment_started(patient)

    def finish_service(self, patient):
        self.services.discard(patient["patient_id"])
        patient.pop("_operations_remaining", None)
        patient.pop("care_paused", None)
        patient.pop("care_pause_reasons", None)

    def _update_interval(self, patient):
        if self.sim.keep and patient.get("state_intervals"):
            patient["state_intervals"][-1].update(
                care_paused=bool(patient.get("care_paused")),
                care_pause_reasons=copy.deepcopy(patient.get("care_pause_reasons", [])),
                expected_stage_end_at=None
                if patient.get("care_paused")
                else self.sim.at(patient["_service_end"]),
                remaining_stage_spec={"kind": "fixed_minutes", "minutes": patient["_operations_remaining"]}
                if patient.get("care_paused")
                else None,
            )

    def pause(self, patient):
        if not patient.get("care_paused"):
            remaining = self.service_remaining(patient)
            if self.model_version == "1.2" and remaining <= 1e-9:
                # Care already completed before this instant. Keep the pending
                # completion event valid; the shortage still blocks new starts.
                return
            patient["_operations_remaining"] = remaining
            patient["_token"] += 1
            patient["care_paused"] = True
            self.sim.transition(patient, patient["state"], patient.get("unit_id"), patient.get("slot_id"))
        elif patient.get("care_pause_reasons") != self.reasons:
            self.sim.transition(patient, patient["state"], patient.get("unit_id"), patient.get("slot_id"))
        patient["care_pause_reasons"] = self.reasons
        self._update_interval(patient)

    def resume(self, patient):
        remaining = patient.pop("_operations_remaining", 0.0)
        patient["care_paused"] = False
        patient["care_pause_reasons"] = []
        patient["_token"] += 1
        patient["_service_end"] = self.sim.now + remaining
        self._first_treatment(patient)
        self.sim.transition(patient, patient["state"], patient.get("unit_id"), patient.get("slot_id"))
        self._update_interval(patient)
        self.sim.schedule(patient["_service_end"], "complete", (patient["patient_id"], patient["_token"]), 0)

    def reconcile(self):
        sim = self.sim
        reasons = self.reasons
        for reason in tuple(self.open_periods):
            if reason not in reasons:
                row = self.open_periods.pop(reason)
                row.update(end_at=sim.at(sim.now), end_elapsed_minutes=sim.now)
        for reason in reasons:
            if reason not in self.open_periods:
                row = {
                    "reason": reason,
                    "start_at": sim.at(sim.now),
                    "start_elapsed_minutes": sim.now,
                    "end_at": None,
                    "end_elapsed_minutes": None,
                }
                self.periods.append(row)
                self.open_periods[reason] = row
        for pid in sorted(self.services):
            patient = sim.patients[pid]
            if patient["state"] in ("discharged", "in_transit"):
                self.services.discard(pid)
            elif reasons:
                self.pause(patient)
            elif patient.get("care_paused"):
                self.resume(patient)
        self.rate = (
            len(self.services) * self.supplies["usage_per_patient_day"] / 1440
            if self.supplies and not reasons
            else 0.0
        )
        depletion_at = sim.now + self.stock / self.rate if self.rate > 0 and self.stock > 1e-9 else None
        schedule = (self.rate, depletion_at)
        unchanged = (
            self.last_depletion_schedule is not None
            and schedule[0] == self.last_depletion_schedule[0]
            and (
                schedule[1] == self.last_depletion_schedule[1]
                or schedule[1] is not None
                and self.last_depletion_schedule[1] is not None
                and abs(schedule[1] - self.last_depletion_schedule[1]) < 1e-6
            )
        )
        if not unchanged:
            self.last_depletion_schedule = schedule
            self.supply_token += 1
            if self.rate > 0 and self.stock > 1e-9:
                sim.schedule(depletion_at, "operations_supply_depleted", self.supply_token, -3)

    def integrate(self, next_time):
        sim = self.sim
        full_elapsed = next_time - sim.now
        measured_start = max(sim.now, sim.measure_start)
        measured_elapsed = max(0.0, next_time - measured_start)
        if self.supplies:
            before = self.stock
            self.stock = max(0.0, before - self.rate * full_elapsed)
            if self.stock < 1e-9:
                self.stock = 0.0
            begin_stock = max(0.0, before - self.rate * max(0.0, measured_start - sim.now))
            end_stock = self.stock
            area = (begin_stock + end_stock) / 2 / self.supplies["capacity"] * 100 * measured_elapsed
            self.supply_percent_minutes += area
            self.supply_measured_minutes += measured_elapsed
            if sim.current_day:
                daily = sim.daily[sim.current_day]
                daily["_medical_supply_percent_minutes"] += area
                daily["_medical_supply_measured_minutes"] += measured_elapsed
                daily["medical_supply_consumed_units"] += (
                    max(0.0, begin_stock - end_stock) if measured_elapsed else 0
                )
                daily["medical_supply_end_percent"] = self.percent()
                daily["medical_supply_min_percent"] = min(daily["medical_supply_min_percent"], self.percent())
                daily["medical_supplies_shortage_hours"] += measured_elapsed / 60 * (before <= 1e-9)
        if sim.current_day and self.disruptions:
            sim.daily[sim.current_day]["treatment_disruption_hours"] += (
                measured_elapsed / 60 * bool(self.active_disruptions)
            )

    def percent(self):
        return self.stock / self.supplies["capacity"] * 100 if self.supplies else None

    def fields(self):
        fields = {"treatment_disrupted": bool(self.active_disruptions), "care_paused": not self.can_treat}
        if self.supplies:
            fields.update(medical_supply_percent=self.percent(), medical_supply_stock=self.stock)
        return fields

    def record(self):
        row = {"at": self.sim.at(self.sim.now), "elapsed_minutes": self.sim.now, **self.fields()}
        if self.history and self.history[-1]["elapsed_minutes"] == self.sim.now:
            self.history[-1] = row
        else:
            self.history.append(row)

    def handle(self, kind, payload):
        sim = self.sim
        if kind == "operations_disruption_start":
            self.active_disruptions.add(payload["id"])
            sim.emit("treatment_disruption_started", reason="treatment_disruption", payload=payload)
        elif kind == "operations_disruption_end":
            self.active_disruptions.discard(payload["id"])
            sim.emit("treatment_disruption_ended", reason="treatment_disruption", payload=payload)
        elif kind == "operations_supply_refill":
            amount = min(
                self.supplies["capacity"] - self.stock,
                self.supplies["capacity"] * self.supplies["refill_percent"] / 100,
            )
            self.stock += amount
            date = (sim.start + timedelta(minutes=sim.now)).astimezone(ZoneInfo(sim.zone)).date().isoformat()
            if date in sim.daily and sim.now >= sim.measure_start:
                sim.daily[date]["medical_supply_refilled_units"] += amount
            sim.emit(
                "medical_supplies_refilled",
                reason="medical_supplies",
                payload={"added_units": amount, "stock_percent": self.percent()},
            )
        elif kind == "operations_supply_depleted":
            if payload != self.supply_token:
                return
            self.stock = 0.0
            sim.emit("medical_supplies_depleted", reason="medical_supplies", payload={"stock_percent": 0})
        self.reconcile()
        self.record()

    def daily_start(self, row):
        if self.supplies:
            row.update(
                medical_supply_end_percent=self.percent(),
                medical_supply_min_percent=self.percent(),
                medical_supply_consumed_units=0.0,
                medical_supply_refilled_units=0.0,
                medical_supplies_shortage_hours=0.0,
                _medical_supply_percent_minutes=0.0,
                _medical_supply_measured_minutes=0.0,
            )
        if self.disruptions:
            row["treatment_disruption_hours"] = 0.0

    def finalize(self, scalar, daily):
        sim = self.sim
        if self.supplies:
            scalar["medical_supply_average_percent"] = (
                self.supply_percent_minutes / self.supply_measured_minutes
                if self.supply_measured_minutes
                else None
            )
        for row in daily:
            if self.supplies:
                minutes = row.pop("_medical_supply_measured_minutes")
                area = row.pop("_medical_supply_percent_minutes")
                row["medical_supply_average_percent"] = area / minutes if minutes else None
        for row in self.open_periods.values():
            row.update(end_at=sim.at(sim.horizon), end_elapsed_minutes=sim.horizon)
        self.record()
        return {
            "hospital_operations_model_version": self.model_version,
            "operations_history": self.history,
            "operations_constraint_periods": self.periods,
            "metric_definitions": {
                "medical_supply_average_percent": "Elapsed-time-weighted general medical supply stock percentage during the measured period. Supplies are used only while patients receive active care; refills add the configured fraction of maximum capacity, capped at capacity.",
                "severity_stays": (
                    "For newly arriving patients, independent gamma(shape=2) total active care time has the configured severity mean and scales the declared ED/inpatient/stepdown stages proportionally. Waiting, interruption and transport time are additional. Initial census retains declared residual stays and future paths."
                    if self.model_version == "1.0"
                    else "For newly arriving admitted patients, independent gamma(shape=2) total inpatient bed care has the configured severity mean and scales inpatient and stepdown stays proportionally. ED and clinic assessment durations and care routing remain unchanged; severity-tagged ED-only visits have no inpatient stay. Waiting, interruption and transport time are additional. Initial census retains declared residual stays and future paths."
                ),
            },
        }
