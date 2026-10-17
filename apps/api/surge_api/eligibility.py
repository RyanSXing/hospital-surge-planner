"""Read-only placement checks against one observed or simulated resource ledger."""

from __future__ import annotations

import copy
from collections import Counter

from .domain import date


def snapshot_units(dataset):
    """Use only declared snapshot values; future availability requires replay."""
    people = dataset.get("patients", [])
    answer = []
    for unit in dataset.get("units", []):
        uid = unit["unit_id"]
        occupied = [p for p in people if p.get("unit_id") == uid]
        staffed = (
            unit.get("advertised_staffed_capacity")
            if unit.get("capacity_mode") == "advertised_aggregate"
            else unit.get("staffed_capacity", 0)
        )
        total = len(occupied) + unit.get("background_occupied", 0)
        pools = [
            p
            for p in dataset.get("equipment_pools", []) + dataset.get("partner_equipment", [])
            if p.get("unit_id") == uid
        ]
        used = Counter()
        for patient in occupied:
            for req in patient.get("resource_requirements", []):
                used[req["capability_code"]] += req.get("quantity", 1)
        equipment = {}
        for pool in pools:
            cap = pool["capability_code"]
            stock = equipment.setdefault(cap, {"quantity": 0, "available": 0, "in_use": used[cap]})
            stock["quantity"] += pool.get("quantity", 0) - pool.get("unserviceable_quantity", 0)
            stock["available"] = max(0, stock["quantity"] - used[cap])
        active = next(
            (
                f.get("status") == "active"
                for f in dataset["facilities"]
                if f["facility_id"] == unit["facility_id"]
            ),
            False,
        )
        answer.append(
            {
                **unit,
                "active": active,
                "admission_gate": True,
                "staffed": staffed or 0,
                "occupied": total,
                "reserved": 0,
                "available": max(0, min(staffed or 0, unit.get("enabled_capacity", 0)) - total),
                "equipment": equipment,
            }
        )
    return answer


def check_placement(dataset, scenario, site, care, requirements, patient=None, state=None, at=None):
    instant = date(at or dataset["snapshot_at"])
    state = state or {}
    ledgers = state.get("units") or snapshot_units(dataset)
    units = [
        u
        for u in ledgers
        if u.get("facility_id") == site["facility_id"] and u.get("kind", u.get("unit_kind")) == care
    ]
    reasons = []
    assessments = []
    if not units:
        reasons.append(f"No compatible {care} unit at this site")
    for unit in units:
        rejected = []
        if not unit.get("active", site.get("status") == "active"):
            rejected.append("Site is not active with allocated staff and equipment")
        if not unit.get("admission_gate", True):
            rejected.append("Admission gate is closed")
        if unit.get("available", 0) < 1:
            rejected.append("No staffed, ready receiving place remains after occupancy and reservations")
        for requirement in requirements:
            cap = requirement["capability_code"]
            needed = requirement.get("quantity", 1)
            available = unit.get("equipment", {}).get(cap, {}).get("available", 0)
            if available < needed:
                rejected.append(f"{cap}: needs {needed}, available {available}")
        assessments.append({**unit, "eligible": not rejected, "reasons": rejected})
    if units and not any(u["eligible"] for u in assessments):
        reasons.extend(dict.fromkeys(reason for unit in assessments for reason in unit["reasons"]))
    transport = None
    source = (patient or {}).get("facility_id", "FAC-MAIN")
    if source != site["facility_id"]:
        if patient:
            eligible = patient.get(
                "eligible_for_transfer",
                care in {"ward", "icu"}
                and patient.get("state") in {"inpatient", "ed_boarding", "direct_waiting"},
            )
            if not eligible:
                reasons.append("This patient is not eligible for inpatient transfer in the selected state")
            if patient.get("pending_transfer") or patient.get("state") in {"transfer_reserved", "in_transit"}:
                reasons.append("A transfer is already reserved or underway")
        routes = copy.deepcopy(dataset.get("routes", []))
        for update in sorted(scenario.get("updates", []), key=lambda x: x.get("effective_at", "")):
            payload = update.get("payload", {})
            if (
                update.get("type") != "route_change"
                or not update.get("effective_at")
                or date(update["effective_at"]) > instant
            ):
                continue
            if payload.get("until") and date(payload["until"]) <= instant:
                continue
            for route in routes:
                if route.get("route_id") == payload.get("route_id"):
                    route.update(payload)
        route = next(
            (
                r
                for r in routes
                if r.get("from_facility_id") == source
                and r.get("to_facility_id") == site["facility_id"]
                and not r.get("unavailable")
            ),
            None,
        )
        if not route:
            reasons.append("No available directed route from the source facility")
        capability = "ADVANCED_TRANSPORT" if requirements or care == "icu" else "BASIC_TRANSPORT"
        vehicle_state = {v["vehicle_id"]: v for v in state.get("vehicles", [])}
        available = []
        for vehicle in dataset.get("vehicles", []):
            live = vehicle_state.get(vehicle["vehicle_id"], {})
            if capability not in vehicle.get("capabilities", []) or live.get("mission"):
                continue
            if live.get("available_at") and date(live["available_at"]) > instant:
                continue
            location = live.get("location", vehicle.get("home_facility_id"))
            reposition = next(
                (
                    r
                    for r in routes
                    if r.get("from_facility_id") == location
                    and r.get("to_facility_id") == source
                    and not r.get("unavailable")
                ),
                None,
            )
            if location != source and not reposition:
                continue
            available.append(
                {
                    "vehicle_id": vehicle["vehicle_id"],
                    "location": location,
                    "reposition_minutes": reposition.get("travel_minutes", 0) if reposition else 0,
                }
            )
        if not available:
            reasons.append(f"No available vehicle with {capability} and a route to the patient")
        transport = {"required_capability": capability, "available_vehicles": available, "route": route}
    return {
        "site": site,
        "eligible": not reasons,
        "reasons": list(dict.fromkeys(reasons)),
        "units": assessments,
        "patient_id": (patient or {}).get("patient_id"),
        "care_level": care,
        "resource_requirements": requirements,
        "transport": transport,
        "at": state.get("at", dataset["snapshot_at"]),
        "requested_at": at,
        "availability_source": "selected_replication" if state else "dataset_snapshot",
        "source": "selected replication resource ledger; rechecked at execution"
        if state
        else "declared dataset snapshot; future capacity is rechecked during simulation",
    }
