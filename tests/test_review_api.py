"""Independent contract regressions found during the release review."""

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.worker import execute_job
from surge_engine import generate_dataset


@pytest.fixture(scope="module")
def reviewed(tmp_path_factory):
    root = tmp_path_factory.mktemp("independent-api-review")
    patch = pytest.MonkeyPatch()
    patch.setenv("APP_ENV", "development")
    patch.setenv("ARTIFACT_LOCAL_DIR", str(root / "artifacts"))
    patch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(root / "review.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    dataset = normalize_dataset(generate_dataset(days=3))
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url = url
        client.dataset_id = dataset["id"]
        scenario = client.post(
            "/api/scenarios",
            json={
                "name": "Independent review",
                "dataset_version_id": dataset["id"],
                "horizon_calendar_days": 1,
                "replications": 1,
            },
        ).json()
        run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
        execute_job(run["id"], url)
        client.completed = client.get("/api/run-groups/" + run["id"]).json()
        assert client.completed["status"] == "SUCCEEDED", client.completed
        client.original_scenario = scenario
        yield client
    patch.undo()


def test_branch_uses_frozen_run_when_draft_was_edited(reviewed):
    client = reviewed
    scenario = client.original_scenario
    changed = [{"kind": "arrival_multiplier", "entry_stream_id": "ED_MAIN", "surge_percent": 200}]
    assert (
        client.patch(
            "/api/scenarios/" + scenario["id"], json={"conditions": changed}, headers={"If-Match": "1"}
        ).status_code
        == 200
    )
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": scenario["id"],
            "type": "arrival_batch",
            "effective_at": "2026-10-16T11:00:00Z",
            "state_origin": "simulation_branch",
            "payload": {
                "facility_id": "FAC-MAIN",
                "entry_stream_id": "ED_MAIN",
                "count": 1,
                "care_mix": {"ward": 1},
            },
        },
    ).json()
    response = client.post(
        "/api/updates/" + event["id"] + "/apply",
        json={
            "source": {
                "parent_run_group_id": client.completed["id"],
                "source_replication_id": client.completed["selected_replication_id"],
                "branch_strategy": "selected_replication",
            },
            "enqueue": False,
        },
    )
    assert response.status_code == 200, response.text
    child = response.json()["scenario"]
    assert child["conditions"] == scenario["conditions"], (
        "Inherited history must use the frozen parent run, not an edited draft"
    )
    assert child["parent_scenario_revision_id"] == client.completed["scenario_revision_id"]


def test_metrics_equivalent_offset_filters_same_instant(reviewed):
    path = "/api/run-groups/" + reviewed.completed["id"] + "/metrics"
    utc = reviewed.get(
        path, params={"start_at": "2026-10-16T05:00:00Z", "end_at": "2026-10-16T06:00:00Z"}
    ).json()["data"]
    offset = reviewed.get(
        path, params={"start_at": "2026-10-16T00:00:00-05:00", "end_at": "2026-10-16T01:00:00-05:00"}
    ).json()["data"]
    assert utc == offset and len(utc) == 1


def test_checkpoints_equivalent_offset_filters_same_instant(reviewed):
    path = "/api/runs/" + reviewed.completed["selected_replication_id"] + "/checkpoints"
    utc = reviewed.get(path, params={"at": "2026-10-16T05:00:00Z"}).json()["items"]
    offset = reviewed.get(path, params={"at": "2026-10-16T00:00:00-05:00"}).json()["items"]
    assert utc == offset and len(utc) == 1


@pytest.mark.parametrize(
    "conditions",
    [
        [None],
        {"kind": "arrival_multiplier"},
        [{"kind": "staff_unavailability", "unit_id": "UNIT-WARD-A", "count": 1}],
    ],
)
def test_malformed_condition_is_field_validation_error(reviewed, conditions):
    response = reviewed.post(
        "/api/scenarios", json={"dataset_version_id": reviewed.dataset_id, "conditions": conditions}
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_failed"


def test_scenario_cannot_shift_snapshot_without_new_observation(reviewed):
    response = reviewed.post(
        "/api/scenarios", json={"dataset_version_id": reviewed.dataset_id, "start_at": "2026-10-17T05:00:00Z"}
    )
    assert response.status_code == 422, response.text


def test_feasible_nonoverlapping_resource_plans_not_rejected(reviewed):
    response = reviewed.post(
        "/api/comparisons",
        json={
            "scenario_id": reviewed.original_scenario["id"],
            "replications": 1,
            "plans": [
                {
                    "name": "Sequential resource reuse",
                    "interventions": [
                        {
                            "kind": "clinic",
                            "nurses": 2,
                            "start_at": "2026-10-16T05:00:00Z",
                            "activation_minutes": 0,
                            "duration_minutes": 120,
                        },
                        {
                            "kind": "staffed_overflow",
                            "nurses": 5,
                            "start_at": "2026-10-16T09:00:00Z",
                            "activation_minutes": 0,
                            "duration_minutes": 120,
                        },
                    ],
                }
            ],
        },
    )
    assert response.status_code == 202, response.text
    assert response.json()["plans"][1]["feasibility"]["feasible"], response.json()["plans"][1]


def test_dataset_zip_round_trip_manifest(reviewed):
    response = reviewed.post(
        "/api/exports", json={"dataset_version_id": reviewed.dataset_id, "format": "zip"}
    )
    job = response.json()
    execute_job(job["id"], reviewed.database_url)
    raw = reviewed.get("/api/exports/" + job["id"] + "/download").content
    imported = reviewed.post("/api/imports", json={}).json()
    reviewed.post(
        "/api/imports/" + imported["id"] + "/files", files={"file": ("dataset.zip", raw, "application/zip")}
    )
    report = reviewed.post("/api/imports/" + imported["id"] + "/validate").json()
    assert report["valid"], report


def test_export_archive_checksum_tampering_rejected(reviewed):
    job = reviewed.post(
        "/api/exports",
        json={"run_group_id": reviewed.completed["id"], "format": "zip", "include_events": False},
    ).json()
    execute_job(job["id"], reviewed.database_url)
    raw = reviewed.get("/api/exports/" + job["id"] + "/download").content
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as original, zipfile.ZipFile(buffer, "w") as changed:
        for name in original.namelist():
            content = original.read(name)
            if name == "dataset.json":
                value = json.loads(content)
                value["facilities"][0]["name"] = "Altered without checksum update"
                content = json.dumps(value).encode()
            changed.writestr(name, content)
    imported = reviewed.post("/api/imports", json={}).json()
    reviewed.post(
        "/api/imports/" + imported["id"] + "/files",
        files={"file": ("tampered.zip", buffer.getvalue(), "application/zip")},
    )
    report = reviewed.post("/api/imports/" + imported["id"] + "/validate").json()
    assert not report["valid"], "ZIP import must verify the export checksum manifest"


def test_export_jobs_honor_workspace_queue_quota(reviewed, monkeypatch):
    monkeypatch.setenv("MAX_QUEUED_RUNS", "1")
    response = reviewed.post(
        "/api/exports", json={"dataset_version_id": reviewed.dataset_id, "format": "zip"}
    )
    assert response.status_code == 429, response.text


def test_event_sequence_cursor_includes_coincident_events(reviewed):
    from collections import defaultdict

    path = "/api/runs/" + reviewed.completed["selected_replication_id"] + "/events"
    events = reviewed.get(path, params={"limit": 200}).json()["items"]
    groups = defaultdict(list)
    for event in events:
        groups[event["occurred_at"]].append(event)
    group = next(value for value in groups.values() if len(value) > 1)
    first, second = group[:2]
    forward = reviewed.get(
        path,
        params={
            "at": first["occurred_at"],
            "direction": "after",
            "after_sequence": first["sequence_number"],
            "limit": 1,
        },
    ).json()["items"]
    backward = reviewed.get(
        path,
        params={
            "at": second["occurred_at"],
            "direction": "before",
            "before_sequence": second["sequence_number"],
            "limit": 1,
        },
    ).json()["items"]
    assert forward[0]["sequence_number"] == second["sequence_number"]
    assert backward[0]["sequence_number"] == first["sequence_number"]
