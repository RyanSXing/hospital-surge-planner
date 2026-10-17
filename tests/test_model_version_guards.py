"""Old results stay readable; missing trajectories cannot be recomputed by a new model."""

# ruff: noqa: F811 -- shared pytest fixture is injected by name.
import copy
import io
import json
import zipfile

import pytest
from sqlalchemy import func, select
from surge_api import worker
from surge_api.db import AuditEvent, Document, Idempotency, Job
from surge_api.model_versions import ModelVersionMismatch
from surge_engine.common import MODEL_VERSION
from test_api import client, create_short_scenario, setup_context  # noqa: F401


def queued_run(client):
    scenario = create_short_scenario(client, setup_context(client), replications=2)
    return client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()["id"]


def legacy(client, identity, version):
    with client.app.state.Session.begin() as session:
        row = session.get(Job, identity)
        payload = copy.deepcopy(row.payload)
        if version is None:
            payload.pop("model_version", None)
        else:
            payload["model_version"] = version
        row.payload = payload
        if row.result.get("manifest"):
            row.result = {**row.result, "manifest": {**row.result["manifest"], "model_version": version}}


def snapshot(client, identity):
    with client.app.state.Session() as session:
        row = session.get(Job, identity)
        return copy.deepcopy(
            {
                "status": row.status,
                "payload": row.payload,
                "result": row.result,
                "attempts": row.attempts,
                "lease_until": row.lease_until,
                "cancelled": row.cancelled,
                "jobs": session.scalar(select(func.count()).select_from(Job)),
                "documents": session.scalar(select(func.count()).select_from(Document)),
                "audit": session.scalar(select(func.count()).select_from(AuditEvent)),
                "idempotency": session.scalar(select(func.count()).select_from(Idempotency)),
            }
        )


def conflict(response):
    assert response.status_code == 409, response.text
    detail = response.json()["error"]
    assert detail["code"] == "MODEL_VERSION_MISMATCH"
    assert "Clone" in detail["message"] and "current model" in detail["message"]
    assert detail["fields"][0]["current_model_version"] == MODEL_VERSION


@pytest.mark.parametrize("version", ["unsupported-old-model", None])
def test_retry_rejects_old_or_unknown_model_without_mutating_frozen_job(client, version):
    identity = queued_run(client)
    client.post(f"/api/run-groups/{identity}/cancel")
    legacy(client, identity, version)
    before = snapshot(client, identity)
    conflict(client.post(f"/api/run-groups/{identity}/retry", headers={"Idempotency-Key": "old-retry"}))
    assert snapshot(client, identity) == before


@pytest.mark.parametrize("version", ["unsupported-old-model", None])
def test_trace_and_export_regeneration_guards_preserve_existing_artifacts(client, version):
    identity = queued_run(client)
    worker.execute_job(identity, client.database_url)
    completed = client.get(f"/api/run-groups/{identity}").json()
    assert completed["status"] == "SUCCEEDED", completed
    selected = completed["selected_replication_id"]
    replications = client.get(f"/api/run-groups/{identity}/replications").json()["items"]
    untraced = next(row["id"] for row in replications if row["id"] != selected)
    pending_export = client.post(
        "/api/exports", json={"run_group_id": identity, "replication_id": untraced}
    ).json()
    legacy(client, identity, version)
    before = snapshot(client, identity)
    conflict(client.post(f"/api/runs/{untraced}/trace"))
    conflict(client.post("/api/exports", json={"run_group_id": identity, "replication_id": untraced}))
    conflict(client.post(f"/api/exports/{pending_export['id']}/regenerate"))
    assert snapshot(client, identity) == before
    # Existing trace lookup and reads do not invoke the current simulation.
    ready = client.post(f"/api/runs/{selected}/trace")
    assert ready.status_code == 202 and ready.json()["ready"] is True
    assert client.get(f"/api/run-groups/{identity}/metrics").status_code == 200
    assert client.get(f"/api/runs/{selected}/events").status_code == 200
    for include_events, replication_id in ((True, selected), (False, untraced)):
        response = client.post(
            "/api/exports",
            json={
                "run_group_id": identity,
                "replication_id": replication_id,
                "include_events": include_events,
            },
        )
        assert response.status_code == 202, response.text
        export_id = response.json()["id"]
        worker.execute_job(export_id, client.database_url)
        exported = client.get(f"/api/exports/{export_id}").json()
        assert exported["status"] == "SUCCEEDED", exported
        download = client.get(exported["download_url"])
        assert download.status_code == 200
        with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
            assert json.loads(archive.read("model-manifest.json"))["model_version"] == version
            assert ("events.csv" in archive.namelist()) is include_events
    assert client.get(f"/api/run-groups/{identity}").json()["input_sha256"] == completed["input_sha256"]


@pytest.mark.parametrize("kind", ["run", "trace", "export"])
@pytest.mark.parametrize("version", ["unsupported-old-model", None])
def test_worker_refuses_queued_legacy_recomputation_before_any_engine_call(
    client, monkeypatch, kind, version
):
    identity = queued_run(client)
    if kind != "run":
        worker.execute_job(identity, client.database_url)
        completed = client.get(f"/api/run-groups/{identity}").json()
        selected = completed["selected_replication_id"]
        rows = client.get(f"/api/run-groups/{identity}/replications").json()["items"]
        untraced = next(row["id"] for row in rows if row["id"] != selected)
        if kind == "trace":
            target = client.post(f"/api/runs/{untraced}/trace").json()["id"]
        else:
            target = client.post(
                "/api/exports", json={"run_group_id": identity, "replication_id": untraced}
            ).json()["id"]
    else:
        target = identity
    legacy(client, identity, version)
    frozen = snapshot(client, identity)

    def unexpected(*args, **kwargs):
        raise AssertionError("A mismatched model reached simulation or new artifact publication")

    monkeypatch.setattr(worker, "timed_replication", unexpected)
    monkeypatch.setattr("surge_engine.run_replication", unexpected)
    monkeypatch.setattr(worker.ArtifactStore, "write", unexpected)
    worker.execute_job(target, client.database_url)
    with client.app.state.Session() as session:
        rejected = session.get(Job, target)
        assert rejected.status == "FAILED"
        assert "Clone" in rejected.error and "current model" in rejected.error
        assert rejected.result["retry"]["error_category"] == "ModelVersionMismatch"
        assert rejected.result["retry"]["automatic"] is False
        assert "artifact" not in rejected.result and "trace_artifact" not in rejected.result
        parent = session.get(Job, identity)
        assert parent.payload == frozen["payload"]
        if target != identity:
            assert parent.result == frozen["result"]
        if kind == "run":
            assert not session.scalar(
                select(Document).where(
                    Document.kind == "replication", Document.data["run_group_id"].as_string() == target
                )
            )


def test_current_version_remains_recomputable():
    from surge_api.model_versions import require_current_model

    require_current_model({"model_version": MODEL_VERSION})
    with pytest.raises(ModelVersionMismatch):
        require_current_model({})


@pytest.mark.parametrize("version", ["1.0.0", None])
@pytest.mark.parametrize("strategy", ["selected_replication", "paired_ensemble"])
def test_historical_parent_update_branch_is_rejected_before_mutation(client, version, strategy):
    identity = queued_run(client)
    worker.execute_job(identity, client.database_url)
    parent = client.get(f"/api/run-groups/{identity}").json()
    source = {"parent_run_group_id": identity, "branch_strategy": strategy}
    report = {
        "scenario_id": parent["scenario_id"],
        "state_origin": "simulation_branch",
        "type": "capacity_change",
        "effective_at": "2026-10-16T06:00:00Z",
        "payload": {"unit_id": "UNIT-WARD-A", "enabled_capacity": 30},
        "parent_run_group_id": identity,
    }
    if strategy == "selected_replication":
        report["replication_id"] = parent["selected_replication_id"]
        source["source_replication_id"] = parent["selected_replication_id"]
    saved = client.post("/api/updates", json=report)
    assert saved.status_code == 201, saved.text
    unbound = client.post(
        "/api/updates",
        json={
            key: value
            for key, value in report.items()
            if key not in {"parent_run_group_id", "replication_id"}
        },
    )
    assert unbound.status_code == 201, unbound.text
    legacy(client, identity, version)
    before = snapshot(client, identity)
    update_history = client.get("/api/updates", params={"scenario_id": parent["scenario_id"]}).json()
    conflict(client.post("/api/updates", json=report))
    for event in (saved.json(), unbound.json()):
        conflict(client.post(f"/api/updates/{event['id']}/apply", json={"source": source}))
    assert snapshot(client, identity) == before
    assert client.get("/api/updates", params={"scenario_id": parent["scenario_id"]}).json() == update_history
    assert client.get(f"/api/runs/{parent['selected_replication_id']}/state").status_code == 200
    legacy(client, identity, MODEL_VERSION)
    applied = client.post(f"/api/updates/{saved.json()['id']}/apply", json={"source": source})
    assert applied.status_code == 200, applied.text
    assert applied.json()["run"]["status"] == "QUEUED"


def test_legacy_branch_clone_becomes_fresh_current_run_and_keeps_origin(client, monkeypatch):
    identity = queued_run(client)
    worker.execute_job(identity, client.database_url)
    parent = client.get(f"/api/run-groups/{identity}").json()
    report = {
        "scenario_id": parent["scenario_id"],
        "state_origin": "simulation_branch",
        "type": "capacity_change",
        "effective_at": "2026-10-16T06:00:00Z",
        "payload": {"unit_id": "UNIT-WARD-A", "enabled_capacity": 30},
        "replication_id": parent["selected_replication_id"],
    }
    saved = client.post("/api/updates", json=report).json()
    branch = client.post(f"/api/updates/{saved['id']}/apply", json={"enqueue": False}).json()["scenario"]
    # A queued child cannot bypass the same guard after its parent model changes.
    queued_child = client.post("/api/run-groups", json={"scenario_id": branch["id"]}).json()["id"]
    current_copy = client.post(f"/api/scenarios/{branch['id']}/clone").json()
    assert current_copy["branch_strategy"] == branch["branch_strategy"]
    legacy(client, identity, "1.0.0")
    before = snapshot(client, identity)
    conflict(client.post("/api/run-groups", json={"scenario_id": branch["id"]}))
    assert snapshot(client, identity) == before

    def unexpected(*args, **kwargs):
        raise AssertionError("Historical branch reached current-model computation")

    original_compute = worker.timed_replication
    monkeypatch.setattr(worker, "timed_replication", unexpected)
    worker.execute_job(queued_child, client.database_url)
    with client.app.state.Session() as session:
        assert session.get(Job, queued_child).status == "FAILED"
        assert session.get(Job, queued_child).result["retry"]["error_category"] == "ModelVersionMismatch"
    child_before = snapshot(client, queued_child)
    conflict(client.post(f"/api/run-groups/{queued_child}/retry"))
    assert snapshot(client, queued_child) == child_before
    before = snapshot(client, identity)
    conflict(
        client.post(
            "/api/comparisons",
            json={
                "scenario_id": branch["id"],
                "replications": 2,
                "plans": [{"name": "No change", "interventions": []}],
            },
        )
    )
    assert snapshot(client, identity) == before
    monkeypatch.setattr(worker, "timed_replication", original_compute)
    cloned = client.post(f"/api/scenarios/{branch['id']}/clone")
    assert cloned.status_code == 201, cloned.text
    fresh = cloned.json()
    for field in (
        "dataset_version_id",
        "start_at",
        "end_at",
        "horizon_calendar_days",
        "base_seed",
        "conditions",
        "interventions",
        "updates",
    ):
        assert fresh.get(field) == branch.get(field)
    for field in (
        "parent_run_group_id",
        "parent_replication_id",
        "branch_strategy",
        "branch_at",
        "branch_replication_index",
        "measurement_start_at",
        "conditional_label",
        "state_origin",
    ):
        assert field not in fresh
    assert fresh["model_migration"]["source_parent_run_group_id"] == identity
    assert fresh["model_migration"]["historical_branch_context"]["branch_at"] == branch["branch_at"]
    assert fresh["parent_scenario_id"] == branch["id"]
    accepted = client.post("/api/run-groups", json={"scenario_id": fresh["id"]})
    assert accepted.status_code == 202, accepted.text
    with client.app.state.Session() as session:
        assert session.get(Job, accepted.json()["id"]).payload["model_version"] == MODEL_VERSION
    worker.execute_job(accepted.json()["id"], client.database_url)
    assert client.get(f"/api/run-groups/{accepted.json()['id']}").json()["status"] == "SUCCEEDED"
    baseline_clone = client.post(f"/api/scenarios/{parent['scenario_id']}/clone").json()
    assert "model_migration" not in baseline_clone
    assert client.post("/api/run-groups", json={"scenario_id": baseline_clone["id"]}).status_code == 202
    # A real complete reset may read an old parent trace without replaying its model.
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": parent["scenario_id"],
            "state_origin": "observed_reset",
            "type": "census_replacement",
            "effective_at": parent["start_at"],
            "payload": {"observed_dataset_version_id": branch["dataset_version_id"]},
        },
    )
    assert event.status_code == 201, event.text
    applied_reset = client.post(
        f"/api/updates/{event.json()['id']}/apply",
        json={
            "source": {
                "observed_dataset_version_id": branch["dataset_version_id"],
                "parent_run_group_id": identity,
                "reference_replication_id": parent["selected_replication_id"],
            },
        },
    )
    assert applied_reset.status_code == 200, applied_reset.text
    reset = applied_reset.json()["scenario"]
    worker.execute_job(applied_reset.json()["run_group_id"], client.database_url)
    assert (
        client.get(f"/api/run-groups/{applied_reset.json()['run_group_id']}").json()["status"] == "SUCCEEDED"
    )
    reset_clone = client.post(f"/api/scenarios/{reset['id']}/clone").json()
    assert reset_clone["state_origin"] == "observed_reset"
    assert reset_clone["branch_at"] == parent["start_at"]
    assert reset_clone["reconciliation"] == reset["reconciliation"]
    assert "model_migration" not in reset_clone


def test_forged_reset_provenance_is_rejected_at_create_patch_inline_run_and_worker(client, monkeypatch):
    identity = queued_run(client)
    worker.execute_job(identity, client.database_url)
    parent = client.get(f"/api/run-groups/{identity}").json()
    legacy(client, identity, "1.0.0")
    scenario = client.get(f"/api/scenarios/{parent['scenario_id']}").json()
    forged = {
        "state_origin": "observed_reset",
        "parent_run_group_id": identity,
        "branch_strategy": "selected_replication",
        "branch_replication_index": 0,
        "branch_at": parent["start_at"],
    }
    before = snapshot(client, identity)
    for response in (
        client.post("/api/scenarios", json={"dataset_version_id": scenario["dataset_version_id"], **forged}),
        client.patch(
            f"/api/scenarios/{scenario['id']}", json=forged, headers={"If-Match": str(scenario["revision"])}
        ),
        client.post(
            "/api/run-groups",
            json={"scenario": {"dataset_version_id": scenario["dataset_version_id"], **forged}},
        ),
    ):
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "SERVER_OWNED_PROVENANCE"
    assert snapshot(client, identity) == before
    # An already-persisted forged draft and queued job are also rejected defensively.
    legacy(client, identity, MODEL_VERSION)
    queued_child = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()["id"]
    with client.app.state.Session.begin() as session:
        draft = session.get(Document, scenario["id"])
        draft.data = {**draft.data, **forged}
        child = session.get(Job, queued_child)
        child.payload = {**child.payload, "scenario": {**child.payload["scenario"], **forged}}
    before = snapshot(client, identity)
    rejected = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
    assert rejected.status_code == 422 and rejected.json()["error"]["code"] == "INCOMPLETE_RESET_SNAPSHOT"
    assert snapshot(client, identity) == before

    def unexpected(*args, **kwargs):
        raise AssertionError("Forged reset reached the simulation")

    monkeypatch.setattr(worker, "timed_replication", unexpected)
    worker.execute_job(queued_child, client.database_url)
    with client.app.state.Session() as session:
        child = session.get(Job, queued_child)
        assert child.status == "FAILED"
        assert child.result["retry"]["error_category"] == "InvalidResetProvenance"
