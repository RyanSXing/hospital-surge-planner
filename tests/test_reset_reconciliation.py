"""Observed reset approval uses the same complete authoritative context as commit."""

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job
from surge_api.main import create_app


def test_reset_preview_and_apply_share_full_ledger_and_reference(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    app = create_app("sqlite:///" + str(tmp_path / "reset.db"), seed=True, start_dispatcher=False)
    with TestClient(app) as client:
        dataset = client.get("/api/workspaces/workspace-main/summary").json()["dataset"]
        scenario = client.post(
            "/api/scenarios",
            json={
                "name": "Large reset",
                "dataset_version_id": dataset["id"],
                "horizon_calendar_days": 1,
                "replications": 1,
            },
        ).json()
        run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
        rep_id = "reset-reference-rep"
        trace = {
            "replication_id": rep_id,
            "start_at": scenario["start_at"],
            "end_at": run["end_at"],
            "horizon_elapsed_minutes": 1440,
            "unit_history": {},
            "patients": [
                {
                    "patient_id": dataset["patients"][0]["patient_id"] if i == 0 else f"RESET-{i:04}",
                    "state_intervals": [
                        {
                            "start_elapsed_minutes": 0,
                            "state": "ed_waiting",
                            "care_level": "ed",
                            "facility_id": "FAC-MAIN",
                            "unit_id": None,
                        }
                    ],
                }
                for i in range(1250)
            ],
        }
        artifact = ArtifactStore().put_json("workspace-main", "reset-test", "trace", trace)
        with app.state.Session.begin() as session:
            session.add(
                Document(
                    id=rep_id,
                    workspace_id="workspace-main",
                    kind="replication",
                    data={"id": rep_id, "run_group_id": run["id"], "trace_artifact": artifact},
                )
            )
            job = session.get(Job, run["id"])
            job.status = "SUCCEEDED"
            job.result = {"selected_replication_id": rep_id}
        request = {
            "observed_dataset_version_id": dataset["id"],
            "effective_at": dataset["snapshot_at"],
            "parent_scenario_revision_id": run["scenario_revision_id"],
            "parent_run_group_id": run["id"],
            "reference_replication_id": rep_id,
        }
        with app.state.Session() as session:
            before = session.scalar(select(func.count()).select_from(Document))
        response = client.post(f"/api/scenarios/{scenario['id']}/reset-reconciliation", json=request)
        assert response.status_code == 200, response.text
        preview = response.json()
        assert preview["prior_patient_total"] == 1250
        assert len(preview["matched"]) == 1 and len(preview["absent"]) == 1249
        assert len(preview["new"]) == 83
        assert preview["basis"]["replication_id"] == rep_id
        with app.state.Session() as session:
            assert session.scalar(select(func.count()).select_from(Document)) == before
        event = client.post(
            "/api/updates",
            json={
                "scenario_id": scenario["id"],
                "type": "census_replacement",
                "effective_at": dataset["snapshot_at"],
                "state_origin": "observed_reset",
                "payload": {
                    "observed_dataset_version_id": dataset["id"],
                    "effective_at": dataset["snapshot_at"],
                },
            },
        ).json()
        source = {
            key: value
            for key, value in request.items()
            if key not in {"effective_at", "parent_scenario_revision_id"}
        }
        source["reconciliation_hash"] = "invalid-reviewed-state"
        payload = {
            "parent_scenario_revision_id": run["scenario_revision_id"],
            "source": source,
            "enqueue": False,
        }
        rejected = client.post(f"/api/updates/{event['id']}/apply", json=payload)
        assert rejected.status_code == 409, rejected.text
        assert rejected.json()["error"]["code"] == "UNRESOLVED_RECONCILIATION"
        source["reconciliation_hash"] = preview["reconciliation_hash"]
        applied = client.post(f"/api/updates/{event['id']}/apply", json=payload)
        assert applied.status_code == 200, applied.text
        report = applied.json()["scenario"]["reconciliation"]
        for field in ("matched", "absent", "new", "basis", "reconciliation_hash"):
            assert report[field] == preview[field]
        assert report["update_disposition"][0]["action"] == "exclude"
        assert report["absent_is_not_discharge"] is True
        unauthorized = client.post(
            f"/api/scenarios/{scenario['id']}/reset-reconciliation",
            json={**request, "parent_run_group_id": "not-owned"},
        )
        assert unauthorized.status_code == 404
        invalid_time = client.post(
            f"/api/scenarios/{scenario['id']}/reset-reconciliation",
            json={**request, "effective_at": "not-a-timestamp"},
        )
        assert invalid_time.status_code == 422
