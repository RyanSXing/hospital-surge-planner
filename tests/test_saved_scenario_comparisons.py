"""Two library scenarios compare only complete, matching, owned saved results."""

import copy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.scenario_comparisons import compatibility, descriptive_deltas
from surge_api.worker import execute_job
from surge_engine import generate_dataset
from surge_engine.hospital_operations import OPERATIONS_MODEL_VERSION


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(tmp_path / "library-comparison.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    dataset = generate_dataset("hospital_baseline", days=3)
    for stream in dataset["entry_streams"]:
        stream["expected_arrivals_per_local_day"] = 16 if stream["entry_type"] == "ed" else 2
    dataset["arrival_profiles"].update(ed_arrivals_per_local_day=16, direct_ward_arrivals_per_local_day=2)
    dataset = normalize_dataset(dataset)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url, client.dataset = url, dataset
        yield client
    app.state.engine.dispose()


def supplies():
    return {
        "supplies": {
            "initial_percent": 100,
            "capacity": 100,
            "usage_per_patient_day": 0,
            "refill_every_days": 3,
            "refill_percent": 100,
        }
    }


def severity():
    return {
        "severity_mix": {
            "low": {"percentage": 60, "average_stay_hours": 24},
            "medium": {"percentage": 30, "average_stay_hours": 72},
            "high": {"percentage": 10, "average_stay_hours": 168},
        }
    }


def create(client, name, **fields):
    response = client.post(
        "/api/scenarios",
        json={
            "name": name,
            "dataset_version_id": client.dataset["id"],
            "horizon_calendar_days": 2,
            "replications": 1,
            "base_seed": 20261017,
            **fields,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def queue(client, scenario):
    response = client.post(
        "/api/run-groups",
        json={"scenario_id": scenario["id"], "expected_scenario_revision": scenario["revision"]},
    )
    assert response.status_code == 202, response.text
    return response.json()


def complete(client, scenario, operations_version=None):
    queued = queue(client, scenario)
    if operations_version is not None:
        with client.app.state.Session.begin() as session:
            job = session.get(Job, queued["id"])
            job.payload = {**job.payload, "hospital_operations_model_version": operations_version}
    execute_job(queued["id"], client.database_url)
    run = client.get(f"/api/run-groups/{queued['id']}").json()
    assert run["status"] == "SUCCEEDED", run
    return run


def pair(client):
    left = create(client, "Current staffing", hospital_operations=supplies())
    right = create(
        client,
        "Higher patient arrivals",
        hospital_operations=supplies(),
        conditions=[
            {
                "kind": "arrival_multiplier",
                "entry_stream_id": "ED_MAIN",
                "multiplier": 2.5,
                "start_at": client.dataset["snapshot_at"],
                "end_at": "2026-10-18T05:00:00Z",
            }
        ],
    )
    return left, right, complete(client, left), complete(client, right)


def compare(client, left, right, **query):
    response = client.get(
        "/api/scenario-comparisons",
        params={"left_scenario_id": left["id"], "right_scenario_id": right["id"], **query},
    )
    assert response.status_code == 200, response.text
    return response.json()


def replace_aggregate(client, run, change):
    with client.app.state.Session.begin() as session:
        job = session.get(Job, run["id"])
        store = ArtifactStore()
        value = store.get_json(job.result["aggregate_artifact"])
        change(value)
        artifact = store.put_json("workspace-main", job.id, "test-result", value)
        job.result = {**job.result, "aggregate_artifact": artifact}


def database_snapshot(client):
    with client.app.state.Session() as session:
        return (
            [
                (row.id, row.revision, copy.deepcopy(row.data))
                for row in session.scalars(select(Document).order_by(Document.id))
            ],
            [
                (row.id, row.status, copy.deepcopy(row.payload), copy.deepcopy(row.result))
                for row in session.scalars(select(Job).order_by(Job.id))
            ],
        )


def test_actual_saved_results_compare_descriptively_without_jobs_or_writes(library, monkeypatch):
    client = library
    left, right, first, second = pair(client)
    before, reads = database_snapshot(client), []
    original = ArtifactStore.get_json_cached

    def recorded(store, metadata, *args, **kwargs):
        reads.append(metadata["object_key"])
        return original(store, metadata, *args, **kwargs)

    monkeypatch.setattr(ArtifactStore, "get_json_cached", recorded)
    result = compare(client, left, right)
    assert result["kind"] == "saved_scenarios" and result["scope"] == "independent_ensembles"
    assert result["paired_evidence"] is None and "not paired estimates" in result["evidence_label"]
    assert result["compatibility"] == {"comparable": True, "reasons": []}
    assert result["left"]["state"] == result["right"]["state"] == "ready"
    assert result["left"]["run"]["id"] == first["id"]
    assert result["right"]["run"]["id"] == second["id"]
    assert result["left"]["scenario"]["end_at"] == "2026-10-18T05:00:00Z"
    assert len(reads) == 2 and all("aggregate" in key for key in reads)
    for side in (result["left"], result["right"]):
        assert side["can_run"] and side["can_run_reason"] is None
        assert side["metrics"]["context"]["run_group_id"] == side["run"]["id"]
        assert side["metrics"]["context"]["source_draft_revision"] == side["scenario"]["revision"]
        assert side["metrics"]["context"]["resolution"]["aligned_across_plans"] is True
        assert not {"events", "patients", "unit_series", "bottleneck_evidence", "checkpoints"} & set(
            side["metrics"]
        )
    for delta in result["deltas"]:
        assert delta["available"], delta
        scale = 100 if delta["metric"].endswith("utilization") else 1
        a = result["left"]["metrics"]["scalar_metrics"][delta["metric"]]["p50"] * scale
        b = result["right"]["metrics"]["scalar_metrics"][delta["metric"]]["p50"] * scale
        assert delta["left"] == a and delta["right"] == b
        assert delta["difference"] == pytest.approx(b - a)
        assert delta["percent_change"] == (pytest.approx(100 * (b - a) / a) if a != 0 else None)
    assert next(row for row in result["deltas"] if row["metric"] == "arrivals")["difference"] > 0
    assert any(row["field"] == "conditions" for row in result["configuration_differences"])
    assert "rankings" not in result and "recommendation" not in result
    assert database_snapshot(client) == before


def test_changed_draft_never_reuses_old_results_and_guard_rejects_stale_run_action(library):
    client = library
    left, right, _, _ = pair(client)
    edited = client.patch(
        f"/api/scenarios/{left['id']}",
        headers={"If-Match": str(left["revision"])},
        json={"name": "Updated saved scenario", "hospital_operations": None},
    ).json()
    before = database_snapshot(client)
    result = compare(client, left, right)
    assert result["left"]["state"] == "stale"
    assert result["left"]["run"] is None and result["left"]["metrics"] is None
    assert result["left"]["latest_run"]["source_draft_revision"] < result["left"]["scenario"]["revision"]
    assert not result["compatibility"]["comparable"]
    assert all(row["difference"] is None and not row["available"] for row in result["deltas"])
    response = client.post(
        "/api/run-groups", json={"scenario_id": left["id"], "expected_scenario_revision": left["revision"]}
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "revision_conflict", (
        response.text
    )
    assert database_snapshot(client) == before
    completed = complete(client, edited)
    result = compare(client, left, right)
    assert result["left"]["state"] == "ready" and result["left"]["run"]["id"] == completed["id"]
    # Enabling operations is an intentional configuration change, not two conflicting active versions.
    assert result["compatibility"]["comparable"]


@pytest.mark.parametrize(
    "status,expected",
    [
        (None, "missing"),
        ("QUEUED", "running"),
        ("RUNNING", "running"),
        ("AGGREGATING", "running"),
        ("FAILED", "failed"),
        ("CANCELLED", "cancelled"),
    ],
)
def test_missing_and_incomplete_runs_are_honest_states(library, status, expected):
    client = library
    left, right = create(client, "Left"), create(client, "Right")
    if status:
        run = queue(client, left)
        with client.app.state.Session.begin() as session:
            session.get(Job, run["id"]).status = status
    result = compare(client, left, right)
    assert result["left"]["state"] == expected and result["right"]["state"] == "missing"
    assert result["left"]["metrics"] is None and result["left"]["run"] is None
    assert (result["left"]["latest_run"] is not None) == bool(status)
    assert all(
        row["left"] is None and row["right"] is None and row["difference"] is None for row in result["deltas"]
    )


def test_latest_success_for_current_revision_survives_a_newer_failed_attempt(library):
    client = library
    left, right, succeeded, _ = pair(client)
    latest = queue(client, left)
    with client.app.state.Session.begin() as session:
        row = session.get(Job, latest["id"])
        row.status, row.error = "FAILED", "A test execution failed"
    result = compare(client, left, right)
    assert result["left"]["state"] == "ready" and result["left"]["run"]["id"] == succeeded["id"]
    assert (
        result["left"]["latest_run"]["id"] == latest["id"]
        and result["left"]["latest_run"]["status"] == "FAILED"
    )
    assert result["left"]["reasons"][0]["code"] == "newer_attempt"


def test_legacy_staff_absence_normalization_does_not_make_fresh_results_stale(library):
    client = library
    left = create(
        client,
        "Legacy absence format",
        conditions=[
            {
                "kind": "staff_unavailability",
                "unit_id": "UNIT-WARD-A",
                "absence_percent": 10,
                "start_at": client.dataset["snapshot_at"],
                "end_at": "2026-10-18T05:00:00Z",
            }
        ],
    )
    right = create(client, "Current format")
    # Represent an already-saved legacy alias. The normal run path accepts and
    # normalizes it, retaining the saved revision and immutable public draft.
    with client.app.state.Session.begin() as session:
        row = session.get(Document, left["id"])
        old = copy.deepcopy(row.data)
        old["conditions"][0]["kind"] = "staff_absence"
        old["conditions"][0].pop("count", None)
        row.data = old
    run = complete(client, left)
    complete(client, right)
    result = compare(client, left, right)
    assert result["left"]["state"] == "ready", result["left"]
    assert result["left"]["run"]["id"] == run["id"]
    assert result["left"]["scenario"]["conditions"][0]["kind"] == "staff_absence"


@pytest.mark.parametrize(
    "problem",
    [
        "missing_file",
        "missing_summary",
        "incomplete",
        "wrong_period",
        "wrong_model",
        "missing_frozen_revision",
    ],
)
def test_missing_or_mismatched_evidence_never_becomes_zero(library, problem):
    client = library
    left, right, run, _ = pair(client)
    if problem in {"missing_file", "incomplete", "missing_frozen_revision"}:
        with client.app.state.Session.begin() as session:
            row = session.get(Job, run["id"])
            if problem == "missing_file":
                row.result = {key: value for key, value in row.result.items() if key != "aggregate_artifact"}
            elif problem == "incomplete":
                row.completed = 0
            else:
                row.payload = {**row.payload, "scenario_revision_id": None}
    else:

        def change(value):
            if problem == "missing_summary":
                value.pop("scalar_metrics")
            elif problem == "wrong_period":
                value["end_at"] = "2026-10-19T05:00:00Z"
            else:
                value["model_version"] = "other-implementation"

        replace_aggregate(client, run, change)
    result = compare(client, left, right)
    assert result["left"]["state"] == "unavailable" and result["left"]["metrics"] is None
    assert not result["compatibility"]["comparable"]
    assert all(row["difference"] is None and row["left"] is None for row in result["deltas"])


def test_missing_individual_metric_stays_unavailable_while_other_metrics_compare(library):
    client = library
    left, right, run, _ = pair(client)
    replace_aggregate(
        client, run, lambda value: value["scalar_metrics"].pop("average_wait_per_patient_hours")
    )
    result = compare(client, left, right)
    assert result["compatibility"]["comparable"]
    wait = next(row for row in result["deltas"] if row["metric"] == "average_wait_per_patient_hours")
    assert wait["left"] is None and wait["difference"] is None and not wait["available"]
    assert next(row for row in result["deltas"] if row["metric"] == "arrivals")["available"]


@pytest.mark.parametrize(
    "field", ["id", "horizon_calendar_days", "source_draft_revision", "dataset_version_id"]
)
def test_run_snapshot_must_match_selected_saved_scenario(library, field):
    client = library
    left, right, run, _ = pair(client)
    with client.app.state.Session.begin() as session:
        row = session.get(Job, run["id"])
        changed = copy.deepcopy(row.payload)
        if field == "source_draft_revision":
            changed[field] = 0
        elif field == "dataset_version_id":
            changed[field] = "another-dataset"
        else:
            changed["scenario"][field] = "another-scenario" if field == "id" else 3
        row.payload = changed
    result = compare(client, left, right)
    assert result["left"]["state"] == "stale" and result["left"]["metrics"] is None


def test_different_active_versions_keep_each_result_visible_but_block_deltas(library):
    client = library
    left = create(client, "Earlier supply model", hospital_operations=supplies())
    right = create(client, "Current supply model", hospital_operations=supplies())
    complete(client, left, operations_version="1.1")
    complete(client, right)
    result = compare(client, left, right)
    assert result["left"]["state"] == result["right"]["state"] == "ready"
    assert result["left"]["metrics"]["hospital_operations_model_version"] == "1.1"
    assert result["right"]["metrics"]["hospital_operations_model_version"] == OPERATIONS_MODEL_VERSION
    assert not result["compatibility"]["comparable"]
    assert any(item["code"] == "different_operations_model" for item in result["compatibility"]["reasons"])
    assert all(row["difference"] is None and not row["available"] for row in result["deltas"])


def test_known_legacy_severity_is_outdated_instead_of_presented_as_current(library):
    client = library
    left = create(client, "Legacy severity", hospital_operations=severity())
    right = create(client, "Current severity", hospital_operations=severity())
    complete(client, left, operations_version="1.0")
    complete(client, right)
    result = compare(client, left, right)
    assert result["left"]["state"] == "stale" and result["left"]["metrics"] is None
    assert result["left"]["reasons"][0]["code"] == "legacy_severity_model" and result["left"]["can_run"]


def test_inherited_legacy_severity_requires_configuration_instead_of_a_useless_rerun(library):
    client = library
    source = create(client, "Legacy history", hospital_operations=severity())
    parent = complete(client, source, operations_version="1.0")
    event = client.post(
        "/api/updates",
        json={
            "scenario_id": source["id"],
            "state_origin": "simulation_branch",
            "type": "capacity_change",
            "effective_at": "2026-10-16T06:00:00Z",
            "payload": {"unit_id": "UNIT-WARD-A", "enabled_capacity": 40},
        },
    )
    assert event.status_code == 201, event.text
    applied = client.post(
        f"/api/updates/{event.json()['id']}/apply",
        json={
            "enqueue": False,
            "source": {
                "parent_run_group_id": parent["id"],
                "branch_strategy": "selected_replication",
                "source_replication_id": parent["selected_replication_id"],
            },
        },
    )
    assert applied.status_code == 200, applied.text
    result = compare(client, applied.json()["scenario"], source)
    assert result["left"]["state"] == "missing" and not result["left"]["can_run"]
    assert "independent scenario" in result["left"]["can_run_reason"]


@pytest.mark.parametrize("different", ["dataset", "horizon", "timezone"])
def test_different_result_contexts_have_no_descriptive_delta(library, different):
    client = library
    left = create(client, "Left")
    changes = {}
    if different == "dataset":
        dataset = normalize_dataset(client.dataset)
        with client.app.state.Session.begin() as session:
            add_document(session, "workspace-main", "dataset", dataset)
        changes["dataset_version_id"] = dataset["id"]
    elif different == "horizon":
        changes["horizon_calendar_days"] = 3
    else:
        changes["timezone"] = "UTC"
    right = create(client, "Right", **changes)
    complete(client, left)
    complete(client, right)
    result = compare(client, left, right)
    assert result["left"]["state"] == result["right"]["state"] == "ready"
    assert not result["compatibility"]["comparable"]
    assert any(row["code"] == "different_" + different for row in result["compatibility"]["reasons"])
    assert all(row["difference"] is None for row in result["deltas"])


def test_archived_and_unowned_scenarios_are_guarded_and_viewers_cannot_run(library):
    client = library
    left, right = create(client, "Left"), create(client, "Right")
    assert client.post(f"/api/scenarios/{left['id']}/archive").status_code == 200
    result = compare(client, left, right)
    assert result["left"]["state"] == "archived" and not result["left"]["can_run"]
    assert (
        client.get(
            "/api/scenario-comparisons",
            params={"left_scenario_id": right["id"], "right_scenario_id": right["id"]},
        ).status_code
        == 422
    )
    with client.app.state.Session.begin() as session:
        foreign = copy.deepcopy(right)
        foreign["id"] = "foreign-scenario"
        add_document(session, "workspace-other", "scenario", foreign)
    for identity in ("foreign-scenario", "not-found"):
        assert (
            client.get(
                "/api/scenario-comparisons",
                params={"left_scenario_id": right["id"], "right_scenario_id": identity},
            ).status_code
            == 404
        )
    assert client.post("/api/auth/login", json={"demo_role": "viewer"}).status_code == 200
    result = compare(client, left, right)
    assert not result["right"]["can_run"] and "read-only" in result["right"]["can_run_reason"]


def test_old_auto_response_comparison_runs_do_not_impersonate_saved_scenario_runs(library):
    client = library
    left, right = create(client, "Existing saved plan"), create(client, "Other saved plan")
    response = client.post(
        "/api/comparisons",
        json={
            "scenario_id": left["id"],
            "replications": 1,
            "plans": [{"name": "Historic evaluated plan", "interventions": []}],
        },
    )
    assert response.status_code == 202, response.text
    old = response.json()
    for plan in old["plans"]:
        execute_job(plan["run_group_id"], client.database_url)
    frozen_old = client.get(f"/api/comparisons/{old['id']}").json()
    assert frozen_old["status"] == "SUCCEEDED"
    plan_id = next(plan["id"] for plan in frozen_old["plans"] if not plan["reference"])
    adopted = client.post(f"/api/comparisons/{old['id']}/save-plan", json={"plan_id": plan_id}).json()
    before = database_snapshot(client)
    assert compare(client, left, right)["left"]["state"] == "missing"
    result = compare(client, adopted, right)
    assert result["left"]["state"] == "missing" and result["left"]["run"] is None
    assert database_snapshot(client) == before
    assert client.get(f"/api/comparisons/{old['id']}").json() == frozen_old


def test_compatible_chart_series_share_bounded_original_timestamps(library):
    client = library
    left, right, first, second = pair(client)
    for run, offset in ((first, 0), (second, 100)):

        def dense(value, offset=offset):
            value["series"] = [
                {
                    "at": f"2026-10-16T{index // 3600:02}:{index // 60 % 60:02}:{index % 60:02}Z",
                    "elapsed_minutes": index / 60,
                    "waiting": {"p50": (index % 71) + offset},
                }
                for index in range(3000)
            ]

        replace_aggregate(client, run, dense)
    result = compare(client, left, right, max_points=200)
    a, b = result["left"]["metrics"]["series"], result["right"]["metrics"]["series"]
    assert len(a) == len(b) <= 200
    assert [row["at"] for row in a] == [row["at"] for row in b]
    assert all(right["waiting"]["p50"] - left["waiting"]["p50"] == 100 for left, right in zip(a, b))
    assert result["left"]["metrics"]["context"]["resolution"]["values_are_original_points"]


@pytest.mark.parametrize("value", [True, "1", 0, -1])
def test_run_revision_guard_is_a_strict_positive_integer(library, value):
    client = library
    scenario = create(client, "Revision guard")
    with client.app.state.Session() as session:
        before = session.scalar(select(func.count()).select_from(Job))
    response = client.post(
        "/api/run-groups", json={"scenario_id": scenario["id"], "expected_scenario_revision": value}
    )
    assert response.status_code == 422, response.text
    with client.app.state.Session() as session:
        assert session.scalar(select(func.count()).select_from(Job)) == before


def test_revision_guard_requires_a_saved_scenario_but_legacy_callers_can_omit_it(library):
    client = library
    response = client.post(
        "/api/run-groups",
        json={
            "expected_scenario_revision": 1,
            "scenario": {"dataset_version_id": client.dataset["id"], "replications": 1},
        },
    )
    assert response.status_code == 422
    scenario = create(client, "Legacy caller")
    assert client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).status_code == 202


def test_zero_baseline_and_invalid_metrics_do_not_fabricate_percent_improvement():
    def side(value):
        return {"metrics": {"scalar_metrics": {"average_wait_per_patient_hours": value}}}

    row = descriptive_deltas(side({"p50": 0}), side({"p50": 2}), True)[0]
    assert row["available"] and row["difference"] == 2 and row["percent_change"] is None
    for invalid in (None, False, True, "0", {"p50": None}, {"p50": "0"}):
        row = descriptive_deltas(side(invalid), side({"p50": 2}), True)[0]
        assert row["left"] is None and row["difference"] is None and not row["available"]


def test_measurement_period_and_global_model_mismatches_are_explicit():
    scenario = {
        "dataset_version_id": "same",
        "start_at": "2026-10-16T05:00:00Z",
        "horizon_calendar_days": 2,
        "timezone": "America/Chicago",
    }
    left = {"state": "ready", "scenario": scenario, "metrics": {"model_version": "1.0"}}
    right = {
        "state": "ready",
        "scenario": {**scenario, "measurement_start_at": "2026-10-16T06:00:00Z"},
        "metrics": {"model_version": "1.1"},
    }
    result = compatibility(left, right)
    assert not result["comparable"]
    assert {row["code"] for row in result["reasons"]} == {"different_model", "different_measurement_period"}
