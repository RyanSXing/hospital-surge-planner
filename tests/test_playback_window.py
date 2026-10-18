"""Independent exact-state and transport oracles for continuous recorded replay."""

import copy
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select
from surge_api import playback
from surge_api import replay as replay_cache
from surge_api.artifacts import ArtifactStore
from surge_api.db import AuditEvent, Document, Job, digest
from surge_api.replay import exact_state
from surge_engine import generate_dataset, run_replication
from surge_engine.common import dt, iso
from test_review_api import reviewed  # noqa: F401

AGGREGATES = (
    "patient_total",
    "patient_counts",
    "queue_counts",
    "blocker_counts_by_unit",
    "blocker_summary",
    "flow_counts",
    "flow_counts_start_at",
    "patient_groups",
)


def instant(trace, minute):
    return iso(dt(trace["start_at"]) + timedelta(minutes=minute))


def normalized_aggregates(value):
    result = {key: value[key] for key in AGGREGATES}
    result["patient_groups"] = sorted(result["patient_groups"], key=lambda group: digest(group))
    return result


def assert_exact_floor(actual, expected):
    for collection, identity in (("slots", "slot_id"), ("units", "unit_id")):
        assert {row[identity]: row for row in actual[collection]} == {
            row[identity]: row for row in expected[collection]
        }
    assert normalized_aggregates(actual) == normalized_aggregates(expected)


def apply_frame(state, frame):
    for collection, identity in (("slots", "slot_id"), ("units", "unit_id")):
        values = {row[identity]: row for row in state[collection]}
        values.update({row[identity]: row for row in frame[collection]})
        state[collection] = list(values.values())
    state.update(frame["aggregates"], at=frame["at"], elapsed_minutes=frame["elapsed_minutes"])


def small_trace():
    start = "2026-10-16T05:00:00Z"
    trace = {
        "replication_id": "playback-hand-calculated",
        "model_version": "playback-test-1",
        "start_at": start,
        "end_at": "2026-10-16T09:00:00Z",
        "horizon_elapsed_minutes": 240,
        "unit_history": {},
        "slot_history": {},
        "patients": [],
        "events": [],
        "blocker_history": {},
    }
    for identity, kind in (("ED", "ed"), ("WARD", "ward")):
        trace["unit_history"][identity] = [
            {
                "unit_id": identity,
                "kind": kind,
                "facility_id": "FAC-MAIN",
                "elapsed_minutes": 0,
                "at": start,
                "physical": 2,
                "staffed": 2,
                "occupied": 0,
                "available": 2,
            }
        ]
    trace["slot_history"]["BED-ED"] = [
        {
            "slot_id": "BED-ED",
            "unit_id": "ED",
            "elapsed_minutes": 0,
            "at": start,
            "status": "ready",
        }
    ]
    trace["slot_history"]["BED-ED"] += [
        {
            "slot_id": "BED-ED",
            "unit_id": "ED",
            "elapsed_minutes": minute,
            "at": instant(trace, minute),
            "status": status,
            "patient_id": patient,
        }
        for minute, status, patient in ((30, "occupied", "P1"), (50, "cleaning", None), (70, "ready", None))
    ]
    trace["patients"] = [
        {
            "patient_id": "P1",
            "state_intervals": [
                {
                    "start_elapsed_minutes": minute,
                    "state": state,
                    "care_level": "ward",
                    "facility_id": "FAC-MAIN",
                    "unit_id": unit,
                    "slot_id": slot,
                    "admission_pending": pending,
                    "queue_group": "ward:oxygen",
                }
                for minute, state, unit, slot, pending in (
                    (10, "ed_waiting", None, None, False),
                    (30, "ed_assessment", "ED", "BED-ED", False),
                    (40, "ed_boarding", "ED", "BED-ED", True),
                    (50, "inpatient", "WARD", "BED-WARD", False),
                    (90, "discharged", None, None, False),
                )
            ],
        },
        {
            "patient_id": "P2",
            "state_intervals": [
                {
                    "start_elapsed_minutes": 0,
                    "state": "direct_waiting",
                    "care_level": "ward",
                    "facility_id": "FAC-MAIN",
                    "admission_pending": True,
                    "queue_group": "ward:oxygen",
                },
                {
                    "start_elapsed_minutes": 60,
                    "state": "inpatient",
                    "care_level": "ward",
                    "facility_id": "FAC-MAIN",
                    "unit_id": "WARD",
                    "slot_id": "BED-WARD2",
                    "care_paused": True,
                    "care_pause_reasons": ["medical_supplies", "medical_supplies"],
                },
                {
                    "start_elapsed_minutes": 80,
                    "state": "inpatient",
                    "care_level": "ward",
                    "facility_id": "FAC-MAIN",
                    "unit_id": "WARD",
                    "slot_id": "BED-WARD2",
                    "care_paused": False,
                },
            ],
        },
    ]
    trace["blocker_history"]["ward:oxygen"] = [
        {
            "start_elapsed_minutes": minute,
            "reasons": reasons,
            "units": [{"unit_id": "WARD", "reasons": reasons}, {"unit_id": "WARD", "reasons": reasons}],
        }
        for minute, reasons in ((0, ["nursing_capacity", "required_equipment_unavailable"]), (45, []))
    ]
    trace["events"] = [
        {
            "event_id": f"E{index}",
            "sequence_number": index,
            "elapsed_minutes": minute,
            "occurred_at": instant(trace, minute),
            "event_type": kind,
            "patient_id": "P1",
            "from_unit_id": source,
            "to_unit_id": destination,
        }
        for index, (minute, kind, source, destination) in enumerate(
            [
                (10, "arrival", None, None),
                (30, "assessment_start", None, "ED"),
                (40, "admission_request", "ED", None),
                (50, "admission", "ED", "WARD"),
                (90, "discharge", "WARD", None),
            ],
            start=1,
        )
    ]
    return trace


def test_hand_calculated_full_population_changes_and_overlapping_constraints():
    trace = small_trace()
    before = copy.deepcopy(trace)
    value = playback.playback_window(trace, instant(trace, 10), instant(trace, 90))
    assert value["complete"] and value["final_state_at"] == instant(trace, 90)
    assert value["initial_state"]["queue_counts"]["FAC-MAIN"] == {
        "total": 1,
        "ward": 1,
        "icu": 0,
        "ed": 1,
        "ed_boarding": 0,
        "direct_waiting": 1,
        "stepdown": 0,
    }
    initial_reasons = value["initial_state"]["blocker_counts_by_unit"]["WARD"]
    assert initial_reasons == {"nursing_capacity": 2, "required_equipment_unavailable": 2}
    # Two overlapping categories describe the same two people, not four people.
    assert value["initial_state"]["patient_total"] == 2
    by_time = {frame["elapsed_minutes"]: frame for frame in value["frames"]}
    assert by_time[40]["aggregates"]["queue_counts"]["FAC-MAIN"]["total"] == 2
    assert by_time[45]["aggregates"]["blocker_counts_by_unit"] == {"WARD": {}}
    assert by_time[60]["aggregates"]["queue_counts"] == {}
    assert by_time[60]["aggregates"]["blocker_counts_by_unit"] == {"WARD": {"medical_supplies": 1}}
    assert by_time[80]["aggregates"]["blocker_counts_by_unit"] == {}
    assert by_time[90]["aggregates"]["patient_total"] == 1
    assert by_time[90]["aggregates"]["flow_counts"]["FAC-MAIN"]["discharges"] == 1
    # Start is already applied, end is included, administrative requests are not movement.
    assert [event["event_id"] for event in value["events"]] == ["E2", "E4", "E5"]
    state = copy.deepcopy(value["initial_state"])
    assert_exact_floor(state, exact_state(trace, 10))
    for frame in value["frames"]:
        apply_frame(state, frame)
        assert_exact_floor(state, exact_state(trace, frame["elapsed_minutes"]))
    assert trace == before
    assert state["patients"] == [] and state["partial_collections"] == ["patients"]


@pytest.fixture(scope="module")
def recorded_trace():
    dataset = generate_dataset("hospital_baseline", days=2)
    return run_replication(
        dataset,
        {
            "horizon_calendar_days": 1,
            "base_seed": 20261016,
            "hospital_operations": {
                "severity_mix": {
                    "low": {"percentage": 60, "average_stay_hours": 24},
                    "medium": {"percentage": 30, "average_stay_hours": 72},
                    "high": {"percentage": 10, "average_stay_hours": 168},
                },
                "supplies": {
                    "initial_percent": 100,
                    "capacity": 30,
                    "usage_per_patient_day": 1,
                    "refill_every_days": 1,
                    "refill_percent": 100,
                },
                "disruptions": [
                    {
                        "id": "recorded-playback-disruption",
                        "start_at": "2026-10-16T07:00:00Z",
                        "end_at": "2026-10-16T08:00:00Z",
                    }
                ],
            },
        },
    )


@pytest.mark.parametrize("lower,upper", [(0, 240), (240, 480), (19.75, 205.125), (1200, 1440)])
def test_every_real_frame_and_between_frame_state_equals_exact_reconstruction(recorded_trace, lower, upper):
    trace = recorded_trace
    original = digest(trace)
    value = playback.playback_window(trace, instant(trace, lower), instant(trace, upper))
    state = copy.deepcopy(value["initial_state"])
    assert_exact_floor(state, exact_state(trace, lower))
    times = [frame["elapsed_minutes"] for frame in value["frames"]]
    assert times == sorted(set(times)) and times[-1] == upper
    previous = lower
    for frame in value["frames"]:
        middle = (previous + frame["elapsed_minutes"]) / 2
        assert_exact_floor(state, exact_state(trace, middle))
        apply_frame(state, frame)
        assert_exact_floor(state, exact_state(trace, frame["elapsed_minutes"]))
        previous = frame["elapsed_minutes"]
    expected_events = [
        event
        for event in trace["events"]
        if event["event_type"] in playback.MOTION_EVENTS
        and dt(value["start_at"]) < dt(event["occurred_at"]) <= dt(value["end_at"])
    ]
    assert value["events"] == sorted(
        expected_events, key=lambda event: (dt(event["occurred_at"]), event["sequence_number"])
    )
    assert digest(trace) == original


def test_same_time_replacements_empty_windows_and_fractional_changes():
    trace = small_trace()
    trace["replication_id"] = "playback-tied-fractional"
    # Same-count patient swaps must replace the slot record even with no unit change.
    trace["slot_history"]["BED-ED"].insert(
        2,
        {
            **trace["slot_history"]["BED-ED"][1],
            "patient_id": "LAST-TIED-PATIENT",
        },
    )
    trace["slot_history"]["FRACTIONAL"] = [
        {
            "slot_id": "FRACTIONAL",
            "unit_id": "WARD",
            "elapsed_minutes": 30.00000001,
            "at": instant(trace, 30.00000001),
            "status": "ready",
        }
    ]
    value = playback.playback_window(trace, instant(trace, 20), instant(trace, 35))
    state = copy.deepcopy(value["initial_state"])
    for frame in value["frames"]:
        apply_frame(state, frame)
        assert_exact_floor(state, exact_state(trace, frame["elapsed_minutes"]))
    assert (
        next(slot for slot in state["slots"] if slot["slot_id"] == "BED-ED")["patient_id"]
        == "LAST-TIED-PATIENT"
    )
    assert any(frame["elapsed_minutes"] == 30.00000001 for frame in value["frames"])
    empty = playback.playback_window(trace, instant(trace, 100), instant(trace, 110))
    assert len(empty["frames"]) == 1 and empty["frames"][0]["elapsed_minutes"] == 110
    assert empty["frames"][0]["slots"] == [] and empty["events"] == []


def test_one_exact_initial_reconstruction_instead_of_reconstruction_per_frame(monkeypatch, recorded_trace):
    calls = []
    original = playback.exact_state

    def count(trace, at, **kwargs):
        calls.append(at)
        return original(trace, at, **kwargs)

    monkeypatch.setattr(playback, "exact_state", count)
    value = playback.playback_window(recorded_trace, instant(recorded_trace, 0), instant(recorded_trace, 240))
    assert len(value["frames"]) > 20
    assert calls == [recorded_trace["start_at"]]


def test_concurrent_windows_keep_flow_index_lookup_and_eviction_atomic(monkeypatch):
    class GuardedIndex(OrderedDict):
        checks = 0

        def verify(self):
            assert replay_cache._lock._is_owned(), "Flow-index LRU operations must hold their shared RLock"
            self.checks += 1

        def get(self, *args):
            self.verify()
            return super().get(*args)

        def move_to_end(self, *args):
            self.verify()
            return super().move_to_end(*args)

        def popitem(self, *args, **kwargs):
            self.verify()
            return super().popitem(*args, **kwargs)

        def __setitem__(self, *args):
            self.verify()
            return super().__setitem__(*args)

    guarded = GuardedIndex()
    monkeypatch.setattr(replay_cache, "_flow_indexes", guarded)

    def read(index):
        trace = small_trace()
        trace["replication_id"] = f"concurrent-playback-{index}"
        window = playback.playback_window(trace, instant(trace, 0), instant(trace, 120))
        assert window["initial_state"]["flow_counts"]["FAC-MAIN"] == {"arrivals": 0, "discharges": 0}
        assert window["frames"][-1]["aggregates"]["flow_counts"]["FAC-MAIN"] == {
            "arrivals": 1,
            "discharges": 1,
        }

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(read, range(32)))
    assert guarded.checks >= 64 and len(guarded) <= 4


def test_oversized_uncached_ledger_is_pinned_once_per_window(monkeypatch):
    class CountingLedger(list):
        scans = 0

        def __iter__(self):
            self.scans += 1
            return super().__iter__()

    trace = small_trace()
    trace["replication_id"] = "playback-oversized-flow-index"
    ledger = CountingLedger(trace["events"])
    trace["events"] = ledger
    monkeypatch.setattr(replay_cache, "_FLOW_INDEX_MAX_EVENTS", 1)
    monkeypatch.setattr(replay_cache, "_flow_indexes", OrderedDict())
    window = playback.playback_window(trace, instant(trace, 20), instant(trace, 100))
    # One event-filter pass and one pinned-index build, regardless of the number
    # of frames. Initial exact_state reuses the same counter rather than building.
    assert ledger.scans == 2 and len(window["frames"]) > 5
    assert not replay_cache._flow_indexes
    assert window["initial_state"]["flow_counts"]["FAC-MAIN"] == {"arrivals": 1, "discharges": 0}
    for frame in window["frames"]:
        assert frame["aggregates"]["flow_counts"]["FAC-MAIN"] == {
            "arrivals": 1,
            "discharges": int(frame["elapsed_minutes"] >= 90),
        }


@pytest.mark.parametrize(
    "constant,limit",
    [
        ("MAX_FRAMES", 2),
        ("MAX_CHANGES", 2),
        ("MAX_EVENTS", 1),
        ("MAX_RESPONSE_BYTES", 100),
    ],
)
def test_budget_excess_fails_explicitly_instead_of_sampling_or_clipping(monkeypatch, constant, limit):
    trace = small_trace()
    monkeypatch.setattr(playback, constant, limit)
    with pytest.raises(playback.PlaybackWindowError) as raised:
        playback.playback_window(trace, instant(trace, 0), instant(trace, 90))
    assert raised.value.code == "playback_window_too_large" and raised.value.status == 413


@pytest.mark.parametrize("missing", ["patients", "unit_history", "slot_history", "events"])
def test_incomplete_trace_is_unavailable_not_a_zero_patient_or_no_movement_projection(missing):
    trace = small_trace()
    del trace[missing]
    with pytest.raises(playback.PlaybackWindowError) as raised:
        playback.playback_window(trace, instant(trace, 0), instant(trace, 30))
    assert raised.value.code == "playback_window_unavailable" and raised.value.status == 409


def test_transport_is_frozen_bounded_authorized_and_read_only(reviewed):  # noqa: F811
    client = reviewed
    identity = client.completed["selected_replication_id"]
    with client.app.state.Session() as session:
        row = session.get(Document, identity)
        artifact = copy.deepcopy(row.data["trace_artifact"])
        stored = ArtifactStore().get_json(artifact)
        run = session.get(Job, row.data["run_group_id"])
        frozen = digest(run.payload)
        database_counts = tuple(
            session.scalar(select(func.count()).select_from(kind)) for kind in (Document, Job, AuditEvent)
        )
    trace_hash = digest(stored)
    path = f"/api/runs/{identity}/playback-window"
    params = {"start_at": stored["start_at"], "end_at": instant(stored, 240)}
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["replication_id"] == identity and value["complete"] is True
    assert value["context"]["run_group_id"] == client.completed["id"]
    assert value["context"]["scenario_revision_id"] == client.completed["scenario_revision_id"]
    assert value["context"]["evidence"] == "recorded_changes"
    assert value["initial_state"]["patients"] == []
    for forbidden in ("slot_history", "unit_history", "state_intervals", "blocker_history"):
        assert forbidden not in response.text
    offset = {
        "start_at": dt(params["start_at"]).astimezone(ZoneInfo("America/Chicago")).isoformat(),
        "end_at": dt(params["end_at"]).astimezone(ZoneInfo("America/Chicago")).isoformat(),
    }
    assert client.get(path, params=offset).content == response.content
    with client.app.state.Session() as session:
        assert digest(session.get(Job, client.completed["id"]).payload) == frozen
        assert (
            tuple(
                session.scalar(select(func.count()).select_from(kind)) for kind in (Document, Job, AuditEvent)
            )
            == database_counts
        )
    assert digest(ArtifactStore().get_json(artifact)) == trace_hash
    # Even a warm serialized cache may not bypass the ownership lookup.
    with client.app.state.Session.begin() as session:
        session.get(Document, identity).workspace_id = "another-workspace"
    try:
        assert client.get(path, params=params).status_code == 404
    finally:
        with client.app.state.Session.begin() as session:
            session.get(Document, identity).workspace_id = "workspace-main"
    assert client.get(path, params=params).content == response.content


def test_transport_remains_the_frozen_result_after_scenario_draft_edits(reviewed):  # noqa: F811
    client = reviewed
    identity = client.completed["selected_replication_id"]
    path = f"/api/runs/{identity}/playback-window"
    params = {"start_at": "2026-10-16T05:00:00Z", "end_at": "2026-10-16T09:00:00Z"}
    before = client.get(path, params=params)
    assert before.status_code == 200
    current = client.get("/api/scenarios/" + client.original_scenario["id"]).json()
    changed = client.patch(
        "/api/scenarios/" + current["id"],
        json={"conditions": [{"kind": "arrival_multiplier", "surge_percent": 190}]},
        headers={"If-Match": str(current["revision"])},
    )
    assert changed.status_code == 200, changed.text
    assert client.get(path, params=params).content == before.content
    assert before.json()["context"]["scenario_revision_id"] == client.completed["scenario_revision_id"]


def test_transport_end_boundary_matches_exact_horizon_state(reviewed):  # noqa: F811
    client = reviewed
    identity = client.completed["selected_replication_id"]
    params = {"start_at": "2026-10-17T04:00:00Z", "end_at": client.completed["end_at"]}
    response = client.get(f"/api/runs/{identity}/playback-window", params=params)
    assert response.status_code == 200, response.text
    window = response.json()
    state = copy.deepcopy(window["initial_state"])
    for frame in window["frames"]:
        apply_frame(state, frame)
    exact = client.get(f"/api/runs/{identity}/state", params={"at": params["end_at"]}).json()
    assert_exact_floor(state, exact)
    assert state["at"] == window["final_state_at"] == params["end_at"]


@pytest.mark.parametrize(
    "start,end,status,code",
    [
        ("2026-10-16T05:00:00", "2026-10-16T06:00:00Z", 422, "invalid_playback_window"),
        ("not-a-date", "2026-10-16T06:00:00Z", 422, "invalid_playback_window"),
        ("2026-10-16T05:00:00Z", "2026-10-16T05:00:00Z", 422, "invalid_playback_window"),
        ("2026-10-16T04:59:00Z", "2026-10-16T06:00:00Z", 422, "invalid_playback_window"),
        ("2026-10-16T05:00:00Z", "2026-10-16T09:00:01Z", 413, "playback_window_too_large"),
        ("2026-10-17T04:00:00Z", "2026-10-17T05:00:01Z", 422, "invalid_playback_window"),
    ],
)
def test_transport_rejects_invalid_unbounded_or_outside_horizon_times(reviewed, start, end, status, code):  # noqa: F811
    identity = reviewed.completed["selected_replication_id"]
    response = reviewed.get(
        f"/api/runs/{identity}/playback-window", params={"start_at": start, "end_at": end}
    )
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
