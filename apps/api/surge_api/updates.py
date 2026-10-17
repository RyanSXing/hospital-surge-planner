"""Field-level validation for immutable operational inputs."""

from __future__ import annotations

import math

from .domain import date


def payload_errors(record, dataset):
    errors = []
    kind = record.get("type")
    payload = record.get("payload", {})

    def error(field, message):
        errors.append({"field": "payload." + field, "message": message})

    if not isinstance(payload, dict):
        return [{"field": "payload", "message": "Supply a JSON object"}]
    units = {u["unit_id"]: u for u in dataset.get("units", [])}
    sites = {f["facility_id"]: f for f in dataset.get("facilities", [])}
    staff = {s["staff_id"]: s for s in dataset.get("staff", [])}

    def integer(field, minimum=0, maximum=10000, required=True):
        value = payload.get(field)
        if value is None and not required:
            return
        if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
            error(field, f"Use an integer from {minimum} to {maximum}")

    def reference(field, values, required=True):
        if (required or field in payload) and payload.get(field) not in values:
            error(field, "Select an existing declared resource")

    def roster(required=False):
        ids = payload.get("staff_ids", payload.get("assigned_staff_ids", []))
        if not isinstance(ids, list) or any(s not in staff for s in ids):
            error("staff_ids", "Staff IDs must reference the declared roster")
        elif len(ids) != len(set(ids)):
            error("staff_ids", "A staff member cannot be allocated twice")
        elif required and not ids:
            error("staff_ids", "Select the actual staff being assigned or restored")

    if payload.get("until"):
        try:
            if date(payload["until"]) <= date(record["effective_at"]):
                error("until", "End time must follow effective time")
        except (ValueError, TypeError, KeyError, AttributeError):
            error("until", "Use a timestamp with an explicit UTC offset")
    if kind == "arrival_batch":
        integer("count")
        reference("facility_id", sites)
        mix = payload.get("care_mix")
        if (
            not isinstance(mix, dict)
            or not mix
            or set(mix) - {"discharge", "ward", "icu"}
            or any(
                not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x) or x < 0
                for x in mix.values()
            )
            or not math.isclose(sum(mix.values()), 1, abs_tol=1e-6)
        ):
            error("care_mix", "Explicit discharge, ward and ICU fractions must be nonnegative and sum to one")
        elif any(
            s.get("entry_stream_id") == payload.get("entry_stream_id")
            and s.get("entry_type") == "direct_ward"
            for s in dataset.get("entry_streams", [])
        ) and any(weight > 0 and care != "ward" for care, weight in mix.items()):
            error("care_mix", "Direct ward incidents must request ward care only")
        if "spread_minutes" in payload and (
            not isinstance(payload["spread_minutes"], (int, float))
            or not math.isfinite(payload["spread_minutes"])
            or payload["spread_minutes"] < 0
        ):
            error("spread_minutes", "Spread must be finite and nonnegative")
        if payload.get("entry_stream_id") and payload["entry_stream_id"] not in {
            s["entry_stream_id"] for s in dataset.get("entry_streams", [])
        }:
            error("entry_stream_id", "Choose a declared arrival stream")
    elif kind in {"capacity_change", "advertised_capacity_change"}:
        reference("unit_id", units)
        unit = units.get(payload.get("unit_id"), {})
        field = "enabled_capacity" if kind == "capacity_change" else "advertised_staffed_capacity"
        integer(
            field,
            maximum=unit.get("physical_capacity", 0)
            if kind == "capacity_change"
            else unit.get("enabled_capacity", 0),
        )
        if kind == "advertised_capacity_change" and unit.get("capacity_mode") != "advertised_aggregate":
            error("unit_id", "Advertised totals apply only to an aggregate receiving unit")
    elif kind == "staff_unavailable":
        roster()
        if not payload.get("staff_ids"):
            reference("unit_id", units)
            integer("count", minimum=1, maximum=len(staff))
        if not payload.get("until"):
            error("until", "Specify the end of this staff absence")
    elif kind == "staff_available":
        roster(required=True)
    elif kind == "site_ready":
        reference("facility_id", sites)
        roster(required=True)
        integer("enabled_slots", minimum=1)
        if payload.get("facility_id") in sites and not any(
            u["facility_id"] == payload["facility_id"] and u["kind"] in {"clinic", "ward"}
            for u in units.values()
        ):
            error("facility_id", "Choose a declared clinic or ward location")
        pools = {p["equipment_pool_id"] for p in dataset.get("equipment_pools", [])}
        allocations = payload.get("equipment_allocations", [])
        if not isinstance(allocations, list):
            error("equipment_allocations", "Supply an array of equipment pool and quantity allocations")
        else:
            for index, item in enumerate(allocations):
                if (
                    not isinstance(item, dict)
                    or item.get("equipment_pool_id") not in pools
                    or not isinstance(item.get("quantity"), int)
                    or item.get("quantity", 0) <= 0
                ):
                    error(
                        f"equipment_allocations.{index}",
                        "Select a declared equipment pool and a positive integer quantity",
                    )
    elif kind == "equipment_change":
        pool = payload.get("equipment_pool_id", payload.get("pool_id"))
        if pool not in {p["equipment_pool_id"] for p in dataset.get("equipment_pools", [])}:
            error("equipment_pool_id", "Select a declared equipment pool")
        integer("quantity", maximum=100000, required=False)
        if "quantity" not in payload:
            integer("quantity_delta", minimum=-100000, maximum=100000)
        if payload.get("operation", "add") not in {"add", "fail", "repair", "decommission"}:
            error("operation", "Choose add, fail, repair or decommission")
    elif kind == "route_change":
        reference("route_id", {r["route_id"] for r in dataset.get("routes", [])})
        if not ("travel_minutes" in payload or "unavailable" in payload):
            error("route_id", "Supply travel minutes or an unavailable flag")
        if "travel_minutes" in payload and (
            not isinstance(payload["travel_minutes"], (int, float))
            or not math.isfinite(payload["travel_minutes"])
            or payload["travel_minutes"] < 0
        ):
            error("travel_minutes", "Travel duration must be finite and nonnegative")
        if "unavailable" in payload and not isinstance(payload["unavailable"], bool):
            error("unavailable", "Use a boolean availability flag")
    elif kind == "patient_departure":
        if not isinstance(payload.get("patient_id"), str) or not payload["patient_id"]:
            error("patient_id", "Select an active patient")
        if payload.get("destination_kind") not in {"discharge", "death", "external_transfer"}:
            error("destination_kind", "Choose discharge, death or external_transfer")
    return errors
