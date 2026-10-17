"""Canonical input shape, vocabulary, and reference validation before reconciliation.

Never repairs input. Rows use CSV-compatible numbering (header=1, first row=2).
System-owned provenance fields may be absent on create; operational fields may not.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .common import dt
from .stage_clock import reserved_source_finishes_before_pickup

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$")
UNIT_KINDS = {"ward", "icu", "ed", "clinic", "shelter"}
CARE_LEVELS = {"ward", "icu", "ambulatory", "nonclinical"}
TABLES = {
    "organizations": "organization_id",
    "facilities": "facility_id",
    "units": "unit_id",
    "slots": "slot_id",
    "patients": "patient_id",
    "staff": "staff_id",
    "assignments": "assignment_id",
    "equipment_pools": "equipment_pool_id",
    "partner_equipment": "advertisement_id",
    "capacity_policies": "capacity_policy_id",
    "capabilities": "capability_code",
    "resource_profiles": "resource_profile_id",
    "cohorts": "cohort_id",
    "los_templates": "template_id",
    "entry_streams": "entry_stream_id",
    "clinic_policies": "clinic_policy_id",
    "pathway_profiles": "pathway_profile_id",
    "routes": "route_id",
    "vehicles": "vehicle_id",
    "virtual_locations": "location_id",
    "geometry": "unit_id",
}
ALIASES = {"assignments": "staff_assignments", "los_templates": "distributions", "geometry": "unit_layouts"}


def canonical_schema_errors(dataset):
    errors = []
    tables = {}
    indexes = {}

    def issue(table, row, field, message):
        errors.append({"file": table, "row": row, "field": field, "message": message})

    def text(table, n, row, key, required=True, identity=False):
        value = row.get(key)
        if value is None and not required:
            return None
        if not isinstance(value, str) or not value.strip() or (identity and not IDENTIFIER.fullmatch(value)):
            issue(
                table,
                n,
                key,
                "Expected a nonempty string identifier" if identity else "Expected a nonempty string",
            )
            return None
        return value

    def number(table, n, row, key, minimum=0, maximum=None, integer=False, required=True):
        value = row.get(key)
        if value is None and not required:
            return None
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or (integer and not isinstance(value, int))
            or value < minimum
            or (maximum is not None and value > maximum)
        ):
            issue(
                table,
                n,
                key,
                f"Expected {'integer' if integer else 'finite number'} >= {minimum}"
                + (f" and <= {maximum}" if maximum is not None else ""),
            )
            return None
        return value

    def boolean(table, n, row, key, required=True):
        if row.get(key) is None and not required:
            return
        if not isinstance(row.get(key), bool):
            issue(table, n, key, "Expected boolean")

    def enum(table, n, row, key, values, required=True):
        value = row.get(key)
        if value is None and not required:
            return None
        if not isinstance(value, str) or value not in values:
            issue(table, n, key, "Expected one of: " + ", ".join(sorted(values)))
            return None
        return value

    def timestamp(table, n, row, key, required=True):
        value = row.get(key)
        if value is None and not required:
            return None
        try:
            if not isinstance(value, str):
                raise TypeError()
            return dt(value)
        except (ValueError, TypeError, AttributeError, OverflowError):
            issue(table, n, key, "Expected timestamp with explicit UTC offset")
            return None

    def ref(table, n, row, key, target, required=True):
        value = text(table, n, row, key, required, True)
        if value is not None and value not in indexes.get(target, {}):
            issue(table, n, key, f"Unknown {target} reference: {value}")
        return indexes.get(target, {}).get(value)

    def array(table, n, row, key, required=True):
        value = row.get(key)
        if value is None and not required:
            return []
        if not isinstance(value, list):
            issue(table, n, key, "Expected array")
            return []
        return value

    def codes(table, n, row, key, kind=None, required=True):
        for i, code in enumerate(array(table, n, row, key, required)):
            cap = indexes.get("capabilities", {}).get(code) if isinstance(code, str) else None
            if not cap or (kind and cap.get("kind") != kind):
                issue(table, n, f"{key}.{i}", f"Unknown or incompatible {kind or ''} capability")

    def requirements(table, n, row, key):
        for i, item in enumerate(array(table, n, row, key)):
            if not isinstance(item, dict):
                issue(table, n, f"{key}.{i}", "Expected capability/quantity object")
                continue
            cap = ref(table, n, item, "capability_code", "capabilities")
            if cap and cap.get("kind") != "equipment":
                issue(
                    table, n, f"{key}.{i}.capability_code", "Requirement must reference equipment capability"
                )
            number(table, n, item, "quantity", 1, integer=True)

    def weights(table, n, values, key, expected=1, count=None):
        if not isinstance(values, list) or (count is not None and len(values) != count) or not values:
            issue(
                table,
                n,
                key,
                "Expected nonempty probability array" + (f" of length {count}" if count else ""),
            )
            return
        if any(
            not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0
            for v in values
        ):
            issue(table, n, key, "Weights must be finite nonnegative numbers")
        elif not math.isclose(sum(values), expected, abs_tol=1e-9):
            issue(table, n, key, f"Weights must sum to {expected}")

    def source_rows(table):
        rows = dataset.get(table, [])
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

    clinics_enabled = any(row.get("kind") == "clinic" for row in source_rows("facilities"))
    partners_enabled = any(
        row.get("capacity_mode") == "advertised_aggregate" and row.get("kind") in ("ward", "icu")
        for row in source_rows("units")
    )
    transfers_enabled = (
        partners_enabled
        or any(row.get("state") in ("transfer_reserved", "in_transit") for row in source_rows("patients"))
        or any(row.get("transport_required") is True for row in source_rows("clinic_policies"))
    )
    optional_tables = {
        "clinic_policies": not clinics_enabled,
        "partner_equipment": not partners_enabled,
        "routes": not transfers_enabled,
        "vehicles": not transfers_enabled,
    }
    for table, identity in TABLES.items():
        rows = dataset.get(table, dataset.get(ALIASES.get(table)))
        if table not in dataset and optional_tables.get(table, False):
            rows = []
        if not isinstance(rows, list):
            issue(table, 0, table, "Required array is missing or malformed")
            rows = []
        if table in {"organizations", "facilities", "units", "entry_streams"} and not rows:
            issue(table, 0, table, "At least one declared record is required")
        tables[table] = []
        indexes[table] = {}
        for n, row in enumerate(rows, 2):
            if not isinstance(row, dict):
                issue(table, n, "", "Expected object")
                continue
            tables[table].append((n, row))
            identity_value = text(table, n, row, identity, identity=True)
            if identity_value:
                if identity_value in indexes[table]:
                    issue(table, n, identity, "Duplicate identifier")
                indexes[table][identity_value] = row

    # Invalid container/key types must not reach cross-field dictionary lookups.
    string_fields = {
        "kind",
        "state",
        "status",
        "role",
        "care_level",
        "capacity_mode",
        "purpose",
        "family",
        "stage_kind",
        "entry_type",
        "source_type",
        "unit_kind",
        "stage_status",
        "departure_kind",
        "target_unit_kind",
        "employment_pool",
        "installation_status",
        "slot_kind",
        "capability_code",
        "nurse_capability",
        "required_site_capability",
        "required_transport_capability",
        "method",
        "estimate_source",
        "routing_mode",
    }
    for table, rows in tables.items():
        for n, row in rows:
            for key, value in row.items():
                if (
                    (key in string_fields or key.endswith("_id"))
                    and value is not None
                    and not isinstance(value, str)
                ):
                    issue(table, n, key, "Expected string or null")
    if errors:
        return errors

    enum("manifest", 0, dataset, "schema_version", {"1.0"})
    text("manifest", 0, dataset, "dataset_version_id", identity=True)
    ref("manifest", 0, dataset, "organization_id", "organizations")
    label = text("manifest", 0, dataset, "label")
    if label and len(label) > 120:
        issue("manifest", 0, "label", "Label exceeds 120 characters")
    snapshot = timestamp("manifest", 0, dataset, "snapshot_at")
    zone = text("manifest", 0, dataset, "timezone")
    if zone:
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError):
            issue("manifest", 0, "timezone", "Unknown IANA timezone")
    boolean("manifest", 0, dataset, "synthetic")
    if dataset.get("synthetic") is True:
        number("manifest", 0, dataset, "generator_seed", integer=True)
        text("manifest", 0, dataset, "generator_version")
    enum("manifest", 0, dataset, "historical_census_linkage", {"independent_demo_snapshot", "longitudinal"})
    for n, row in tables["organizations"]:
        text("organizations", n, row, "name")
    for n, row in tables["capabilities"]:
        enum("capabilities", n, row, "kind", {"care", "staff", "equipment", "transport"})
        text("capabilities", n, row, "label")
        text("capabilities", n, row, "description")
    for n, row in tables["facilities"]:
        table = "facilities"
        ref(table, n, row, "organization_id", "organizations")
        text(table, n, row, "name")
        enum(table, n, row, "kind", {"hospital", "clinic", "ward_overflow", "shelter"})
        enum(table, n, row, "status", {"active", "candidate", "activating", "unavailable", "closed"})
        enum(table, n, row, "location_quality", {"synthetic_approximate", "verified"})
        enum(table, n, row, "acceptance_mode", {"internal", "synthetic_auto", "manual_confirmation"})
        number(table, n, row, "latitude", -90, 90)
        number(table, n, row, "longitude", -180, 180)
        number(table, n, row, "activation_minutes", integer=True)
        codes(table, n, row, "capabilities", "care")
        if not row.get("capabilities") and row.get("status") not in {"candidate", "unavailable"}:
            issue(table, n, "capabilities", "An active facility requires declared care capabilities")
        timestamp(table, n, row, "readiness_checked_at", False)
        notes = row.get("suitability_notes")
        if notes is not None and (not isinstance(notes, str) or len(notes) > 2000):
            issue(table, n, "suitability_notes", "Expected text of at most 2000 characters")
    for n, row in tables["capacity_policies"]:
        table = "capacity_policies"
        enum(table, n, row, "unit_kind", UNIT_KINDS)
        # Nonclinical shelter has no clinical nursing vocabulary in demo-v1.
        # Its explicit sentinel is retained; other policy references must resolve.
        if row.get("unit_kind") == "shelter" and row.get("nurse_capability") == "SHELTER_NURSING":
            capability = None
        else:
            capability = ref(table, n, row, "nurse_capability", "capabilities")
        if capability and capability.get("kind") != "staff":
            issue(table, n, "nurse_capability", "Expected staff capability")
        number(table, n, row, "slots_per_nurse", 1, integer=True)
        for key in ("minimum_provider_count", "minimum_support_count"):
            number(table, n, row, key, integer=True)
        requirements(table, n, row, "per_slot_resources")
        for care in array(table, n, row, "allowed_patient_care_levels"):
            if not isinstance(care, str) or care not in CARE_LEVELS:
                issue(table, n, "allowed_patient_care_levels", "Unknown care level")
        boolean(table, n, row, "is_demonstration_assumption")
    for n, row in tables["units"]:
        table = "units"
        ref(table, n, row, "facility_id", "facilities")
        text(table, n, row, "name")
        kind = enum(table, n, row, "kind", UNIT_KINDS)
        policy = ref(table, n, row, "capacity_policy_id", "capacity_policies")
        if policy and kind != policy.get("unit_kind"):
            issue(table, n, "capacity_policy_id", "Policy kind disagrees with unit kind")
        enum(table, n, row, "capacity_mode", {"staff_derived", "advertised_aggregate"})
        for key in ("physical_capacity", "enabled_capacity", "background_occupied", "turnover_minutes"):
            number(table, n, row, key, integer=True)
        number(
            table,
            n,
            row,
            "advertised_staffed_capacity",
            integer=True,
            required=row.get("capacity_mode") == "advertised_aggregate",
        )
        codes(table, n, row, "capabilities", "care")
        for key in ("map_x", "map_y"):
            number(table, n, row, key, 0, 1, required=False)
        if row.get("capacity_mode") == "staff_derived" and row.get("background_occupied") != 0:
            issue(
                table, n, "background_occupied", "Fully patient-modeled units cannot have anonymous occupants"
            )
        for key in ("enabled_capacity", "background_occupied"):
            if (
                isinstance(row.get(key), int)
                and isinstance(row.get("physical_capacity"), int)
                and row[key] > row["physical_capacity"]
            ):
                issue(table, n, key, "Count exceeds physical capacity")
    for n, row in tables["slots"]:
        table = "slots"
        unit = ref(table, n, row, "unit_id", "units")
        enum(table, n, row, "slot_kind", {"ward_bed", "icu_bed", "ed_bay", "clinic_space", "shelter_space"})
        expected = {
            "ward": "ward_bed",
            "icu": "icu_bed",
            "ed": "ed_bay",
            "clinic": "clinic_space",
            "shelter": "shelter_space",
        }
        if unit and row.get("slot_kind") != expected.get(unit.get("kind")):
            issue(table, n, "slot_kind", "Slot kind disagrees with unit kind")
        boolean(table, n, row, "enabled")
        enum(table, n, row, "installation_status", {"planned", "installed", "removed"})
        text(table, n, row, "display_label")
        codes(table, n, row, "capabilities", "care")
        for key in ("layout_x", "layout_y"):
            number(table, n, row, key, 0, 1)
    for n, row in tables["staff"]:
        table = "staff"
        enum(table, n, row, "role", {"rn", "provider", "support", "driver", "responder"})
        enum(table, n, row, "employment_pool", {"hospital", "reserve", "transport"})
        text(table, n, row, "team_id", identity=True)
        codes(table, n, row, "capabilities", "staff")
        ref(table, n, row, "home_unit_id", "units", False)
    for n, row in tables["assignments"]:
        table = "assignments"
        ref(table, n, row, "staff_id", "staff")
        ref(table, n, row, "unit_id", "units", False)
        text(table, n, row, "reserve_pool_id", False, True)
        enum(table, n, row, "status", {"scheduled", "unavailable", "reassigned"})
        start, end = timestamp(table, n, row, "start_at"), timestamp(table, n, row, "end_at")
        if start and end and start >= end:
            issue(table, n, "end_at", "Assignment end must follow start")
        fraction = number(table, n, row, "allocation_fraction", 0, 1)
        if fraction == 0:
            issue(table, n, "allocation_fraction", "Allocation must be positive")
    for table in ("equipment_pools", "partner_equipment"):
        for n, row in tables[table]:
            ref(table, n, row, "facility_id", "facilities")
            unit = ref(table, n, row, "unit_id", "units", table == "partner_equipment")
            if unit and unit.get("facility_id") != row.get("facility_id"):
                issue(table, n, "facility_id", "Pool facility disagrees with unit facility")
            capability = ref(table, n, row, "capability_code", "capabilities")
            if capability and capability.get("kind") != "equipment":
                issue(table, n, "capability_code", "Expected equipment capability")
            number(table, n, row, "quantity", integer=True)
            if table == "equipment_pools":
                number(table, n, row, "unserviceable_quantity", integer=True)
                number(table, n, row, "setup_minutes", integer=True)
                boolean(table, n, row, "portable")
    for n, row in tables["los_templates"]:
        table = "los_templates"
        enum(table, n, row, "purpose", {"total_los", "remaining_los", "assessment", "clinic_service"})
        family = enum(table, n, row, "family", {"gamma", "fixed"})
        for key in ("shape", "scale_hours") if family == "gamma" else ("fixed_minutes",):
            value = number(table, n, row, key, integer=key == "fixed_minutes")
            if value == 0:
                issue(table, n, key, "Duration parameter must be positive")
        number(table, n, row, "minimum_minutes", integer=True)
        text(table, n, row, "description")
        boolean(table, n, row, "synthetic")
    for n, row in tables["resource_profiles"]:
        table = "resource_profiles"
        text(table, n, row, "name")
        enum(table, n, row, "stage_kind", {"ed", "ward", "icu", "clinic"})
        cap = ref(table, n, row, "required_site_capability", "capabilities")
        if cap and cap.get("kind") != "care":
            issue(table, n, "required_site_capability", "Expected care capability")
        requirements(table, n, row, "required_equipment")
        kinds = array(table, n, row, "allowed_unit_kinds")
        if not kinds or any(not isinstance(k, str) or k not in UNIT_KINDS for k in kinds):
            issue(table, n, "allowed_unit_kinds", "Select one or more declared unit kinds")
        boolean(table, n, row, "transfer_allowed")
        boolean(table, n, row, "synthetic")
        number(table, n, row, "acuity_rank", 1, 5, integer=True, required=False)
        cap = ref(table, n, row, "required_transport_capability", "capabilities", False)
        if cap and cap.get("kind") != "transport":
            issue(table, n, "required_transport_capability", "Expected transport capability")
    cohort_weights = defaultdict(list)
    for n, row in tables["cohorts"]:
        table = "cohorts"
        care = enum(table, n, row, "care_level", CARE_LEVELS)
        template_key = "los_template_id" if care in {"ward", "icu"} else "assessment_template_id"
        template = ref(table, n, row, template_key, "los_templates", care in {"ward", "icu", "ambulatory"})
        if template and template.get("purpose") != ("total_los" if care in {"ward", "icu"} else "assessment"):
            issue(table, n, template_key, "Distribution purpose is incompatible with cohort stage")
        weight = number(table, n, row, "selection_weight", 0, 1)
        if care and weight is not None:
            cohort_weights[care].append(weight)
        profile_weights = []
        for i, item in enumerate(array(table, n, row, "resource_profile_weights")):
            if not isinstance(item, dict):
                issue(table, n, f"resource_profile_weights.{i}", "Expected profile/weight object")
                continue
            profile = ref(table, n, item, "resource_profile_id", "resource_profiles")
            if profile and profile.get("stage_kind") not in ({care} if care in {"ward", "icu"} else {"ed"}):
                issue(
                    table,
                    n,
                    f"resource_profile_weights.{i}.resource_profile_id",
                    "Profile stage disagrees with cohort care level",
                )
            profile_weights.append(item.get("weight"))
        weights(table, n, profile_weights, "resource_profile_weights")
        boolean(table, n, row, "transfer_eligibility")
    for care, values in cohort_weights.items():
        weights("cohorts", 0, values, f"selection_weight.{care}")
    baseline = dataset.get("arrival_profiles", dataset.get("baseline"))
    if not isinstance(baseline, dict):
        issue("baseline", 0, "", "Required baseline object is missing or malformed")
        baseline = {}
    summaries = [("baseline", baseline)]
    if "arrival_profiles" in dataset and "baseline" in dataset:
        alias = dataset["baseline"]
        if not isinstance(alias, dict):
            issue("baseline", 0, "", "Baseline alias must be an object")
        else:
            summaries.append(("baseline", alias))
    summary_error_count = len(errors)
    for table, summary in summaries:
        text(table, 0, summary, "baseline_id", identity=True)
        for key in ("ed_arrivals_per_local_day", "direct_ward_arrivals_per_local_day"):
            number(table, 0, summary, key)
        for key in ("ed_admission_probability", "icu_fraction_of_admissions"):
            number(table, 0, summary, key, 0, 1)
        enum(table, 0, summary, "method", {"configured", "estimated"})
        weights(table, 0, summary.get("hour_weights"), "hour_weights", count=24)
        weights(table, 0, summary.get("weekday_weights"), "weekday_weights", 7, 7)
        mix = summary.get("cohort_mix")
        if not isinstance(mix, dict):
            issue(table, 0, "cohort_mix", "Expected ward/ICU weight object")
        else:
            for care in ("ward", "icu"):
                weights(
                    table, 0, mix.get(care), "cohort_mix." + care, count=len(cohort_weights.get(care, []))
                )
                declared = mix.get(care)
                resolved = cohort_weights.get(care, [])
                if (
                    isinstance(declared, list)
                    and len(declared) == len(resolved)
                    and all(
                        isinstance(value, (int, float)) and not isinstance(value, bool) for value in declared
                    )
                    and any(not math.isclose(a, b, abs_tol=1e-9) for a, b in zip(declared, resolved))
                ):
                    issue(
                        table,
                        0,
                        "cohort_mix." + care,
                        "Baseline cohort mix disagrees with cohort selection weights",
                    )
    if len(summaries) == 2 and len(errors) == summary_error_count:
        alias = summaries[1][1]
        for key in (
            "ed_arrivals_per_local_day",
            "direct_ward_arrivals_per_local_day",
            "ed_admission_probability",
            "icu_fraction_of_admissions",
            "hour_weights",
            "weekday_weights",
        ):
            declared = alias[key] if isinstance(alias[key], list) else [alias[key]]
            canonical = baseline[key] if isinstance(baseline[key], list) else [baseline[key]]
            if any(not math.isclose(a, b, abs_tol=1e-9) for a, b in zip(declared, canonical)):
                issue("baseline", 0, key, "Baseline alias disagrees with arrival_profiles")
    for n, row in tables["entry_streams"]:
        table = "entry_streams"
        kind = enum(table, n, row, "entry_type", {"ed", "direct_ward"})
        ref(table, n, row, "destination_facility_id", "facilities")
        boolean(table, n, row, "enabled")
        if row.get("baseline_id") != baseline.get("baseline_id"):
            issue(table, n, "baseline_id", "Unknown baseline reference")
        number(table, n, row, "expected_arrivals_per_local_day")
        weights(table, n, row.get("hour_weights"), "hour_weights", count=24)
        weights(table, n, row.get("weekday_weights"), "weekday_weights", 7, 7)
        disposition = row.get("disposition_weights")
        if not isinstance(disposition, dict) or any(
            k not in {"discharge", "ward", "icu"} for k in disposition
        ):
            issue(table, n, "disposition_weights", "Expected discharge/ward/ICU weights")
        else:
            weights(table, n, list(disposition.values()), "disposition_weights")
            if kind == "direct_ward" and any(v != 0 for k, v in disposition.items() if k != "ward"):
                issue(table, n, "disposition_weights", "Direct ward stream must resolve to ward")
        template = ref(table, n, row, "assessment_template_id", "los_templates", kind == "ed")
        if template and template.get("purpose") != "assessment":
            issue(table, n, "assessment_template_id", "Expected assessment distribution")
        number(table, n, row, "clinic_eligibility_probability_given_discharge", 0, 1)
        ref(table, n, row, "initial_queue_location_id", "virtual_locations")
    for n, row in tables["clinic_policies"]:
        table = "clinic_policies"
        site = ref(table, n, row, "site_id", "facilities")
        if site and site.get("kind") != "clinic":
            issue(table, n, "site_id", "Clinic policy requires a clinic site")
        template = ref(table, n, row, "service_template_id", "los_templates")
        if template and template.get("purpose") != "clinic_service":
            issue(table, n, "service_template_id", "Expected clinic service distribution")
        enum(table, n, row, "eligibility_tag", {"eligible_for_clinic_diversion"})
        enum(table, n, row, "routing_mode", {"new_arrivals_only"})
        for key in ("hospital_fallback", "transport_required", "drain_after_close"):
            boolean(table, n, row, key)
        start, end = (
            timestamp(table, n, row, "admission_start_at"),
            timestamp(table, n, row, "admission_end_at"),
        )
        if start and end and start >= end:
            issue(table, n, "admission_end_at", "Clinic closing time must follow opening")

    def pathway_weights(n, row, key, care):
        values = row.get(key)
        if isinstance(values, list) and values and isinstance(values[0], dict):
            seen = set()
            probabilities = []
            for i, item in enumerate(values):
                if not isinstance(item, dict):
                    issue("pathway_profiles", n, f"{key}.{i}", "Expected cohort/weight object")
                    continue
                ident = item.get("cohort_id", item.get("cohort_template_id"))
                cohort = ref("pathway_profiles", n, {"cohort_id": ident}, "cohort_id", "cohorts")
                if cohort and cohort.get("care_level") != care:
                    issue(
                        "pathway_profiles",
                        n,
                        f"{key}.{i}.cohort_id",
                        "Pathway cohort disagrees with care level",
                    )
                if isinstance(ident, str):
                    if ident in seen:
                        issue("pathway_profiles", n, f"{key}.{i}.cohort_id", "Duplicate cohort in mixture")
                    seen.add(ident)
                probabilities.append(item.get("weight"))
            weights("pathway_profiles", n, probabilities, key)
        else:
            weights("pathway_profiles", n, values, key, count=len(cohort_weights.get(care, [])))

    seen_pathways = set()
    for n, row in tables["pathway_profiles"]:
        table = "pathway_profiles"
        if row.get("entry_stream_id") in seen_pathways:
            issue(table, n, "entry_stream_id", "An entry stream may have only one pathway configuration")
        seen_pathways.add(row.get("entry_stream_id"))
        disposition = row.get("ed_disposition_weights")
        if disposition is not None:
            if not isinstance(disposition, dict) or any(
                k not in {"discharge", "ward", "icu"} for k in disposition
            ):
                issue(table, n, "ed_disposition_weights", "Expected discharge/ward/ICU weights")
            else:
                weights(table, n, list(disposition.values()), "ed_disposition_weights")
        ref(table, n, row, "entry_stream_id", "entry_streams")
        ref(table, n, row, "clinic_policy_id", "clinic_policies", False)
        for care in ("ward", "icu"):
            pathway_weights(n, row, care + "_cohort_weights", care)
        probability = number(table, n, row, "icu_stepdown_probability", 0, 1)
        if probability:
            pathway_weights(n, row, "stepdown_ward_cohort_weights", "ward")
    for _, stream in tables["entry_streams"]:
        if stream.get("enabled") is True and stream["entry_stream_id"] not in seen_pathways:
            issue(
                "pathway_profiles",
                0,
                "entry_stream_id",
                f"Enabled entry stream has no pathway configuration: {stream['entry_stream_id']}",
            )
    configured_clinic_sites = {policy.get("site_id") for _, policy in tables["clinic_policies"]}
    for _, facility in tables["facilities"]:
        if facility.get("kind") == "clinic" and facility["facility_id"] not in configured_clinic_sites:
            issue(
                "clinic_policies",
                0,
                "site_id",
                f"Clinic site has no service/diversion policy: {facility['facility_id']}",
            )
    seen_routes = set()
    for n, row in tables["routes"]:
        table = "routes"
        pair = (row.get("from_facility_id"), row.get("to_facility_id"))
        if pair in seen_routes:
            issue(
                table, n, "to_facility_id", "Duplicate directed route; route changes belong in timed updates"
            )
        seen_routes.add(pair)
        ref(table, n, row, "from_facility_id", "facilities")
        ref(table, n, row, "to_facility_id", "facilities")
        if row.get("from_facility_id") == row.get("to_facility_id"):
            issue(table, n, "to_facility_id", "A route must connect distinct facilities")
        number(table, n, row, "travel_minutes", 1, integer=True)
        for key in ("loading_minutes", "unloading_minutes"):
            number(table, n, row, key, integer=True)
        enum(table, n, row, "estimate_source", {"synthetic", "manual", "provider"})
        timestamp(table, n, row, "effective_at")
    for n, row in tables["vehicles"]:
        table = "vehicles"
        ref(table, n, row, "home_facility_id", "facilities")
        ref(table, n, row, "current_facility_id", "facilities", False)
        codes(table, n, row, "capabilities", "transport")
        number(table, n, row, "patient_capacity", 1, integer=True)
        number(table, n, row, "turnaround_minutes", integer=True)
        start, end = (
            timestamp(table, n, row, "available_from"),
            timestamp(table, n, row, "available_until", False),
        )
        if start and end and start >= end:
            issue(table, n, "available_until", "Availability end must follow start")
    for table in ("virtual_locations", "geometry"):
        for n, row in tables[table]:
            ref(table, n, row, "facility_id", "facilities")
            text(table, n, row, "label")
            if table == "geometry":
                unit = ref(table, n, row, "unit_id", "units")
                if unit and unit.get("facility_id") != row.get("facility_id"):
                    issue(table, n, "facility_id", "Geometry facility disagrees with unit")
            for key in ("x", "y", "width", "height") if table == "geometry" else ("layout_x", "layout_y"):
                number(table, n, row, key, 0, 1)
    for unit in indexes["units"]:
        if unit not in indexes["geometry"]:
            issue("geometry", 0, "unit_id", f"Unit has no layout: {unit}")
    # Historical observations may be omitted from an operational import, but any
    # supplied episodes use the same strict typed/FK boundary as current records.
    history_counts = defaultdict(lambda: defaultdict(int))
    if "history" in dataset:
        seen_episodes = set()
        for n, row in enumerate(array("history", 0, dataset, "history"), 2):
            if not isinstance(row, dict):
                issue("history", n, "", "Expected historical episode object")
                continue
            identity = text("history", n, row, "episode_id", identity=True)
            if identity in seen_episodes:
                issue("history", n, "episode_id", "Duplicate identifier")
            seen_episodes.add(identity)
            enum("history", n, row, "entry_type", {"ed", "direct_ward"})
            enum("history", n, row, "care_level", CARE_LEVELS)
            boolean("history", n, row, "censored")
            cohort = ref("history", n, row, "cohort_id", "cohorts", False)
            if cohort and cohort.get("care_level") != row.get("care_level"):
                issue("history", n, "cohort_id", "Historical cohort disagrees with care level")
            arrival = timestamp("history", n, row, "arrival_at")
            if arrival and zone:
                try:
                    day = arrival.astimezone(ZoneInfo(zone)).date().isoformat()
                    counts = history_counts[day]
                    if row.get("entry_type") in ("ed", "direct_ward"):
                        counts["ed_arrivals" if row["entry_type"] == "ed" else "direct_admissions"] += 1
                    if row.get("admitted_at") and row.get("care_level") in ("ward", "icu"):
                        counts[row["care_level"] + "_admissions"] += 1
                        counts["ed_admissions"] += int(row.get("entry_type") == "ed")
                except (ZoneInfoNotFoundError, ValueError):
                    pass  # The manifest already reports the invalid timezone.
            previous = arrival
            for key in ("assessment_end_at", "admitted_at", "departure_at"):
                at = timestamp("history", n, row, key, False)
                if at and previous and at < previous:
                    issue("history", n, key, "Episode timestamps must follow arrival/stage order")
                if at:
                    previous = at
            if row.get("departure_at") is None and row.get("censored") is False:
                issue("history", n, "censored", "An episode without a departure is still open")
    if "historical_daily_summaries" in dataset:
        seen_days = set()
        for n, row in enumerate(
            array("historical_daily_summaries", 0, dataset, "historical_daily_summaries"), 2
        ):
            table = "historical_daily_summaries"
            if not isinstance(row, dict):
                issue(table, n, "", "Expected daily summary object")
                continue
            day = row.get("local_date")
            try:
                if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day:
                    raise ValueError()
            except (ValueError, TypeError):
                issue(table, n, "local_date", "Expected local date YYYY-MM-DD")
                continue
            if day in seen_days:
                issue(table, n, "local_date", "Duplicate local date")
            seen_days.add(day)
            for key in (
                "ed_arrivals",
                "direct_admissions",
                "ward_admissions",
                "icu_admissions",
                "ed_admissions",
            ):
                value = number(table, n, row, key, integer=True)
                if "history" in dataset and value is not None and value != history_counts[day][key]:
                    issue(table, n, key, "Daily summary disagrees with historical episodes")
        if "history" in dataset and set(history_counts) - seen_days:
            issue(
                "historical_daily_summaries",
                0,
                "local_date",
                "Some historical episode days have no daily summary",
            )
    for table, position, value_key, baseline_key, count in (
        ("hour_of_day_baseline", "hour", "weight", "hour_weights", 24),
        ("weekday_baseline", "weekday", "multiplier", "weekday_weights", 7),
    ):
        if table not in dataset:
            continue
        seen = set()
        for n, row in enumerate(array(table, 0, dataset, table), 2):
            if not isinstance(row, dict):
                issue(table, n, "", "Expected profile summary object")
                continue
            index = number(table, n, row, position, 0, count - 1, integer=True)
            value = number(table, n, row, value_key)
            if index is not None:
                if index in seen:
                    issue(table, n, position, "Duplicate profile position")
                seen.add(index)
                declared = baseline.get(baseline_key)
                if (
                    value is not None
                    and isinstance(declared, list)
                    and len(declared) == count
                    and isinstance(declared[index], (int, float))
                    and not math.isclose(value, declared[index], abs_tol=1e-9)
                ):
                    issue(table, n, value_key, "Profile summary disagrees with baseline")
        if len(seen) != count:
            issue(table, 0, position, f"Expected exactly {count} unique profile positions")
    # Entry streams are the editable demand source; scalar baseline fields are
    # derived summaries and cannot silently disagree with the executed demand.
    if not errors:
        active_streams = [row for _, row in tables["entry_streams"] if row["enabled"]]
        ed = [row for row in active_streams if row["entry_type"] == "ed"]
        direct = [row for row in active_streams if row["entry_type"] == "direct_ward"]
        ed_rate = sum(row["expected_arrivals_per_local_day"] for row in ed)
        direct_rate = sum(row["expected_arrivals_per_local_day"] for row in direct)
        admitted = sum(
            row["expected_arrivals_per_local_day"]
            * (row["disposition_weights"].get("ward", 0) + row["disposition_weights"].get("icu", 0))
            for row in ed
        )
        icu = sum(
            row["expected_arrivals_per_local_day"] * row["disposition_weights"].get("icu", 0) for row in ed
        )
        expected = {
            "ed_arrivals_per_local_day": ed_rate,
            "direct_ward_arrivals_per_local_day": direct_rate,
            "ed_admission_probability": admitted / ed_rate if ed_rate else 0,
            "icu_fraction_of_admissions": icu / admitted if admitted else 0,
        }
        for key, resolved in expected.items():
            if not math.isclose(baseline[key], resolved, abs_tol=1e-9):
                issue("baseline", 0, key, "Baseline summary disagrees with enabled entry streams")
        rate = ed_rate + direct_rate
        contributors = active_streams or [row for _, row in tables["entry_streams"]]
        for key, count in (("hour_weights", 24), ("weekday_weights", 7)):
            if rate:
                resolved = [
                    sum(
                        (row["expected_arrivals_per_local_day"] / rate) * row[key][i]
                        for row in active_streams
                    )
                    for i in range(count)
                ]
            elif contributors:
                resolved = [
                    sum(row[key][i] / len(contributors) for row in contributors) for i in range(count)
                ]
            else:
                resolved = baseline[key]
            if any(not math.isclose(a, b, abs_tol=1e-9) for a, b in zip(baseline[key], resolved)):
                issue("baseline", 0, key, "Baseline weights disagree with the resolved entry-stream summary")
    for n, row in tables["patients"]:
        table = "patients"
        transfer_data = row.get("pending_transfer") if isinstance(row.get("pending_transfer"), dict) else {}
        clinic_transfer = (
            row.get("state") in {"transfer_reserved", "in_transit"}
            and transfer_data.get("prior_state") == "ed_waiting"
        )
        completed_source = row.get("stage_status") == "ready_to_exit" and row.get("state") in {
            "inpatient",
            "transfer_reserved",
            "in_transit",
        }
        state = enum(
            table,
            n,
            row,
            "state",
            {
                "ed_waiting",
                "direct_waiting",
                "ed_assessment",
                "ed_boarding",
                "inpatient",
                "clinic_assessment",
                "transfer_reserved",
                "in_transit",
                "discharged",
            },
        )
        care = enum(table, n, row, "care_level", CARE_LEVELS)
        enum(table, n, row, "entry_type", {"ed", "direct_ward"})
        enum(
            table,
            n,
            row,
            "source_type",
            {"initial_census", "baseline_arrival", "surge_arrival", "reported_batch"},
        )
        number(table, n, row, "acuity_rank", 1, 5, True)
        ref(table, n, row, "facility_id", "facilities", state != "discharged")
        unit = ref(table, n, row, "unit_id", "units", False)
        ref(table, n, row, "slot_id", "slots", False)
        cohort = ref(table, n, row, "cohort_template_id", "cohorts")
        for key in ("eligible_for_transfer", "eligible_for_clinic_diversion", "needs_advanced_transport"):
            boolean(table, n, row, key)
        requirements(table, n, row, "resource_requirements")
        if "inpatient_resource_requirements" in row:
            for i, item in enumerate(array(table, n, row, "inpatient_resource_requirements")):
                if isinstance(item, str):
                    cap = indexes["capabilities"].get(item)
                    if not cap or cap.get("kind") != "equipment":
                        issue(
                            table, n, f"inpatient_resource_requirements.{i}", "Unknown equipment capability"
                        )
                elif isinstance(item, dict):
                    requirements(
                        table,
                        n,
                        {"inpatient_resource_requirements": [item]},
                        "inpatient_resource_requirements",
                    )
                else:
                    issue(
                        table,
                        n,
                        f"inpatient_resource_requirements.{i}",
                        "Expected equipment capability or requirement object",
                    )
        for tag in array(table, n, row, "tags", False):
            if not isinstance(tag, str):
                issue(table, n, "tags", "Tags must be strings")
        times = {}
        for key in (
            "arrival_at",
            "unit_entered_at",
            "admitted_at",
            "admission_requested_at",
            "state_entered_at",
            "current_stage_started_at",
            "queue_entered_at",
        ):
            required = (
                key == "arrival_at"
                or (key == "admitted_at" and state == "inpatient")
                or (
                    key == "admission_requested_at"
                    and (state in {"ed_boarding", "direct_waiting"} or completed_source)
                )
                or (key == "queue_entered_at" and completed_source)
                or (
                    key == "unit_entered_at"
                    and state in {"inpatient", "ed_assessment", "ed_boarding", "clinic_assessment"}
                )
            )
            times[key] = timestamp(table, n, row, key, required)
            if times[key] and snapshot and times[key] > snapshot:
                issue(table, n, key, "Observation cannot follow snapshot")
            if (
                key != "arrival_at"
                and times[key]
                and times["arrival_at"]
                and times[key] < times["arrival_at"]
            ):
                issue(table, n, key, "Stage/request timestamp cannot precede arrival")
        if state in {"ed_boarding", "direct_waiting", "transfer_reserved", "in_transit"}:
            enum(table, n, row, "target_unit_kind", {"clinic"} if clinic_transfer else {"ward", "icu"})
        if row.get("queue_location_id"):
            ref(table, n, row, "queue_location_id", "virtual_locations")
        enum(table, n, row, "stage_status", {"not_started", "in_service", "ready_to_exit"}, False)
        enum(table, n, row, "departure_kind", {"discharge", "transfer_out"}, False)
        source_unit = unit
        if completed_source:
            if state in {"transfer_reserved", "in_transit"}:
                source_unit = ref(table, n, transfer_data, "source_unit_id", "units")
            if (
                care != "ward"
                or row.get("target_unit_kind") != "ward"
                or not source_unit
                or source_unit.get("kind") != "icu"
                or (
                    state in {"transfer_reserved", "in_transit"}
                    and transfer_data.get("prior_state") != "inpatient"
                )
                or (state == "transfer_reserved" and unit != source_unit)
            ):
                issue(
                    table,
                    n,
                    "stage_status",
                    "Completed inpatient stage requires an ICU source and a pending ward stepdown",
                )
            if (
                times["queue_entered_at"]
                and times["admission_requested_at"]
                and times["queue_entered_at"] < times["admission_requested_at"]
            ):
                issue(
                    table, n, "queue_entered_at", "Stepdown queue entry cannot precede its admission request"
                )
        if unit:
            expected_kind = {
                "ed_assessment": "ed",
                "ed_boarding": "ed",
                "clinic_assessment": "clinic",
                "inpatient": unit.get("kind") if row.get("stage_status") == "ready_to_exit" else care,
            }.get(state)
            if expected_kind and unit.get("kind") != expected_kind:
                issue(table, n, "unit_id", "Unit kind is incompatible with patient state/care")
        source_state = (
            (row.get("pending_transfer") or {}).get("prior_state")
            if isinstance(row.get("pending_transfer"), dict) and state in {"transfer_reserved", "in_transit"}
            else state
        )
        stage_care = (
            "ambulatory"
            if source_state in {"ed_waiting", "ed_assessment", "clinic_assessment"}
            else care
            if source_state in {"ed_boarding", "direct_waiting", "inpatient"}
            else None
        )
        if source_state == "inpatient" and completed_source and source_unit:
            stage_care = source_unit.get("kind")
        if cohort and stage_care and cohort.get("care_level") != stage_care:
            issue(
                table,
                n,
                "cohort_template_id",
                "Cohort care level disagrees with the patient's current source stage",
            )
        spec = row.get("remaining_stage_spec")
        if spec is not None and not isinstance(spec, dict):
            issue(table, n, "remaining_stage_spec", "Expected discriminated remaining-stage object")
        elif isinstance(spec, dict):
            kind = enum(
                table,
                n,
                spec,
                "kind",
                {"fixed_minutes", "expected_end", "remaining_distribution", "conditional_total"},
            )
            allowed = {
                "fixed_minutes": {"kind", "minutes"},
                "expected_end": {"kind", "expected_end_at"},
                "remaining_distribution": {"kind", "distribution_id"},
                "conditional_total": {"kind", "distribution_id", "elapsed_minutes"},
            }.get(kind, set())
            if set(spec) - allowed:
                issue(
                    table, n, "remaining_stage_spec", "Conflicting fields from another remaining-stage method"
                )
            if kind == "fixed_minutes":
                number(table, n, spec, "minutes", 1, integer=True)
            elif kind == "expected_end":
                end = timestamp(table, n, spec, "expected_end_at")
                if end and snapshot and end <= snapshot:
                    issue(
                        table,
                        n,
                        "remaining_stage_spec.expected_end_at",
                        "Expected stage end must follow snapshot",
                    )
            elif kind in {"remaining_distribution", "conditional_total"}:
                template = ref(table, n, spec, "distribution_id", "los_templates")
                if template and template.get("purpose") != (
                    "remaining_los" if kind == "remaining_distribution" else "total_los"
                ):
                    issue(
                        table,
                        n,
                        "remaining_stage_spec.distribution_id",
                        "Distribution purpose disagrees with remaining-stage method",
                    )
                if kind == "conditional_total":
                    number(table, n, spec, "elapsed_minutes", integer=True)
                    if template and template.get("family") != "gamma":
                        issue(
                            table,
                            n,
                            "remaining_stage_spec.distribution_id",
                            "Conditional total requires a gamma distribution",
                        )
        flat_specs = []
        for key in ("remaining_stay_minutes", "assessment_remaining_minutes"):
            if row.get(key) is not None:
                number(table, n, row, key, 1, integer=True)
                flat_specs.append({"kind": "fixed_minutes", "minutes": row[key]})
        if row.get("remaining_stay_template_id") is not None:
            template = ref(table, n, row, "remaining_stay_template_id", "los_templates")
            if template and template.get("purpose") != "remaining_los":
                issue(table, n, "remaining_stay_template_id", "Expected remaining-stay distribution")
            flat_specs.append(
                {"kind": "remaining_distribution", "distribution_id": row["remaining_stay_template_id"]}
            )
        if len(flat_specs) > 1 or (isinstance(spec, dict) and flat_specs and spec != flat_specs[0]):
            issue(table, n, "remaining_stage_spec", "Conflicting remaining duration methods")
        if row.get("pending_transfer") is not None and not isinstance(row["pending_transfer"], dict):
            issue(table, n, "pending_transfer", "Expected transfer object")
        if isinstance(row.get("pending_transfer"), dict):
            transfer = row["pending_transfer"]
            text(table, n, transfer, "request_id", identity=True)
            text(table, n, transfer, "reservation_id", False, True)
            text(table, n, transfer, "cancellation_reason", False)
            enum(
                table,
                n,
                transfer,
                "prior_state",
                {"inpatient", "ed_boarding", "direct_waiting", "ed_waiting"},
                state in {"transfer_reserved", "in_transit"},
            )
            enum(table, n, transfer, "status", {"requested", "reserved", "departed", "arrived", "cancelled"})
            requested = timestamp(table, n, transfer, "requested_at")
            if requested and snapshot and requested > snapshot:
                issue(
                    table,
                    n,
                    "pending_transfer.requested_at",
                    "Observed transfer request cannot follow snapshot",
                )
            destination = ref(table, n, transfer, "destination_unit_id", "units")
            if transfer.get("prior_state") == "ed_waiting":
                policy = ref(table, n, transfer, "clinic_policy_id", "clinic_policies")
                profile = ref(table, n, transfer, "clinic_resource_profile_id", "resource_profiles")
                if (
                    not clinic_transfer
                    or not destination
                    or destination.get("kind") != "clinic"
                    or care != "ambulatory"
                    or row.get("unit_id")
                    or row.get("slot_id")
                    or transfer.get("source_unit_id")
                ):
                    issue(
                        table,
                        n,
                        "pending_transfer.prior_state",
                        "ED waiting source is permitted only for an ambulatory clinic transfer without a source slot",
                    )
                if policy and destination and policy.get("site_id") != destination.get("facility_id"):
                    issue(
                        table,
                        n,
                        "pending_transfer.clinic_policy_id",
                        "Clinic policy must belong to the destination site",
                    )
                if profile and (
                    profile.get("stage_kind") != "clinic"
                    or "clinic" not in profile.get("allowed_unit_kinds", [])
                ):
                    issue(
                        table,
                        n,
                        "pending_transfer.clinic_resource_profile_id",
                        "Select a compatible clinic resource profile",
                    )
                source_profile = ref(table, n, row, "resource_profile_id", "resource_profiles", False)
                if source_profile and source_profile["stage_kind"] != "ed":
                    issue(
                        table,
                        n,
                        "resource_profile_id",
                        "Clinic transfer source profile must describe ED assessment",
                    )
                if row.get("resource_requirements"):
                    issue(
                        table,
                        n,
                        "resource_requirements",
                        "Clinic transit/waiting source does not occupy assessment equipment",
                    )
                if policy and policy.get("transport_required") is not True:
                    issue(
                        table,
                        n,
                        "pending_transfer.clinic_policy_id",
                        "Clinic mission requires a transport-enabled policy",
                    )
                departure = timestamp(table, n, transfer, "planned_departure_at")
                arrival = timestamp(table, n, transfer, "planned_arrival_at")
                expiry = timestamp(table, n, transfer, "expiry_at")
                policy_start = (
                    timestamp("clinic_policies", 0, policy, "admission_start_at") if policy else None
                )
                policy_end = timestamp("clinic_policies", 0, policy, "admission_end_at") if policy else None
                if (
                    requested
                    and departure
                    and arrival
                    and expiry
                    and not requested <= departure < arrival < expiry
                ):
                    issue(
                        table,
                        n,
                        "pending_transfer.expiry_at",
                        "Clinic mission requires request <= departure < arrival < expiry",
                    )
                if requested and policy_start and requested < policy_start:
                    issue(
                        table,
                        n,
                        "pending_transfer.requested_at",
                        "Clinic request precedes the policy admission interval",
                    )
                if arrival and policy_end and arrival >= policy_end:
                    issue(
                        table,
                        n,
                        "pending_transfer.planned_arrival_at",
                        "Clinic arrival must precede the policy admission end",
                    )
                vehicle = (
                    indexes["vehicles"].get(transfer.get("vehicle_id"))
                    if isinstance(transfer.get("vehicle_id"), str)
                    else None
                )
                slot = (
                    indexes["slots"].get(transfer.get("destination_slot_id"))
                    if isinstance(transfer.get("destination_slot_id"), str)
                    else None
                )
                if (
                    profile
                    and vehicle
                    and (profile.get("required_transport_capability") or "BASIC_TRANSPORT")
                    not in vehicle.get("capabilities", [])
                ):
                    issue(
                        table,
                        n,
                        "pending_transfer.vehicle_id",
                        "Vehicle does not provide the clinic profile transport capability",
                    )
                if (
                    profile
                    and slot
                    and profile.get("required_site_capability") not in slot.get("capabilities", [])
                ):
                    issue(
                        table,
                        n,
                        "pending_transfer.destination_slot_id",
                        "Clinic reservation slot lacks the profile site capability",
                    )
            ref(table, n, transfer, "vehicle_id", "vehicles", False)
            ref(table, n, transfer, "destination_slot_id", "slots", False)
            for key in ("planned_departure_at", "planned_arrival_at"):
                timestamp(table, n, transfer, key, False)
            number(
                table,
                n,
                transfer,
                "remaining_stage_minutes",
                0 if completed_source or reserved_source_finishes_before_pickup(row, snapshot) else 1,
                required=state in {"transfer_reserved", "in_transit"}
                and not clinic_transfer
                and not completed_source,
            )
    return errors
