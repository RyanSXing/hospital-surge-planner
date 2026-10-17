"""Bounded, auditable expiration of regenerable artifacts; saved history survives."""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta

from sqlalchemy import Text, cast, or_, select

from .artifacts import ArtifactStore
from .db import AuditEvent, Document, Job, now
from .domain import date

DEFAULT_POLICY = {"unselected_trace_days": 30, "failed_import_days": 7, "export_days": 7}
TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED"}


def object_keys(value):
    """Inspect metadata recursively without assuming a particular document kind."""
    if isinstance(value, dict):
        if isinstance(value.get("object_key"), str):
            yield value["object_key"]
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from object_keys(child)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                yield from object_keys(child)


def referenced_keys(session, workspace):
    # SQL filters avoid deserializing large datasets without artifact metadata.
    # Include references from any workspace: a conservative cross-workspace
    # reference must never cause a shared object to be removed.
    prefix = workspace + "/"
    references = set()
    for columns in ([Document.data], [Job.payload, Job.result], [AuditEvent.details]):
        query = select(*columns).where(
            or_(*(cast(c, Text).contains(prefix, autoescape=True) for c in columns))
        )
        for row in session.execute(query.execution_options(yield_per=1)):
            for value in row:
                references.update(key for key in object_keys(value) if key.startswith(prefix))
    return references


def has_reference(session, key):
    # Recheck metadata committed after the initial scan. A cursor string is
    # deliberately not an artifact reference; preserving it would permanently
    # strand the first object of every subsequent page.
    for columns in ([Document.data], [Job.payload, Job.result], [AuditEvent.details]):
        query = select(*columns).where(or_(*(cast(c, Text).contains(key, autoescape=True) for c in columns)))
        for row in session.execute(query.execution_options(yield_per=1)):
            if any(key in object_keys(value) for value in row):
                return True
    return False


def active_owner(session, workspace, owner):
    query = (
        select(Job.id)
        .where(
            Job.workspace_id == workspace,
            Job.status.notin_(TERMINAL),
            or_(Job.id == owner, Job.payload["run_group_id"].as_string() == owner),
        )
        .limit(1)
    )
    return bool(session.scalar(query))


def cleanup_orphans(Session, *, apply=False, limit=100, workspace_id=None, as_of=None, scan_limit=500):
    """Sweep one bounded workspace page with a fixed minimum 24-hour grace.

    Applied cursors survive restarts. The global invocation rotates workspaces
    after a complete prefix; a failed delete remains discoverable next cycle.
    No caller can lower the grace or request arbitrary object prefixes.
    """
    instant = date(as_of or now())
    limit = max(0, min(1000, limit))
    scan_limit = max(1, min(1000, scan_limit))
    result = {
        "dry_run": not apply,
        "grace_hours": 24,
        "scan_limit": scan_limit,
        "delete_limit": limit,
        "scanned": 0,
        "eligible_count": 0,
        "items": [],
    }
    if not limit:
        return {**result, "status": "budget_exhausted"}
    global_id = "artifact-gc-workspace-cursor"
    with Session() as session:
        global_row = session.get(Document, global_id)
        state = global_row.data if global_row else {}
        if workspace_id:
            workspace = workspace_id
        else:
            workspaces = (
                select(Document.workspace_id)
                .where(Document.kind != "artifact_gc_cursor")
                .union(select(Job.workspace_id))
                .subquery()
            )
            query = select(workspaces.c.workspace_id).order_by(workspaces.c.workspace_id).limit(1)
            if state.get("pending"):
                workspace = state["workspace"]
            else:
                workspace = session.scalar(
                    query.where(workspaces.c.workspace_id > state.get("workspace", ""))
                )
                workspace = workspace or session.scalar(query)
        if not workspace:
            return {**result, "status": "empty"}
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", workspace):
            return {**result, "status": "invalid_workspace"}
        cursor_id = "artifact-gc-" + hashlib.sha256(workspace.encode()).hexdigest()[:20]
        cursor_row = session.get(Document, cursor_id)
        cursor = cursor_row.data.get("cursor") if cursor_row else None
        references = referenced_keys(session, workspace)
    store = ArtifactStore()
    page = store.list_page(workspace, cursor=cursor, limit=scan_limit)
    next_cursor = page["next_cursor"]
    generated = re.compile(
        rf"{re.escape(workspace)}/(?:run|export|import)_[0-9a-f]{{20}}/artifact_[0-9a-f]{{20}}/(?P<basename>[^/\x00-\x1f\x7f-\x9f]{{1,255}})"
    )
    result.update(workspace_id=workspace, cursor=cursor)
    for metadata in page["items"]:
        key = metadata["object_key"]
        if result["eligible_count"] >= limit:
            next_cursor = key
            break
        result["scanned"] += 1
        match = generated.fullmatch(key)
        if not match or match["basename"] in {".", ".."} or key in references:
            continue
        try:
            if not metadata.get("created_at"):
                continue
            if date(metadata["created_at"]) > instant - timedelta(hours=24):
                continue
        except (KeyError, ValueError, TypeError):
            continue  # Unknown age is never permission to delete.
        owner = key.split("/")[1]
        with Session() as session:
            if active_owner(session, workspace, owner) or has_reference(session, key):
                continue
        result["eligible_count"] += 1
        item = {"object_key": key, "byte_size": metadata.get("byte_size", 0), "status": "eligible"}
        if apply:
            try:
                store.delete(metadata)
                item["status"] = "purged"
                with Session.begin() as session:
                    session.add(
                        AuditEvent(
                            workspace_id=workspace,
                            user_id="system-retention",
                            action="artifact.orphan_purged",
                            entity_id=owner,
                            details={
                                "object_key_sha256": hashlib.sha256(key.encode()).hexdigest(),
                                "byte_size": metadata.get("byte_size", 0),
                                "grace_hours": 24,
                            },
                        )
                    )
            except Exception as exc:  # noqa: BLE001 - object remains discoverable on the next bounded cycle.
                item.update(status="deletion_pending", error_type=type(exc).__name__)
        result["items"].append(item)
    result["next_cursor"] = next_cursor
    if apply:
        with Session.begin() as session:
            updates = [(cursor_id, workspace, {"cursor": next_cursor})]
            if not workspace_id:
                updates.append(
                    (global_id, "system-retention", {"workspace": workspace, "pending": bool(next_cursor)})
                )
            for identity, scope, value in updates:
                row = session.get(Document, identity)
                if row:
                    row.data = value
                else:
                    session.add(
                        Document(id=identity, workspace_id=scope, kind="artifact_gc_cursor", data=value)
                    )
    return result


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
    try:
        result["orphan_collection"] = cleanup_orphans(
            Session,
            apply=apply,
            limit=limit - len(candidates),
            workspace_id=workspace_id,
            as_of=instant.isoformat(),
        )
    except Exception as exc:  # noqa: BLE001 - an unavailable listing must not hide completed category cleanup.
        result["orphan_collection"] = {
            "dry_run": not apply,
            "status": "scan_deferred",
            "error_type": type(exc).__name__,
        }
    return result
