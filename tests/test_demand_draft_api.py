import copy

import pytest
from surge_engine import estimate_expected_arrivals
from test_dataset_contract_validation import client as contract_client
from test_dataset_contract_validation import source as contract_source


@pytest.fixture(scope="module")
def source():
    return contract_source.__wrapped__()


@pytest.fixture(scope="module")
def client(tmp_path_factory, source):
    yield from contract_client.__wrapped__(tmp_path_factory, source)


def draft_for(client):
    response = client.post("/api/dataset-drafts", json={"source_dataset_version_id": client.dataset["id"]})
    assert response.status_code == 201
    return response.json()


def edit(client, draft, operations):
    return client.patch(
        f"/api/dataset-drafts/{draft['id']}/entities",
        headers={"If-Match": str(draft["revision"])},
        json={"operations": operations},
    )


def test_editing_authoritative_rate_updates_summary_and_commits_without_second_edit(client):
    original = copy.deepcopy(client.dataset)
    draft = draft_for(client)
    stream = copy.deepcopy(next(s for s in original["entry_streams"] if s["entry_type"] == "ed"))
    stream["expected_arrivals_per_local_day"] = 120
    response = edit(client, draft, [{"collection": "entry_streams", "entity": stream}])
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["validation"]["valid"], saved["validation"]["errors"]
    assert saved["dataset"]["arrival_profiles"]["ed_arrivals_per_local_day"] == 120
    assert saved["dataset"]["entry_streams"] != original["entry_streams"]
    assert {"entry_streams", "arrival_profiles", "hour_of_day_baseline", "weekday_baseline"} <= set(
        saved["dirty_fields"]
    )
    committed = client.post(
        f"/api/dataset-drafts/{draft['id']}/commit", headers={"If-Match": str(saved["revision"])}
    )
    assert committed.status_code == 201, committed.text
    result = committed.json()
    assert result["arrival_profiles"]["ed_arrivals_per_local_day"] == 120
    scenario = {"horizon_calendar_days": 1, "start_at": original["snapshot_at"]}
    assert estimate_expected_arrivals(result, scenario) > estimate_expected_arrivals(original, scenario)
    unchanged = client.get(f"/api/datasets/{original['id']}").json()
    assert unchanged["entry_streams"] == original["entry_streams"]
    assert unchanged["arrival_profiles"] == original["arrival_profiles"]


@pytest.mark.parametrize(
    "collection", ["arrival_profiles", "baseline", "hour_of_day_baseline", "weekday_baseline"]
)
def test_derived_summary_mutations_are_rejected_atomically(client, collection):
    draft = draft_for(client)
    stream = {**client.dataset["entry_streams"][0], "expected_arrivals_per_local_day": 120}
    response = edit(
        client,
        draft,
        [
            {"collection": "entry_streams", "entity": stream},
            {"collection": collection, "entity": {"ed_arrivals_per_local_day": 999}},
        ],
    )
    assert response.status_code == 422
    assert "read-only" in response.json()["error"]["message"]
    assert response.json()["error"]["fields"][0]["file"] == collection
    unchanged = client.get(f"/api/dataset-drafts/{draft['id']}").json()
    assert unchanged["revision"] == draft["revision"]
    assert unchanged["dataset"]["entry_streams"] == draft["dataset"]["entry_streams"]


def test_malformed_stream_demand_remains_reviewable_but_cannot_commit(client):
    draft = draft_for(client)
    stream = {**client.dataset["entry_streams"][0], "hour_weights": [1]}
    response = edit(client, draft, [{"collection": "entry_streams", "entity": stream}])
    assert response.status_code == 200, response.text
    saved = response.json()
    assert not saved["validation"]["valid"]
    assert any(
        e["file"] == "entry_streams" and e["field"] == "hour_weights" for e in saved["validation"]["errors"]
    )
    assert saved["dataset"]["arrival_profiles"] == draft["dataset"]["arrival_profiles"]
    assert (
        client.post(
            f"/api/dataset-drafts/{draft['id']}/commit", headers={"If-Match": str(saved["revision"])}
        ).status_code
        == 422
    )


def test_imported_contradictory_summary_still_fails_instead_of_being_repaired(client):
    original = copy.deepcopy(client.dataset)
    original["entry_streams"][0]["expected_arrivals_per_local_day"] = 120
    stage = client.post("/api/imports", json={"dataset": original}).json()
    report = client.post(f"/api/imports/{stage['id']}/validate").json()
    assert not report["valid"]
    assert any(e["field"] == "ed_arrivals_per_local_day" for e in report["errors"])
    assert client.post(f"/api/imports/{stage['id']}/commit").status_code == 422


def test_cohort_weight_edits_derive_summary_preserve_order_and_allow_intermediate_review(client):
    draft = draft_for(client)
    original = client.dataset
    ward = [copy.deepcopy(c) for c in original["cohorts"] if c["care_level"] == "ward"]
    ward[0]["selection_weight"] = 0.3
    first = edit(client, draft, [{"collection": "cohorts", "entity": ward[0]}])
    assert first.status_code == 200, first.text
    saved = first.json()
    assert not saved["validation"]["valid"]
    assert saved["dataset"]["arrival_profiles"]["cohort_mix"]["ward"][0] == 0.3
    assert (
        client.post(
            f"/api/dataset-drafts/{draft['id']}/commit", headers={"If-Match": str(saved["revision"])}
        ).status_code
        == 422
    )
    ward[1]["selection_weight"] = 0.5
    ward[2]["selection_weight"] = 0.2
    final = edit(client, saved, [{"collection": "cohorts", "entity": row} for row in ward[1:]])
    assert final.status_code == 200, final.text
    result = final.json()
    assert result["validation"]["valid"], result["validation"]["errors"]
    assert result["dataset"]["arrival_profiles"]["cohort_mix"]["ward"] == [0.3, 0.5, 0.2]
    assert [c["cohort_id"] for c in result["dataset"]["cohorts"]] == [
        c["cohort_id"] for c in original["cohorts"]
    ]
    assert result["dataset"]["pathway_profiles"] == original["pathway_profiles"]


def test_imported_normalized_but_disagreeing_cohort_summary_is_rejected(client):
    original = copy.deepcopy(client.dataset)
    original["arrival_profiles"]["cohort_mix"]["ward"] = [0.3, 0.5, 0.2]
    stage = client.post("/api/imports", json={"dataset": original}).json()
    report = client.post(f"/api/imports/{stage['id']}/validate").json()
    assert not report["valid"]
    assert any(e["field"] == "cohort_mix.ward" for e in report["errors"])
