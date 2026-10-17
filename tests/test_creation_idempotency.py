"""Lost HTTP responses replay the original creation, including immutable lineage."""

import copy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from surge_api.alerts import DEFAULT_RULE
from surge_api.db import AuditEvent, Document
from surge_api.main import create_app
from surge_api.worker import execute_job
from test_api import create_short_scenario, setup_context


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DEMO_MODE", "true")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(tmp_path / "test.db")
    app = create_app(url, seed=True, start_dispatcher=False)
    with TestClient(app) as c:
        c.database_url = url
        yield c


def checked(response, status=201):
    assert response.status_code == status, response.text
    return response.json()


def counts(client, kind, action):
    with client.app.state.Session() as session:
        return (
            session.scalar(select(func.count()).select_from(Document).where(Document.kind == kind)),
            session.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == action)),
        )


def replay_creation(client, path, payload, kind, action, changed=None, extra_headers=None):
    headers = {"Idempotency-Key": "lost-response", **(extra_headers or {})}
    before = counts(client, kind, action)
    first = checked(client.post(path, json=payload, headers=headers))
    second = checked(client.post(path, json=payload, headers=headers))
    assert second == first
    assert counts(client, kind, action) == tuple(value + 1 for value in before)
    mismatch = client.post(path, json=changed or {**payload, "name": "Different request"}, headers=headers)
    assert mismatch.status_code == 409, mismatch.text
    assert mismatch.json()["error"]["code"] == "idempotency_conflict"
    assert counts(client, kind, action) == tuple(value + 1 for value in before)
    return first


@pytest.mark.parametrize("operation", ["create", "freeze", "clone"])
def test_scenario_creation_retry_is_one_entity_and_audit(client, operation):
    context = setup_context(client)
    if operation == "create":
        path = "/api/scenarios"
        payload = {"dataset_version_id": context["dataset"]["id"], "name": "One scenario"}
        kind, action = "scenario", "scenario.created"
    else:
        scenario = create_short_scenario(client, context)
        path = f"/api/scenarios/{scenario['id']}/" + ("revisions" if operation == "freeze" else "clone")
        payload = {"name": "One saved copy"}
        kind, action = (
            ("scenario_revision", "scenario.frozen")
            if operation == "freeze"
            else ("scenario", "scenario.cloned")
        )
    first = replay_creation(client, path, payload, kind, action)
    if operation != "create":
        checked(
            client.patch(
                f"/api/scenarios/{scenario['id']}", json={"name": "Edited later"}, headers={"If-Match": "1"}
            ),
            200,
        )
        again = checked(client.post(path, json=payload, headers={"Idempotency-Key": "lost-response"}))
        assert again == first
        assert again["name"] != "Edited later"


def test_dataset_draft_creation_retry(client):
    context = setup_context(client)
    replay_creation(
        client,
        "/api/dataset-drafts",
        {"dataset_version_id": context["dataset"]["id"]},
        "dataset_draft",
        "dataset.draft_created",
    )


def test_dataset_commit_replays_frozen_output_after_later_draft_edit(client):
    context = setup_context(client)
    draft = checked(client.post("/api/dataset-drafts", json={"dataset_version_id": context["dataset"]["id"]}))
    path = f"/api/dataset-drafts/{draft['id']}/commit"
    headers = {"If-Match": "1", "Idempotency-Key": "commit-once"}
    before = counts(client, "dataset", "dataset.committed")
    first = checked(client.post(path, headers=headers))
    assert checked(client.post(path, headers=headers)) == first
    assert counts(client, "dataset", "dataset.committed") == tuple(x + 1 for x in before)
    facility = {**draft["facilities"][0], "name": "Changed after response lost"}
    checked(
        client.patch(
            f"/api/dataset-drafts/{draft['id']}/entities",
            json={"operations": [{"collection": "facilities", "entity": facility}]},
            headers={"If-Match": "1"},
        ),
        200,
    )
    assert checked(client.post(path, headers=headers)) == first
    mismatch = client.post(path, headers={**headers, "If-Match": "2"})
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"
    assert first["facilities"] == context["dataset"]["facilities"]


def test_alert_rule_creation_retry(client):
    setup_context(client)
    replay_creation(
        client,
        "/api/alert-rules",
        DEFAULT_RULE,
        "alert_rule",
        "alert_rule.created",
        {**DEFAULT_RULE, "threshold": 5},
    )


def test_update_correction_retry(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    payload = {"facility_id": "FAC-MAIN", "count": 2, "care_mix": {"ward": 1.0}}
    original = checked(
        client.post(
            "/api/updates",
            json={
                "scenario_id": scenario["id"],
                "type": "arrival_batch",
                "effective_at": scenario["start_at"],
                "state_origin": "simulation_branch",
                "payload": payload,
            },
        )
    )
    body = {"reason": "Corrected count", "payload": {**payload, "count": 3}}
    corrected = replay_creation(
        client,
        f"/api/updates/{original['id']}/correct",
        body,
        "update",
        "update.corrected",
        {**body, "reason": "Different correction"},
    )
    assert corrected["supersedes_update_id"] == original["id"]


def test_evaluated_plan_save_retry_preserves_one_scenario(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=1)
    comparison = checked(
        client.post(
            "/api/comparisons",
            json={
                "scenario_id": scenario["id"],
                "replications": 1,
                "plans": [{"name": "Reserve staff", "interventions": [{"kind": "staff_existing"}]}],
            },
        ),
        202,
    )
    for plan in comparison["plans"]:
        execute_job(plan["run_group_id"], client.database_url)
    replay_creation(
        client,
        f"/api/comparisons/{comparison['id']}/save-plan",
        {"plan_id": comparison["plans"][-1]["id"], "name": "Saved response"},
        "scenario",
        "plan.saved",
    )


def test_import_commit_key_is_bound_to_source_import(client):
    context = setup_context(client)
    stages = []
    for _ in range(2):
        stage = checked(client.post("/api/imports", json={"dataset": copy.deepcopy(context["dataset"])}))
        checked(client.post(f"/api/imports/{stage['id']}/validate", json={}), 200)
        stages.append(stage)
    headers = {"Idempotency-Key": "one-import-commit"}
    path = f"/api/imports/{stages[0]['id']}/commit"
    first = checked(client.post(path, headers=headers))
    assert checked(client.post(path, headers=headers)) == first
    mismatch = client.post(f"/api/imports/{stages[1]['id']}/commit", headers=headers)
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"


def test_update_application_key_rejects_changed_branch_request(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    event = checked(
        client.post(
            "/api/updates",
            json={
                "scenario_id": scenario["id"],
                "type": "arrival_batch",
                "effective_at": scenario["start_at"],
                "state_origin": "simulation_branch",
                "payload": {"facility_id": "FAC-MAIN", "count": 2, "care_mix": {"ward": 1.0}},
            },
        )
    )
    headers = {"Idempotency-Key": "one-branch"}
    path = f"/api/updates/{event['id']}/apply"
    before = counts(client, "scenario", "update.applied")
    first = checked(client.post(path, json={"run": False}, headers=headers), 200)
    again = checked(client.post(path, json={"run": False}, headers=headers), 200)
    assert again["scenario"]["id"] == first["scenario"]["id"] and again["already_applied"]
    assert counts(client, "scenario", "update.applied") == tuple(x + 1 for x in before)
    mismatch = client.post(path, json={"run": True}, headers=headers)
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"


def test_import_file_retry_does_not_write_second_artifact(client, monkeypatch):
    from surge_api.artifacts import ArtifactStore

    context = setup_context(client)
    stage = checked(client.post("/api/imports", json={"source_dataset_version_id": context["dataset"]["id"]}))
    writes = []
    original_write = ArtifactStore.write

    def counted_write(self, *args, **kwargs):
        result = original_write(self, *args, **kwargs)
        writes.append(result["object_key"])
        return result

    monkeypatch.setattr(ArtifactStore, "write", counted_write)
    path = f"/api/imports/{stage['id']}/files"
    headers = {"Idempotency-Key": "one-file"}
    file = ("sites.csv", b"facility_id,name\nFAC-MAIN,Synthetic hospital\n", "text/csv")
    first = checked(client.post(path, files={"file": file}, headers=headers), 200)
    assert checked(client.post(path, files={"file": file}, headers=headers), 200) == first
    assert len(first["files"]) == 1 and len(writes) == 1
    for changed in [
        ("different.csv", file[1], file[2]),
        (file[0], b"facility_id,name\nFAC-MAIN,Changed\n", file[2]),
        (file[0], file[1], "application/octet-stream"),
    ]:
        response = client.post(path, files={"file": changed}, headers=headers)
        assert response.status_code == 409 and response.json()["error"]["code"] == "idempotency_conflict"
    assert len(writes) == 1
    assert counts(client, "import", "import.file_uploaded")[1] == 1


def test_export_regeneration_retry_reuses_completed_artifact(client):
    from surge_api.db import Job

    context = setup_context(client)
    original = checked(
        client.post("/api/exports", json={"dataset_version_id": context["dataset"]["id"]}), 202
    )
    execute_job(original["id"], client.database_url)
    assert client.get("/api/exports/" + original["id"]).json()["status"] == "SUCCEEDED"
    headers = {"Idempotency-Key": "one-regenerated-export"}
    path = f"/api/exports/{original['id']}/regenerate"
    first = checked(client.post(path, headers=headers), 202)
    assert checked(client.post(path, headers=headers), 202) == first
    execute_job(first["id"], client.database_url)
    replay = checked(client.post(path, headers=headers), 202)
    assert replay["id"] == first["id"] and replay["status"] == "SUCCEEDED"
    assert (
        replay["artifact"]["object_key"]
        == client.get("/api/exports/" + first["id"]).json()["artifact"]["object_key"]
    )
    with client.app.state.Session() as session:
        assert session.scalar(select(func.count()).select_from(Job).where(Job.kind == "export")) == 2
        assert (
            session.scalar(
                select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "export.regenerated")
            )
            == 1
        )
    mismatch = client.post(f"/api/exports/{first['id']}/regenerate", headers=headers)
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"


def test_member_creation_retry_returns_original_public_member(client):
    setup_context(client)
    member = replay_creation(
        client,
        "/api/workspaces/workspace-main/members",
        {
            "username": "retry-member",
            "name": "Synthetic viewer",
            "role": "viewer",
            "password": "synthetic-test-password-only",
        },
        "member",
        "member.created",
    )
    assert "password_hash" not in member and "password_salt" not in member


def test_concurrent_upload_key_is_acquired_before_external_write(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from surge_api import main
    from surge_api.artifacts import ArtifactStore

    context = setup_context(client)
    stage = checked(client.post("/api/imports", json={"source_dataset_version_id": context["dataset"]["id"]}))
    barrier = Barrier(2)
    original_idempotent, original_write = main.idempotent, ArtifactStore.write
    writes = []

    def collide(session, user, operation, key, payload):
        previous = original_idempotent(session, user, operation, key, payload)
        if operation == "import-files" and not previous:
            barrier.wait(timeout=10)
        return previous

    def counted_write(self, *args, **kwargs):
        result = original_write(self, *args, **kwargs)
        writes.append(result["object_key"])
        return result

    monkeypatch.setattr(main, "idempotent", collide)
    monkeypatch.setattr(ArtifactStore, "write", counted_write)

    def send():
        app = create_app(client.database_url, seed=False, start_dispatcher=False)
        with TestClient(app) as c:
            c.cookies.update(client.cookies)
            return c.post(
                f"/api/imports/{stage['id']}/files",
                files={"file": ("one.csv", b"a,b\n1,2\n", "text/csv")},
                headers={"Idempotency-Key": "racing-upload"},
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda _: send(), range(2)))
    assert sorted(r.status_code for r in replies) == [200, 409]
    assert len(writes) == 1
    current = client.get(f"/api/imports/{stage['id']}").json()
    assert len(current["files"]) == 1 and current["files"][0]["object_key"] == writes[0]
    # The client retains the command key after the concurrent 409 and recovers the winner.
    recovered = checked(
        client.post(
            f"/api/imports/{stage['id']}/files",
            files={"file": ("one.csv", b"a,b\n1,2\n", "text/csv")},
            headers={"Idempotency-Key": "racing-upload"},
        ),
        200,
    )
    assert recovered["files"] == current["files"] and len(writes) == 1


@pytest.mark.parametrize("with_keys,maximum", [(True, 8192), (False, 8192), (True, 3072)])
def test_concurrent_distinct_uploads_append_and_share_quota(client, monkeypatch, with_keys, maximum):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from surge_api import main
    from surge_api.artifacts import ArtifactStore

    context = setup_context(client)
    stage = checked(client.post("/api/imports", json={"source_dataset_version_id": context["dataset"]["id"]}))
    monkeypatch.setenv("MAX_UPLOAD_BYTES", str(maximum))
    barrier = Barrier(2)
    original_idempotent, original_write = main.idempotent, ArtifactStore.write
    writes = []

    def collide(session, user, operation, key, payload):
        previous = original_idempotent(session, user, operation, key, payload)
        if operation == "import-files":
            barrier.wait(timeout=10)
        return previous

    def counted_write(self, *args, **kwargs):
        result = original_write(self, *args, **kwargs)
        writes.append(result["object_key"])
        return result

    monkeypatch.setattr(main, "idempotent", collide)
    monkeypatch.setattr(ArtifactStore, "write", counted_write)

    def send(index):
        app = create_app(client.database_url, seed=False, start_dispatcher=False)
        with TestClient(app) as c:
            c.cookies.update(client.cookies)
            return c.post(
                f"/api/imports/{stage['id']}/files",
                files={"file": (f"file-{index}.csv", b"a,b\n1,2\n" * 256, "text/csv")},
                headers={"Idempotency-Key": f"distinct-{index}"} if with_keys else {},
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(send, range(2)))
    expected = 1 if maximum < 4096 else 2
    assert sorted(r.status_code for r in replies) == ([200, 413] if expected == 1 else [200, 200])
    files = client.get(f"/api/imports/{stage['id']}").json()["files"]
    assert len(files) == len(writes) == expected
    assert {f["object_key"] for f in files} == set(writes)
    assert sum(f["byte_size"] for f in files) <= maximum


def test_manual_retry_replay_preserves_current_generation_and_status(client):
    from surge_api.db import Job

    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    run = checked(client.post("/api/run-groups", json={"scenario_id": scenario["id"]}), 202)
    with client.app.state.Session() as session:
        row = session.get(Job, run["id"])
        row.status = "FAILED"
        row.attempts = 3
        session.commit()
    path = f"/api/run-groups/{run['id']}/retry"
    headers = {"Idempotency-Key": "one-manual-retry"}
    first = checked(client.post(path, headers=headers), 202)
    assert checked(client.post(path, headers=headers), 202) == first
    for status in ["RUNNING", "SUCCEEDED"]:
        with client.app.state.Session() as session:
            row = session.get(Job, run["id"])
            row.status = status
            row.attempts = 4
            session.commit()
        replay = checked(client.post(path, headers=headers), 202)
        assert replay["status"] == status
        with client.app.state.Session() as session:
            row = session.get(Job, run["id"])
            assert row.result["retry_generation"] == {"number": 1, "attempt_base": 3}
            assert row.attempts == 4
    assert counts(client, "scenario", "run.retried")[1] == 1
    other = checked(client.post("/api/run-groups", json={"scenario_id": scenario["id"]}), 202)
    mismatch = client.post(f"/api/run-groups/{other['id']}/retry", headers=headers)
    assert mismatch.status_code == 409 and mismatch.json()["error"]["code"] == "idempotency_conflict"
