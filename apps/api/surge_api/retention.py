"""Bounded, auditable expiration of regenerable artifacts; saved history survives."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import or_, select

from .artifacts import ArtifactStore
from .db import AuditEvent, Document, Job, now
from .domain import date

DEFAULT_POLICY = {"unselected_trace_days": 30, "failed_import_days": 7, "export_days": 7}


def policy(settings=None):
    return {**DEFAULT_POLICY, **(settings or {}).get("retention_policy", {})}


def cleanup(Session, *, apply=False, limit=100, workspace_id=None, as_of=None):
    """Expire at most limit eligible entities; dry-run is the default.

    First remove public live references transactionally, then delete objects.
    Pending deletion metadata survives a crash or storage failure and is retried.
    Original inputs, saved revisions, aggregates and selected traces are excluded.
    """
    instant = date(as_of or now())
    limit = max(1, min(1000, limit))
    candidates = []
    with Session() as session:
        settings = {
            d.workspace_id: policy(d.data)
            for d in session.scalars(select(Document).where(Document.kind == "workspace_settings"))
        }
        jobs = (
            select(Job)
            .where(
                Job.kind == "export",
                Job.status == "SUCCEEDED",
                or_(
                    Job.result["artifact"].as_string().is_not(None),
                    Job.result["expired_artifact"].as_string().is_not(None),
                ),
            )
            .order_by(Job.created_at)
            .limit(5000)
        )
        docs = (
            select(Document)
            .where(
                or_(
                    (Document.kind == "replication")
                    & Document.data["selected"].as_boolean().is_not(True)
                    & or_(
                        Document.data["trace_artifact"].as_string().is_not(None),
                        Document.data["expired_trace_artifact"].as_string().is_not(None),
                    ),
                    (Document.kind == "import")
                    & or_(
                        Document.data["status"].as_string().in_(["INVALID", "FAILED"]),
                        (Document.data["status"].as_string() == "EXPIRED")
                        & Document.data["purge_pending"].as_string().is_not(None),
                    ),
                )
            )
            .order_by(Document.created_at)
            .limit(5000)
        )
        if workspace_id:
            jobs = jobs.where(Job.workspace_id == workspace_id)
            docs = docs.where(Document.workspace_id == workspace_id)
        for row in session.scalars(jobs):
            config = settings.get(row.workspace_id, DEFAULT_POLICY)
            artifact = row.result.get("expired_artifact") or row.result.get("artifact")
            if artifact and (
                row.result.get("expired_at")
                or date(row.completed_at or row.created_at) + timedelta(days=config["export_days"]) <= instant
            ):
                candidates.append(
                    {
                        "kind": "export",
                        "id": row.id,
                        "workspace_id": row.workspace_id,
                        "artifacts": [artifact],
                        "reason": f"Export retention {config['export_days']} days",
                    }
                )
        for row in session.scalars(docs):
            config = settings.get(row.workspace_id, DEFAULT_POLICY)
            if row.kind == "replication":
                artifact = row.data.get("expired_trace_artifact") or row.data.get("trace_artifact")
                generated = (
                    row.data.get("trace_generated_at") or (artifact or {}).get("created_at") or row.updated_at
                )
                if artifact and (
                    row.data.get("trace_expired_at")
                    or date(generated) + timedelta(days=config["unselected_trace_days"]) <= instant
                ):
                    candidates.append(
                        {
                            "kind": "trace",
                            "id": row.id,
                            "workspace_id": row.workspace_id,
                            "artifacts": [artifact],
                            "reason": f"Unselected trace retention {config['unselected_trace_days']} days",
                        }
                    )
            else:
                files = row.data.get("purge_pending") or row.data.get("files", [])
                latest = max([row.updated_at, *[f.get("created_at", row.updated_at) for f in files]])
                if files and (
                    row.data.get("expired_at")
                    or date(latest) + timedelta(days=config["failed_import_days"]) <= instant
                ):
                    candidates.append(
                        {
                            "kind": "failed_import",
                            "id": row.id,
                            "workspace_id": row.workspace_id,
                            "artifacts": files,
                            "reason": f"Failed upload retention {config['failed_import_days']} days",
                        }
                    )
    candidates = candidates[:limit]
    result = {
        "dry_run": not apply,
        "as_of": instant.isoformat(),
        "limit": limit,
        "eligible_count": len(candidates),
        "byte_size": sum(a.get("byte_size", 0) for c in candidates for a in c["artifacts"]),
        "items": [],
        "preserves": [
            "datasets",
            "saved_scenario_revisions",
            "run_inputs",
            "aggregate_results",
            "selected_representative_traces",
            "audit_history",
        ],
    }
    for item in candidates:
        summary = {k: v for k, v in item.items() if k != "artifacts"}
        summary["artifact_count"] = len(item["artifacts"])
        if apply:
            with Session.begin() as session:
                if item["kind"] == "export":
                    row = session.get(Job, item["id"])
                    row.result = {
                        **row.result,
                        "expired_at": row.result.get("expired_at", now()),
                        "expired_artifact": item["artifacts"][0],
                    }
                    row.result.pop("artifact", None)
                else:
                    row = session.get(Document, item["id"])
                    value = {**row.data}
                    if item["kind"] == "trace":
                        # A regenerated replacement has another object key. Never
                        # expire a newly written object selected after this scan.
                        current = value.get("trace_artifact") or value.get("expired_trace_artifact")
                        if value.get("selected") or current != item["artifacts"][0]:
                            summary["status"] = "skipped_changed"
                            result["items"].append(summary)
                            continue
                        value.update(
                            trace_expired_at=value.get("trace_expired_at", now()),
                            expired_trace_artifact=item["artifacts"][0],
                        )
                        value.pop("trace_artifact", None)
                    else:
                        if value.get("status") not in {"INVALID", "FAILED", "EXPIRED"}:
                            summary["status"] = "skipped_changed"
                            result["items"].append(summary)
                            continue
                        value.update(
                            status="EXPIRED",
                            expired_at=value.get("expired_at", now()),
                            purge_pending=item["artifacts"],
                            files=[],
                            dataset=None,
                        )
                    row.data = value
                session.add(
                    AuditEvent(
                        workspace_id=item["workspace_id"],
                        user_id="system-retention",
                        action="artifact.expired",
                        entity_id=item["id"],
                        details={
                            "kind": item["kind"],
                            "reason": item["reason"],
                            "artifact_count": len(item["artifacts"]),
                        },
                    )
                )
            try:
                store = ArtifactStore()
                for metadata in item["artifacts"]:
                    store.delete(metadata)
                with Session.begin() as session:
                    if item["kind"] == "export":
                        row = session.get(Job, item["id"])
                        value = {**row.result, "retention_purged_at": now()}
                        value.pop("expired_artifact", None)
                        row.result = value
                    else:
                        row = session.get(Document, item["id"])
                        value = {**row.data, "retention_purged_at": now()}
                        value.pop("expired_trace_artifact", None)
                        value.pop("purge_pending", None)
                        row.data = value
                summary["status"] = "purged"
            except Exception as exc:  # noqa: BLE001 - durable cleanup boundary must retain failed deletions.
                # Retry metadata is durable. Report type, never credential-bearing
                # storage service exception details.
                summary.update(status="deletion_pending", error_type=type(exc).__name__)
        else:
            summary["status"] = "eligible"
        result["items"].append(summary)
    return result
