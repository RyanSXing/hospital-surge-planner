import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from surge_api.artifacts import ArtifactStore
from surge_api.db import AuditEvent, Document, Job, make_database
from surge_api.retention import cleanup, cleanup_orphans


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_BACKEND", "local")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    engine, Session = make_database("sqlite:///" + str(tmp_path / "retention.db"))
    with Session.begin() as session:
        session.add(Document(id="workspace-main", workspace_id="workspace-main", kind="workspace", data={}))
    yield Session, ArtifactStore()
    engine.dispose()


def artifact(store, index, *, workspace="workspace-main", old=True, name="aggregate.json.gz"):
    owner = "run_" + f"{index:020x}"
    metadata = store.write(workspace, owner, name, b"synthetic")
    if old:
        stamp = (datetime.now(UTC) - timedelta(hours=48)).timestamp()
        os.utime(store.root / metadata["object_key"], (stamp, stamp))
    return owner, metadata


def test_orphan_dry_run_preserves_all_references_active_owners_grace_and_prefix(storage):
    Session, store = storage
    values = [artifact(store, i) for i in range(8)]
    recent = artifact(store, 8, old=False)
    foreign = artifact(store, 9, workspace="other-workspace")
    malformed = artifact(store, 10, name="control\x01name.json")
    with Session.begin() as session:
        session.add(
            Document(
                id="saved",
                workspace_id="workspace-main",
                kind="scenario_revision",
                data={"nested": [{"input": values[1][1]}]},
            )
        )
        session.add(
            Job(
                id="saved-job",
                workspace_id="workspace-main",
                kind="run",
                status="SUCCEEDED",
                payload={"nested": values[2][1]},
                result={"aggregate": values[3][1]},
            )
        )
        session.add(
            AuditEvent(
                workspace_id="workspace-main",
                user_id="system",
                action="saved",
                entity_id="saved",
                details={"artifact": values[4][1]},
            )
        )
        session.add(
            Job(
                id=values[5][0],
                workspace_id="workspace-main",
                kind="run",
                status="RUNNING",
                payload={},
                result={},
            )
        )
        session.add(
            Job(
                id="trace-active",
                workspace_id="workspace-main",
                kind="trace",
                status="QUEUED",
                payload={"run_group_id": values[6][0]},
                result={},
            )
        )
        # A reference in another workspace is conservatively preserved too.
        session.add(
            Document(
                id="cross-reference",
                workspace_id="other-workspace",
                kind="saved",
                data={"artifact": values[7][1]},
            )
        )
    dry = cleanup_orphans(Session, workspace_id="workspace-main")
    assert dry["dry_run"] and dry["eligible_count"] == 1
    assert store.read(values[0][1])
    with Session() as session:
        assert not list(session.scalars(select(Document).where(Document.kind == "artifact_gc_cursor")))
    applied = cleanup_orphans(Session, apply=True, workspace_id="workspace-main")
    assert applied["items"][0]["status"] == "purged"
    assert not (store.root / values[0][1]["object_key"]).exists()
    for _, metadata in [*values[1:], recent, foreign, malformed]:
        assert store.read(metadata)


def test_orphan_scan_and_delete_bounds_progress_and_retry(storage, monkeypatch):
    Session, store = storage
    values = [artifact(store, i) for i in range(4)]
    original = ArtifactStore.delete
    failures = {values[0][1]["object_key"]}

    def fail_once(self, metadata):
        if metadata["object_key"] in failures:
            failures.remove(metadata["object_key"])
            raise OSError("temporary storage failure")
        return original(self, metadata)

    monkeypatch.setattr(ArtifactStore, "delete", fail_once)
    first = cleanup_orphans(Session, apply=True, workspace_id="workspace-main", limit=1, scan_limit=2)
    assert first["items"][0]["status"] == "deletion_pending"
    assert first["scanned"] <= 2 and first["eligible_count"] == 1
    assert first["next_cursor"]
    for _ in range(5):
        result = cleanup_orphans(Session, apply=True, workspace_id="workspace-main", limit=1, scan_limit=2)
        assert result["scanned"] <= 2 and result["eligible_count"] <= 1
    assert all(not (store.root / value["object_key"]).exists() for _, value in values)


def test_reference_committed_after_listing_is_rechecked(storage, monkeypatch):
    Session, store = storage
    _, value = artifact(store, 1)
    original = ArtifactStore.list_page

    def list_and_commit(self, *args, **kwargs):
        page = original(self, *args, **kwargs)
        with Session.begin() as session:
            session.add(
                Document(
                    id="new-reference",
                    workspace_id="workspace-main",
                    kind="replication",
                    data={"trace_artifact": value},
                )
            )
        return page

    monkeypatch.setattr(ArtifactStore, "list_page", list_and_commit)
    assert cleanup_orphans(Session, apply=True, workspace_id="workspace-main")["eligible_count"] == 0
    assert store.read(value)


def test_global_cursor_rotates_after_prefix_completed_and_daily_cleanup_invokes(storage):
    Session, store = storage
    with Session.begin() as session:
        session.add(Document(id="workspace-z", workspace_id="workspace-z", kind="workspace", data={}))
    main = [artifact(store, i) for i in (1, 2)]
    _, other = artifact(store, 3, workspace="workspace-z")
    first = cleanup_orphans(Session, apply=True, limit=1, scan_limit=1)
    second = cleanup_orphans(Session, apply=True, limit=1, scan_limit=1)
    third = cleanup(Session, apply=True, limit=1)["orphan_collection"]
    assert first["workspace_id"] == second["workspace_id"] == "workspace-main"
    assert third["workspace_id"] == "workspace-z"
    assert all(not (store.root / value["object_key"]).exists() for _, value in main)
    assert not (store.root / other["object_key"]).exists()


def test_oci_listing_is_prefix_scoped_bounded_and_uses_inclusive_cursor(storage):
    _, store = storage
    key = "workspace-main/run_" + "1" * 20 + "/artifact_" + "2" * 20 + "/aggregate.json.gz"
    calls = []

    def list_objects(namespace, bucket, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            data=SimpleNamespace(
                objects=[SimpleNamespace(name=key, size=10, time_created=datetime.now(UTC))],
                next_start_with=key + "z",
            )
        )

    store.backend = "oci"
    store.namespace, store.bucket = "namespace", "bucket"
    store.client = SimpleNamespace(list_objects=list_objects)
    page = store.list_page("workspace-main", cursor=key, limit=5000)
    assert calls == [
        {"prefix": "workspace-main/", "limit": 1000, "fields": "name,size,timeCreated", "start": key}
    ]
    assert page["items"][0]["object_key"] == key and page["next_cursor"] == key + "z"
    with pytest.raises(ValueError):
        store.list_page("../other")
    with pytest.raises(ValueError):
        store.list_page("workspace-main", cursor="other/key")


def test_missing_object_age_and_symlink_are_preserved(storage, monkeypatch):
    Session, store = storage
    _, value = artifact(store, 1)
    original = ArtifactStore.list_page

    def without_age(self, *args, **kwargs):
        page = original(self, *args, **kwargs)
        for item in page["items"]:
            item["created_at"] = None
        return page

    monkeypatch.setattr(ArtifactStore, "list_page", without_age)
    assert cleanup_orphans(Session, apply=True, workspace_id="workspace-main")["eligible_count"] == 0
    assert store.read(value)
    path = store.root / value["object_key"]
    target = store.root / "external-target"
    path.replace(target)
    path.symlink_to(target)
    assert original(store, "workspace-main")["items"] == []
    assert target.exists()


def test_orphan_uploaded_filenames_with_spaces_and_unicode_are_collected(storage):
    Session, store = storage
    _, value = artifact(store, 1, name="ward census 床位.csv")
    result = cleanup_orphans(Session, apply=True, workspace_id="workspace-main")
    assert result["eligible_count"] == 1 and result["items"][0]["status"] == "purged"
    assert not (store.root / value["object_key"]).exists()


def test_oci_missing_creation_time_is_unknown(storage):
    _, store = storage
    store.backend = "oci"
    store.namespace, store.bucket = "namespace", "bucket"
    store.client = SimpleNamespace(
        list_objects=lambda *args, **kwargs: SimpleNamespace(
            data=SimpleNamespace(
                objects=[SimpleNamespace(name="workspace-main/unknown", size=1, time_created=None)],
                next_start_with=None,
            )
        )
    )
    assert store.list_page("workspace-main")["items"][0]["created_at"] is None


def add_expired_export(Session, value):
    old = (datetime.now(UTC) - timedelta(days=10)).isoformat()
    with Session.begin() as session:
        session.add(
            Job(
                id="export-expired",
                workspace_id="workspace-main",
                kind="export",
                status="SUCCEEDED",
                created_at=old,
                completed_at=old,
                payload={},
                result={"artifact": value},
            )
        )


def test_orphans_share_daily_deletion_budget(storage):
    Session, store = storage
    _, export = artifact(store, 1)
    _, orphan = artifact(store, 2)
    add_expired_export(Session, export)
    result = cleanup(Session, apply=True, limit=1)
    assert result["items"][0]["status"] == "purged"
    assert result["orphan_collection"]["status"] == "budget_exhausted"
    assert store.read(orphan)


def test_orphan_listing_outage_does_not_hide_completed_category_cleanup(storage, monkeypatch):
    Session, store = storage
    _, export = artifact(store, 1)
    add_expired_export(Session, export)

    def unavailable(*args, **kwargs):
        raise OSError("Private service detail must not appear in reports")

    monkeypatch.setattr(ArtifactStore, "list_page", unavailable)
    result = cleanup(Session, apply=True)
    assert result["items"][0]["status"] == "purged"
    assert result["orphan_collection"] == {
        "dry_run": False,
        "status": "scan_deferred",
        "error_type": "OSError",
    }
