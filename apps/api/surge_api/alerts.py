"""Server-owned metric registry and evidence-backed planning alert evaluation."""

from __future__ import annotations

import math
import operator

from sqlalchemy import select

from .artifacts import ArtifactStore
from .db import Document, digest, uid
from .domain import add_document, serialize

METRICS = {
    "peak_inpatient_queue": {"unit": "patients", "aggregation": "maximum"},
    "inpatient_waiting_patient_hours": {"unit": "patient-hours", "aggregation": "sum"},
    "ed_waiting_patient_hours": {"unit": "patient-hours", "aggregation": "sum"},
    "ward_utilization": {"unit": "ratio", "aggregation": "ratio_of_integrals"},
    "icu_utilization": {"unit": "ratio", "aggregation": "ratio_of_integrals"},
    "ed_utilization": {"unit": "ratio", "aggregation": "ratio_of_integrals"},
    "peak_staffed_utilization": {"unit": "ratio", "aggregation": "maximum"},
    "capacity_shortfall_hours": {"unit": "hours", "aggregation": "sum"},
    "arrivals": {"unit": "patients", "aggregation": "sum"},
    "discharges": {"unit": "patients", "aggregation": "sum"},
}

DEFAULT_RULE = {
    "name": "Daily inpatient placement demand",
    "metric": "peak_inpatient_queue",
    "scope_filters": {"facility_id": "FAC-MAIN"},
    "statistic": "p50",
    "grain": "day",
    "operator": "gt",
    "threshold": 0,
    "unit": "patients",
    "consecutive_buckets": 1,
    "severity": "warning",
    "enabled": True,
}


def rule_errors(value):
    errors = []
    metric = METRICS.get(value.get("metric"))
    if not metric:
        errors.append({"field": "metric", "message": "Choose a supported metric from the registry"})
    elif value.get("unit", metric["unit"]) != metric["unit"]:
        errors.append({"field": "unit", "message": f"This metric uses {metric['unit']}"})
    if value.get("statistic", "p50") not in {"p10", "p50", "p90", "mean", "selected_replication"}:
        errors.append({"field": "statistic", "message": "Unsupported statistic"})
    if value.get("grain", "day") not in {"day", "week", "month"}:
        errors.append({"field": "grain", "message": "Unsupported grain"})
    if value.get("operator", "gt") not in {"gt", "gte", "lt", "lte"}:
        errors.append({"field": "operator", "message": "Unsupported operator"})
    threshold = value.get("threshold")
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold):
        errors.append({"field": "threshold", "message": "A finite numeric threshold is required"})
    count = value.get("consecutive_buckets", 1)
    if not isinstance(count, int) or not 1 <= count <= 365:
        errors.append({"field": "consecutive_buckets", "message": "Use an integer from 1 to 365"})
    if value.get("severity", "warning") not in {"info", "warning", "critical"}:
        errors.append({"field": "severity", "message": "Unsupported severity"})
    scope = value.get("scope_filters", {})
    if scope not in ({}, {"facility_id": "FAC-MAIN"}):
        errors.append(
            {
                "field": "scope_filters",
                "message": "This metric registry supports main-hospital scope; unsupported dimensions are rejected",
            }
        )
    return errors


def evaluate(session, workspace, job, replication_id=None):
    from surge_engine.aggregate import aggregate_results

    from .worker import period_aggregation

    store = ArtifactStore()
    reps = store.get_json(job.result["replications_artifact"])
    for replication in reps:
        for row in replication.get("daily", []):
            for care in ("ward", "icu", "ed"):
                denom = row.get(f"{care}_staffed_hours", 0)
                row[f"{care}_utilization"] = row.get(f"{care}_occupied_hours", 0) / denom if denom else None
    rules = list(
        session.scalars(
            select(Document).where(Document.workspace_id == workspace, Document.kind == "alert_rule")
        )
    )
    if not rules:
        rules = [add_document(session, workspace, "alert_rule", {"id": uid("rule"), **DEFAULT_RULE})]
    output = []
    operators = {"gt": operator.gt, "gte": operator.ge, "lt": operator.lt, "lte": operator.le}
    ensembles = {}
    for rule in rules:
        config = {**DEFAULT_RULE, **rule.data}
        if not config["enabled"]:
            continue
        chosen = reps
        selected = config["statistic"] == "selected_replication"
        if selected:
            if not replication_id:
                continue
            chosen = [r for r in reps if r["replication_id"] == replication_id]
            if not chosen:
                raise ValueError("Selected replication does not belong to this run")
        cache_key = (config["grain"], replication_id if selected else None)
        if cache_key not in ensembles:
            ensembles[cache_key] = (
                aggregate_results(chosen)["daily"]
                if config["grain"] == "day"
                else period_aggregation(chosen, config["grain"])
            )
        rows = ensembles[cache_key]
        streak = []
        for row in rows:
            metric = row.get(config["metric"])
            statistic = "p50" if selected else config["statistic"]
            value = metric.get(statistic) if isinstance(metric, dict) else metric
            if value is None or not operators[config["operator"]](value, config["threshold"]):
                streak = []
                continue
            streak.append(row)
            if len(streak) < config["consecutive_buckets"]:
                continue
            start = row["start_at"]
            identity = (
                "alert_"
                + digest(
                    [
                        rule.id,
                        rule.revision,
                        job.id,
                        replication_id if selected else "ensemble",
                        start,
                        config["scope_filters"],
                    ]
                )[:24]
            )
            record = session.get(Document, identity)
            if not record:
                record = add_document(
                    session,
                    workspace,
                    "alert",
                    {
                        "id": identity,
                        "run_group_id": job.id,
                        "replication_id": replication_id if selected else None,
                        "rule_id": rule.id,
                        "rule_revision_id": f"{rule.id}:{rule.revision}",
                        "rule_revision": rule.revision,
                        "rule_snapshot": config,
                        "title": config["name"],
                        "message": config["name"],
                        "metric": config["metric"],
                        "value": value,
                        "threshold": config["threshold"],
                        "unit": config["unit"],
                        "severity": config["severity"],
                        "scope_filters": config["scope_filters"],
                        "statistic": config["statistic"],
                        "grain": config["grain"],
                        "bucket_start": start,
                        "bucket_end": row["end_at"],
                        "local_date": row.get("local_date"),
                        "triggered_interval_start": streak[-config["consecutive_buckets"]]["start_at"],
                        "acknowledged": False,
                    },
                )
            output.append(serialize(record))
    return output
