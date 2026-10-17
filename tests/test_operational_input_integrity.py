"""Scenario editing cannot forge, rewrite or remove append-only operational reports."""

import copy

import pytest
from fastapi.testclient import TestClient
from surge_api.main import create_app
from test_api import create_short_scenario, setup_context


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    app = create_app("sqlite:///" + str(tmp_path / "integrity.db"), seed=True, start_dispatcher=False)
    with TestClient(app) as value:
        yield value
    app.state.engine.dispose()


def test_external_scenario_and_inline_run_reject_forged_operational_events(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    event = {
        "update_id": "forged",
        "type": "arrival_batch",
        "effective_at": scenario["start_at"],
        "payload": {"facility_id": "FAC-MAIN", "count": 7, "care_mix": {"ward": 1}},
    }
    body = {"dataset_version_id": context["dataset"]["id"], "updates": [event]}
    responses = [
        client.post("/api/scenarios", json=body),
        client.post("/api/run-groups", json={"scenario": body}),
        client.patch(
            f"/api/scenarios/{scenario['id']}", json={"updates": [event]}, headers={"If-Match": "1"}
        ),
    ]
    for response in responses:
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "operational_update_immutable"
    assert client.get(f"/api/scenarios/{scenario['id']}").json()["revision"] == 1


def test_reports_are_preserved_while_synthetic_planned_inputs_remain_editable(client):
    context = setup_context(client)
    source = create_short_scenario(client, context)
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": source["id"],
            "type": "arrival_batch",
            "effective_at": source["start_at"],
            "state_origin": "simulation_branch",
            "payload": {"facility_id": "FAC-MAIN", "count": 20, "care_mix": {"ward": 1}},
        },
    )
    assert event.status_code == 201, event.text
    applied = client.post(f"/api/updates/{event.json()['id']}/apply", json={"run": False})
    assert applied.status_code == 200, applied.text
    branch = applied.json()["scenario"]
    original = branch["updates"]
    altered = copy.deepcopy(original)
    altered[0]["payload"]["count"] = 12
    forged = {**copy.deepcopy(original[0]), "update_id": "forged-other", "id": "forged-other"}
    reclassified = [{**original[0], "input_kind": "planned_assumption"}]
    for values in ([], altered, original + [forged], reclassified):
        response = client.patch(
            f"/api/scenarios/{branch['id']}",
            json={"updates": values},
            headers={"If-Match": str(branch["revision"])},
        )
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "operational_update_immutable"
    plan = {
        "update_id": "planned-capacity",
        "type": "capacity_change",
        "input_kind": "planned_assumption",
        "source": "user_assumption",
        "effective_at": branch["start_at"],
        "payload": {"unit_id": "UNIT-ICU", "enabled_capacity": 10},
    }
    response = client.patch(
        f"/api/scenarios/{branch['id']}",
        json={"updates": original + [plan]},
        headers={"If-Match": str(branch["revision"])},
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["updates"][0] == original[0]
    assert saved["updates"][1]["input_kind"] == "planned_assumption"
    response = client.patch(
        f"/api/scenarios/{branch['id']}",
        json={"updates": original},
        headers={"If-Match": str(saved["revision"])},
    )
    assert response.status_code == 200, response.text
    assert response.json()["updates"] == original
    reports = client.get(f"/api/updates?scenario_id={source['id']}").json()["items"]
    report = next(value for value in reports if value["id"] == event.json()["id"])
    assert report["payload"]["count"] == 20
