"""Small immutable dataset cards must remain isolated and revision-correct."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import event
from surge_api.db import Document, make_database
from surge_api.main import cached_dataset_snapshot, create_app, dataset_cards, dataset_snapshot


def test_card_cache_avoids_json_reads_and_tracks_database_workspace_revision(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    engines = []
    for label in ("first", "second"):
        engine, Session = make_database("sqlite:///" + str(tmp_path / (label + ".db")))
        engines.append(engine)
        with Session.begin() as session:
            session.add(
                Document(
                    id="same-dataset-id",
                    workspace_id="workspace-a",
                    kind="dataset",
                    data={"name": label, "synthetic": True},
                    revision=1,
                    updated_at="2026-10-17T00:00:00Z",
                )
            )
            session.add(
                Document(
                    id="other-dataset",
                    workspace_id="workspace-b",
                    kind="dataset",
                    data={"name": "other workspace"},
                    revision=1,
                )
            )
        statements = []

        def capture(connection, cursor, statement, parameters, context, many, bucket=statements):
            bucket.append(statement)

        event.listen(engine, "before_cursor_execute", capture)
        with Session() as session:
            cold = dataset_cards(session, "workspace-a", limit=1)
            assert cold["items"][0]["name"] == label
            assert any("JSON_EXTRACT" in sql for sql in statements)
            statements.clear()
            warm = dataset_cards(session, "workspace-a", limit=1)
            assert warm == cold
            assert not any("JSON_EXTRACT" in sql for sql in statements)
            assert dataset_cards(session, "workspace-b")["items"][0]["name"] == "other workspace"
            assert dataset_cards(session, "unowned-workspace")["items"] == []
        with Session.begin() as session:
            row = session.get(Document, "same-dataset-id")
            row.data = {**row.data, "name": "revised metadata"}
            row.revision += 1
        with Session() as session:
            revised = dataset_cards(session, "workspace-a")
            assert revised["items"][0]["name"] == "revised metadata"
            assert revised["items"][0]["revision"] == 2
        event.remove(engine, "before_cursor_execute", capture)
    for engine in engines:
        engine.dispose()


def test_snapshot_cache_is_isolated_revision_scoped_and_does_not_alias_results(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    engine, Session = make_database("sqlite:///" + str(tmp_path / "snapshots.db"))
    value = {
        "snapshot_at": "2026-10-16T05:00:00Z",
        "patients": [{"patient_id": "P-001", "state": "inpatient"}],
        "history": [1, 2],
        "assignments": [
            {"start_at": "2026-10-16T00:00:00Z", "end_at": "2026-10-16T12:00:00Z"},
            {"start_at": "2026-10-17T00:00:00Z", "end_at": "2026-10-17T12:00:00Z"},
        ],
    }
    with Session.begin() as session:
        session.add(Document(id="snapshot-dataset", workspace_id="workspace-a", kind="dataset", data=value))
    with Session() as session:
        expected = dataset_snapshot(session.get(Document, "snapshot-dataset"))
        first = cached_dataset_snapshot(session, "snapshot-dataset", {"workspace_id": "workspace-a"})
        assert first == expected
        assert len(first["assignments"]) == 1 and first["collection_counts"]["assignments"] == 2
        assert "history" not in first and first["collection_counts"]["history"] == 2
        first["patients"][0]["state"] = "changed-by-caller"
    statements = []

    def capture(connection, cursor, statement, parameters, context, many):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    with Session() as session:
        assert (
            cached_dataset_snapshot(session, "snapshot-dataset", {"workspace_id": "workspace-a"}) == expected
        )
        with pytest.raises(HTTPException) as rejected:
            cached_dataset_snapshot(session, "snapshot-dataset", {"workspace_id": "workspace-b"})
        assert rejected.value.status_code == 404
    assert all("documents.data" not in statement for statement in statements)
    event.remove(engine, "before_cursor_execute", capture)
    with Session.begin() as session:
        row = session.get(Document, "snapshot-dataset")
        row.data = {**row.data, "name": "revised metadata"}
        row.revision += 1
    with Session() as session:
        assert (
            cached_dataset_snapshot(session, "snapshot-dataset", {"workspace_id": "workspace-a"})["name"]
            == "revised metadata"
        )
    engine.dispose()


def test_summary_keeps_scenarios_and_run_status_live_with_cached_dataset(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    from surge_api.db import Job

    app = create_app("sqlite:///" + str(tmp_path / "live-summary.db"), seed=True, start_dispatcher=False)
    with TestClient(app) as client:
        original = client.get("/api/workspaces/workspace-main/summary").json()
        chosen = client.post(
            "/api/scenarios",
            json={
                "name": "New live summary",
                "dataset_version_id": original["dataset"]["id"],
                "horizon_calendar_days": 1,
                "replications": 1,
            },
        ).json()
        run = client.post("/api/run-groups", json={"scenario_id": chosen["id"]}).json()
        queued = client.get("/api/workspaces/workspace-main/summary").json()
        assert queued["scenario"]["id"] == chosen["id"] and queued["run"]["status"] == "QUEUED"
        with app.state.Session.begin() as session:
            session.get(Job, run["id"]).status = "FAILED"
        updated = client.get("/api/workspaces/workspace-main/summary").json()
        assert updated["run"]["status"] == "FAILED"
        assert updated["inventory"]["patients"] == 84
        assert updated["inventory"]["history"] == original["inventory"]["history"] == 9360
