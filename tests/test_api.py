"""API lifecycle tests exercise persistence, ownership, roles and immutable snapshots."""

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from surge_api.db import Document, Job
from surge_api.main import create_app
from surge_api.worker import execute_job


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(tmp_path / "test.db")
    app = create_app(url, seed=True, start_dispatcher=False)
    with TestClient(app) as c:
        c.database_url = url
        yield c


def setup_context(client):
    response = client.get("/api/workspaces/workspace-main/summary")
    assert response.status_code == 200, response.text
    return response.json()


def create_short_scenario(client, context, **values):
    response = client.post(
        "/api/scenarios",
        json={
            "name": "Lifecycle test",
            "dataset_version_id": context["dataset"]["id"],
            "horizon_calendar_days": 1,
            "replications": 2,
            "conditions": [],
            **values,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_boot_seeded_sessions_and_census(client):
    context = setup_context(client)
    assert client.cookies.get("hsp_session")
    assert context["run_group"] is None
    assert len(context["dataset"]["patients"]) == 84
    response = client.get("/api/v1/datasets")
    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert client.get("/api/me").json()["role"] == "admin"
    assert client.get("/api/workspaces/not-my-workspace/summary").status_code == 404


def test_dataset_cards_are_projected_and_paginated_in_sql(client):
    from sqlalchemy import event

    context = setup_context(client)
    statements = []

    def capture(connection, cursor, statement, parameters, execution_context, executemany):
        statements.append(statement)

    event.listen(client.app.state.engine, "before_cursor_execute", capture)
    try:
        first = client.get("/api/datasets?limit=1").json()
        second = client.get(f"/api/datasets?limit=1&cursor={first['next_cursor']}").json()
    finally:
        event.remove(client.app.state.engine, "before_cursor_execute", capture)
    assert first["total"] == 2 and first["next_cursor"] == "1"
    assert second["next_cursor"] is None
    assert first["items"][0]["id"] != second["items"][0]["id"]
    assert all("patients" not in item and "assignments" not in item for item in first["items"])
    card = next(item for item in first["items"] + second["items"] if item["id"] == context["dataset"]["id"])
    assert card["manifest"] == context["dataset"]["manifest"]
    assert card["synthetic"] is True
    dataset_selects = [s for s in statements if "JSON_EXTRACT" in s]
    assert not dataset_selects, "Warm cards must not reparse a full dataset JSON document"
    page_selects = [s for s in statements if "FROM documents" in s and "LIMIT" in s]
    assert len(page_selects) == 2
    assert all("OFFSET" in s and ", documents.data," not in s for s in page_selects)
    assert client.get("/api/datasets?cursor=invalid").status_code == 422


def test_immutable_revision_and_optimistic_conflict(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    revision = client.post(f"/api/scenarios/{scenario['id']}/revisions").json()
    edit = client.patch(
        f"/api/scenarios/{scenario['id']}",
        json={"name": "Revised"},
        headers={"If-Match": str(scenario["revision"])},
    )
    assert edit.status_code == 200
    assert (
        client.patch(
            f"/api/scenarios/{scenario['id']}", json={"name": "Lost write"}, headers={"If-Match": "1"}
        ).status_code
        == 409
    )
    read = client.get(f"/api/scenarios/{scenario['id']}").json()
    frozen = next(x for x in read["revisions"] if x["id"] == revision["id"])
    assert frozen["name"] == "Lifecycle test"
    assert read["name"] == "Revised"


def test_role_and_origin_enforcement(client):
    context = setup_context(client)
    assert client.post("/api/auth/login", json={"demo_role": "viewer"}).status_code == 200
    assert client.get("/api/datasets").status_code == 200
    assert (
        client.post("/api/scenarios", json={"dataset_version_id": context["dataset"]["id"]}).status_code
        == 403
    )
    assert (
        client.post(
            "/api/auth/login", json={"demo_role": "admin"}, headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )


def test_idempotency_and_frozen_run_inputs(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    payload = {"scenario_id": scenario["id"], "replications": 1}
    first = client.post("/api/run-groups", json=payload, headers={"Idempotency-Key": "same-run"})
    assert first.status_code == 202, first.text
    second = client.post("/api/run-groups", json=payload, headers={"Idempotency-Key": "same-run"})
    assert second.json()["id"] == first.json()["id"]
    assert (
        client.post(
            "/api/run-groups", json={**payload, "replications": 2}, headers={"Idempotency-Key": "same-run"}
        ).status_code
        == 409
    )
    client.patch(
        f"/api/scenarios/{scenario['id']}", json={"name": "Changed after enqueue"}, headers={"If-Match": "1"}
    )
    with client.app.state.Session() as session:
        frozen = session.get(Job, first.json()["id"]).payload["scenario"]
        assert frozen["name"] == "Lifecycle test"
    assert client.post(f"/api/run-groups/{first.json()['id']}/cancel").json()["status"] == "CANCELLED"


def test_run_replay_export_import_roundtrip(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
    execute_job(run["id"], client.database_url)
    completed = client.get(f"/api/run-groups/{run['id']}").json()
    assert completed["status"] == "SUCCEEDED", completed
    assert completed["completed"] == 2
    metrics = client.get(f"/api/run-groups/{run['id']}/metrics").json()
    assert len(metrics["daily"]) == 1
    assert "inpatient_waiting_patient_hours" in metrics["scalar_metrics"]
    selected = completed["selected_replication_id"]
    state = client.get(f"/api/runs/{selected}/state", params={"at": scenario["start_at"]}).json()
    assert len(state["patients"]) == 84, state.keys()
    events = client.get(f"/api/runs/{selected}/events", params={"limit": 3}).json()
    assert len(events["items"]) == 3 and events["next_cursor"]
    export = client.post("/api/exports", json={"run_group_id": run["id"], "format": "zip"}).json()
    execute_job(export["id"], client.database_url)
    status = client.get(f"/api/exports/{export['id']}").json()
    assert status["status"] == "SUCCEEDED", status
    download = client.get(status["download_url"])
    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
        assert {"dataset.json", "scenario.json", "metrics.json", "events.csv", "checksums.json"} <= set(
            archive.namelist()
        )
        original = json.loads(archive.read("dataset.json"))
    imported = client.post("/api/imports", json={"dataset": original}).json()
    valid = client.post(f"/api/imports/{imported['id']}/validate").json()
    assert valid["valid"], valid
    committed = client.post(f"/api/imports/{imported['id']}/commit")
    assert committed.status_code == 201, committed.text
    assert committed.json()["patients"] == original["patients"]


def test_cross_workspace_resource_hidden(client):
    setup_context(client)
    with client.app.state.Session.begin() as session:
        session.add(
            Document(
                id="dataset-private",
                workspace_id="other-workspace",
                kind="dataset",
                data={"id": "dataset-private"},
            )
        )
    assert client.get("/api/datasets/dataset-private").status_code == 404
    assert client.post("/api/scenarios", json={"dataset_version_id": "dataset-private"}).status_code == 404


def test_update_idempotency_and_branch_preservation(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    payload = {
        "scenario_id": scenario["id"],
        "type": "arrival_batch",
        "effective_at": scenario["start_at"],
        "state_origin": "simulation_branch",
        "payload": {"facility_id": "FAC-MAIN", "count": 20, "care_mix": {"ward": 1.0}},
        "idempotency_key": "incident-1",
    }
    event = client.post("/api/updates", json=payload)
    assert event.status_code == 201, event.text
    assert client.post("/api/updates", json=payload).json()["id"] == event.json()["id"]
    applied = client.post(f"/api/updates/{event.json()['id']}/apply", json={"run": False}).json()
    assert applied["scenario"]["parent_scenario_id"] == scenario["id"]
    assert client.get(f"/api/scenarios/{scenario['id']}").json()["updates"] == []
    assert client.post(f"/api/updates/{event.json()['id']}/apply", json={"run": False}).json()[
        "already_applied"
    ]


def test_invalid_scenario_and_draft_edits(client):
    context = setup_context(client)
    invalid = client.post(
        "/api/scenarios", json={"dataset_version_id": context["dataset"]["id"], "replications": 501}
    )
    assert invalid.status_code == 422
    draft = client.post("/api/dataset-drafts", json={"dataset_version_id": context["dataset"]["id"]}).json()
    assert (
        client.patch(f"/api/dataset-drafts/{draft['id']}/entities", json={"operations": []}).status_code
        == 409
    )
    invalid = client.patch(
        f"/api/dataset-drafts/{draft['id']}/entities",
        headers={"If-Match": "1"},
        json={
            "operations": [
                {
                    "collection": "patients",
                    "action": "upsert",
                    "entity": {"patient_id": "bad-patient", "unit_id": "missing"},
                }
            ]
        },
    )
    assert invalid.status_code == 200
    assert not invalid.json()["validation"]["valid"]
    assert (
        client.post(f"/api/dataset-drafts/{draft['id']}/commit", headers={"If-Match": "2"}).status_code == 422
    )
    assert len(client.get(f"/api/datasets/{context['dataset']['id']}").json()["patients"]) == 84


def test_endpoint_inventory(client):
    schema = client.get("/api/openapi.json").json()
    paths = schema["paths"]
    for path in [
        "/api/imports",
        "/api/dataset-drafts",
        "/api/comparisons",
        "/api/updates",
        "/api/alert-rules",
        "/api/exports",
        "/api/audit-events",
    ]:
        assert path in paths


def test_selected_branch_preserves_history_and_varies_future(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    parent = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
    execute_job(parent["id"], client.database_url)
    parent = client.get(f"/api/run-groups/{parent['id']}").json()
    cutoff = "2026-10-16T11:00:00Z"
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": scenario["id"],
            "type": "arrival_batch",
            "effective_at": cutoff,
            "state_origin": "simulation_branch",
            "replication_id": parent["selected_replication_id"],
            "payload": {
                "facility_id": "FAC-MAIN",
                "count": 3,
                "care_mix": {"ward": 1.0},
                "spread_minutes": 0,
            },
        },
    ).json()
    response = client.post(
        f"/api/updates/{event['id']}/apply",
        json={
            "parent_scenario_revision_id": parent["scenario_revision_id"],
            "effective_at": cutoff,
            "state_origin": "simulation_branch",
            "update_ids": [event["id"]],
            "source": {
                "parent_run_group_id": parent["id"],
                "branch_strategy": "selected_replication",
                "source_replication_id": parent["selected_replication_id"],
            },
            "replications": 2,
            "enqueue": True,
        },
    )
    assert response.status_code == 200, response.text
    child = response.json()["run"]
    execute_job(child["id"], client.database_url)
    child = client.get(f"/api/run-groups/{child['id']}").json()
    assert child["status"] == "SUCCEEDED", child
    a = client.get(
        f"/api/runs/{parent['selected_replication_id']}/state", params={"at": "2026-10-16T10:00:00Z"}
    ).json()
    b = client.get(
        f"/api/runs/{child['selected_replication_id']}/state", params={"at": "2026-10-16T10:00:00Z"}
    ).json()
    assert a["patients"] == b["patients"]
    reps = client.get(f"/api/run-groups/{child['id']}/replications").json()["items"]
    assert reps[0]["seed"] != reps[1]["seed"]
    unselected = next(r for r in reps if r["id"] != child["selected_replication_id"])
    regenerated = client.post(f"/api/runs/{unselected['id']}/trace").json()
    execute_job(regenerated["id"], client.database_url)
    assert client.get(f"/api/runs/{unselected['id']}/trace").json()["ready"]


def test_member_roles_are_revoked_when_changed(client):
    setup_context(client)
    member = client.post(
        "/api/workspaces/workspace-main/members",
        json={
            "name": "Reader",
            "username": "reader",
            "role": "viewer",
            "password": "a sufficiently long password",
        },
    )
    assert member.status_code == 201, member.text
    assert "password_hash" not in member.json()
    assert (
        client.post(
            "/api/auth/login", json={"username": "reader", "password": "a sufficiently long password"}
        ).status_code
        == 200
    )
    assert client.get("/api/me").json()["role"] == "viewer"
    assert client.post("/api/demo-datasets", json={}).status_code == 403
    assert client.post("/api/auth/login", json={"demo_role": "admin"}).status_code == 200
    modified = client.patch(
        f"/api/workspaces/workspace-main/members/{member.json()['id']}",
        json={"role": "planner"},
        headers={"If-Match": "1"},
    )
    assert modified.status_code == 200, modified.text
    assert (
        client.post(
            "/api/auth/login", json={"username": "reader", "password": "a sufficiently long password"}
        ).status_code
        == 200
    )
    assert client.get("/api/me").json()["role"] == "planner"


def test_comparison_and_alert_evidence(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=1)
    comparison = client.post(
        "/api/comparisons",
        json={
            "scenario_id": scenario["id"],
            "replications": 1,
            "plans": [{"name": "Same plan", "interventions": []}],
        },
    ).json()
    for plan in comparison["plans"]:
        execute_job(plan["run_group_id"], client.database_url)
    result = client.get(f"/api/comparisons/{comparison['id']}").json()
    assert result["status"] == "SUCCEEDED"
    assert result["plans"][1]["improvement"]["p50"] == 0
    assert result["plans"][1]["metrics"]["series"]
    rule = client.post(
        "/api/alert-rules",
        json={
            "name": "Every bucket",
            "metric": "peak_inpatient_queue",
            "operator": "gte",
            "threshold": 0,
            "statistic": "p50",
            "grain": "day",
            "unit": "patients",
            "consecutive_buckets": 1,
            "severity": "info",
        },
    ).json()
    assert rule["metric"] == "peak_inpatient_queue"
    run_id = result["plans"][0]["run_group_id"]
    first = client.get("/api/alerts", params={"run_group_id": run_id}).json()["items"]
    second = client.get("/api/alerts", params={"run_group_id": run_id}).json()["items"]
    assert first[0]["id"] == second[0]["id"]
    assert first[0]["bucket_start"] and first[0]["bucket_end"] and first[0]["rule_revision_id"]
    assert client.post(f"/api/alerts/{first[0]['id']}/acknowledge").json()["acknowledged"]


def test_eligibility_uses_patient_profile_and_comparison_does_not_replace_main_run(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context)
    patient = next(
        p
        for p in context["dataset"]["patients"]
        if any(r["capability_code"] == "VENTILATOR" for r in p.get("resource_requirements", []))
    )
    response = client.get(
        "/api/sites/FAC-EAST/eligibility",
        params={"scenario_id": scenario["id"], "patient_id": patient["patient_id"], "care_level": "ward"},
    )
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["care_level"] == "icu" and not value["eligible"]
    assert any("VENTILATOR" in reason for reason in value["reasons"])
    assert value["availability_source"] == "dataset_snapshot"
    invalid = client.post(
        "/api/updates",
        json={
            "scenario_id": scenario["id"],
            "type": "advertised_capacity_change",
            "state_origin": "simulation_branch",
            "effective_at": scenario["start_at"],
            "payload": {"unit_id": "UNIT-EAST-WARD", "advertised_staffed_capacity": 33},
        },
    )
    assert invalid.status_code == 422 and invalid.json()["error"]["fields"]
    run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
    comparison = client.post(
        "/api/comparisons",
        json={
            "scenario_id": scenario["id"],
            "plans": [{"name": "Same inputs", "interventions": []}],
            "replications": 2,
        },
    )
    assert comparison.status_code == 202, comparison.text
    summary = setup_context(client)
    assert summary["run"]["id"] == run["id"]
    assert (
        client.get("/api/comparisons", params={"scenario_id": scenario["id"]}).json()["items"][0]["id"]
        == comparison.json()["id"]
    )
    audits = client.get("/api/audit-events?limit=2").json()
    assert len(audits["items"]) == 2 and audits["next_cursor"] == "2"
    assert len(client.get("/api/audit-events?limit=2&cursor=2").json()["items"]) == 2


def test_parallel_replications_and_export_without_trace(client, monkeypatch):
    monkeypatch.setenv("SIMULATION_WORKERS", "2")
    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=6)
    run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
    execute_job(run["id"], client.database_url)
    complete = client.get(f"/api/run-groups/{run['id']}").json()
    assert complete["status"] == "SUCCEEDED", complete
    assert complete["completed"] == 6
    reps = client.get(f"/api/run-groups/{run['id']}/replications").json()["items"]
    assert sorted(r["replication_index"] for r in reps) == list(range(6))
    from surge_engine import run_replication

    with client.app.state.Session() as session:
        job = session.get(Job, run["id"])
        dataset = session.get(Document, job.payload["dataset_version_id"]).data
        expected = run_replication(dataset, job.payload["scenario"], replication_index=3, keep_trace=False)
    actual = next(r for r in reps if r["replication_index"] == 3)
    assert actual["scalar_metrics"] == expected["scalar_metrics"]
    exported = client.post("/api/exports", json={"run_group_id": run["id"], "include_events": False}).json()
    execute_job(exported["id"], client.database_url)
    response = client.get(f"/api/exports/{exported['id']}/download")
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert "events.jsonl" not in archive.namelist() and "events.csv" not in archive.namelist()
        assert json.loads(archive.read("model-manifest.json"))["export_includes_events"] is False


def test_compute_budget_rejects_before_queue_and_feasibility_is_read_only(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=100)
    preview = client.post(
        f"/api/scenarios/{scenario['id']}/feasibility",
        json={"interventions": [{"kind": "staff_existing", "nurses": 1}]},
    ).json()
    assert preview["valid"] and preview["feasibility"]["feasible"]
    assert preview["compute_estimate"]["expected_trajectories_total"] > 0
    assert client.get(f"/api/scenarios/{scenario['id']}").json()["interventions"] == []
    settings = client.get("/api/workspaces/workspace-main/settings").json()
    response = client.patch(
        "/api/workspaces/workspace-main/settings",
        json={"max_run_trajectories": 1000, "max_comparison_trajectories": 1500},
        headers={"If-Match": str(settings["revision"])},
    )
    assert response.status_code == 200
    run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
    assert run.status_code == 422 and run.json()["error"]["code"] == "compute_budget_exceeded"
    compare = client.post(
        "/api/comparisons",
        json={"scenario_id": scenario["id"], "plans": [{"name": "Alternative", "interventions": []}]},
    )
    assert compare.status_code == 422
    assert client.get("/api/workspaces/workspace-main/summary").json()["run_group"] is None
    assert not client.post(f"/api/scenarios/{scenario['id']}/validate").json()["valid"]


def test_bounded_state_keeps_exact_counts_and_paginated_filters(client):
    from surge_api.artifacts import ArtifactStore

    setup_context(client)
    identity = "large-state-rep"
    trace = {
        "replication_id": identity,
        "start_at": "2026-10-16T05:00:00Z",
        "horizon_elapsed_minutes": 60,
        "unit_history": {
            "ED": [
                {
                    "elapsed_minutes": 0,
                    "unit_id": "ED",
                    "facility_id": "FAC-MAIN",
                    "kind": "ed",
                    "occupied": 0,
                }
            ]
        },
        "patients": [
            {
                "patient_id": f"P{i:04}",
                "state_intervals": [
                    {
                        "start_elapsed_minutes": 0,
                        "state": "ed_waiting" if i % 2 else "direct_waiting",
                        "care_level": "ward",
                        "facility_id": "FAC-MAIN",
                        "unit_id": None,
                        "admission_pending": i % 2 == 0,
                    }
                ],
            }
            for i in range(1250)
        ],
    }
    artifact = ArtifactStore().put_json("workspace-main", "state-test", "trace", trace)
    with client.app.state.Session.begin() as session:
        session.add(
            Document(
                id=identity,
                workspace_id="workspace-main",
                kind="replication",
                data={"id": identity, "run_group_id": "large-run", "trace_artifact": artifact},
            )
        )
    response = client.get(f"/api/runs/{identity}/state").json()
    assert len(response["patients"]) == 500 and response["patient_total"] == 1250
    assert response["patient_counts"]["by_facility"]["FAC-MAIN"] == 1250
    assert response["queue_counts"]["FAC-MAIN"]["total"] == 625
    assert response["queue_counts"]["FAC-MAIN"]["ed"] == 625
    assert sum(g["count"] for g in response["patient_groups"]) == 1250
    assert sum(g["count"] for g in response["patient_groups"] if g["admission_pending"]) == 625
    page = client.get(
        f"/api/runs/{identity}/patients?facility_id=FAC-MAIN&admission_pending=true&limit=50&cursor=50"
    ).json()
    assert len(page["items"]) == 50 and page["total"] == 625 and page["next_cursor"] == "100"
    waiting = client.get(f"/api/runs/{identity}/patients?state=waiting&limit=50").json()
    assert waiting["total"] == 1250


def test_export_preserves_explicit_run_when_comparison_reference_is_separate(client):
    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=1)
    direct = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
    execute_job(direct["id"], client.database_url)
    direct = client.get(f"/api/run-groups/{direct['id']}").json()
    comparison = client.post(
        "/api/comparisons",
        json={
            "scenario_id": scenario["id"],
            "replications": 2,
            "plans": [{"name": "Paired alternative", "interventions": []}],
        },
    ).json()
    for plan in comparison["plans"]:
        execute_job(plan["run_group_id"], client.database_url)
    changed = client.patch(
        f"/api/scenarios/{scenario['id']}",
        json={"name": "A changed mutable name"},
        headers={"If-Match": str(scenario["revision"])},
    )
    assert changed.status_code == 200
    response = client.post(
        "/api/exports",
        json={
            "run_group_id": direct["id"],
            "scenario_id": scenario["id"],
            "comparison_id": comparison["id"],
            "replication_id": direct["selected_replication_id"],
            "include_events": True,
        },
    )
    assert response.status_code == 202, response.text
    with client.app.state.Session() as session:
        payload = session.get(Job, response.json()["id"]).payload
        assert payload["run_group_id"] == direct["id"]
        assert payload["scenario_revision_id"] == direct["scenario_revision_id"]
        assert payload["replication_id"] == direct["selected_replication_id"]
    execute_job(response.json()["id"], client.database_url)
    download = client.get(f"/api/exports/{response.json()['id']}/download")
    assert download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(download.content)) as package:
        assert json.loads(package.read("model-manifest.json"))["run_group_id"] == direct["id"]
        assert "comparison.csv" in package.namelist()
