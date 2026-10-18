"""Recorded hospital-wide pauses agree on seek and continuous replay boundaries."""

# ruff: noqa: F811 -- shared pytest fixture is injected by name.
import copy
from collections import OrderedDict
from datetime import timedelta

import pytest
from surge_api import playback, treatment_status
from surge_api.artifacts import ArtifactStore
from surge_api.db import Document, Job, digest
from surge_api.replay import bounded_state, exact_state
from surge_api.treatment_status import treatment_index_for
from surge_engine import run_replication
from surge_engine.common import dt
from test_hospital_operations import (  # noqa: F401
    disruption,
    empty_hospital,
    hospital,
    initial_patient,
    model,
    supplies,
)
from test_operations_versions_api import complete, ops_client  # noqa: F401
from test_playback_window import instant, small_trace


def row(trace, minute, paused=False, disrupted=False, **extra):
    return {
        "at": instant(trace, minute),
        "elapsed_minutes": minute,
        "care_paused": paused,
        "treatment_disrupted": disrupted,
        **extra,
    }


def expected(trace, since, paused=False, disrupted=False, reasons=(), resumed=None):
    return {
        "care_paused": paused,
        "treatment_disrupted": disrupted,
        "reasons": list(reasons),
        "since_at": instant(trace, since),
        "last_resumed_at": instant(trace, resumed) if resumed is not None else None,
    }


def test_stock_only_changes_ignore_since_while_overlapping_reasons_and_true_recovery_are_exact():
    trace = small_trace()
    trace["replication_id"] = "treatment-overlap-stock-signatures"
    trace["operations_history"] = [
        row(trace, 0, medical_supply_stock=100),
        row(trace, 10, medical_supply_stock=95),
        row(trace, 20, True, True, medical_supply_stock=95),
        row(trace, 25, True, True, medical_supply_stock=90),
        row(trace, 30, True, True, medical_supply_stock=0),
        row(trace, 40, True, False, medical_supply_stock=0),
        row(trace, 45, True, False, medical_supply_stock=0),
        row(trace, 50, medical_supply_stock=100),
        row(trace, 55, medical_supply_stock=99),
        row(trace, 60, True, True, medical_supply_stock=99),
        row(trace, 70, medical_supply_stock=99),
    ]
    original = copy.deepcopy(trace)
    index = treatment_index_for(trace)
    assert index.times == (0, 20, 30, 40, 50, 60, 70)
    assert index.at(19.999) == expected(trace, 0)
    assert index.at(20) == expected(trace, 20, True, True, ["treatment_disruption"])
    assert index.at(29.999) == expected(trace, 20, True, True, ["treatment_disruption"])
    assert index.at(30) == expected(trace, 30, True, True, ["treatment_disruption", "medical_supplies"])
    assert index.at(49.999) == expected(trace, 40, True, False, ["medical_supplies"])
    assert index.at(50) == expected(trace, 50, resumed=50)
    assert index.at(59.999) == expected(trace, 50, resumed=50)
    assert index.at(60) == expected(trace, 60, True, True, ["treatment_disruption"], resumed=50)
    assert index.at(70) == expected(trace, 70, resumed=70)
    assert index.at(15) == expected(trace, 0)  # No future resumption leaks on rewind.
    assert bounded_state(exact_state(trace, 35), trace["replication_id"], 1)["treatment_status"] == index.at(
        35
    )
    answer = index.at(35)
    answer["reasons"].append("invented")
    assert "invented" not in index.at(35)["reasons"]
    assert trace == original


@pytest.mark.parametrize("history", [None, [], {}, "not-a-ledger"])
def test_missing_or_empty_operations_history_remains_unavailable_despite_patient_samples(history):
    trace = small_trace()
    trace["replication_id"] = f"treatment-unavailable-{type(history).__name__}"
    trace["operations_history"] = history
    assert exact_state(trace, 65)["treatment_status"] is None
    window = playback.playback_window(trace, instant(trace, 60), instant(trace, 90))
    assert window["initial_state"]["treatment_status"] is None
    assert all(frame["aggregates"]["treatment_status"] is None for frame in window["frames"])
    assert any(patient.get("care_paused") for patient in exact_state(trace, 65)["patients"])


def test_partial_and_malformed_observations_break_resume_continuity_without_invented_zeros():
    trace = small_trace()
    trace["replication_id"] = "treatment-partial-history"
    trace["operations_history"] = [
        row(trace, 10, True, True),
        {**row(trace, 20), "care_paused": "false"},
        row(trace, 30),
        {key: value for key, value in row(trace, 35).items() if key != "at"},
        row(trace, 40, True, True),
        row(trace, 50),
    ]
    index = treatment_index_for(trace)
    assert index.at(0) is None
    assert index.at(10) == expected(trace, 10, True, True, ["treatment_disruption"])
    assert index.at(20) is None
    assert index.at(30) == expected(trace, 30)  # Never assume a resume across the unknown gap.
    assert index.at(35) is None
    assert index.at(40) == expected(trace, 40, True, True, ["treatment_disruption"])
    assert index.at(50) == expected(trace, 50, resumed=50)
    window = playback.playback_window(trace, instant(trace, 0), instant(trace, 60))
    at = {frame["elapsed_minutes"]: frame["aggregates"]["treatment_status"] for frame in window["frames"]}
    assert at[20] is None and at[35] is None
    assert at[30]["last_resumed_at"] is None
    assert at[50]["last_resumed_at"] == instant(trace, 50)


@pytest.mark.parametrize(
    "observation",
    [None, {"at": "bad", "elapsed_minutes": float("nan")}, {"elapsed_minutes": True}],
)
def test_an_unlocatable_gap_makes_history_unavailable_instead_of_hiding_it(observation):
    trace = small_trace()
    trace["operations_history"] = [row(trace, 0), observation, row(trace, 50)]
    assert treatment_index_for(trace).at(55) is None


def test_generic_paused_status_does_not_guess_supplies_and_tiny_positive_percent_is_not_empty_stock():
    trace = small_trace()
    trace["operations_history"] = [
        row(trace, 0, True),
        row(trace, 10, True, medical_supply_percent=0),
        row(trace, 20, medical_supply_stock=10, medical_supply_percent=1e-12),
    ]
    index = treatment_index_for(trace)
    assert index.at(0) == expected(trace, 0, True)
    assert index.at(10) == expected(trace, 0, True)
    assert index.at(20) == expected(trace, 20, resumed=20)
    assert not index.at(20)["reasons"]


def test_inconsistent_booleans_are_unavailable_and_same_time_last_observation_wins():
    trace = small_trace()
    trace["operations_history"] = [
        row(trace, 0),
        row(trace, 10, False, True),
        row(trace, 20),
        row(trace, 30, True, True),
        row(trace, 30),
        row(trace, 40, False, medical_supply_stock=0),
    ]
    index = treatment_index_for(trace)
    assert index.at(10) is None
    assert index.at(20) == expected(trace, 20)
    assert index.at(30) == expected(trace, 20)
    assert index.at(40) is None


def test_zero_patient_operations_boundaries_are_real_frames_and_match_exact_iso_seeks():
    trace = small_trace()
    trace["replication_id"] = "treatment-empty-hospital-fractional"
    trace["patients"], trace["events"], trace["blocker_history"] = [], [], {}
    trace["slot_history"], trace["unit_history"] = {}, {}
    trace["operations_history"] = [
        row(trace, 0),
        row(trace, 30.00000001, True, True),
        row(trace, 45.123456789),
    ]
    before = digest(trace)
    window = playback.playback_window(trace, instant(trace, 0), instant(trace, 60))
    assert len(window["frames"]) == 3
    assert window["initial_state"]["treatment_status"] == expected(trace, 0)
    for frame in window["frames"]:
        assert frame["slots"] == frame["units"] == []
        assert frame["aggregates"]["patient_total"] == 0
        assert frame["aggregates"]["treatment_status"] == exact_state(trace, frame["at"])["treatment_status"]
        assert (
            frame["aggregates"]["treatment_status"]
            == exact_state(trace, frame["elapsed_minutes"])["treatment_status"]
        )
    start, resumed = trace["operations_history"][1:]
    assert (
        exact_state(trace, dt(start["at"]) - timedelta(microseconds=1))["treatment_status"]["care_paused"]
        is False
    )
    assert exact_state(trace, start["at"])["treatment_status"]["care_paused"] is True
    assert exact_state(trace, resumed["at"])["treatment_status"]["last_resumed_at"] == resumed["at"]
    assert digest(trace) == before


def test_real_supply_pause_outlasts_disruption_and_actual_refill_records_one_resume(hospital):
    data, _ = initial_patient(hospital, hours=30)
    trace = model(
        data,
        {"supplies": supplies(initial_percent=0), "disruptions": [disruption(data, 1, 10)]},
        days=2,
        arrivals=(2,),
    ).run()
    index = treatment_index_for(trace)
    assert index.at(0) == expected(trace, 0, True, False, ["medical_supplies"])
    assert index.at(60) == expected(trace, 60, True, True, ["treatment_disruption", "medical_supplies"])
    assert index.at(600) == expected(trace, 600, True, False, ["medical_supplies"])
    assert index.at(1439.999)["last_resumed_at"] is None
    assert index.at(1440) == expected(trace, 1440, resumed=1440)
    for lower, upper in [(0, 180), (570, 630), (1380, 1500)]:
        value = playback.playback_window(trace, instant(trace, lower), instant(trace, upper))
        assert value["initial_state"]["treatment_status"] == exact_state(trace, lower)["treatment_status"]
        for frame in value["frames"]:
            assert (
                frame["aggregates"]["treatment_status"] == exact_state(trace, frame["at"])["treatment_status"]
            )


def test_consecutive_actual_days_keep_one_continuous_pause_in_an_empty_hospital(hospital):
    trace = model(empty_hospital(hospital), {"disruption_chance_percent": 100}).run()
    index = treatment_index_for(trace)
    assert index.times == (0,)
    assert index.at(24 * 60) == expected(trace, 0, True, True, ["treatment_disruption"])
    assert index.at(48 * 60)["last_resumed_at"] is None
    for lower in (23 * 60, 47 * 60):
        value = playback.playback_window(trace, instant(trace, lower), instant(trace, lower + 120))
        assert value["initial_state"]["treatment_status"] == index.at(lower)
        assert all(frame["aggregates"]["treatment_status"] == index.at(lower) for frame in value["frames"])


@pytest.mark.parametrize("version", ["1.0", "1.1", "1.2", "1.3"])
def test_supported_frozen_model_histories_project_without_reexecuting_or_changing_them(hospital, version):
    data, _ = initial_patient(hospital, hours=4)
    trace = run_replication(
        data,
        {
            "base_seed": 43121,
            "horizon_calendar_days": 1,
            "hospital_operations": {"disruptions": [disruption(data, 1, 2)]},
            "_hospital_operations_model_version": version,
        },
    )
    before = digest(trace)
    assert trace["hospital_operations_model_version"] == version
    assert exact_state(trace, 60)["treatment_status"] == expected(
        trace, 60, True, True, ["treatment_disruption"]
    )
    assert exact_state(trace, 120)["treatment_status"] == expected(trace, 120, resumed=120)
    window = playback.playback_window(trace, instant(trace, 30), instant(trace, 180))
    assert window["hospital_operations_model_version"] == version
    assert window["frames"][-1]["aggregates"]["treatment_status"] == expected(trace, 120, resumed=120)
    assert digest(trace) == before


def test_warm_queries_build_once_and_oversized_uncached_history_is_pinned_once_per_window(monkeypatch):
    class CountingHistory(list):
        scans = 0

        def __iter__(self):
            self.scans += 1
            return super().__iter__()

    trace = small_trace()
    trace["replication_id"] = "treatment-index-scan-budget"
    trace["operations_history"] = CountingHistory(
        [
            row(trace, minute, minute >= 30, minute >= 30, medical_supply_stock=100 - minute)
            for minute in range(100)
        ]
    )
    monkeypatch.setattr(treatment_status, "_indexes", OrderedDict())
    first = treatment_index_for(trace)
    for minute in range(100):
        assert treatment_index_for(trace) is first
        assert first.at(minute) == exact_state(trace, minute)["treatment_status"]
    assert trace["operations_history"].scans == 1
    monkeypatch.setattr(treatment_status, "MAX_CACHED_OBSERVATIONS", 1)
    monkeypatch.setattr(treatment_status, "_indexes", OrderedDict())
    trace["replication_id"] += "-uncached"
    trace["operations_history"].scans = 0
    window = playback.playback_window(trace, instant(trace, 10), instant(trace, 90))
    assert len(window["frames"]) > 5
    assert trace["operations_history"].scans == 1
    assert not treatment_status._indexes


def test_treatment_status_api_and_playback_are_frozen_read_only_and_do_not_change_old_models(ops_client):
    client = ops_client
    created = client.post(
        "/api/scenarios",
        json={
            "name": "Recorded treatment status",
            "dataset_version_id": client.dataset["id"],
            "horizon_calendar_days": 1,
            "replications": 1,
            "hospital_operations": {"disruption_chance_percent": 100},
        },
    )
    assert created.status_code == 201, created.text
    queued = client.post("/api/run-groups", json={"scenario_id": created.json()["id"]})
    assert queued.status_code == 202, queued.text
    run = complete(client, queued.json()["id"])
    replication = run["selected_replication_id"]
    with client.app.state.Session() as session:
        job = session.get(Job, run["id"])
        frozen = digest(job.payload)
        stored = session.get(Document, replication).data["trace_artifact"]
        trace = ArtifactStore().get_json(stored)
        artifact_hash = digest(trace)
    at = trace["start_at"]
    response = client.get(f"/api/runs/{replication}/state", params={"at": at})
    assert response.status_code == 200, response.text
    assert response.json()["treatment_status"] == expected(trace, 0, True, True, ["treatment_disruption"])
    window = client.get(
        f"/api/runs/{replication}/playback-window", params={"start_at": at, "end_at": instant(trace, 240)}
    )
    assert window.status_code == 200, window.text
    value = window.json()
    assert value["initial_state"]["treatment_status"] == response.json()["treatment_status"]
    assert all(
        frame["aggregates"]["treatment_status"] == response.json()["treatment_status"]
        for frame in value["frames"]
    )
    latest = client.get(f"/api/scenarios/{created.json()['id']}").json()
    changed = client.patch(
        f"/api/scenarios/{latest['id']}",
        headers={"If-Match": str(latest["revision"])},
        json={"hospital_operations": None},
    )
    assert changed.status_code == 200, changed.text
    assert (
        client.get(
            f"/api/runs/{replication}/playback-window", params={"start_at": at, "end_at": instant(trace, 240)}
        ).content
        == window.content
    )
    with client.app.state.Session() as session:
        assert digest(session.get(Job, run["id"]).payload) == frozen
    assert digest(ArtifactStore().get_json(stored)) == artifact_hash
