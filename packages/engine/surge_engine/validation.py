"""Structural and cross-resource import validation. Errors never repair input silently."""

from __future__ import annotations

import csv
import io
import json
import math
import re
import zipfile
from collections import Counter, defaultdict

from .common import canonical, dt

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$")


def validate_dataset(dataset):
    errors = []
    warnings = []

    def error(table, row, field, message):
        errors.append({"file": table, "row": row, "field": field, "message": message})

    if not isinstance(dataset, dict):
        return {
            "valid": False,
            "errors": [{"file": "dataset", "row": 0, "field": "", "message": "Expected JSON object"}],
            "warnings": [],
        }
    from .schema_validation import canonical_schema_errors

    schema_errors = canonical_schema_errors(dataset)
    if schema_errors:
        return {
            "valid": False,
            "errors": schema_errors,
            "warnings": [],
            "synthetic": dataset.get("synthetic", False),
        }
    required = {
        "facilities": "facility_id",
        "units": "unit_id",
        "slots": "slot_id",
        "patients": "patient_id",
        "staff": "staff_id",
        "equipment_pools": "equipment_pool_id",
        "cohorts": "cohort_id",
        "los_templates": "template_id",
    }
    indexes = {}
    for table, key in required.items():
        rows = dataset.get(table)
        if not isinstance(rows, list):
            error(table, 0, key, "Required table is missing")
            rows = []
        index = {}
        for i, row in enumerate(rows, 2):
            if not isinstance(row, dict):
                error(table, i, "", "Expected object")
                continue
            ident = row.get(key)
            if not isinstance(ident, str) or not ID.fullmatch(ident):
                error(table, i, key, "Invalid identifier")
            if ident in index:
                error(table, i, key, "Duplicate identifier")
            index[ident] = row
        indexes[table] = index
    if not dataset.get("snapshot_at"):
        error("manifest", 0, "snapshot_at", "Snapshot timestamp required")
    try:
        snapshot = dt(dataset.get("snapshot_at"))
    except (ValueError, TypeError):
        snapshot = None
        error("manifest", 0, "snapshot_at", "Timestamp must include timezone")

    def foreign(table, row, field, other, optional=False):
        value = row.get(field)
        if value is None and optional:
            return
        if value not in indexes[other]:
            error(table, 0, field, f"Unknown reference: {value}")

    for i, u in enumerate(dataset.get("units", []), 2):
        foreign("units", u, "facility_id", "facilities")
        for f in ["physical_capacity", "enabled_capacity", "background_occupied"]:
            if not isinstance(u.get(f), int) or isinstance(u.get(f), bool) or u[f] < 0:
                error("units", i, f, "Expected nonnegative integer")
        if u.get("kind") not in ("ward", "icu", "ed", "clinic", "shelter"):
            error("units", i, "kind", "Unsupported unit kind")
        installed = sum(
            s.get("unit_id") == u.get("unit_id") and s.get("installation_status") == "installed"
            for s in dataset.get("slots", [])
        )
        enabled = sum(
            s.get("unit_id") == u.get("unit_id")
            and s.get("installation_status") == "installed"
            and s.get("enabled")
            for s in dataset.get("slots", [])
        )
        if installed != u.get("physical_capacity"):
            error(
                "units",
                i,
                "physical_capacity",
                f"Physical count does not reconcile with installed slots ({installed})",
            )
        if enabled != u.get("enabled_capacity"):
            error("units", i, "enabled_capacity", f"Enabled count does not reconcile with slots ({enabled})")
        if (
            u.get("capacity_mode") == "advertised_aggregate"
            and not 0 <= u.get("advertised_staffed_capacity", -1) <= enabled
        ):
            error(
                "units",
                i,
                "advertised_staffed_capacity",
                "Advertised total must be within installed enabled capacity",
            )
    for i, s in enumerate(dataset.get("slots", []), 2):
        foreign("slots", s, "unit_id", "units")
        if s.get("installation_status") not in ("planned", "installed", "removed"):
            error("slots", i, "installation_status", "Unknown installation status")
        if s.get("installation_status") != "installed" and s.get("enabled"):
            error("slots", i, "enabled", "An uninstalled slot cannot be enabled")
    policies = {p["capacity_policy_id"]: p for p in dataset["capacity_policies"]}

    def bundle(unit_id, requirements):
        quantities = Counter()
        for item in requirements:
            if isinstance(item, str):
                quantities[item] += 1
            else:
                quantities[item["capability_code"]] += item["quantity"]
        unit = indexes["units"].get(unit_id)
        if unit:
            blanket = Counter()
            for item in policies[unit["capacity_policy_id"]]["per_slot_resources"]:
                blanket[item["capability_code"]] += item["quantity"]
            for capability, count in blanket.items():
                quantities[capability] = max(quantities[capability], count)
        return quantities

    occupied = set()
    reserved_slots = set()
    assigned_vehicles = set()
    equipment_usage = Counter()
    allowed_states = {
        "ed_waiting",
        "direct_waiting",
        "ed_assessment",
        "ed_boarding",
        "inpatient",
        "clinic_assessment",
        "transfer_reserved",
        "in_transit",
        "discharged",
    }
    for i, p in enumerate(dataset.get("patients", []), 2):
        foreign("patients", p, "facility_id", "facilities", optional=p.get("state") == "discharged")
        foreign("patients", p, "unit_id", "units", optional=True)
        foreign("patients", p, "cohort_template_id", "cohorts")
        state = p.get("state")
        slot = p.get("slot_id")
        unit = p.get("unit_id")
        transfer = p.get("pending_transfer") or {}
        clinic_transfer = (
            state in ("transfer_reserved", "in_transit") and transfer.get("prior_state") == "ed_waiting"
        )
        completed_source = p.get("stage_status") == "ready_to_exit" and state in (
            "inpatient",
            "transfer_reserved",
            "in_transit",
        )
        if unit in indexes["units"] and indexes["units"][unit]["facility_id"] != p.get("facility_id"):
            error("patients", i, "facility_id", "Patient facility disagrees with occupied unit")
        if p.get("care_level") not in ("ambulatory", "ward", "icu", "nonclinical"):
            error("patients", i, "care_level", "Unsupported care level")
        if state not in allowed_states:
            error("patients", i, "state", "Unsupported patient state")
        if state in ("inpatient", "ed_assessment", "ed_boarding", "clinic_assessment") or (
            state == "transfer_reserved"
            and transfer.get("prior_state") not in ("direct_waiting", "ed_waiting")
        ):
            if slot not in indexes["slots"]:
                error("patients", i, "slot_id", "Occupying patient requires a valid slot")
            elif indexes["slots"][slot]["unit_id"] != unit:
                error("patients", i, "slot_id", "Slot belongs to a different unit")
            elif indexes["slots"][slot].get("installation_status") != "installed":
                error("patients", i, "slot_id", "Patient cannot occupy uninstalled slot")
            if slot in occupied:
                error("patients", i, "slot_id", "Slot has multiple occupants")
            occupied.add(slot)
        if (
            state in ("ed_waiting", "direct_waiting", "in_transit", "discharged")
            or (
                state == "transfer_reserved"
                and transfer.get("prior_state") in ("direct_waiting", "ed_waiting")
            )
        ) and (slot or unit):
            error("patients", i, "unit_id", "Queue/transit/terminal state cannot occupy a slot")
        if state in ("ed_boarding", "direct_waiting") and not p.get("admission_requested_at"):
            error("patients", i, "admission_requested_at", "Pending admission requires request timestamp")
        if state == "inpatient" and p.get("eligible_for_clinic_diversion"):
            error(
                "patients",
                i,
                "eligible_for_clinic_diversion",
                "Inpatients cannot be diverted to outpatient clinic",
            )
        for field in ("arrival_at", "unit_entered_at", "admission_requested_at", "admitted_at"):
            if p.get(field):
                try:
                    if snapshot and dt(p[field]) > snapshot:
                        error("patients", i, field, "Observation cannot be after snapshot")
                except (ValueError, TypeError):
                    error("patients", i, field, "Timestamp must include timezone")
        if not completed_source and (
            state in ("inpatient", "ed_assessment", "clinic_assessment")
            or (state == "transfer_reserved" and transfer.get("prior_state") == "inpatient")
        ):
            spec = p.get("remaining_stage_spec")
            flat = [
                p.get("remaining_stay_minutes"),
                p.get("remaining_stay_template_id"),
                p.get("assessment_remaining_minutes"),
            ]
            if sum(x is not None for x in flat) > 1:
                error("patients", i, "remaining_stage_spec", "Conflicting remaining duration methods")
            if not spec and not any(x is not None for x in flat):
                error("patients", i, "remaining_stage_spec", "In-service stage requires remaining duration")
            if spec:
                if spec.get("kind") == "fixed_minutes" and (
                    not isinstance(spec.get("minutes"), (int, float)) or spec["minutes"] <= 0
                ):
                    error("patients", i, "remaining_stage_spec", "Remaining duration must be positive")
                if (
                    spec.get("kind") in ("remaining_distribution", "conditional_total")
                    and spec.get("distribution_id") not in indexes["los_templates"]
                ):
                    error("patients", i, "remaining_stage_spec", "Unknown distribution")
                if spec.get("kind") not in (
                    "fixed_minutes",
                    "expected_end",
                    "remaining_distribution",
                    "conditional_total",
                ):
                    error("patients", i, "remaining_stage_spec", "Unknown remaining duration method")
                if spec.get("kind") == "expected_end":
                    try:
                        if snapshot and dt(spec.get("expected_end_at")) <= snapshot:
                            error(
                                "patients",
                                i,
                                "remaining_stage_spec",
                                "Expected stage end must follow snapshot",
                            )
                    except (ValueError, TypeError):
                        error(
                            "patients",
                            i,
                            "remaining_stage_spec",
                            "Expected stage end requires timezone-aware timestamp",
                        )
        if state in ("transfer_reserved", "in_transit"):
            if transfer.get("prior_state") not in (
                "inpatient",
                "ed_boarding",
                "direct_waiting",
                "ed_waiting",
            ):
                error("patients", i, "pending_transfer.prior_state", "Explicit prior source state required")
            if transfer.get("status") != ("departed" if state == "in_transit" else "reserved"):
                error(
                    "patients", i, "pending_transfer.status", "Transfer status disagrees with patient state"
                )
            sid = transfer.get("destination_slot_id") or transfer.get("reservation_id")
            destination = indexes["units"].get(transfer.get("destination_unit_id"))
            destination_slot = indexes["slots"].get(sid)
            if not destination or destination["kind"] != (
                "clinic" if clinic_transfer else p.get("care_level")
            ):
                error(
                    "patients",
                    i,
                    "pending_transfer.destination_unit_id",
                    "Receiving unit requires matching care capability",
                )
            if (
                not destination_slot
                or destination_slot.get("unit_id") != transfer.get("destination_unit_id")
                or destination_slot.get("installation_status") != "installed"
            ):
                error(
                    "patients",
                    i,
                    "pending_transfer.destination_slot_id",
                    "Receiving reservation requires an installed destination slot",
                )
            if sid in reserved_slots:
                error(
                    "patients", i, "pending_transfer.destination_slot_id", "Receiving slot is reserved twice"
                )
            reserved_slots.add(sid)
            vehicle = transfer.get("vehicle_id")
            if (
                vehicle not in {v["vehicle_id"] for v in dataset.get("vehicles", [])}
                or vehicle in assigned_vehicles
            ):
                error(
                    "patients",
                    i,
                    "pending_transfer.vehicle_id",
                    "Transfer requires one unique declared vehicle",
                )
            assigned_vehicles.add(vehicle)
            duration = transfer.get("remaining_stage_minutes")
            if (
                not clinic_transfer
                and not completed_source
                and (
                    not isinstance(duration, (int, float))
                    or isinstance(duration, bool)
                    or not math.isfinite(duration)
                    or duration <= 0
                )
            ):
                error(
                    "patients",
                    i,
                    "pending_transfer.remaining_stage_minutes",
                    "Explicit positive remaining stage required",
                )
            try:
                requested, arrival = dt(transfer["requested_at"]), dt(transfer["planned_arrival_at"])
                departure = dt(transfer["planned_departure_at"])
                if (
                    not transfer.get("request_id")
                    or not snapshot
                    or requested > snapshot
                    or arrival <= snapshot
                    or departure >= arrival
                    or (state == "transfer_reserved" and departure < snapshot)
                    or (state == "in_transit" and departure > snapshot)
                ):
                    error(
                        "patients",
                        i,
                        "pending_transfer",
                        "Transfer timestamps must reconcile with snapshot and state",
                    )
            except (KeyError, ValueError, TypeError):
                error(
                    "patients",
                    i,
                    "pending_transfer",
                    "Transfer requires request, departure and arrival timestamps with timezones",
                )
            destination_requirements = p.get("inpatient_resource_requirements", [])
            if clinic_transfer:
                destination_requirements = next(
                    profile["required_equipment"]
                    for profile in dataset["resource_profiles"]
                    if profile["resource_profile_id"] == transfer["clinic_resource_profile_id"]
                )
            for cap, qty in bundle(transfer.get("destination_unit_id"), destination_requirements).items():
                equipment_usage[(transfer.get("destination_unit_id"), cap)] += qty
        for cap, qty in bundle(unit, p.get("resource_requirements", [])).items():
            equipment_usage[(unit, cap)] += qty
        if unit in indexes["units"]:
            policy = policies[indexes["units"][unit]["capacity_policy_id"]]
            # An ED boarder still occupies the ED assessment stage; its target
            # inpatient care level is not an ED policy exclusion.
            stage_care = (
                "ambulatory"
                if indexes["units"][unit]["kind"] in ("ed", "clinic")
                else indexes["units"][unit]["kind"]
                if completed_source
                else p["care_level"]
            )
            if stage_care not in policy["allowed_patient_care_levels"]:
                error(
                    "patients",
                    i,
                    "unit_id",
                    "Occupied unit policy excludes the patient's current stage care level",
                )
    if occupied.intersection(reserved_slots):
        error(
            "patients",
            0,
            "pending_transfer.destination_slot_id",
            "Receiving reservation overlaps an occupied slot",
        )
    pool_qty = Counter()
    for i, pool in enumerate(dataset.get("equipment_pools", []), 2):
        foreign("equipment_pools", pool, "facility_id", "facilities")
        foreign("equipment_pools", pool, "unit_id", "units", optional=True)
        q = pool.get("quantity", -1)
        bad = pool.get("unserviceable_quantity", 0)
        if not isinstance(q, int) or not isinstance(bad, int) or not 0 <= bad <= q:
            error("equipment_pools", i, "quantity", "Invalid serviceable inventory")
            continue
        pool_qty[(pool.get("unit_id"), pool.get("capability_code"))] += q - bad
    for pool in dataset.get("partner_equipment", []):
        pool_qty[(pool.get("unit_id"), pool.get("capability_code"))] += pool.get("quantity", 0)
    for key, quantity in equipment_usage.items():
        if quantity > pool_qty[key]:
            error(
                "patients",
                0,
                "resource_requirements",
                f"Initial equipment oversubscribed: {key}, {quantity} needed / {pool_qty[key]} serviceable",
            )
    assignments = dataset.get("assignments", dataset.get("staff_assignments", []))
    staff_intervals = defaultdict(list)
    seen_assign = set()
    for i, a in enumerate(assignments, 2):
        if a.get("assignment_id") in seen_assign:
            error("assignments", i, "assignment_id", "Duplicate assignment ID")
        seen_assign.add(a.get("assignment_id"))
        foreign("assignments", a, "staff_id", "staff")
        foreign("assignments", a, "unit_id", "units", optional=True)
        if bool(a.get("unit_id")) == bool(a.get("reserve_pool_id")):
            error("assignments", i, "unit_id", "Exactly one unit or reserve pool is required")
        try:
            start, end = dt(a["start_at"]), dt(a["end_at"])
            if end <= start:
                error("assignments", i, "end_at", "Shift must have positive duration")
            fraction = a.get("allocation_fraction", 1)
            if not isinstance(fraction, (float, int)) or not 0 < fraction <= 1:
                error("assignments", i, "allocation_fraction", "Allocation must be in (0,1]")
            elif a.get("status") != "unavailable":
                staff_intervals[a.get("staff_id")].extend([(start, float(fraction)), (end, -float(fraction))])
        except (KeyError, ValueError, TypeError):
            error("assignments", i, "start_at", "Invalid shift timestamps")
    for staff, points in staff_intervals.items():
        allocated = 0
        for _, delta in sorted(points):
            allocated += delta
            if allocated > 1.000001:
                error("assignments", 0, "staff_id", f"Overlapping allocation for {staff}")
                break
    baseline = dataset.get("arrival_profiles", dataset.get("baseline", {}))
    for field, expected, length in [("hour_weights", 1, 24), ("weekday_weights", 7, 7)]:
        values = baseline.get(field, [])
        if (
            len(values) != length
            or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values)
            or abs(sum(values) - expected) > 1e-9
        ):
            error("baseline", 0, field, f"Expected {length} finite nonnegative weights summing to {expected}")
    for field in ("ed_arrivals_per_local_day", "direct_ward_arrivals_per_local_day"):
        value = baseline.get(field)
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            error("baseline", 0, field, "Expected finite nonnegative rate")
    for i, t in enumerate(dataset.get("los_templates", []), 2):
        fields = ["shape", "scale_hours"] if t.get("family") == "gamma" else ["fixed_minutes"]
        for field in fields:
            value = t.get(field)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                error("los_templates", i, field, "Distribution parameter must be positive and finite")
    if dataset.get("synthetic"):
        warnings.append("Synthetic engineering fixtures; these parameters are not clinically validated.")
    if dataset.get("historical_census_linkage") == "independent_demo_snapshot":
        warnings.append("Historical episodes and current census are separately constructed.")
    reconciliation = []
    active_staff = defaultdict(lambda: defaultdict(float))
    if snapshot:
        for assignment in assignments:
            if (
                assignment.get("unit_id")
                and assignment["status"] != "unavailable"
                and dt(assignment["start_at"]) <= snapshot < dt(assignment["end_at"])
            ):
                active_staff[assignment["unit_id"]][assignment["staff_id"]] = assignment[
                    "allocation_fraction"
                ]
    facilities = indexes["facilities"]
    for unit in dataset["units"]:
        policy = policies[unit["capacity_policy_id"]]
        allocation = active_staff[unit["unit_id"]]
        qualifications = {
            "rn": policy["nurse_capability"],
            "provider": unit["kind"].upper() + "_PROVIDER",
            "support": "GENERAL_SUPPORT",
        }
        counts = {
            role: sum(
                fraction
                for identity, fraction in allocation.items()
                if capability in indexes["staff"][identity]["capabilities"]
            )
            for role, capability in qualifications.items()
        }
        enabled = unit["enabled_capacity"]
        if unit["capacity_mode"] == "advertised_aggregate":
            staffed = min(enabled, unit["advertised_staffed_capacity"])
            gate = True
        else:
            staffed = min(enabled, math.floor(counts["rn"] * policy["slots_per_nurse"]))
            gate = (
                counts["provider"] >= policy["minimum_provider_count"]
                and counts["support"] >= policy["minimum_support_count"]
            )
            for capability, count in bundle(unit["unit_id"], []).items():
                staffed = min(staffed, pool_qty[(unit["unit_id"], capability)] // count)
        active = facilities[unit["facility_id"]]["status"] == "active"
        if not active:
            staffed, gate = 0, False
        modeled = sum(p.get("unit_id") == unit["unit_id"] for p in dataset["patients"])
        incoming = sum(
            (p.get("pending_transfer") or {}).get("destination_unit_id") == unit["unit_id"]
            and p["state"] in ("transfer_reserved", "in_transit")
            for p in dataset["patients"]
        )
        occupied_count = modeled + unit["background_occupied"]
        reconciliation.append(
            {
                "unit_id": unit["unit_id"],
                "physical": unit["physical_capacity"],
                "enabled": enabled,
                "occupied": occupied_count,
                "modeled_occupied": modeled,
                "background_occupied": unit["background_occupied"],
                "reserved": incoming,
                "staffed": staffed,
                "qualified_staff_by_role": counts,
                "admission_gate": gate,
                "available": max(0, min(enabled, staffed) - occupied_count - incoming) if gate else 0,
                "capacity_deficit": max(0, occupied_count + incoming - staffed),
            }
        )
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "counts": {k: len(dataset.get(k, [])) for k in required},
        "snapshot_at": dataset.get("snapshot_at"),
        "synthetic": dataset.get("synthetic", False),
        "capacity_reconciliation": reconciliation,
    }


def dataset_to_zip(dataset):
    """Lossless canonical JSON archive; CSV templates are separate import surfaces."""
    buffer = io.BytesIO()
    raw = canonical(dataset).encode()
    manifest = {
        "schema_version": "1.0",
        "dataset_version_id": dataset.get("dataset_version_id"),
        "files": [
            {"name": "dataset.json", "sha256": __import__("hashlib").sha256(raw).hexdigest(), "row_count": 1}
        ],
    }
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("dataset.json", raw)
        archive.writestr("manifest.json", canonical(manifest))
    return buffer.getvalue()


def dataset_from_zip(content):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        infos = archive.infolist()
        if sum(x.file_size for x in infos) > 100_000_000:
            raise ValueError("Uncompressed import exceeds 100 MB")
        names = [x.filename for x in infos]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate archive filenames")
        if any(n.startswith("/") or ".." in n.split("/") or "\\" in n for n in names):
            raise ValueError("Unsafe archive path")
        manifest = json.loads(archive.read("manifest.json"))
        for f in manifest.get("files", []):
            blob = archive.read(f["name"])
            if __import__("hashlib").sha256(blob).hexdigest() != f["sha256"]:
                raise ValueError(f"Checksum mismatch: {f['name']}")
        if "dataset.json" in names:
            return json.loads(archive.read("dataset.json"))
        data = {k: v for k, v in manifest.items() if k != "files"}
        data["manifest"] = manifest
        aliases = {
            "staff_assignments": "assignments",
            "distributions": "los_templates",
            "baseline": "arrival_profiles",
            "unit_layouts": "geometry",
        }
        integer_fields = {
            "physical_capacity",
            "enabled_capacity",
            "background_occupied",
            "advertised_staffed_capacity",
            "quantity",
            "unserviceable_quantity",
            "setup_minutes",
            "acuity_rank",
            "remaining_stay_minutes",
            "assessment_remaining_minutes",
            "turnover_minutes",
            "activation_minutes",
            "slots_per_nurse",
            "minimum_provider_count",
            "minimum_support_count",
            "fixed_minutes",
            "minimum_minutes",
        }
        float_fields = {
            "latitude",
            "longitude",
            "layout_x",
            "layout_y",
            "x",
            "y",
            "width",
            "height",
            "allocation_fraction",
            "shape",
            "scale_hours",
            "selection_weight",
        }
        boolean_fields = {
            "enabled",
            "portable",
            "synthetic",
            "eligible_for_transfer",
            "eligible_for_clinic_diversion",
            "needs_advanced_transport",
            "is_demonstration_assumption",
            "transfer_eligibility",
        }
        children = {}
        for name in names:
            stem = name.rsplit(".", 1)[0]
            if name.endswith(".json") and name != "manifest.json":
                data[aliases.get(stem, stem)] = json.loads(archive.read(name))
            elif name.endswith(".csv"):
                reader = csv.DictReader(io.StringIO(archive.read(name).decode("utf-8-sig")))
                if len(reader.fieldnames or []) != len(set(reader.fieldnames or [])):
                    raise ValueError(f"Duplicate headers in {name}")
                rows = []
                for row in reader:
                    if None in row:
                        raise ValueError(f"Invalid column count in {name}")
                    item = {}
                    for key, value in row.items():
                        if value in ("", None):
                            item[key] = None
                        elif key in integer_fields:
                            item[key] = int(value)
                        elif key in float_fields:
                            item[key] = float(value)
                        elif key in boolean_fields:
                            if value not in ("true", "false"):
                                raise ValueError(f"Invalid boolean in {name}.{key}")
                            item[key] = value == "true"
                        else:
                            item[key] = value
                    rows.append(item)
                children[stem] = rows
                data[aliases.get(stem, stem)] = rows
        for parent, key, child, value_key in [
            ("facilities", "facility_id", "facility_capabilities", "capabilities"),
            ("units", "unit_id", "unit_capabilities", "capabilities"),
            ("slots", "slot_id", "slot_capabilities", "capabilities"),
            ("staff", "staff_id", "staff_capabilities", "capabilities"),
            ("patients", "patient_id", "patient_resources", "resource_requirements"),
        ]:
            for row in data.get(parent, []):
                matches = [c for c in children.get(child, []) if c.get(key) == row.get(key)]
                row[value_key] = (
                    [{"capability_code": c["capability_code"], "quantity": c["quantity"]} for c in matches]
                    if value_key == "resource_requirements"
                    else [c["capability_code"] for c in matches]
                )
        data["id"] = data.get("dataset_version_id")
        return data
