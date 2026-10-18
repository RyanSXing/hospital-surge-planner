"""Chance settings freeze with results and cannot rewrite inherited daily draws."""

# ruff: noqa: F811 -- shared pytest fixture is injected by name.
import copy
import json

import pytest
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, digest
from surge_api.model_versions import (
    ModelVersionMismatch,
    execution_scenario,
    operations_version_for_new_run,
    require_matching_operations_history,
)
from surge_api.schemas import HospitalOperationsSettings, command_dict
from surge_api.worker import execute_job
from surge_engine.common import MODEL_VERSION
from test_operations_versions_api import (  # noqa: F401
    branch_from,
    complete,
    enqueue,
    operations,
    ops_client,
    payload,
)


def create_chance(client, chance=50, days=3):
    response = client.post(
        "/api/scenarios",
        json={
            "name": "Frozen daily disruption chance",
            "dataset_version_id": client.dataset["id"],
            "base_seed": 43121,
            "horizon_calendar_days": days,
            "replications": 2,
            "hospital_operations": {"disruption_chance_percent": chance},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("chance", [-1, 101, True, "25", None, float("nan"), float("inf")])
def test_invalid_chance_rejected_without_editing_saved_scenario(ops_client, chance):
    client = ops_client
    original = create_chance(client)
    before = client.get(f"/api/scenarios/{original['id']}").json()
    response = client.patch(
        f"/api/scenarios/{original['id']}",
        headers={"If-Match": str(original["revision"]), "Content-Type": "application/json"},
        content=json.dumps({"hospital_operations": {"disruption_chance_percent": chance}}),
    )
    assert response.status_code == 422, response.text
    assert client.get(f"/api/scenarios/{original['id']}").json() == before


def test_default_zero_is_not_materialized_into_historical_operations_or_input_digest(ops_client):
    assert command_dict(HospitalOperationsSettings.model_validate(operations())) == operations()
    client = ops_client
    frozen = enqueue(client, version="1.2")
    before = payload(client, frozen["id"])
    assert "disruption_chance_percent" not in before["scenario"]["hospital_operations"]
    assert digest({"dataset": client.dataset, "scenario": before["scenario"]}) == before["input_sha256"]
    finished = complete(client, frozen["id"])
    assert payload(client, frozen["id"]) == before
    assert "disruption_chance_percent" not in finished["scenario_context"]["hospital_operations"]
    assert finished["hospital_operations_model_version"] == "1.2"


def test_hundred_percent_run_freezes_chance_records_actual_pauses_and_survives_draft_change(ops_client):
    client = ops_client
    original = create_chance(client, 100)
    response = client.post("/api/run-groups", json={"scenario_id": original["id"]})
    assert response.status_code == 202, response.text
    queued = response.json()
    frozen = payload(client, queued["id"])
    changed = client.patch(
        f"/api/scenarios/{original['id']}",
        headers={"If-Match": str(original["revision"])},
        json={"hospital_operations": None},
    )
    assert changed.status_code == 200, changed.text
    completed = complete(client, queued["id"])
    assert completed["hospital_operations_model_version"] == "1.3"
    assert completed["source_draft_revision"] == original["revision"]
    assert completed["scenario_context"]["hospital_operations"] == {"disruption_chance_percent": 100}
    assert payload(client, queued["id"]) == frozen
    assert client.get(f"/api/scenarios/{original['id']}").json()["hospital_operations"] is None
    metrics = client.get(f"/api/run-groups/{queued['id']}/metrics", params={"grain": "day"})
    assert metrics.status_code == 200, metrics.text
    values = metrics.json()
    assert values["context"]["scenario_revision_id"] == completed["scenario_revision_id"]
    assert values["hospital_operations_model_version"] == "1.3"
    assert values["scalar_metrics"]["success_score_percent"]["p50"] == 0
    assert [row["treatment_disruption_hours"]["p50"] for row in values["data"]] == pytest.approx([24, 24, 24])
    assert all(row["arrivals"]["p50"] > 0 for row in values["data"])
    evidence = client.get(f"/api/run-groups/{queued['id']}/bottlenecks").json()
    assert evidence["scope"] == "ensemble" and evidence["evidence_available"]
    assert any(row["reason"] == "treatment_disruption" for row in evidence["categories"])
    rep = completed["selected_replication_id"]
    events = client.get(f"/api/runs/{rep}/events", params={"limit": 200}).json()
    assert events["event_type_counts"]["arrival"] > 0
    for kind in ("admission", "assessment_start", "assessment_end", "discharge"):
        assert events["event_type_counts"].get(kind, 0) == 0
    with client.app.state.Session() as session:
        trace = ArtifactStore().get_json(session.get(Document, rep).data["trace_artifact"])
        assert len(trace["sampled_disruption_days"]) == 3
        assert all(day["affected"] for day in trace["sampled_disruption_days"])


@pytest.mark.parametrize("version", ["1.0", "1.1", "1.2"])
def test_new_probability_cannot_be_dispatched_under_an_older_frozen_model(version):
    frozen = {
        "model_version": MODEL_VERSION,
        "hospital_operations_model_version": version,
        "scenario": {"hospital_operations": {"disruption_chance_percent": 50}},
    }
    with pytest.raises(ModelVersionMismatch):
        execution_scenario(frozen)


def test_changed_probability_cannot_rewrite_a_branch_prefix_but_unchanged_chance_can_continue(ops_client):
    client = ops_client
    original = create_chance(client, 100, days=2)
    parent = complete(client, enqueue(client, scenario_id=original["id"])["id"])
    child = branch_from(client, parent, enqueue_branch=False)["scenario"]
    changed = client.patch(
        f"/api/scenarios/{child['id']}",
        headers={"If-Match": str(child["revision"])},
        json={"hospital_operations": {"disruption_chance_percent": 50}},
    )
    assert changed.status_code == 200, changed.text
    rejected = client.post("/api/run-groups", json={"scenario_id": child["id"]})
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["error"]["code"] == "MODEL_VERSION_MISMATCH"
    assert "chance" in rejected.json()["error"]["message"].lower()
    restored = client.patch(
        f"/api/scenarios/{child['id']}",
        headers={"If-Match": str(changed.json()["revision"])},
        json={"hospital_operations": {"disruption_chance_percent": 100}},
    )
    assert restored.status_code == 200, restored.text
    allowed = client.post("/api/run-groups", json={"scenario_id": child["id"]})
    assert allowed.status_code == 202, allowed.text
    finished = complete(client, allowed.json()["id"])
    assert finished["hospital_operations_model_version"] == "1.3"
    assert finished["scenario_context"]["parent_run_group_id"] == parent["id"]


def test_worker_prefix_guard_and_scratch_reset_policies_cannot_bypass_chance_lineage():
    original = {
        "model_version": MODEL_VERSION,
        "hospital_operations_model_version": "1.3",
        "scenario": {"hospital_operations": {"disruption_chance_percent": 50}},
    }
    changed = copy.deepcopy(original)
    changed["scenario"]["hospital_operations"]["disruption_chance_percent"] = 75
    with pytest.raises(ModelVersionMismatch):
        require_matching_operations_history(changed, original)
    with pytest.raises(ModelVersionMismatch):
        operations_version_for_new_run(changed["scenario"], original)
    assert operations_version_for_new_run(original["scenario"], original) == "1.3"
    assert operations_version_for_new_run(changed["scenario"]) == "1.3"


def test_comparison_plans_freeze_same_probability_and_preserve_existing_results_after_draft_edit(ops_client):
    client = ops_client
    original = create_chance(client, 50, days=2)
    response = client.post(
        "/api/comparisons",
        json={
            "scenario_id": original["id"],
            "replications": 2,
            "plans": [{"name": "Same resources", "interventions": []}],
        },
    )
    assert response.status_code == 202, response.text
    comparison = response.json()
    assert comparison["hospital_operations_model_version"] == "1.3"
    for plan in comparison["plans"]:
        assert payload(client, plan["run_group_id"])["scenario"]["hospital_operations"] == {
            "disruption_chance_percent": 50
        }
        execute_job(plan["run_group_id"], client.database_url)
    completed = client.get(f"/api/comparisons/{comparison['id']}").json()
    assert completed["status"] == "SUCCEEDED"
    assert (
        completed["plans"][0]["metrics"]["scalar_metrics"]
        == completed["plans"][1]["metrics"]["scalar_metrics"]
    )
    changed = client.patch(
        f"/api/scenarios/{original['id']}",
        headers={"If-Match": str(original["revision"])},
        json={"hospital_operations": {"disruption_chance_percent": 100}},
    )
    assert changed.status_code == 200, changed.text
    assert completed["source_draft_revision"] < changed.json()["revision"]
    assert client.get(f"/api/comparisons/{comparison['id']}").json() == completed
