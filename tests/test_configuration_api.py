"""Saved configuration reaches the worker; observed snapshots replace its stock/roster."""

import copy
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.worker import execute_job
from surge_engine import generate_dataset
from surge_engine.common import digest, dt, iso


@pytest.fixture(scope="module")
def configured_api(tmp_path_factory):
    root = tmp_path_factory.mktemp("configuration-api")
    patch = pytest.MonkeyPatch()
    patch.setenv("APP_ENV", "development")
    patch.setenv("ARTIFACT_LOCAL_DIR", str(root / "artifacts"))
    patch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(root / "configuration.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    dataset = normalize_dataset(generate_dataset(fixture="hospital_baseline", days=2))
    original_digest = digest(dataset)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url = url
        client.dataset = dataset
        client.dataset_digest = original_digest
        before = client.get(f"/api/datasets/{dataset['id']}")
        assert before.status_code == 200, before.text
        client.dataset_before = before.json()
        created = client.post(
            "/api/scenarios",
            json={
                "name": "Configured ICU API lifecycle",
                "dataset_version_id": dataset["id"],
                "horizon_calendar_days": 1,
                "replications": 1,
                "conditions": [
                    {
                        "id": "configured-icu",
                        "kind": "unit_configuration",
                        "unit_id": "UNIT-ICU",
                        "physical_capacity": 20,
                        "enabled_capacity": 20,
                        "staffed_capacity": 18,
                        "staff_counts": {"rn": 8, "provider": 3, "support": 4},
                        "source": "user_assumption",
                        "configuration_control": {"owner": "main_configuration"},
                    },
                    {
                        "id": "retained-demand",
                        "kind": "arrival_multiplier",
                        "entry_stream_id": "ED_MAIN",
                        "surge_percent": 10,
                        "start_at": dataset["snapshot_at"],
                        "end_at": "2026-10-17T05:00:00Z",
                    },
                ],
            },
        )
        assert created.status_code == 201, created.text
        initial = created.json()
        edited = copy.deepcopy(initial["conditions"])
        edited[0]["staff_counts"]["rn"] = 9
        saved = client.patch(
            f"/api/scenarios/{initial['id']}",
            headers={"If-Match": str(initial["revision"])},
            json={"conditions": edited},
        )
        assert saved.status_code == 200, saved.text
        client.saved = saved.json()
        client.saved_conditions = edited
        reloaded = client.get(f"/api/scenarios/{initial['id']}")
        assert reloaded.status_code == 200, reloaded.text
        assert reloaded.json()["conditions"] == edited
        accepted = client.post("/api/run-groups", json={"scenario_id": initial["id"]})
        assert accepted.status_code == 202, accepted.text
        queued = accepted.json()
        # Mutate the draft after enqueue. The worker must execute the saved
        # nine-nurse revision that was frozen when the job was accepted.
        later = copy.deepcopy(edited)
        later[0]["staff_counts"]["rn"] = 10
        changed = client.patch(
            f"/api/scenarios/{initial['id']}",
            headers={"If-Match": str(client.saved["revision"])},
            json={"conditions": later},
        )
        assert changed.status_code == 200, changed.text
        client.latest_draft = changed.json()
        execute_job(queued["id"], url)
        completed = client.get(f"/api/run-groups/{queued['id']}")
        assert completed.status_code == 200, completed.text
        client.completed = completed.json()
        assert client.completed["status"] == "SUCCEEDED", client.completed
        yield client
    app.state.engine.dispose()
    patch.undo()


def icu_at(client, replication, start, minute):
    response = client.get(
        f"/api/runs/{replication}/state",
        params={"at": iso(dt(start) + timedelta(minutes=minute))},
    )
    assert response.status_code == 200, response.text
    state = response.json()
    unit = next(row for row in state["units"] if row["unit_id"] == "UNIT-ICU")
    return state, unit


def test_saved_configuration_runs_frozen_counts_across_shifts_without_mutating_source(configured_api):
    client = configured_api
    completed = client.completed
    assert completed["replications_completed"] == 1
    assert completed["scenario_context"]["conditions"] == client.saved_conditions
    assert completed["source_draft_revision"] == client.saved["revision"]
    assert client.latest_draft["conditions"][0]["staff_counts"]["rn"] == 10
    original_staff = {row["staff_id"] for row in client.dataset["staff"]}
    active_teams = []
    for minute in (0, 420, 720, 721, 1140, 1439):
        state, unit = icu_at(
            client,
            completed["selected_replication_id"],
            completed["start_at"],
            minute,
        )
        # Twenty installed beds and eighteen requested staffed beds remain
        # constrained by the unchanged blanket stock of sixteen ICU monitors.
        assert (unit["physical"], unit["enabled"], unit["staffed"]) == (20, 20, 16)
        assert unit["qualified_staff_by_role"] == {"rn": 9, "provider": 3, "support": 4}
        assert len(unit["active_staff_ids"]) == 16
        assert all(identity not in original_staff for identity in unit["active_staff_ids"])
        assert all(identity.startswith("STAFF-CONFIG-") for identity in unit["active_staff_ids"])
        active_teams.append(set(unit["active_staff_ids"]))
        monitors = next(
            pool for pool in state["equipment_pools"] if pool["equipment_pool_id"] == "EQ-ICU-MONITOR"
        )
        assert monitors["quantity"] == 16
    assert active_teams[0].isdisjoint(active_teams[2]), "The twelve-hour shift rotates identities"
    assert active_teams[2] == active_teams[3], "A minute after handoff retains the same on-duty team"
    after = client.get(f"/api/datasets/{client.dataset['id']}")
    assert after.status_code == 200, after.text
    assert after.json() == client.dataset_before
    assert digest(client.dataset) == client.dataset_digest


def test_complete_observed_reset_replaces_inherited_configuration_with_observed_stock_and_roster(
    configured_api,
):
    client = configured_api
    parent = client.completed
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": client.saved["id"],
            "type": "census_replacement",
            "effective_at": client.dataset["snapshot_at"],
            "state_origin": "observed_reset",
            "payload": {"observed_dataset_version_id": client.dataset["id"]},
        },
    )
    assert event.status_code == 201, event.text
    applied = client.post(
        f"/api/updates/{event.json()['id']}/apply",
        json={
            "parent_scenario_revision_id": parent["scenario_revision_id"],
            "source": {
                "observed_dataset_version_id": client.dataset["id"],
                "parent_run_group_id": parent["id"],
                "reference_replication_id": parent["selected_replication_id"],
            },
        },
    )
    assert applied.status_code == 200, applied.text
    value = applied.json()
    reset = value["scenario"]
    assert reset["state_origin"] == "observed_reset"
    assert reset["dataset_version_id"] == client.dataset["id"]
    assert reset["conditions"] == [client.saved_conditions[1]], (
        "Demand assumptions survive the stock/roster reset"
    )
    assert all(condition["kind"] != "unit_configuration" for condition in reset["conditions"])
    execute_job(value["run_group_id"], client.database_url)
    response = client.get(f"/api/run-groups/{value['run_group_id']}")
    assert response.status_code == 200, response.text
    completed = response.json()
    assert completed["status"] == "SUCCEEDED", completed
    assert completed["scenario_context"]["conditions"] == reset["conditions"]
    observed_staff = {row["staff_id"] for row in client.dataset["staff"]}
    for minute in (0, 420, 720, 1140, 1439):
        _, unit = icu_at(client, completed["selected_replication_id"], completed["start_at"], minute)
        assert (unit["physical"], unit["enabled"], unit["staffed"]) == (12, 12, 12)
        assert unit["qualified_staff_by_role"] == {"rn": 6, "provider": 1, "support": 2}
        assert set(unit["active_staff_ids"]) <= observed_staff
        assert all(not identity.startswith("STAFF-CONFIG-") for identity in unit["active_staff_ids"])
    # Neither executing the configured run nor replacing it with a complete
    # observation may rewrite the immutable source inventory or roster.
    assert client.get(f"/api/datasets/{client.dataset['id']}").json() == client.dataset_before
    assert digest(client.dataset) == client.dataset_digest
