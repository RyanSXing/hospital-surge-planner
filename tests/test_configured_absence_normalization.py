"""Percentage staffing assumptions follow the edited starting roster."""

import copy

import pytest
from fastapi.testclient import TestClient
from surge_api.domain import add_document, normalize_conditions, normalize_dataset, scenario_defaults
from surge_api.main import create_app
from surge_engine import generate_dataset, run_replication, state_at


@pytest.fixture(scope="module")
def hospital():
    return generate_dataset(fixture="hospital_baseline", days=2)


def inputs(dataset, kind="staff_absence", **absence):
    value = scenario_defaults({}, dataset)
    value.update(
        horizon_calendar_days=1,
        replications=1,
        conditions=[
            {
                "kind": kind,
                "unit_id": "UNIT-WARD-A",
                "absence_percent": 50,
                "start_at": dataset["snapshot_at"],
                "end_at": "2026-10-17T05:00:00Z",
                **absence,
            },
            {
                "id": "configured-ward",
                "kind": "unit_configuration",
                "unit_id": "UNIT-WARD-A",
                "physical_capacity": 40,
                "enabled_capacity": 40,
                "staffed_capacity": 40,
                "staff_counts": {"rn": 12, "provider": 2, "support": 4},
                "source": "user_assumption",
                "configuration_control": {"owner": "main_configuration"},
            },
        ],
    )
    return value


@pytest.mark.parametrize("kind", ["staff_absence", "staff_unavailability"])
def test_percentage_uses_configured_count_and_matches_direct_engine(hospital, kind):
    value = inputs(hospital, kind)
    before = copy.deepcopy(value)
    normalized = normalize_conditions(value, hospital)
    assert normalized["conditions"][0]["count"] == 6
    assert normalized["conditions"][1] == value["conditions"][1]
    assert value == before
    for scenario in (value, normalized):
        unit = next(
            u
            for u in state_at(run_replication(hospital, scenario), 1)["units"]
            if u["unit_id"] == "UNIT-WARD-A"
        )
        assert unit["qualified_staff_by_role"]["rn"] == 6
        assert unit["staffed"] == 24


def test_saved_percentage_recomputes_when_initial_roster_changes(hospital):
    value = normalize_conditions(inputs(hospital), hospital)
    value["conditions"][1]["staff_counts"]["rn"] = 14
    normalized = normalize_conditions(value, hospital)
    assert normalized["conditions"][0]["count"] == 7
    assert normalize_conditions(normalized, hospital) == normalized
    # A pre-configuration scenario also follows its original source roster.
    value["conditions"] = value["conditions"][:1]
    assert normalize_conditions(value, hospital)["conditions"][0]["count"] == 4


def test_exact_counts_named_people_and_untouched_roles_keep_their_semantics(hospital):
    value = inputs(hospital, count=3)
    del value["conditions"][0]["absence_percent"]
    assert normalize_conditions(value, hospital)["conditions"][0] == {
        **value["conditions"][0],
        "kind": "staff_unavailability",
    }
    value = inputs(hospital, staff_ids=["STAFF-T1-WARD-A-RN-01"], count=1)
    assert normalize_conditions(value, hospital)["conditions"][0] == {
        **value["conditions"][0],
        "kind": "staff_unavailability",
    }
    value = inputs(hospital)
    value["conditions"][1]["staff_counts"] = {"provider": 3}
    assert normalize_conditions(value, hospital)["conditions"][0]["count"] == 4


def test_create_and_patch_preserve_configuration_and_renormalize_percentage(hospital, tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.delenv("REDIS_URL", raising=False)
    app = create_app(
        "sqlite:///" + str(tmp_path / "configured-absence.db"), seed=False, start_dispatcher=False
    )
    data = normalize_dataset(hospital)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", data)
    value = inputs(data)
    payload = {
        key: value[key]
        for key in ("dataset_version_id", "horizon_calendar_days", "replications", "conditions")
    }
    with TestClient(app, raise_server_exceptions=False) as client:
        created = client.post("/api/scenarios", json=payload)
        assert created.status_code == 201, created.text
        saved = created.json()
        assert saved["conditions"][0]["count"] == 6
        assert saved["conditions"][1] == payload["conditions"][1]
        updated = copy.deepcopy(saved["conditions"])
        updated[1]["staff_counts"]["rn"] = 14
        response = client.patch(
            "/api/scenarios/" + saved["id"],
            json={"conditions": updated},
            headers={"If-Match": str(saved["revision"])},
        )
        assert response.status_code == 200, response.text
        assert response.json()["conditions"][0]["count"] == 7
        assert response.json()["conditions"][1] == updated[1]
