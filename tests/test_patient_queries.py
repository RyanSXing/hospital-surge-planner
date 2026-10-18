# ruff: noqa: F401,F811
import pytest
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job
from surge_api.patients import remaining_summary
from test_api import client, setup_context


@pytest.mark.parametrize("fixture,eligible", [("planning_baseline", "true"), ("hospital_baseline", "false")])
def test_source_patient_filters_keep_residual_mean_and_validate_bounds(client, fixture, eligible):
    context = setup_context(client, fixture)
    endpoint = f"/api/datasets/{context['dataset']['id']}/patients"
    result = client.get(
        endpoint, params={"care_level": "ward", "remaining_max_hours": 25, "transfer_eligible": eligible}
    ).json()
    assert result["total"] == 25
    assert all(bool(p.get("eligible_for_transfer")) == (eligible == "true") for p in result["items"])
    assert all(
        p["remaining_summary"]["hours"] == 24 and p["required_care_level"] == "ward" for p in result["items"]
    )
    assert all(p["remaining_summary"]["basis"] == "residual_template_mean" for p in result["items"])
    patient = result["items"][0]
    assert client.get(endpoint, params={"search": patient["patient_id"]}).json()["total"] == 1
    for query in (
        {"remaining_min_hours": -1},
        {"remaining_min_hours": 10, "remaining_max_hours": 2},
        {"remaining_max_hours": "NaN"},
        {"arrival_from": "2026-10-17"},
        {"arrival_from": "2026-10-18T00:00:00Z", "arrival_until": "2026-10-17T00:00:00Z"},
    ):
        assert client.get(endpoint, params=query).status_code == 422


def test_selected_census_filters_exact_next_care_wait_and_unit_evidence(client):
    setup_context(client)
    at = "2026-10-16T05:00:00Z"
    rep = "query-test-rep"
    entries = [
        ("P0", "inpatient", "ward", None, False, True, "2026-10-14T05:00:00Z", "2026-10-16T07:00:00Z"),
        ("P1", "inpatient", "icu", "ward", True, True, "2026-10-15T05:00:00Z", at),
        ("P2", "direct_waiting", "ward", "ward", True, False, "2026-10-16T04:00:00Z", None),
        (
            "P3",
            "ed_assessment",
            "ambulatory",
            None,
            False,
            False,
            "2026-10-16T04:30:00Z",
            "2026-10-16T06:30:00Z",
        ),
    ]
    patients = [
        {
            "patient_id": identity,
            "arrival_at": arrival,
            "admission_requested_at": "2026-10-15T23:00:00Z" if identity == "P1" else arrival,
            "state_intervals": [
                {
                    "start_at": at,
                    "start_elapsed_minutes": 0,
                    "state": state,
                    "care_level": care,
                    "target_unit_kind": target,
                    "admission_pending": pending,
                    "eligible_for_transfer": eligible,
                    "unit_id": "U",
                    "facility_id": "FAC-MAIN",
                    "expected_stage_end_at": end,
                    "queue_group": "ward:O2" if pending else None,
                    "inpatient_resource_requirements": ["WARD_OXYGEN"] if pending else [],
                    "resource_requirements": ["ICU_MONITOR"] if care == "icu" else [],
                }
            ],
        }
        for identity, state, care, target, pending, eligible, arrival, end in entries
    ]
    unit = {
        "unit_id": "U",
        "facility_id": "FAC-MAIN",
        "kind": "ward",
        "at": at,
        "elapsed_minutes": 0,
        "physical": 2,
        "enabled": 2,
        "staffed": 2,
        "occupied": 1,
        "active": True,
        "admission_gate": True,
        "active_staff_ids": ["RN1"],
    }
    trace = {
        "replication_id": rep,
        "start_at": at,
        "horizon_elapsed_minutes": 60,
        "patients": patients,
        "unit_history": {"U": [unit]},
        "blocker_history": {
            "ward:O2": [
                {"start_elapsed_minutes": 0, "reasons": ["nursing_capacity"], "units": [{"unit_id": "U"}]}
            ]
        },
        "unit_series": {"U": {"fields": {"occupied": [1], "staffed": [2]}}},
        "series": [{"at": at, "ward_queue": 2}],
        "events": [],
    }
    artifact = ArtifactStore().put_json("workspace-main", rep, "trace", trace)
    with client.app.state.Session.begin() as session:
        session.add(
            Document(
                id=rep,
                workspace_id="workspace-main",
                kind="replication",
                data={"run_group_id": "query-run", "trace_artifact": artifact},
            )
        )
    endpoint = f"/api/runs/{rep}/patients"
    ward = client.get(endpoint, params={"care_level": "ward"}).json()
    assert {p["patient_id"] for p in ward["items"]} == {"P0", "P1", "P2"}
    waiting = client.get(
        endpoint, params={"waiting_reason": "nursing_capacity", "transfer_eligible": "true"}
    ).json()
    assert waiting["total"] == 1 and waiting["items"][0]["patient_id"] == "P1"
    assert waiting["items"][0]["waiting_hours"] == 6
    assert waiting["items"][0]["placement_resource_requirements"] == ["WARD_OXYGEN"]
    remaining = client.get(endpoint, params={"remaining_min_hours": 1, "remaining_max_hours": 3}).json()
    assert {p["patient_id"] for p in remaining["items"]} == {"P0", "P3"}
    arrived = client.get(
        endpoint,
        params={"arrival_from": "2026-10-15T00:00:00-05:00", "arrival_until": "2026-10-16T04:30:00Z"},
    ).json()
    assert {p["patient_id"] for p in arrived["items"]} == {"P1", "P2"}
    evidence = client.get(f"/api/runs/{rep}/units/U/timeline").json()
    assert evidence["current"]["active_staff_ids"] == ["RN1"]
    assert evidence["series"][0]["occupied"] == 1
    assert evidence["series"][0]["shared_care_queue"] == 2 and "shared" in evidence["queue_scope"]


def test_conditional_residual_summary_does_not_restart_total_stay():
    result = remaining_summary(
        {
            "state": "inpatient",
            "remaining_stage_spec": {
                "kind": "conditional_total",
                "distribution_id": "EXP",
                "elapsed_minutes": 2880,
            },
        },
        "2026-10-16T05:00:00Z",
        {"EXP": {"template_id": "EXP", "family": "gamma", "shape": 1, "scale_hours": 24}},
    )
    assert abs(result["hours"] - 24) < 1e-9
    assert result["basis"] == "conditional_mean"
