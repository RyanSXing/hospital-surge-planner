"""Replay filters and annotations preserve exact immutable trace semantics."""

import copy
from collections import Counter

from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job
from surge_api.domain import add_document, date, normalize_dataset
from surge_api.replay_annotations import intervention_results, shortage_periods
from surge_api.worker import execute_job
from surge_engine import generate_dataset, state_at
from test_review_api import reviewed  # noqa: F401


def trace_for(client, identity=None):
    identity = identity or client.completed["selected_replication_id"]
    with client.app.state.Session() as session:
        row = session.get(Document, identity)
        run = session.get(Job, row.data["run_group_id"])
        return identity, copy.deepcopy(run.payload), ArtifactStore().get_json(row.data["trace_artifact"])


def test_event_type_is_filtered_before_pagination_with_complete_window_metadata(reviewed):  # noqa: F811
    identity, _, trace = trace_for(reviewed)
    path = f"/api/runs/{identity}/events"
    events = trace["events"]
    counts = Counter(event["event_type"] for event in events)
    kind = next(event["event_type"] for event in events[2:] if event["event_type"] != events[0]["event_type"])
    expected = [event for event in events if event["event_type"] == kind]
    cursor, found = None, []
    while True:
        params = {"event_type": kind, "limit": 2}
        if cursor is not None:
            params["cursor"] = cursor
        response = reviewed.get(path, params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["total"] == len(expected)
        assert page["window_total"] == len(events)
        assert page["event_types"] == sorted(counts)
        assert page["event_type_counts"] == counts
        found += page["items"]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert found == expected
    unknown = reviewed.get(path, params={"event_type": kind + "_unknown"}).json()
    assert unknown["total"] == 0 and unknown["items"] == []
    assert unknown["event_types"] == sorted(counts)
    assert reviewed.get(path, params={"event_type": ""}).status_code == 422


def test_event_type_metadata_respects_patient_time_window_and_preserves_sequence_navigation(reviewed):  # noqa: F811
    identity, _, trace = trace_for(reviewed)
    path = f"/api/runs/{identity}/events"
    counts = Counter(event["patient_id"] for event in trace["events"] if event.get("patient_id"))
    patient = counts.most_common(1)[0][0]
    events = [event for event in trace["events"] if event.get("patient_id") == patient]
    lower, upper = events[0]["occurred_at"], events[-1]["occurred_at"]
    window = [event for event in events if date(lower) <= date(event["occurred_at"]) < date(upper)]
    expected_counts = Counter(event["event_type"] for event in window)
    kind = window[-1]["event_type"]
    params = {"patient_id": patient, "start_at": lower, "end_at": upper, "event_type": kind, "limit": 200}
    page = reviewed.get(path, params=params).json()
    assert page["event_type_counts"] == expected_counts and page["window_total"] == len(window)
    assert page["items"] == [event for event in window if event["event_type"] == kind]
    selected = window[len(window) // 2]
    for direction, sequence_key in (("before", "before_sequence"), ("after", "after_sequence")):
        response = reviewed.get(
            path,
            params={
                "at": selected["occurred_at"],
                "direction": direction,
                sequence_key: selected["sequence_number"],
                "event_type": kind,
                "limit": 200,
            },
        ).json()
        time_window = [
            event
            for event in trace["events"]
            if (
                date(event["occurred_at"]) <= date(selected["occurred_at"])
                if direction == "before"
                else date(event["occurred_at"]) >= date(selected["occurred_at"])
            )
        ]
        expected = [
            event
            for event in time_window
            if event["event_type"] == kind
            and (
                event["sequence_number"] < selected["sequence_number"]
                if direction == "before"
                else event["sequence_number"] > selected["sequence_number"]
            )
        ]
        if direction == "before":
            expected.reverse()
        assert response["items"] == expected[:200]
        assert response["total"] == len(expected)
        assert response["event_type_counts"] == Counter(event["event_type"] for event in time_window)


def test_annotations_use_frozen_inputs_and_exact_selected_trace_after_draft_edit(reviewed):  # noqa: F811
    dataset = normalize_dataset(generate_dataset("stress_snapshot", days=2))
    with reviewed.app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", dataset)
    created = reviewed.post(
        "/api/scenarios",
        json={
            "name": "Exact stress annotations",
            "dataset_version_id": dataset["id"],
            "horizon_calendar_days": 1,
            "replications": 1,
            "interventions": [{"kind": "partner_transfer"}],
        },
    )
    assert created.status_code == 201, created.text
    queued = reviewed.post("/api/run-groups", json={"scenario_id": created.json()["id"]}).json()
    execute_job(queued["id"], reviewed.database_url)
    run = reviewed.get("/api/run-groups/" + queued["id"]).json()
    assert run["status"] == "SUCCEEDED", run
    identity, payload, trace = trace_for(reviewed, run["selected_replication_id"])
    scenario = reviewed.get("/api/scenarios/" + payload["scenario_id"]).json()
    changed = reviewed.patch(
        "/api/scenarios/" + scenario["id"],
        json={"conditions": [{"kind": "arrival_multiplier", "surge_percent": 120}]},
        headers={"If-Match": str(scenario["revision"])},
    )
    assert changed.status_code == 200, changed.text
    path = f"/api/runs/{identity}/annotations"
    response = reviewed.get(path)
    assert response.status_code == 200, response.text
    annotations = response.json()
    assert annotations["scenario_revision_id"] == payload["scenario_revision_id"]
    assert annotations["conditions"] == payload["scenario"].get("conditions", [])
    assert annotations["conditions"] != changed.json()["conditions"]
    assert annotations["planned_interventions"] == payload["scenario"].get("interventions", [])
    assert annotations["updates"] == payload["scenario"].get("updates", [])
    assert annotations["intervention_results"] == trace["interventions"]
    assert annotations["start_at"] == trace["start_at"] and annotations["end_at"] == trace["end_at"]
    assert reviewed.get(path).content == response.content
    periods = annotations["shortage_periods"]
    assert periods, "The selected real trace must exercise a shortage"
    times = {0.0, trace["horizon_elapsed_minutes"] / 2}
    for period in periods:
        lower, upper = period["start_elapsed_minutes"], period["end_elapsed_minutes"]
        times.update([lower, (lower + upper) / 2])
        if upper < trace["horizon_elapsed_minutes"]:
            times.add(upper)
    for minute in times:
        actual = any(patient["admission_pending"] for patient in state_at(trace, minute)["patients"])
        annotated = any(
            period["start_elapsed_minutes"] <= minute < period["end_elapsed_minutes"] for period in periods
        )
        assert annotated == actual, minute
    with reviewed.app.state.Session.begin() as session:
        session.add(
            Document(
                id="foreign-replay",
                workspace_id="another-workspace",
                kind="replication",
                data={"run_group_id": payload.get("run_group_id"), "trace_artifact": {}},
            )
        )
    assert reviewed.get("/api/runs/foreign-replay/annotations").status_code == 404
    assert (
        reviewed.get("/api/runs/foreign-replay/events", params={"event_type": "arrival"}).status_code == 404
    )


def test_shortage_union_combines_ties_clips_horizon_and_ignores_zero_length():
    def interval(start, end, pending=True):
        return {"start_elapsed_minutes": start, "end_elapsed_minutes": end, "admission_pending": pending}

    trace = {
        "start_at": "2026-10-16T05:00:00Z",
        "end_at": "2026-10-16T06:00:00Z",
        "patients": [
            {"state_intervals": [interval(-5, 10), interval(10, 20), interval(20, 40, False)]},
            {"state_intervals": [interval(20, 30), interval(35, 35), interval(50, None)]},
            {"state_intervals": [interval(25, 40), interval(55, 80), interval(80, 90)]},
        ],
    }
    periods = shortage_periods(trace)
    assert [(period["start_elapsed_minutes"], period["end_elapsed_minutes"]) for period in periods] == [
        (0, 40),
        (50, 60),
    ]
    assert periods[0]["start_at"] == trace["start_at"] and periods[-1]["end_at"] == trace["end_at"]


def test_intervention_outcome_times_require_unique_identified_events_and_preserve_source():
    failure = {"id": "plan-one", "kind": "clinic", "status": "infeasible", "reason": "Reserve overlap"}
    ready = {"id": "plan-two", "kind": "clinic", "status": "active", "ready_at": "existing-time"}
    unknown = {"id": "plan-three", "kind": "clinic", "status": "infeasible", "reason": "Insufficient kits"}
    trace = {
        "interventions": [failure, ready, unknown],
        "events": [
            {
                "event_type": "intervention_failed",
                "occurred_at": "2026-10-16T08:00:00Z",
                "payload": {"intervention_id": "plan-one", "kind": "clinic"},
            },
            {
                "event_type": "intervention_ready",
                "occurred_at": "2026-10-16T09:00:00Z",
                "payload": {"id": "plan-two", "kind": "clinic"},
            },
            {"event_type": "intervention_failed", "occurred_at": "2026-10-16T10:00:00Z", "payload": {}},
        ],
    }
    before = copy.deepcopy(trace)
    result = intervention_results(trace)
    assert result[0] == {**failure, "at": "2026-10-16T08:00:00Z"}
    assert result[1:] == [ready, unknown]
    assert trace == before
    trace["events"].append(copy.deepcopy(trace["events"][0]))
    assert intervention_results(trace)[0] == failure  # Ambiguous duplicate identities are not guessed.
