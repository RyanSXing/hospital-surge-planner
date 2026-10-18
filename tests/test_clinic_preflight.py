"""Clinic destination/policy errors must be actionable before work is queued."""

# ruff: noqa: F811 -- shared pytest fixture is injected by name.
import copy

import pytest
from sqlalchemy import func, select
from surge_api.db import AuditEvent, Document, Job
from surge_api.domain import scenario_defaults, validate_scenario
from surge_engine import generate_dataset
from test_api import client, create_short_scenario, setup_context  # noqa: F401


@pytest.fixture(scope="module")
def source():
    return generate_dataset(days=3)


def report(data, **plan):
    scenario = scenario_defaults(
        {
            "horizon_calendar_days": 1,
            "replications": 1,
            "interventions": [{"kind": "clinic", "activation_minutes": 0, **plan}],
        },
        data,
    )
    return validate_scenario(scenario, data)


@pytest.mark.parametrize(
    "plan,field",
    [
        ({"clinic_policy_id": "MISSING"}, "clinic_policy_id"),
        ({"destination_unit_id": "UNIT-WARD-A"}, "destination_unit_id"),
        ({"unit_id": "UNIT-WARD-A"}, "unit_id"),
        ({"facility_id": "FAC-MAIN"}, "facility_id"),
        ({"unit_id": "UNIT-CLINIC-NORTH", "facility_id": "FAC-MAIN"}, "facility_id"),
    ],
)
def test_clinic_invalid_targets_and_policy_have_field_errors(source, plan, field):
    result = report(source, **plan)
    assert not result["valid"]
    assert any(item["field"] == "interventions.0." + field for item in result["errors"])


@pytest.mark.parametrize(
    "plan",
    [
        {},
        {"unit_id": "UNIT-CLINIC-NORTH"},
        {"destination_unit_id": "UNIT-CLINIC-NORTH"},
        {"facility_id": "FAC-CLINIC-NORTH"},
        {"kind": "activate_clinic"},
    ],
)
def test_canonical_clinic_target_forms_are_supported(source, plan):
    result = report(source, **plan)
    assert result["valid"], result["errors"]


def test_custom_clinic_ids_and_policy_destination_match(source):
    data = copy.deepcopy(source)
    unit = next(unit for unit in data["units"] if unit["unit_id"] == "UNIT-CLINIC-NORTH")
    unit.update(unit_id="UNIT-CUSTOM-CLINIC", facility_id="FAC-CUSTOM-CLINIC")
    next(site for site in data["facilities"] if site["facility_id"] == "FAC-CLINIC-NORTH")["facility_id"] = (
        "FAC-CUSTOM-CLINIC"
    )
    data["clinic_policies"][0]["site_id"] = "FAC-CUSTOM-CLINIC"
    for plan in (
        {"facility_id": "FAC-CUSTOM-CLINIC"},
        {"unit_id": "UNIT-CUSTOM-CLINIC"},
        {"destination_unit_id": "UNIT-CUSTOM-CLINIC", "clinic_policy_id": "CLINIC-POLICY"},
    ):
        result = report(data, **plan)
        assert result["valid"], result["errors"]
    assert not report(data)["valid"], "A missing default unit must require explicit selection"
    data["clinic_policies"].append(
        {**data["clinic_policies"][0], "clinic_policy_id": "OTHER-SITE", "site_id": "FAC-CLINIC-NORTH"}
    )
    result = report(data, facility_id="FAC-CUSTOM-CLINIC", clinic_policy_id="OTHER-SITE")
    assert any(item["field"] == "interventions.0.clinic_policy_id" for item in result["errors"])


def test_implicit_policy_uses_unique_ed_pathway_preference(source):
    data = copy.deepcopy(source)
    data["clinic_policies"].append({**data["clinic_policies"][0], "clinic_policy_id": "SECOND-CLINIC"})
    assert report(data)["valid"]
    assert report(data, clinic_policy_id="SECOND-CLINIC")["valid"]
    for pathway in data["pathway_profiles"]:
        pathway.pop("clinic_policy_id", None)
    result = report(data)
    assert not result["valid"]
    assert any(item["field"] == "interventions.0.clinic_policy_id" for item in result["errors"])
    ed_path = next(path for path in data["pathway_profiles"] if path["entry_stream_id"] == "ED_MAIN")
    ed_path["clinic_policy_id"] = "CLINIC-POLICY"
    data["pathway_profiles"].append(
        {**ed_path, "pathway_profile_id": "SECOND-PATH", "clinic_policy_id": "SECOND-CLINIC"}
    )
    assert not report(data)["valid"], "Two preferred policies are still ambiguous"
    assert report(data, clinic_policy_id="SECOND-CLINIC")["valid"]
    data["clinic_policies"] = []
    assert not report(data)["valid"]


def test_clinic_default_profile_requires_a_declared_unambiguous_choice(source):
    data = copy.deepcopy(source)
    profile = next(profile for profile in data["resource_profiles"] if profile["stage_kind"] == "clinic")
    profile["resource_profile_id"] = "CUSTOM-CLINIC"
    assert report(data)["valid"]
    data["resource_profiles"].append({**profile, "resource_profile_id": "SECOND-CLINIC"})
    assert any(item["field"] == "interventions.0.clinic_profile" for item in report(data)["errors"])
    data["resource_profiles"] = [
        profile for profile in data["resource_profiles"] if profile["stage_kind"] != "clinic"
    ]
    assert not report(data)["valid"]
    assert report(data, enabled=False)["valid"], "Disabled interventions require no clinic default"


def counts(client):
    with client.app.state.Session() as session:
        return tuple(
            session.scalar(select(func.count()).select_from(model)) for model in (Job, Document, AuditEvent)
        )


def test_clinic_bad_input_cannot_create_scenario_or_queue_existing_draft(client, monkeypatch):
    context = setup_context(client, "planning_baseline")
    scenario = create_short_scenario(client, context, replications=1)

    def unexpected(*args, **kwargs):
        raise AssertionError("Preflight must not construct a simulation")

    monkeypatch.setattr("surge_engine.simulation.HospitalSimulation.__init__", unexpected)
    for plan, field in [
        ({"clinic_policy_id": "MISSING"}, "clinic_policy_id"),
        ({"destination_unit_id": "UNIT-WARD-A"}, "destination_unit_id"),
        ({"facility_id": "FAC-MAIN"}, "facility_id"),
    ]:
        interventions = [{"kind": "clinic", "activation_minutes": 0, **plan}]
        before = counts(client)
        created = client.post(
            "/api/scenarios",
            json={"dataset_version_id": context["dataset"]["id"], "interventions": interventions},
        )
        assert created.status_code == 422, created.text
        assert any(item["field"] == "interventions.0." + field for item in created.json()["error"]["fields"])
        assert counts(client) == before
        # Historical/imported drafts are revalidated at the queue boundary too.
        with client.app.state.Session.begin() as session:
            draft = session.get(Document, scenario["id"])
            draft.data = {**draft.data, "interventions": interventions}
        before = counts(client)
        validation = client.post(f"/api/scenarios/{scenario['id']}/validate")
        assert validation.status_code == 200 and not validation.json()["valid"]
        queued = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
        assert queued.status_code == 422, queued.text
        assert any(item["field"] == "interventions.0." + field for item in queued.json()["error"]["fields"])
        assert counts(client) == before, "Rejected runs must not persist jobs, revisions or audit events"
    with client.app.state.Session.begin() as session:
        draft = session.get(Document, scenario["id"])
        draft.data = {**draft.data, "interventions": [{"kind": "clinic", "activation_minutes": 0}]}
    queued = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
    assert queued.status_code == 202, queued.text
