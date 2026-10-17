"""Inspector reports validate against their authorized historical run, not edited drafts."""

import pytest
from fastapi.testclient import TestClient
from surge_api.db import Document, Job
from surge_api.main import create_app
from surge_engine.common import MODEL_VERSION


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    app = create_app("sqlite:///" + str(tmp_path / "updates.db"), seed=False, start_dispatcher=False)
    with app.state.Session.begin() as session:
        for suffix in ("old", "new"):
            session.add(
                Document(
                    id="dataset_" + suffix,
                    workspace_id="workspace-main",
                    kind="dataset",
                    data={
                        "units": [
                            {"unit_id": "WARD-" + suffix, "physical_capacity": 40, "enabled_capacity": 40}
                        ],
                    },
                )
            )
        session.add(
            Document(
                id="scenario_a",
                workspace_id="workspace-main",
                kind="scenario",
                data={
                    "name": "Edited draft",
                    "replications": 1,
                    "dataset_version_id": "dataset_new",
                    "start_at": "2026-11-01T05:00:00Z",
                },
            )
        )
        for identity, workspace, scenario, status in (
            ("run_old", "workspace-main", "scenario_a", "SUCCEEDED"),
            ("run_other", "workspace-main", "scenario_other", "SUCCEEDED"),
            ("run_private", "workspace-other", "scenario_a", "SUCCEEDED"),
            ("run_running", "workspace-main", "scenario_a", "RUNNING"),
        ):
            session.add(
                Job(
                    id=identity,
                    workspace_id=workspace,
                    kind="run",
                    status=status,
                    payload={
                        "model_version": MODEL_VERSION,
                        "scenario_id": scenario,
                        "dataset_version_id": "dataset_old",
                        "scenario_revision_id": "revision_old",
                        "scenario": {"start_at": "2026-10-16T05:00:00Z", "dataset_version_id": "dataset_old"},
                    },
                )
            )
            session.add(
                Document(
                    id=identity + "_rep",
                    workspace_id=workspace,
                    kind="replication",
                    data={"run_group_id": identity},
                )
            )
    with TestClient(app) as value:
        yield value
    app.state.engine.dispose()


def report(**extra):
    return {
        "scenario_id": "scenario_a",
        "type": "capacity_change",
        "state_origin": "simulation_branch",
        "effective_at": "2026-10-16T06:01:01.250Z",
        "payload": {"unit_id": "WARD-old", "enabled_capacity": 30},
        **extra,
    }


@pytest.mark.parametrize("source", [{"replication_id": "run_old_rep"}, {"parent_run_group_id": "run_old"}])
def test_historical_report_uses_frozen_dataset_and_start_after_draft_switch(client, source):
    saved = client.post("/api/updates", json=report(**source))
    assert saved.status_code == 201, saved.text
    assert saved.json()["payload"]["unit_id"] == "WARD-old"
    assert saved.json()["effective_at"] == "2026-10-16T06:01:01.250Z"
    wrong_inventory = client.post(
        "/api/updates", json=report(**source, payload={"unit_id": "WARD-new", "enabled_capacity": 10})
    )
    assert wrong_inventory.status_code == 422
    assert any(error["field"] == "payload.unit_id" for error in wrong_inventory.json()["error"]["fields"])
    with client.app.state.Session() as session:
        assert session.get(Document, "scenario_a").data["dataset_version_id"] == "dataset_new"
        assert session.get(Job, "run_old").payload["dataset_version_id"] == "dataset_old"


@pytest.mark.parametrize(
    "source,status",
    [
        ({"replication_id": "run_other_rep"}, 422),
        ({"parent_run_group_id": "run_other"}, 422),
        ({"replication_id": "run_private_rep"}, 404),
        ({"parent_run_group_id": "run_private"}, 404),
        ({"replication_id": "run_running_rep"}, 422),
        ({"replication_id": "run_old_rep", "parent_run_group_id": "run_other"}, 422),
    ],
)
def test_historical_report_requires_same_scenario_workspace_and_completed_parent(client, source, status):
    response = client.post("/api/updates", json=report(**source))
    assert response.status_code == status, response.text


@pytest.mark.parametrize("source", [{"parent_run_group_id": "run_old"}, {"replication_id": "run_old_rep"}])
def test_report_cannot_be_applied_against_another_parent(client, source):
    saved = client.post("/api/updates", json=report(**source))
    assert saved.status_code == 201, saved.text
    response = client.post(
        f"/api/updates/{saved.json()['id']}/apply",
        json={
            "source": {"parent_run_group_id": "run_other", "branch_strategy": "paired_ensemble"},
            "enqueue": False,
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "INVALID_BRANCH_SOURCE"


def test_unsourced_draft_report_keeps_current_dataset_validation(client):
    response = client.post(
        "/api/updates",
        json=report(
            effective_at="2026-11-01T05:00:00Z", payload={"unit_id": "WARD-new", "enabled_capacity": 20}
        ),
    )
    assert response.status_code == 201, response.text
