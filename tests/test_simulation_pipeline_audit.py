"""Independent API-to-worker audits using isolated real hospital simulations.

Arrival counts are sampled, so these tests check exact expected exposure and
keyed patient identities, never pretend a multiplier fixes a Poisson count.
"""

import copy
from collections import defaultdict
from datetime import timedelta
from statistics import median
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job, digest
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.worker import execute_job
from surge_engine import generate_dataset
from surge_engine.common import dt, iso
from surge_engine.hospital_operations import OPERATIONS_MODEL_VERSION


@pytest.fixture(scope="module")
def pipeline(tmp_path_factory):
    root = tmp_path_factory.mktemp("simulation-pipeline-audit")
    patch = pytest.MonkeyPatch()
    patch.setenv("APP_ENV", "development")
    patch.setenv("ARTIFACT_LOCAL_DIR", str(root / "artifacts"))
    patch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(root / "audit.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    dataset = generate_dataset("hospital_baseline", days=30)
    # Retain real census, schedules, equipment and pathways while keeping this
    # a short integration suite rather than a load benchmark.
    rates = {"ed": 18, "direct_ward": 2}
    dataset["arrival_profiles"]["ed_arrivals_per_local_day"] = rates["ed"]
    dataset["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = rates["direct_ward"]
    for stream in dataset["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = rates[stream["entry_type"]]
    dataset = normalize_dataset(dataset)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url = url
        client.dataset = dataset
        yield client
    app.state.engine.dispose()
    patch.undo()


def create_scenario(client, **values):
    response = client.post(
        "/api/scenarios",
        json={
            "name": "Simulation pipeline audit",
            "dataset_version_id": client.dataset["id"],
            "horizon_calendar_days": 3,
            "replications": 1,
            "base_seed": 20261017,
            **values,
        },
    )
    assert response.status_code == 201, response.text
    # Read and later compare the same public representation, including its
    # read-only revision list, when checking rejected-write immutability.
    return client.get(f"/api/scenarios/{response.json()['id']}").json()


def patch_scenario(client, scenario, **values):
    response = client.patch(
        f"/api/scenarios/{scenario['id']}",
        headers={"If-Match": str(scenario["revision"])},
        json=values,
    )
    assert response.status_code == 200, response.text
    return response.json()


def enqueue(client, scenario):
    response = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
    assert response.status_code == 202, response.text
    return response.json()


def execute(client, queued):
    execute_job(queued["id"], client.database_url)
    response = client.get(f"/api/run-groups/{queued['id']}")
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "SUCCEEDED", run
    with client.app.state.Session() as session:
        job = session.get(Job, run["id"])
        rep = session.get(Document, run["selected_replication_id"])
        store = ArtifactStore()
        return (
            run,
            store.get_json(rep.data["trace_artifact"]),
            copy.deepcopy(job.payload),
            store.get_json(job.result["inputs_artifact"]),
        )


def local_boundary(client, index):
    local_start = dt(client.dataset["snapshot_at"]).astimezone(ZoneInfo(client.dataset["timezone"]))
    return iso(local_start + timedelta(days=index))


def arrival_curve(client, start, end, multiplier, identity):
    return {
        "id": identity,
        "kind": "arrival_multiplier",
        "entry_stream_id": "ED_MAIN",
        "shape": "step",
        "start_at": local_boundary(client, start),
        "end_at": local_boundary(client, end),
        "control_points": [
            {"at": local_boundary(client, start), "multiplier": multiplier},
            {"at": local_boundary(client, end), "multiplier": multiplier},
        ],
        "source": "user_assumption",
    }


def arrival_records(trace):
    rows = defaultdict(dict)
    zone = ZoneInfo(trace["timezone"])
    for event in trace["events"]:
        if event["event_type"] == "arrival":
            day = dt(event["occurred_at"]).astimezone(zone).date().isoformat()
            rows[event["payload"]["entry_type"], day][event["patient_id"]] = event["occurred_at"]
    return rows


@pytest.mark.parametrize("days", [7, 14, 30], ids=["one-week", "two-weeks", "one-month-dst"])
def test_saved_global_slider_and_late_dot_edits_drive_every_simulated_day(pipeline, days):
    client = pipeline
    first = create_scenario(client, horizon_calendar_days=days)
    baseline_job = enqueue(client, first)
    global_conditions = [arrival_curve(client, 0, days, 2.5, "whole-horizon-slider")]
    global_plan = patch_scenario(client, first, conditions=global_conditions)
    global_job = enqueue(client, global_plan)
    edits = {days - 1: 3, days - 4: 0, days // 2: 0.25}
    if days == 7:
        edits[1] = 0  # Keep a distinct zero day when the middle indices coincide.
    if days == 30:
        edits[16] = 0.25  # The repeated-clock day of the fall DST transition.
    daily_conditions = [
        arrival_curve(client, i, i + 1, factor, f"dot-day-{i}") for i, factor in edits.items()
    ]
    daily_plan = patch_scenario(client, global_plan, conditions=daily_conditions)
    daily_job = enqueue(client, daily_plan)
    future_draft = patch_scenario(client, daily_plan, name="Later unsimulated draft", conditions=[])
    # A stale browser cannot overwrite the newer draft or change any queued job.
    conflict = client.patch(
        f"/api/scenarios/{first['id']}",
        headers={"If-Match": str(daily_plan["revision"])},
        json={"conditions": global_conditions},
    )
    assert conflict.status_code == 409, conflict.text
    traces, arrivals = [], []
    for queued, saved in ((baseline_job, first), (global_job, global_plan), (daily_job, daily_plan)):
        run, trace, frozen, inputs = execute(client, queued)
        assert run["source_draft_revision"] == saved["revision"] < future_draft["revision"]
        assert frozen["scenario"]["conditions"] == saved["conditions"]
        assert inputs["scenario"] == frozen["scenario"]
        assert digest(inputs) == frozen["input_sha256"]
        assert run["start_at"] == local_boundary(client, 0)
        assert run["end_at"] == local_boundary(client, days)
        metrics = client.get(f"/api/run-groups/{run['id']}/metrics", params={"grain": "day"}).json()
        assert metrics["context"]["scenario_revision_id"] == run["scenario_revision_id"]
        assert metrics["context"]["run_group_id"] == run["id"]
        assert len(metrics["data"]) == len(trace["daily"]) == days
        records = arrival_records(trace)
        event_rows = [event for event in trace["events"] if event["event_type"] == "arrival"]
        assert len({event["patient_id"] for event in event_rows}) == len(event_rows)
        assert all(
            dt(run["start_at"]) <= dt(event["occurred_at"]) < dt(run["end_at"]) for event in event_rows
        )
        for index, day in enumerate(trace["daily"]):
            assert day["start_at"] == local_boundary(client, index)
            assert day["end_at"] == local_boundary(client, index + 1)
            count = sum(len(records[entry, day["local_date"]]) for entry in ("ed", "direct_ward"))
            assert day["arrivals"] == metrics["data"][index]["arrivals"]["p50"] == count
        assert trace["scalar_metrics"]["arrivals"] == len(event_rows)
        assert trace["scalar_metrics"]["patient_conservation_ok"]
        traces.append(trace)
        arrivals.append(records)
    for mode, trace in enumerate(traces):
        expected = 0
        for index in range(days):
            local = dt(local_boundary(client, index)).astimezone(ZoneInfo(client.dataset["timezone"]))
            day = local.date().isoformat()
            factor = 1 if mode == 0 else 2.5 if mode == 1 else edits.get(index, 1)
            for stream in client.dataset["entry_streams"]:
                expected += (
                    stream["expected_arrivals_per_local_day"]
                    * stream["weekday_weights"][local.weekday()]
                    * (factor if stream["entry_type"] == "ed" else 1)
                )
            normal, changed = arrivals[0]["ed", day], arrivals[mode]["ed", day]
            assert arrivals[mode]["direct_ward", day] == arrivals[0]["direct_ward", day]
            if factor == 1:
                assert changed == normal
            elif factor == 0:
                assert normal and not changed
            elif factor > 1:
                assert normal.items() < changed.items(), (days, mode, index)
            else:
                assert changed.items() < normal.items(), (days, mode, index)
        assert trace["scalar_metrics"]["expected_arrivals"] == pytest.approx(expected)
    if days == 30:
        assert (dt(traces[-1]["end_at"]) - dt(traces[-1]["start_at"])).total_seconds() / 3600 == 721
        dst = next(row for row in traces[-1]["daily"] if row["local_date"] == "2026-11-01")
        assert (dt(dst["end_at"]) - dt(dst["start_at"])).total_seconds() / 3600 == 25
    with client.app.state.Session() as session:
        assert session.get(Document, client.dataset["id"]).data == client.dataset
    assert client.get(f"/api/scenarios/{first['id']}").json()["conditions"] == []


def severity():
    return {
        "low": {"percentage": 60, "average_stay_hours": 24},
        "medium": {"percentage": 30, "average_stay_hours": 72},
        "high": {"percentage": 10, "average_stay_hours": 168},
    }


def supplies():
    return {
        "initial_percent": 5,
        "capacity": 100,
        "usage_per_patient_day": 0,
        "refill_every_days": 3,
        "refill_percent": 3,
    }


def interruption(client, start=1, end=2, identity="interruption"):
    return {"id": identity, "start_at": local_boundary(client, start), "end_at": local_boundary(client, end)}


def test_local_calendar_supplies_and_disruption_results_survive_api_round_trip(pipeline):
    client = pipeline
    operations = {"supplies": supplies(), "disruptions": [interruption(client, 16, 17, "dst-day")]}
    saved = create_scenario(client, horizon_calendar_days=30, hospital_operations=operations)
    queued = enqueue(client, saved)
    patch_scenario(client, saved, hospital_operations=None)
    run, trace, frozen, inputs = execute(client, queued)
    assert frozen["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    assert inputs["scenario"]["hospital_operations"] == operations
    refills = [event for event in trace["events"] if event["event_type"] == "medical_supplies_refilled"]
    assert [event["occurred_at"] for event in refills] == [local_boundary(client, i) for i in range(3, 30, 3)]
    assert all(event["payload"]["added_units"] == 3 for event in refills)
    begin, end = dt(local_boundary(client, 16)), dt(local_boundary(client, 17))
    during = [event for event in trace["events"] if begin <= dt(event["occurred_at"]) < end]
    assert any(event["event_type"] == "arrival" for event in during)
    assert not any(
        event["event_type"] in {"admission", "assessment_start", "assessment_end", "discharge"}
        for event in during
    )
    assert any(
        event["event_type"] == "assessment_start" and dt(event["occurred_at"]) >= end
        for event in trace["events"]
    )
    weighted_stock, hours = 0, 0
    for index, day in enumerate(trace["daily"]):
        expected = 5 + 3 * (index // 3)
        elapsed = (dt(day["end_at"]) - dt(day["start_at"])).total_seconds() / 3600
        weighted_stock += expected * elapsed
        hours += elapsed
        assert day["medical_supply_average_percent"] == pytest.approx(expected)
        assert day["medical_supply_end_percent"] == pytest.approx(expected)
        assert day["medical_supply_consumed_units"] == 0
        assert day["medical_supply_refilled_units"] == (3 if index and index % 3 == 0 else 0)
        assert day["treatment_disruption_hours"] == (25 if index == 16 else 0)
    assert trace["scalar_metrics"]["medical_supply_average_percent"] == pytest.approx(weighted_stock / hours)
    evidence = client.get(f"/api/run-groups/{run['id']}/bottlenecks").json()
    assert evidence["context"]["scenario_revision_id"] == run["scenario_revision_id"]
    assert evidence["scope"] == "ensemble"
    assert any(row["reason"] == "treatment_disruption" for row in evidence["categories"])


INVALID_OPERATIONS = [
    {"severity_mix": {**severity(), "low": {"percentage": 59.9, "average_stay_hours": 24}}},
    {"severity_mix": {**severity(), "low": {"percentage": 60, "average_stay_hours": 73}}},
    {"severity_mix": {**severity(), "high": {"percentage": 10, "average_stay_hours": 87601}}},
    {"severity_mix": {**severity(), "low": {"percentage": True, "average_stay_hours": 24}}},
    {"severity_mix": {**severity(), "unknown": {"percentage": 0, "average_stay_hours": 24}}},
    {"supplies": {**supplies(), "usage_per_patient_day": -0.01}},
    {"supplies": {**supplies(), "refill_percent": 100.1}},
    {"supplies": {**supplies(), "refill_every_days": True}},
    {"supplies": {**supplies(), "capacity": "100"}},
    {"supplies": {**supplies(), "unexpected_supply": 10}},
    {
        "disruptions": [
            {"id": "naive-time", "start_at": "2026-10-17T00:00:00", "end_at": "2026-10-18T05:00:00Z"}
        ]
    },
    {
        "disruptions": [
            {"id": "reversed", "start_at": "2026-10-18T05:00:00Z", "end_at": "2026-10-17T05:00:00Z"}
        ]
    },
    {
        "disruptions": [
            {"id": "before-start", "start_at": "2026-10-15T05:00:00Z", "end_at": "2026-10-17T05:00:00Z"}
        ]
    },
    {"disruptions": [{"id": "empty", "start_at": "2026-10-17T05:00:00Z", "end_at": "2026-10-17T05:00:00Z"}]},
    {
        "disruptions": [
            {"id": "same", "start_at": "2026-10-17T05:00:00Z", "end_at": "2026-10-18T05:00:00Z"},
            {"id": "same", "start_at": "2026-10-18T05:00:00Z", "end_at": "2026-10-19T05:00:00Z"},
        ]
    },
]


@pytest.mark.parametrize("invalid", INVALID_OPERATIONS)
def test_server_rejects_invalid_operations_before_draft_or_job_mutation(pipeline, invalid):
    client = pipeline
    saved = create_scenario(client)
    with client.app.state.Session() as session:
        before_jobs = session.scalar(select(func.count()).select_from(Job))
    response = client.patch(
        f"/api/scenarios/{saved['id']}",
        headers={"If-Match": str(saved["revision"])},
        json={"hospital_operations": invalid},
    )
    assert response.status_code == 422, response.text
    assert client.get(f"/api/scenarios/{saved['id']}").json() == saved
    response = client.post(
        "/api/run-groups",
        json={
            "scenario": {
                "dataset_version_id": client.dataset["id"],
                "horizon_calendar_days": 3,
                "replications": 1,
                "hospital_operations": invalid,
            }
        },
    )
    assert response.status_code == 422, response.text
    with client.app.state.Session() as session:
        assert session.scalar(select(func.count()).select_from(Job)) == before_jobs


@pytest.mark.parametrize(
    "bad",
    [
        {"horizon_calendar_days": True},
        {"horizon_calendar_days": 366},
        {"timezone": "Invalid/Clock"},
        {"start_at": "2026-10-16T00:00:00"},
        {"start_at": "2026-10-17T05:00:00Z"},
        {"base_seed": True},
    ],
)
def test_invalid_clock_horizon_or_seed_leaves_saved_configuration_intact(pipeline, bad):
    client = pipeline
    saved = create_scenario(client)
    response = client.patch(
        f"/api/scenarios/{saved['id']}", headers={"If-Match": str(saved["revision"])}, json=bad
    )
    assert response.status_code == 422, response.text
    assert client.get(f"/api/scenarios/{saved['id']}").json() == saved


def test_shortening_horizon_cannot_silently_drop_a_saved_disruption(pipeline):
    client = pipeline
    saved = create_scenario(client, hospital_operations={"disruptions": [interruption(client, 2, 3)]})
    response = client.patch(
        f"/api/scenarios/{saved['id']}",
        headers={"If-Match": str(saved["revision"])},
        json={"horizon_calendar_days": 2},
    )
    assert response.status_code == 422, response.text
    assert client.get(f"/api/scenarios/{saved['id']}").json() == saved


def test_comparison_freezes_config_pairs_actual_results_and_saves_evaluated_plan(pipeline):
    client = pipeline
    conditions = [arrival_curve(client, 0, 3, 3, "comparison-demand")]
    # Zero configured ward nurses create a reproducible, resource-specific
    # bottleneck; a qualified reserve response is a real executable intervention.
    conditions += [
        {"kind": "unit_configuration", "unit_id": unit, "staff_counts": {"rn": 0}}
        for unit in ("UNIT-WARD-A", "UNIT-WARD-B", "UNIT-WARD-C")
    ]
    saved = create_scenario(
        client, conditions=conditions, hospital_operations={"severity_mix": severity()}, replications=3
    )
    response = client.post(
        "/api/comparisons",
        json={
            "scenario_id": saved["id"],
            "replications": 3,
            "plans": [
                {
                    "name": "Extra ward nurses",
                    "interventions": [
                        {
                            "kind": "staff_existing",
                            "unit_id": "UNIT-WARD-A",
                            "nurses": 4,
                            "activation_minutes": 0,
                        }
                    ],
                },
                {"name": "Same resources", "interventions": []},
            ],
        },
    )
    assert response.status_code == 202, response.text
    comparison = response.json()
    assert comparison["source_draft_revision"] == saved["revision"]
    assert comparison["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    future = patch_scenario(
        client, saved, conditions=[], hospital_operations=None, name="Unsimulated later plan"
    )
    raw_results = {}
    for plan in comparison["plans"]:
        run, _, frozen, _ = execute(client, {"id": plan["run_group_id"]})
        assert frozen["scenario"]["conditions"] == saved["conditions"]
        assert frozen["scenario"]["hospital_operations"] == saved["hospital_operations"]
        assert frozen["scenario"]["base_seed"] == saved["base_seed"]
        assert frozen["scenario"]["replications"] == 3
        assert frozen["scenario"]["interventions"] == plan["interventions"]
        assert run["source_draft_revision"] == saved["revision"] < future["revision"]
        with client.app.state.Session() as session:
            job = session.get(Job, run["id"])
            raw_results[plan["id"]] = ArtifactStore().get_json(job.result["replications_artifact"])
    response = client.get(f"/api/comparisons/{comparison['id']}")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "SUCCEEDED", result
    assert result["source_scenario_snapshot"]["conditions"] == saved["conditions"]
    reference = next(plan for plan in result["plans"] if plan["reference"])
    ref_by_index = {
        rep["replication_index"]: rep["scalar_metrics"]["inpatient_waiting_patient_hours"]
        for rep in raw_results[reference["id"]]
    }
    assert all(value > 0 for value in ref_by_index.values())
    for plan in result["plans"]:
        reps = raw_results[plan["id"]]
        assert {rep["replication_index"] for rep in reps} == set(ref_by_index)
        assert (
            plan["hospital_operations_model_version"]
            == plan["metrics"]["hospital_operations_model_version"]
            == OPERATIONS_MODEL_VERSION
        )
        deltas = [
            ref_by_index[rep["replication_index"]] - rep["scalar_metrics"]["inpatient_waiting_patient_hours"]
            for rep in reps
        ]
        assert plan["improvement"]["evidence_available"]
        assert plan["improvement"]["p50"] == pytest.approx(median(deltas))
        assert plan["improvement"]["probability_improvement"] == sum(delta > 0 for delta in deltas) / 3
        assert plan["metrics"]["scalar_metrics"]["inpatient_waiting_patient_hours"]["p50"] == pytest.approx(
            median(rep["scalar_metrics"]["inpatient_waiting_patient_hours"] for rep in reps)
        )
    measured_order = sorted(
        result["plans"],
        key=lambda plan: (
            plan["metrics"]["scalar_metrics"]["inpatient_waiting_patient_hours"]["p50"],
            plan["metrics"]["scalar_metrics"]["peak_inpatient_queue"]["p50"],
            plan["metrics"]["scalar_metrics"]["additional_staff_hours"]["p50"],
            plan["id"],
        ),
    )
    assert result["rankings"] == [plan["id"] for plan in measured_order]
    better = next(plan for plan in result["plans"] if plan["name"] == "Extra ward nurses")
    assert better["improvement"]["p50"] > 0
    assert result["rankings"][0] == better["id"]
    assert result["no_plan_improves"] is False
    response = client.post(
        f"/api/comparisons/{comparison['id']}/save-plan",
        json={"plan_id": better["id"], "name": "Reviewed response"},
    )
    assert response.status_code == 201, response.text
    adopted = response.json()
    for key in (
        "conditions",
        "hospital_operations",
        "horizon_calendar_days",
        "base_seed",
        "dataset_version_id",
    ):
        assert adopted[key] == saved[key]
    assert adopted["interventions"] == better["interventions"]
    assert adopted["parent_scenario_id"] == saved["id"]
    assert adopted["comparison_id"] == comparison["id"]
    assert client.get(f"/api/scenarios/{saved['id']}").json()["revision"] == future["revision"]
