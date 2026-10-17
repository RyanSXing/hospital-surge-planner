"""Reported batches preserve and validate explicit conditional resource mixtures."""

import copy

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from surge_api.db import Job
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.schemas import OperationalPayload
from surge_api.updates import payload_errors
from surge_api.worker import execute_job
from surge_engine import generate_dataset


@pytest.fixture(scope="module")
def dataset():
    return generate_dataset(days=2)


def payload(**changes):
    return {
        "facility_id": "FAC-MAIN",
        "entry_stream_id": "ED_MAIN",
        "count": 7,
        "spread_minutes": 0,
        "care_mix": {"ward": 1},
        "resource_profile_mix": {"ward": {"RP-WARD-OXYGEN": 1}},
        **changes,
    }


def record(data):
    return {"type": "arrival_batch", "effective_at": "2026-10-16T05:00:00Z", "payload": data}


@pytest.mark.parametrize(
    "mix",
    [
        {},
        [],
        {"ward": []},
        {"ward": {}},
        {"clinic": {"RP-CLINIC-BASIC": 1}},
        {"ward": {"MISSING-PROFILE": 1}},
        {"ward": {"RP-ICU-VENTILATED": 1}},
        {"ward": {"RP-WARD-BASIC": -0.1, "RP-WARD-OXYGEN": 1.1}},
        {"ward": {"RP-WARD-BASIC": 0.5}},
        {"ward": {"RP-WARD-BASIC": True}},
        {"ward": {"RP-WARD-BASIC": float("nan")}},
        {"ward": {"RP-WARD-BASIC": float("inf")}},
    ],
)
def test_invalid_profile_mixtures_are_field_errors(dataset, mix):
    errors = payload_errors(record(payload(resource_profile_mix=mix)), dataset)
    assert errors and all(e["field"].startswith("payload.resource_profile_mix") for e in errors)


def test_partial_and_omitted_maps_retain_legacy_fallback(dataset):
    assert payload_errors(record(payload()), dataset) == []
    legacy = payload()
    legacy.pop("resource_profile_mix")
    assert payload_errors(record(legacy), dataset) == []
    assert (
        payload_errors(record(payload(resource_profile_mix={"discharge": {"RP-ED-BASIC": 1}})), dataset) == []
    )
    with pytest.raises(ValidationError):
        OperationalPayload.model_validate(payload(resource_profile_mix={"ward": {"RP-WARD-BASIC": True}}))
    schema = OperationalPayload.model_json_schema()["properties"]["resource_profile_mix"]
    assert schema["anyOf"][0]["additionalProperties"]["additionalProperties"]["minimum"] == 0


@pytest.fixture(scope="module")
def client(tmp_path_factory, dataset):
    root = tmp_path_factory.mktemp("reported-resource-mix")
    patch = pytest.MonkeyPatch()
    patch.setenv("APP_ENV", "development")
    patch.setenv("DEMO_MODE", "true")
    patch.setenv("ARTIFACT_LOCAL_DIR", str(root / "artifacts"))
    patch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(root / "test.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    data = normalize_dataset(dataset)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", data)
    with TestClient(app, raise_server_exceptions=False) as value:
        value.database_url = url
        scenario = value.post(
            "/api/scenarios",
            json={
                "name": "Reported resource mix",
                "dataset_version_id": data["id"],
                "horizon_calendar_days": 1,
                "replications": 1,
            },
        )
        assert scenario.status_code == 201, scenario.text
        value.scenario = scenario.json()
        yield value
    app.state.engine.dispose()
    patch.undo()


def request(client, data):
    return {**record(data), "scenario_id": client.scenario["id"], "state_origin": "simulation_branch"}


@pytest.mark.parametrize(
    "data,field",
    [
        (payload(resource_profile_mix={"ward": {"RP-ICU-VENTILATED": 1}}), "resource_profile_mix"),
        (payload(resource_profile_mix={"ward": {"MISSING-PROFILE": 1}}), "resource_profile_mix"),
        (payload(facility_id="FAC-EAST"), "facility_id"),
    ],
)
def test_invalid_report_never_records_or_queues(client, data, field):
    before = client.get("/api/updates").json()["total"]
    response = client.post("/api/updates", json=request(client, data))
    assert response.status_code == 422, response.text
    assert any(field in issue["field"] for issue in response.json()["error"]["fields"])
    assert client.get("/api/updates").json()["total"] == before
    with client.app.state.Session() as session:
        assert session.scalars(select(Job)).all() == []


def test_report_correction_and_branch_preserve_their_own_resource_mixtures(client):
    original_payload = payload()
    response = client.post("/api/updates", json=request(client, original_payload))
    assert response.status_code == 201, response.text
    original = response.json()
    assert original["payload"] == original_payload
    replacement = copy.deepcopy(original_payload)
    replacement["resource_profile_mix"]["ward"] = {"RP-WARD-BASIC": 1}
    corrected = client.post(
        f"/api/updates/{original['id']}/correct",
        json={"payload": replacement, "reason": "Reconciled reported equipment needs"},
    )
    assert corrected.status_code == 201, corrected.text
    correction = corrected.json()
    assert correction["payload"] == replacement
    assert correction["supersedes_update_id"] == original["id"]
    listed = {row["id"]: row for row in client.get("/api/updates").json()["items"]}
    assert listed[original["id"]]["payload"] == original_payload
    run = client.post("/api/run-groups", json={"scenario_id": client.scenario["id"]}).json()
    execute_job(run["id"], client.database_url)
    completed = client.get("/api/run-groups/" + run["id"]).json()
    assert completed["status"] == "SUCCEEDED", completed
    applied = client.post(
        f"/api/updates/{correction['id']}/apply",
        json={
            "source": {"parent_run_group_id": run["id"], "branch_strategy": "paired_ensemble"},
            "enqueue": False,
        },
    )
    assert applied.status_code == 200, applied.text
    event = next(
        event for event in applied.json()["scenario"]["updates"] if event["update_id"] == correction["id"]
    )
    assert event["payload"]["resource_profile_mix"] == replacement["resource_profile_mix"]
    assert event["payload"]["facility_id"] == "FAC-MAIN"
