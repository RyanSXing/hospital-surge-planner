"""Current operations semantics do not rewrite supported historical runs."""

import copy
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from surge_api import worker
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job, digest
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.model_versions import ModelVersionMismatch, execution_scenario, require_current_model
from surge_engine import generate_dataset, run_replication
from surge_engine.common import MODEL_VERSION, dt
from surge_engine.hospital_operations import OPERATIONS_MODEL_VERSION, SUPPORTED_OPERATIONS_MODEL_VERSIONS


def operations():
    return {
        "severity_mix": {
            "low": {"percentage": 0, "average_stay_hours": 24},
            "medium": {"percentage": 0, "average_stay_hours": 72},
            "high": {"percentage": 100, "average_stay_hours": 336},
        }
    }


@pytest.fixture
def ops_client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(tmp_path / "operations-versions.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    dataset = normalize_dataset(generate_dataset("hospital_baseline", days=3))
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url = url
        client.dataset = dataset
        yield client
    app.state.engine.dispose()


def enqueue(client, *, version=None, scenario_id=None):
    if scenario_id is None:
        response = client.post(
            "/api/scenarios",
            json={
                "name": "Frozen operations model",
                "dataset_version_id": client.dataset["id"],
                "horizon_calendar_days": 2,
                "replications": 2,
                "hospital_operations": operations(),
            },
        )
        assert response.status_code == 201, response.text
        scenario_id = response.json()["id"]
    response = client.post("/api/run-groups", json={"scenario_id": scenario_id})
    assert response.status_code == 202, response.text
    run = response.json()
    if version is not None:
        # Represent a historically frozen job, not a client-controlled override.
        with client.app.state.Session.begin() as session:
            row = session.get(Job, run["id"])
            row.payload = {**row.payload, "hospital_operations_model_version": version}
    return client.get(f"/api/run-groups/{run['id']}").json()


def complete(client, identity):
    worker.execute_job(identity, client.database_url)
    with client.app.state.Session() as session:
        row = session.get(Job, identity)
        assert row.status == "SUCCEEDED", row.result
        kind = row.kind
        value = {"id": row.id, "status": row.status, "result": copy.deepcopy(row.result)}
    if kind == "run":
        return client.get(f"/api/run-groups/{identity}").json()
    if kind == "export":
        return client.get(f"/api/exports/{identity}").json()
    return value


def payload(client, identity):
    with client.app.state.Session() as session:
        return copy.deepcopy(session.get(Job, identity).payload)


def clinical_events(trace):
    events = [
        {
            key: value
            for key, value in row.items()
            if key not in {"run_group_id", "replication_id", "replication_index", "event_id"}
        }
        for row in trace["events"]
    ]
    # Stored/exported traces use JSON arrays; run/scenario identity is not clinical history.
    return json.loads(json.dumps(events))


def assert_clinical_events_match(actual, expected):
    actual, expected = clinical_events(actual), clinical_events(expected)
    for index, (left, right) in enumerate(zip(actual, expected)):
        differences = {
            key: (left.get(key), right.get(key))
            for key in left.keys() | right.keys()
            if left.get(key) != right.get(key)
        }
        assert not differences, (index, differences)
    assert len(actual) == len(expected)


def test_new_runs_freeze_current_version_and_keep_dispatch_out_of_public_inputs(ops_client, monkeypatch):
    client = ops_client
    run = enqueue(client)
    frozen = payload(client, run["id"])
    assert frozen["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    assert run["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    assert "_hospital_operations_model_version" not in frozen["scenario"]
    assert digest({"dataset": client.dataset, "scenario": frozen["scenario"]}) == frozen["input_sha256"]
    seen = []
    original = worker.timed_replication

    def checked(dataset, scenario, *args, **kwargs):
        seen.append(scenario.get("_hospital_operations_model_version"))
        return original(dataset, scenario, *args, **kwargs)

    monkeypatch.setattr(worker, "timed_replication", checked)
    finished = complete(client, run["id"])
    assert seen and set(seen) == {OPERATIONS_MODEL_VERSION}
    assert payload(client, run["id"]) == frozen
    assert "_hospital_operations_model_version" not in finished["scenario_context"]
    with client.app.state.Session() as session:
        stored = session.get(Job, run["id"])
        inputs = ArtifactStore().get_json(stored.result["inputs_artifact"])
        assert inputs["scenario"] == frozen["scenario"]
        assert digest(inputs) == frozen["input_sha256"]
        assert stored.result["manifest"]["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    metrics = client.get(f"/api/run-groups/{run['id']}/metrics").json()
    assert metrics["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    assert metrics["context"]["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION


@pytest.mark.parametrize("historical_version", ["1.0", "1.1"])
def test_frozen_trace_and_export_regeneration_preserve_historical_version(
    ops_client, monkeypatch, historical_version
):
    client = ops_client
    old = complete(client, enqueue(client, version=historical_version)["id"])
    frozen = payload(client, old["id"])
    rows = client.get(f"/api/run-groups/{old['id']}/replications").json()["items"]
    other = next(row for row in rows if row["id"] != old["selected_replication_id"])
    assert client.get(f"/api/runs/{other['id']}/trace").json()["ready"] is False
    with client.app.state.Session() as session:
        before_result = copy.deepcopy(session.get(Job, old["id"]).result)
    expected = run_replication(
        client.dataset, execution_scenario(frozen), other["replication_index"], keep_trace=True
    )
    assert expected["scalar_metrics"] == other["scalar_metrics"]
    # The export path must itself reconstruct an absent trace under its saved version.
    seen = []
    import surge_engine

    original = surge_engine.run_replication

    def checked(dataset, scenario, *args, **kwargs):
        seen.append(scenario.get("_hospital_operations_model_version"))
        return original(dataset, scenario, *args, **kwargs)

    monkeypatch.setattr(surge_engine, "run_replication", checked)
    response = client.post("/api/exports", json={"run_group_id": old["id"], "replication_id": other["id"]})
    assert response.status_code == 202, response.text
    exported = complete(client, response.json()["id"])
    assert seen == [historical_version]
    downloaded = client.get(exported["download_url"])
    assert downloaded.status_code == 200
    with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
        events = [json.loads(line) for line in archive.read("events.jsonl").splitlines()]
        assert_clinical_events_match({"events": events}, expected)
        assert (
            json.loads(archive.read("model-manifest.json"))["hospital_operations_model_version"]
            == historical_version
        )
    response = client.post(f"/api/runs/{other['id']}/trace")
    assert response.status_code == 202, response.text
    complete(client, response.json()["id"])
    assert seen == [historical_version, historical_version]
    with client.app.state.Session() as session:
        parent = session.get(Job, old["id"])
        trace = ArtifactStore().get_json(session.get(Document, other["id"]).data["trace_artifact"])
        assert trace["hospital_operations_model_version"] == historical_version
        assert_clinical_events_match(trace, expected)
        assert parent.payload == frozen
        assert parent.result == before_result
    # The ordinary scenario remains editable/rerunnable under current semantics.
    assert (
        enqueue(client, scenario_id=old["scenario_id"])["hospital_operations_model_version"]
        == OPERATIONS_MODEL_VERSION
    )


@pytest.mark.parametrize("version", [None, "unknown", "1.999", {"invalid": "version"}])
def test_unknown_or_missing_operations_version_is_rejected_before_computation(
    ops_client, monkeypatch, version
):
    client = ops_client
    run = enqueue(client)
    with client.app.state.Session.begin() as session:
        row = session.get(Job, run["id"])
        changed = copy.deepcopy(row.payload)
        if version is None:
            changed.pop("hospital_operations_model_version")
        else:
            changed["hospital_operations_model_version"] = version
        row.payload = changed

    def unexpected(*args, **kwargs):
        raise AssertionError("Unversioned operations reached simulation")

    monkeypatch.setattr(worker, "timed_replication", unexpected)
    worker.execute_job(run["id"], client.database_url)
    with client.app.state.Session() as session:
        rejected = session.get(Job, run["id"])
        assert rejected.status == "FAILED"
        assert rejected.result["retry"]["error_category"] == "ModelVersionMismatch"
        assert rejected.result["retry"]["automatic"] is False
    response = client.post(f"/api/run-groups/{run['id']}/retry")
    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "MODEL_VERSION_MISMATCH"


def branch_from(client, parent, *, enqueue_branch=True, origin="simulation_branch"):
    observed = origin == "observed_reset"
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": parent["scenario_id"],
            "state_origin": origin,
            "type": "census_replacement" if observed else "capacity_change",
            "effective_at": parent["start_at"] if observed else "2026-10-16T06:00:00Z",
            "payload": {"observed_dataset_version_id": client.dataset["id"]}
            if observed
            else {"unit_id": "UNIT-WARD-A", "enabled_capacity": 30},
        },
    )
    assert event.status_code == 201, event.text
    source = {"parent_run_group_id": parent["id"]}
    if observed:
        source.update(
            observed_dataset_version_id=client.dataset["id"],
            reference_replication_id=parent["selected_replication_id"],
        )
    else:
        source.update(
            branch_strategy="selected_replication", source_replication_id=parent["selected_replication_id"]
        )
    applied = client.post(
        f"/api/updates/{event.json()['id']}/apply", json={"source": source, "enqueue": enqueue_branch}
    )
    assert applied.status_code == 200, applied.text
    return applied.json()


@pytest.mark.parametrize("historical_version", ["1.0", "1.1"])
def test_inherited_history_retains_version_and_observed_reset_uses_current(ops_client, historical_version):
    client = ops_client
    old = complete(client, enqueue(client, version=historical_version)["id"])
    child = branch_from(client, old)
    frozen = payload(client, child["run_group_id"])
    assert frozen["hospital_operations_model_version"] == historical_version
    finished = complete(client, child["run_group_id"])
    assert finished["scenario_context"]["parent_run_group_id"] == old["id"]
    assert finished["hospital_operations_model_version"] == historical_version
    cutoff = dt("2026-10-16T06:00:00Z")
    with client.app.state.Session() as session:
        store = ArtifactStore()
        original = store.get_json(
            session.get(Document, old["selected_replication_id"]).data["trace_artifact"]
        )
        inherited = store.get_json(
            session.get(Document, finished["selected_replication_id"]).data["trace_artifact"]
        )
        assert [row for row in clinical_events(inherited) if dt(row["occurred_at"]) < cutoff] == [
            row for row in clinical_events(original) if dt(row["occurred_at"]) < cutoff
        ]
    reset = branch_from(client, old, origin="observed_reset")
    assert (
        payload(client, reset["run_group_id"])["hospital_operations_model_version"]
        == OPERATIONS_MODEL_VERSION
    )
    assert (
        complete(client, reset["run_group_id"])["hospital_operations_model_version"]
        == OPERATIONS_MODEL_VERSION
    )


def test_mismatched_inherited_version_is_rejected_at_api_and_worker(ops_client, monkeypatch):
    client = ops_client
    old = complete(client, enqueue(client, version="1.0")["id"])
    child = branch_from(client, old)
    identity = child["run_group_id"]
    assert client.post(f"/api/run-groups/{identity}/cancel").status_code == 200
    with client.app.state.Session.begin() as session:
        row = session.get(Job, identity)
        row.payload = {**row.payload, "hospital_operations_model_version": "1.1"}
    response = client.post(f"/api/run-groups/{identity}/retry")
    assert response.status_code == 409, response.text
    with client.app.state.Session.begin() as session:
        row = session.get(Job, identity)
        row.status, row.cancelled = "QUEUED", False

    def unexpected(*args, **kwargs):
        raise AssertionError("Mixed-model inherited history reached simulation")

    monkeypatch.setattr(worker, "timed_replication", unexpected)
    worker.execute_job(identity, client.database_url)
    with client.app.state.Session() as session:
        assert session.get(Job, identity).result["retry"]["error_category"] == "ModelVersionMismatch"


@pytest.mark.parametrize("historical_version", ["1.0", "1.1"])
def test_comparison_version_is_frozen_and_old_comparisons_are_projected_without_mutation(
    ops_client, historical_version
):
    client = ops_client
    source = enqueue(client)
    response = client.post(
        "/api/comparisons",
        json={
            "scenario_id": source["scenario_id"],
            "replications": 1,
            "plans": [{"name": "Same resources", "interventions": []}],
        },
    )
    assert response.status_code == 202, response.text
    current = response.json()
    assert current["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    with client.app.state.Session.begin() as session:
        comparison = session.get(Document, current["id"])
        historical = copy.deepcopy(comparison.data)
        historical.pop("hospital_operations_model_version")
        comparison.data = historical
        for plan in historical["plans"]:
            run = session.get(Job, plan["run_group_id"])
            run.payload = {**run.payload, "hospital_operations_model_version": historical_version}
    for plan in current["plans"]:
        complete(client, plan["run_group_id"])
    projected = client.get(f"/api/comparisons/{current['id']}")
    assert projected.status_code == 200, projected.text
    assert projected.json()["hospital_operations_model_version"] == historical_version
    assert all(
        plan["hospital_operations_model_version"]
        == plan["metrics"]["hospital_operations_model_version"]
        == historical_version
        for plan in projected.json()["plans"]
    )
    with client.app.state.Session() as session:
        assert session.get(Document, current["id"]).data == historical


@pytest.mark.parametrize("field", ["hospital_operations_model_version", "_hospital_operations_model_version"])
def test_clients_cannot_override_server_owned_operations_version(ops_client, field):
    response = ops_client.post(
        "/api/scenarios",
        json={
            "dataset_version_id": ops_client.dataset["id"],
            "hospital_operations": operations(),
            field: "1.0",
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "SERVER_OWNED_PROVENANCE"


@pytest.mark.parametrize("version", sorted(SUPPORTED_OPERATIONS_MODEL_VERSIONS))
def test_execution_dispatch_is_a_private_copy(version):
    frozen = {
        "model_version": MODEL_VERSION,
        "hospital_operations_model_version": version,
        "scenario": {"hospital_operations": operations()},
    }
    before = copy.deepcopy(frozen)
    require_current_model(frozen)
    execution = execution_scenario(frozen)
    assert execution["_hospital_operations_model_version"] == version
    assert frozen == before
    execution["hospital_operations"]["severity_mix"]["high"]["average_stay_hours"] = 100
    assert frozen == before
    with pytest.raises(ModelVersionMismatch):
        require_current_model({**frozen, "hospital_operations_model_version": None})
