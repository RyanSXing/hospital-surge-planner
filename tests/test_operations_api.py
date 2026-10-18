"""Saved optional operations reach immutable jobs and read-only result evidence."""

import copy

import pytest
from fastapi.testclient import TestClient
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.worker import execute_job
from surge_engine import generate_dataset


def operations():
    return {
        "severity_mix": {
            "low": {"percentage": 60, "average_stay_hours": 24},
            "medium": {"percentage": 30, "average_stay_hours": 72},
            "high": {"percentage": 10, "average_stay_hours": 168},
        },
        "supplies": {
            "initial_percent": 100,
            "capacity": 30,
            "usage_per_patient_day": 1,
            "refill_every_days": 1,
            "refill_percent": 100,
        },
        "disruptions": [
            {
                "id": "day-two",
                "name": "Day two treatment interruption",
                "start_at": "2026-10-17T05:00:00Z",
                "end_at": "2026-10-18T05:00:00Z",
            }
        ],
    }


@pytest.fixture(scope="module")
def operations_api(tmp_path_factory):
    root = tmp_path_factory.mktemp("hospital-operations-api")
    patch = pytest.MonkeyPatch()
    patch.setenv("APP_ENV", "development")
    patch.setenv("ARTIFACT_LOCAL_DIR", str(root / "artifacts"))
    patch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(root / "operations.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    dataset = normalize_dataset(generate_dataset(fixture="hospital_baseline", days=3))
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url = url
        client.dataset = dataset
        created = client.post(
            "/api/scenarios",
            json={
                "name": "Operations frozen API lifecycle",
                "dataset_version_id": dataset["id"],
                "horizon_calendar_days": 3,
                "replications": 2,
            },
        )
        assert created.status_code == 201, created.text
        original = created.json()
        assert original.get("hospital_operations") is None
        saved = client.patch(
            f"/api/scenarios/{original['id']}",
            headers={"If-Match": str(original["revision"])},
            json={"hospital_operations": operations()},
        )
        assert saved.status_code == 200, saved.text
        client.saved = saved.json()
        assert client.saved["hospital_operations"] == operations()
        assert client.get(f"/api/scenarios/{original['id']}").json()["hospital_operations"] == operations()
        queued = client.post("/api/run-groups", json={"scenario_id": original["id"]})
        assert queued.status_code == 202, queued.text
        client.queued = queued.json()
        # Freeze first, then disable the draft: completed results must use the queued revision.
        changed = client.patch(
            f"/api/scenarios/{original['id']}",
            headers={"If-Match": str(client.saved["revision"])},
            json={"hospital_operations": None},
        )
        assert changed.status_code == 200, changed.text
        client.changed = changed.json()
        execute_job(client.queued["id"], url)
        client.completed = client.get(f"/api/run-groups/{client.queued['id']}").json()
        assert client.completed["status"] == "SUCCEEDED", client.completed
        yield client
    app.state.engine.dispose()
    patch.undo()


def test_saved_operations_frozen_in_completed_run_and_daily_results(operations_api):
    client = operations_api
    run = client.completed
    assert run["scenario_context"]["hospital_operations"] == operations()
    assert run["source_draft_revision"] == client.saved["revision"]
    assert run["source_draft_revision"] < client.changed["revision"]
    assert client.get(f"/api/scenarios/{client.saved['id']}").json().get("hospital_operations") is None
    metrics = client.get(f"/api/run-groups/{run['id']}/metrics", params={"grain": "day"})
    assert metrics.status_code == 200, metrics.text
    value = metrics.json()
    assert value["context"]["run_group_id"] == run["id"]
    assert value["context"]["scenario_revision_id"] == run["scenario_revision_id"]
    assert len(value["data"]) == 3
    for key in ("average_wait_per_patient_hours", "medical_supply_average_percent", "success_score_percent"):
        assert value["scalar_metrics"][key]["p50"] is not None
    for day in value["data"]:
        assert 0 <= day["medical_supply_average_percent"]["p50"] <= 100
        assert day["arrivals"]["p50"] > 0


def test_disruption_day_has_real_arrivals_without_treatment_or_discharge(operations_api):
    client = operations_api
    rep = client.completed["selected_replication_id"]
    params = {"start_at": "2026-10-17T05:00:00Z", "end_at": "2026-10-18T05:00:00Z", "limit": 200}
    response = client.get(f"/api/runs/{rep}/events", params=params)
    assert response.status_code == 200, response.text
    counts = response.json()["event_type_counts"]
    assert counts["arrival"] > 0
    for kind in ("admission", "assessment_start", "assessment_end", "discharge"):
        assert counts.get(kind, 0) == 0, (kind, counts)
    state = client.get(f"/api/runs/{rep}/state", params={"at": "2026-10-17T17:00:00Z"})
    assert state.status_code == 200, state.text
    assert any(p.get("care_paused") for p in state.json()["patients"])


def test_ensemble_bottlenecks_are_frozen_context_and_cached_read_only(operations_api):
    client = operations_api
    run = client.completed
    path = f"/api/run-groups/{run['id']}/bottlenecks"
    before = client.get(f"/api/scenarios/{client.saved['id']}").json()
    first = client.get(path)
    assert first.status_code == 200, first.text
    value = first.json()
    assert value["scope"] == "ensemble"
    assert value["evidence_available"] is True
    assert value["context"]["run_group_id"] == run["id"]
    assert value["context"]["scenario_revision_id"] == run["scenario_revision_id"]
    assert value["context"]["dataset_version_id"] == client.dataset["id"]
    reasons = {row["reason"] for row in value["categories"]}
    assert {"medical_supplies", "treatment_disruption"} <= reasons
    assert client.get(path).json() == value
    assert client.get("/api/run-groups/missing/bottlenecks").status_code == 404
    assert client.get(f"/api/scenarios/{client.saved['id']}").json() == before


@pytest.mark.parametrize(
    "bad",
    [
        {"severity_mix": {"low": {"percentage": 100, "average_stay_hours": 24}}},
        {
            "severity_mix": {
                **operations()["severity_mix"],
                "low": {"percentage": 59, "average_stay_hours": 24},
            }
        },
        {
            "severity_mix": {
                **operations()["severity_mix"],
                "low": {"percentage": 60, "average_stay_hours": 0},
            }
        },
        {"supplies": {**operations()["supplies"], "capacity": 0}},
        {"supplies": {**operations()["supplies"], "initial_percent": 101}},
        {"supplies": {**operations()["supplies"], "refill_every_days": 1.5}},
        {"disruptions": [{**operations()["disruptions"][0], "end_at": "2026-10-20T05:00:00Z"}]},
    ],
)
def test_invalid_operations_are_422_and_leave_saved_draft_intact(operations_api, bad):
    client = operations_api
    identity = client.saved["id"]
    before = client.get(f"/api/scenarios/{identity}").json()
    response = client.patch(
        f"/api/scenarios/{identity}",
        headers={"If-Match": str(before["revision"])},
        json={"hospital_operations": copy.deepcopy(bad)},
    )
    assert response.status_code == 422, response.text
    assert client.get(f"/api/scenarios/{identity}").json() == before


def test_enabling_one_feature_does_not_implicitly_enable_other_operations(operations_api):
    client = operations_api
    response = client.post(
        "/api/scenarios",
        json={
            "dataset_version_id": client.dataset["id"],
            "name": "Disruption only",
            "horizon_calendar_days": 3,
            "hospital_operations": {"disruptions": operations()["disruptions"]},
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["hospital_operations"] == {"disruptions": operations()["disruptions"]}


def test_legacy_evidence_falls_back_to_one_labeled_example_and_missing_trace_stays_unavailable(
    operations_api,
):
    client = operations_api
    created = client.post(
        "/api/scenarios",
        json={
            "name": "Legacy result evidence",
            "dataset_version_id": client.dataset["id"],
            "horizon_calendar_days": 1,
            "replications": 1,
        },
    )
    assert created.status_code == 201, created.text
    scenario = created.json()
    queued = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
    assert queued.status_code == 202, queued.text
    execute_job(queued.json()["id"], client.database_url)
    run = client.get(f"/api/run-groups/{queued.json()['id']}").json()
    assert run["status"] == "SUCCEEDED", run
    fresh = client.get(f"/api/run-groups/{run['id']}/metrics").json()
    assert fresh["scalar_metrics"]["average_wait_per_patient_hours"]["p50"] is not None
    assert fresh["scalar_metrics"]["success_score_percent"]["p50"] is not None
    assert "medical_supply_average_percent" not in fresh["scalar_metrics"]
    store = ArtifactStore()
    # Model an already-saved artifact from before ensemble constraint evidence existed.
    # This is an isolated test database; no existing workspace artifact is changed.
    with client.app.state.Session.begin() as session:
        job = session.get(Job, run["id"])
        aggregate = store.get_json(job.result["aggregate_artifact"])
        aggregate.pop("bottleneck_evidence", None)
        for field in (
            "average_wait_per_patient_hours",
            "success_score_percent",
            "success_eligible_arrivals",
            "success_treated_within_24h",
        ):
            aggregate["scalar_metrics"].pop(field, None)
        replacement = store.put_json("workspace-main", run["id"], "legacy-aggregate", aggregate)
        job.result = {**job.result, "aggregate_artifact": replacement}
    path = f"/api/run-groups/{run['id']}/bottlenecks"
    response = client.get(path)
    assert response.status_code == 200, response.text
    example = response.json()
    assert example["scope"] == "selected_replication"
    assert example["evidence_available"] is True
    assert example["replication_id"] == run["selected_replication_id"]
    assert example["replications_completed"] == 1
    metrics = client.get(f"/api/run-groups/{run['id']}/metrics").json()
    assert "medical_supply_average_percent" not in metrics["scalar_metrics"]
    assert "success_score_percent" not in metrics["scalar_metrics"]
    assert "average_wait_per_patient_hours" not in metrics["scalar_metrics"]
    with client.app.state.Session.begin() as session:
        replication = session.get(Document, run["selected_replication_id"])
        replication.data = {key: value for key, value in replication.data.items() if key != "trace_artifact"}
    response = client.get(path)
    assert response.status_code == 200, response.text
    unavailable = response.json()
    assert unavailable["evidence_available"] is False
    assert unavailable["scope"] == "unavailable"
    assert unavailable["categories"] == []
    assert "patient_hours" not in unavailable
