"""Small immutable dataset cards must remain isolated and revision-correct."""

from sqlalchemy import event
from surge_api.db import Document, make_database
from surge_api.main import dataset_cards


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
