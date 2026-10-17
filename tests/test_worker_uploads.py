"""Attempt-owned cleanup preserves committed outputs despite uncertain acknowledgments."""

import threading

import pytest
from oci.exceptions import ServiceError
from sqlalchemy.exc import OperationalError
from surge_api import worker
from surge_api.db import Document, Job, make_database


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_BACKEND", "local")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    engine, Session = make_database("sqlite:///" + str(tmp_path / "uploads.db"))
    with Session.begin() as session:
        session.add(Job(id="run-owned", workspace_id="workspace", payload={}))
    yield worker.PendingUploads(Session, "run-owned"), Session
    engine.dispose()


def test_cleanup_preserves_committed_and_winner_objects_after_lost_commit_acknowledgment(uploads):
    pending, Session = uploads
    store = pending.store
    committed_job = store.write("workspace", "run-owned", "inputs.json", b"job inputs")
    committed_rep = store.write("workspace", "run-owned", "replication.json", b"saved replica")
    unpublished = store.write("workspace", "run-owned", "aggregate.json", b"not committed")
    winner = worker.ArtifactStore().write("workspace", "run-owned", "aggregate.json", b"current owner")
    with Session.begin() as session:
        session.get(Job, "run-owned").result = {"artifact": committed_job, "winner": winner}
        session.add(
            Document(
                id="rep-owned",
                workspace_id="workspace",
                kind="replication",
                data={"run_group_id": "run-owned", "aggregate_artifact": committed_rep},
            )
        )
    # The transaction committed, but the lost acknowledgment prevented retain().
    pending.cleanup()
    assert not pending.pending
    assert not (store.root / unpublished["object_key"]).exists()
    for artifact in (committed_job, committed_rep, winner):
        assert store.read(artifact)


def test_cleanup_defers_when_reference_verification_or_storage_delete_is_unavailable(uploads, monkeypatch):
    pending, Session = uploads
    artifact = pending.store.write("workspace", "run-owned", "pending.json", b"pending")

    class UnavailableDatabase:
        @staticmethod
        def begin():
            raise OperationalError("", {}, ConnectionError("private database details"))

    pending.Session = UnavailableDatabase
    pending.cleanup()
    assert pending.store.read(artifact) == b"pending" and pending.pending
    pending.Session = Session
    with monkeypatch.context() as patch:

        def unavailable_storage(*args):
            raise ServiceError(503, "Unavailable", {}, "private storage details")

        patch.setattr(pending.store, "delete", unavailable_storage)
        pending.cleanup()
        assert pending.store.read(artifact) == b"pending" and pending.pending
    pending.cleanup()
    assert not pending.pending and not (pending.store.root / artifact["object_key"]).exists()


def test_cleanup_waits_for_inflight_publication_before_deciding_object_is_unreferenced(uploads):
    pending, Session = uploads
    artifact = pending.store.write("workspace", "run-owned", "uncertain.json", b"committed late")
    started, finished = threading.Event(), threading.Event()

    def cleanup():
        started.set()
        pending.cleanup()
        finished.set()

    thread = threading.Thread(target=cleanup)
    with Session.begin() as session:
        session.get(Job, "run-owned").result = {"artifact": artifact}
        session.flush()  # The server has the publication, but has not yet committed.
        thread.start()
        assert started.wait(2)
        assert not finished.wait(0.1), "Cleanup must wait for the publication transaction's lock"
    thread.join(5)
    assert finished.is_set() and not pending.pending
    assert pending.store.read(artifact) == b"committed late"
