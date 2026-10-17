"""Shared URL context loads one authorized dataset without the frontend waterfall."""

import pytest
from fastapi.testclient import TestClient
from surge_api.db import Document, Job
from surge_api.main import create_app

SUMMARY = "/api/workspaces/workspace-main/summary"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    app = create_app("sqlite:///" + str(tmp_path / "summary.db"), seed=False, start_dispatcher=False)
    with app.state.Session.begin() as session:
        for suffix, workspace, count in (
            ("a", "workspace-main", 1),
            ("b", "workspace-main", 2),
            ("private", "workspace-other", 3),
        ):
            session.add(
                Document(
                    id=f"dataset_{suffix}",
                    workspace_id=workspace,
                    kind="dataset",
                    data={
                        "name": suffix,
                        "snapshot_at": "2026-10-16T05:00:00Z",
                        "patients": [{"patient_id": f"P-{i}"} for i in range(count)],
                        "history": [{"private_history": suffix}],
                        "assignments": [],
                    },
                    created_at=f"2026-01-0{count}T00:00:00Z",
                )
            )
            session.add(
                Document(
                    id=f"scenario_{suffix}",
                    workspace_id=workspace,
                    kind="scenario",
                    data={"name": suffix, "dataset_version_id": f"dataset_{suffix}"},
                    created_at=f"2026-01-0{count}T00:00:00Z",
                )
            )
        session.add(
            Document(
                id="scenario_archived",
                workspace_id="workspace-main",
                kind="scenario",
                data={"name": "Archived", "dataset_version_id": "dataset_a", "archived": True},
                created_at="2026-01-09T00:00:00Z",
            )
        )
        for identity, suffix, day, extra in (
            ("run_a_old", "a", 1, {}),
            ("run_a", "a", 2, {}),
            ("run_b", "b", 3, {}),
            ("run_comparison", "a", 4, {"comparison_id": "comparison_a"}),
            ("run_legacy_comparison", "a", 5, {}),
            ("run_private", "private", 6, {}),
        ):
            session.add(
                Job(
                    id=identity,
                    workspace_id="workspace-other" if suffix == "private" else "workspace-main",
                    kind="run",
                    status="QUEUED",
                    total=1,
                    payload={
                        "scenario_id": f"scenario_{suffix}",
                        "dataset_version_id": f"dataset_{suffix}",
                        "scenario": {
                            "id": f"scenario_{suffix}",
                            "name": suffix,
                            "horizon_calendar_days": 30,
                            "timezone": "America/Chicago",
                            "conditions": [{"kind": "arrival_multiplier", "multiplier": 1.7}],
                            "updates": [
                                {
                                    "update_id": "frozen-equipment",
                                    "type": "equipment_change",
                                    "input_kind": "planned_assumption",
                                    "payload": {"quantity": 3},
                                }
                            ],
                        },
                        **extra,
                    },
                    created_at=f"2026-01-0{day}T00:00:00Z",
                )
            )
        session.add(
            Document(
                id="comparison_a",
                workspace_id="workspace-main",
                kind="comparison",
                data={"plans": [{"run_group_id": "run_legacy_comparison"}]},
            )
        )
        session.add(Job(id="export_a", workspace_id="workspace-main", kind="export", payload={}))
    with TestClient(app) as value:
        yield value
    app.state.engine.dispose()


def get_summary(client, **params):
    response = client.get(SUMMARY, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_default_and_scenario_context_preserve_lists_and_noncomparison_selection(client, monkeypatch):
    from surge_api import main

    original = get_summary(client)
    assert original["scenario"]["id"] == "scenario_b"
    assert original["run"]["id"] == "run_b"
    loaded = []
    real_snapshot = main.cached_dataset_snapshot

    def capture(session, identity, user):
        loaded.append(identity)
        return real_snapshot(session, identity, user)

    monkeypatch.setattr(main, "cached_dataset_snapshot", capture)
    selected = get_summary(client, scenario_id="scenario_a")
    assert loaded == ["dataset_a"], "The request must not first load the default dataset"
    assert selected["scenario"]["id"] == "scenario_a"
    assert selected["run"]["id"] == selected["run_group"]["id"] == "run_a"
    assert selected["dataset"]["id"] == "dataset_a"
    assert selected["inventory"]["patients"] == 1
    assert "history" not in selected["dataset"]
    assert selected["dataset"]["collection_counts"]["history"] == 1
    for field in ("datasets", "datasets_total", "datasets_next_cursor", "scenarios", "runs"):
        assert selected[field] == original[field]


def test_explicit_old_run_resolves_owner_and_frozen_dataset_after_draft_change(client):
    with client.app.state.Session.begin() as session:
        draft = session.get(Document, "scenario_a")
        draft.data = {
            **draft.data,
            "dataset_version_id": "dataset_b",
            "name": "Edited live draft",
            "horizon_calendar_days": 365,
            "timezone": "America/New_York",
            "conditions": [],
        }
        draft.revision += 1
        for index in range(25):
            session.add(
                Job(
                    id=f"run_recent_{index}",
                    workspace_id="workspace-main",
                    kind="run",
                    payload={"scenario_id": "scenario_b"},
                    created_at="2026-02-01T00:00:00Z",
                )
            )
    selected = get_summary(client, run_group_id="run_a_old")
    assert len(selected["runs"]) == 20
    assert all(run["id"] != "run_a_old" for run in selected["runs"])
    assert selected["scenario"]["id"] == "scenario_a"
    assert selected["scenario"]["name"] == "Edited live draft"
    assert selected["scenario"]["dataset_version_id"] == "dataset_b"
    assert selected["run"]["id"] == "run_a_old"
    assert selected["run"]["dataset_version_id"] == selected["dataset"]["id"] == "dataset_a"
    assert selected["draft_dataset"]["id"] == "dataset_b"
    frozen = selected["run"]["scenario_context"]
    assert frozen["name"] == "a"
    assert frozen["horizon_calendar_days"] == 30
    assert frozen["timezone"] == "America/Chicago"
    assert frozen["conditions"] == [{"kind": "arrival_multiplier", "multiplier": 1.7}]
    assert frozen["updates"][0]["payload"]["quantity"] == 3
    assert client.get("/api/run-groups/run_a_old").json()["scenario_context"] == frozen
    latest_for_scenario = get_summary(client, scenario_id="scenario_a")
    assert latest_for_scenario["dataset"]["id"] == "dataset_a"
    assert latest_for_scenario["draft_dataset"]["id"] == "dataset_b"
    assert latest_for_scenario["run"]["scenario_context"] == frozen
    assert selected["inventory"]["patients"] == 1
    assert get_summary(client, scenario_id="scenario_a", run_group_id="run_a_old") == selected
    with client.app.state.Session.begin() as session:
        session.get(Job, "run_a_old").status = "RUNNING"
    assert get_summary(client, run_group_id="run_a_old")["run"]["status"] == "RUNNING"


def test_explicit_comparison_and_archived_context_remain_readable(client):
    selected = get_summary(client, run_group_id="run_comparison")
    assert selected["scenario"]["id"] == "scenario_a"
    assert selected["run"]["comparison_id"] == "comparison_a"
    archived = get_summary(client, scenario_id="scenario_archived")
    assert archived["scenario"]["archived"] is True and archived["run"] is None
    assert all(item["id"] != "scenario_archived" for item in archived["scenarios"])


@pytest.mark.parametrize(
    "params",
    [
        {"scenario_id": "scenario_private"},
        {"run_group_id": "run_private"},
        {"scenario_id": "missing"},
        {"run_group_id": "missing"},
        {"scenario_id": "dataset_a"},
        {"run_group_id": "export_a"},
    ],
)
def test_summary_context_does_not_disclose_unowned_missing_or_wrong_kind(client, params):
    response = client.get(SUMMARY, params=params)
    assert response.status_code == 404
    assert "private" not in response.text


def test_summary_rejects_mismatched_or_empty_explicit_context(client):
    response = client.get(SUMMARY, params={"scenario_id": "scenario_b", "run_group_id": "run_a"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "context_mismatch"
    for name in ("scenario_id", "run_group_id"):
        assert client.get(SUMMARY, params={name: ""}).status_code == 422
    assert (
        client.get("/api/workspaces/workspace-other/summary", params={"run_group_id": "run_a"}).status_code
        == 404
    )


@pytest.mark.parametrize("target", ["scenario", "dataset"])
def test_owned_run_cannot_resolve_cross_workspace_references(client, target):
    with client.app.state.Session.begin() as session:
        run = session.get(Job, "run_a")
        key = "scenario_id" if target == "scenario" else "dataset_version_id"
        run.payload = {**run.payload, key: f"{target}_private"}
    assert client.get(SUMMARY, params={"run_group_id": "run_a"}).status_code == 404


def test_viewer_can_restore_authorized_context(client):
    assert client.post("/api/auth/login", json={"demo_role": "viewer"}).status_code == 200
    selected = get_summary(client, scenario_id="scenario_a", run_group_id="run_a")
    assert selected["run"]["id"] == "run_a"
