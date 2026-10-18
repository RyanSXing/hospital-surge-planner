"""Compact readbacks from recorded result evidence, never inferred capacity causes."""

from __future__ import annotations

import math
import re
from zoneinfo import ZoneInfo

from .domain import date

REASON_LABELS = {
    "no_matching_physical_place": "not enough suitable beds",
    "nursing_capacity": "no staffed bed available",
    "minimum_operating_team": "the minimum medical or support team was missing",
    "required_equipment_unavailable": "required equipment was unavailable",
    "unsupported_care_capability": "required care capability was unavailable",
    "place_turnover": "beds were being cleaned",
    "incoming_reservation": "beds were reserved for incoming patients",
    "destination_inactive": "the unit was not open",
    "medical_supplies": "medical supplies were exhausted",
    "treatment_disruption": "treatment was interrupted",
}


def bottleneck_question(message):
    return bool(re.search(r"\b(?:bottlenecks?|constraints?|most constrained)\b", message, re.IGNORECASE))


def whole_horizon_bottleneck_intent(message):
    """Only an unqualified main-constraint question can override model filters.

    Any human time/example/history/comparison qualifier keeps the explicit scope;
    an invented tool date or a currently selected replay time does not narrow it.
    """
    if not bottleneck_question(message) or not re.search(
        r"\b(?:main|primary|biggest|largest|greatest|worst|top|most constrained)\b", message, re.IGNORECASE
    ):
        return False
    return not re.search(
        r"\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b|"
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d|"
        r"\b(?:today|yesterday|tomorrow|day|days|hour|hours|moment|time|example|replication|individual|replay|historical|previous|older|earlier|compare|comparison|between|other)\b",
        message,
        re.IGNORECASE,
    )


def finite(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def burden(value):
    """Same mean-first category/unit ranking as the existing Decision summary."""
    if isinstance(value, dict):
        mean = finite(value.get("mean"))
        return mean if mean is not None else finite(value.get("p50"))
    return finite(value)


def recorded_main_constraint(value):
    evidence = value.get("bottlenecks")
    if not isinstance(evidence, dict) or evidence.get("evidence_available") is not True:
        return None
    if any(not isinstance(evidence.get(table), list) for table in ("categories", "units", "resources")):
        return None
    categories = evidence.get("categories")
    if not isinstance(categories, list) or any(
        not isinstance(row, dict)
        or not isinstance(row.get("reason"), str)
        or burden(row.get("patient_hours")) is None
        or burden(row["patient_hours"]) < 0
        for row in categories
    ):
        return None
    positive = [row for row in categories if burden(row["patient_hours"]) > 0]
    if not positive:
        return {"no_attributed_constraint": True}
    category = min(positive, key=lambda row: (-burden(row["patient_hours"]), row["reason"]))
    attributed = [
        row
        for table in ("units", "resources")
        for row in evidence.get(table, [])
        if isinstance(row, dict)
        and row.get("reason") == category["reason"]
        and row.get("unit_id")
        and burden(row.get("patient_hours")) is not None
        and burden(row["patient_hours"]) > 0
    ]
    unit = (
        min(attributed, key=lambda row: (-burden(row["patient_hours"]), row["unit_id"]))
        if attributed
        else None
    )
    names = value.get("unit_names", {})
    name = names.get(unit["unit_id"]) if unit else None
    if unit and not name:
        name = {"ed": "the emergency department", "icu": "intensive care", "ward": "a ward"}.get(
            unit.get("unit_kind")
        )
    record = unit or category
    return {
        "reason": category["reason"],
        "label": REASON_LABELS.get(category["reason"], "a recorded resource constraint"),
        "unit": name,
        "first_at": record.get("first_at") or category.get("first_at"),
        "replication_id": record.get("first_replication_id")
        or category.get("first_replication_id")
        or value["source"].get("replication_id"),
        "peak_waiting": record.get("peak_waiting"),
    }


def bottleneck_summary(value, main):
    if value.get("available") is not True:
        return (
            value.get("reason") or "Recorded results are unavailable; a main bottleneck cannot be identified."
        )
    if main is None:
        return "Recorded bottleneck evidence is unavailable for this period; a main resource constraint cannot be identified."
    source = value["source"]
    ensemble = source["scope"] == "ensemble"
    scope = (
        "Across the completed simulations" if ensemble else "In this one example run (not ensemble evidence)"
    )
    if main.get("no_attributed_constraint"):
        text = f"{scope}, no resource constraint had a positive recorded waiting burden. This does not establish that nobody waited."
    else:
        where = f" in {main['unit']}" if main.get("unit") else " (the affected unit is unavailable)"
        text = f"{scope}, the main recorded bottleneck was {main['label']}{where}."
        try:
            instant = date(main["first_at"]).astimezone(ZoneInfo(source["timezone"]))
            text += f" First recorded: {instant.strftime('%b %-d, %Y, %-I:%M %p %Z')}."
            if ensemble:
                text += " This is the earliest occurrence across simulations."
        except (KeyError, ValueError, TypeError):
            text += " Its first recorded time is unavailable."
        text += (
            " It had the greatest mean recorded waiting burden."
            if ensemble
            else " It had the greatest recorded waiting burden."
        )
        peak = main.get("peak_waiting")
        peak = (
            finite(peak.get("p50"))
            if ensemble and isinstance(peak, dict)
            else finite(peak)
            if not ensemble
            else None
        )
        if peak is not None and peak >= 0:
            text += f" {'Median peak queue' if ensemble else 'Peak queue'} for this constraint: {peak:g} patients."
    wait = (value.get("scalar_metrics") or {}).get("average_wait_per_patient_hours")
    wait = (
        finite(wait.get("p50"))
        if ensemble and isinstance(wait, dict)
        else finite(wait)
        if not ensemble
        else None
    )
    if wait is not None and wait >= 0:
        text += f" Average wait per patient: {wait:.1f} hours" + (
            " (median across simulations)." if ensemble else "."
        )
    if source.get("matches_current_draft") is False:
        text += " These saved results differ from the current unsaved draft."
    if not main.get("no_attributed_constraint"):
        text += " Constraint categories can overlap."
    return text
