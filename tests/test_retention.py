# ruff: noqa: F811
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from surge_api.artifacts import ArtifactStore
from surge_api.db import AuditEvent, Document, Job
from surge_api.retention import cleanup
from test_api import client  # noqa: F401 - shared isolated API fixture


def test_retention_dry_run_apply_preserves_saved_and_selected_artifacts(client):
    client.get("/api/me")
    old = (datetime.now(UTC) - timedelta(days=40)).isoformat()
    store = ArtifactStore()
    artifacts = {
        name: store.put_json("workspace-main", name, "artifact", {"source": name})
        for name in ("selected", "unselected", "export", "failed", "input")
    }
    for artifact in artifacts.values():
        artifact["created_at"] = old
    with client.app.state.Session.begin() as session:
        session.add(
            Document(
                id="selected",
                workspace_id="workspace-main",
                kind="replication",
                created_at=old,
                updated_at=old,
                data={"id": "selected", "selected": True, "trace_artifact": artifacts["selected"]},
            )
        )
        session.add(
            Document(
                id="unselected",
                workspace_id="workspace-main",
                kind="replication",
                created_at=old,
                updated_at=old,
                data={"id": "unselected", "selected": False, "trace_artifact": artifacts["unselected"]},
            )
        )
        session.add(
            Document(
                id="failed",
                workspace_id="workspace-main",
                kind="import",
                created_at=old,
                updated_at=old,
                data={
                    "id": "failed",
                    "status": "INVALID",
                    "files": [artifacts["failed"]],
                    "validation": {"valid": False},
                },
            )
        )
        session.add(
            Job(
                id="old-export",
                workspace_id="workspace-main",
                kind="export",
                status="SUCCEEDED",
                created_at=old,
                completed_at=old,
                payload={"dataset_version_id": "saved"},
                result={"artifact": artifacts["export"]},
            )
        )
        session.add(
            Job(
                id="saved-run",
                workspace_id="workspace-main",
                kind="run",
                status="SUCCEEDED",
                created_at=old,
                completed_at=old,
                payload={},
                result={"inputs_artifact": artifacts["input"], "aggregate_artifact": artifacts["input"]},
            )
        )
    dry = cleanup(client.app.state.Session)
    assert dry["eligible_count"] == 3
    assert all(store.read(artifact) for artifact in artifacts.values())
    applied = cleanup(client.app.state.Session, apply=True)
    assert all(item["status"] == "purged" for item in applied["items"])
    assert store.read(artifacts["selected"]) and store.read(artifacts["input"])
    for name in ("unselected", "export", "failed"):
        assert not (store.root / artifacts[name]["object_key"]).exists()
    assert cleanup(client.app.state.Session, apply=True)["eligible_count"] == 0
    response = client.get("/api/exports/old-export/download")
    assert response.status_code == 410
    assert client.get("/api/exports/old-export").json()["expired"]
    assert client.post("/api/exports/old-export/regenerate").status_code == 202
    assert client.post("/api/imports/failed/validate").status_code == 410
    with client.app.state.Session() as session:
        assert session.get(Document, "unselected").data["trace_expired_at"]
        assert (
            len(list(session.scalars(select(AuditEvent).where(AuditEvent.action == "artifact.expired")))) == 3
        )


def test_retention_storage_failure_is_retryable_and_admin_only(client, monkeypatch):
    client.get("/api/me")
    old = (datetime.now(UTC) - timedelta(days=10)).isoformat()
    store = ArtifactStore()
    artifact = store.put_json("workspace-main", "failed-delete", "artifact", {})
    with client.app.state.Session.begin() as session:
        session.add(
            Job(
                id="failed-delete",
                workspace_id="workspace-main",
                kind="export",
                status="SUCCEEDED",
                created_at=old,
                completed_at=old,
                payload={},
                result={"artifact": artifact},
            )
        )
    original = ArtifactStore.delete

    def fail(*args):
        raise OSError("Storage temporarily unavailable")

    monkeypatch.setattr(ArtifactStore, "delete", fail)
    first = cleanup(client.app.state.Session, apply=True)
    assert first["items"][0]["status"] == "deletion_pending"
    assert (store.root / artifact["object_key"]).exists()
    monkeypatch.setattr(ArtifactStore, "delete", original)
    assert cleanup(client.app.state.Session, apply=True)["items"][0]["status"] == "purged"
    client.post("/api/auth/login", json={"demo_role": "viewer"})
    assert client.post("/api/workspaces/workspace-main/retention", json={"apply": True}).status_code == 403
    assert client.get("/api/workspaces/workspace-main/execution-metrics").status_code == 403
