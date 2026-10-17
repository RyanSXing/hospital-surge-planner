"""Bounded staffing pages cover the complete declared roster and half-open windows."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from surge_api.db import Document
from surge_api.main import create_app

PATH = "/api/datasets/dataset_roster/units/UNIT-WARD/schedule"
AT = "2026-11-01T05:00:00Z"
END = "2026-11-02T06:00:00Z"


@pytest.fixture
def roster_client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    app = create_app("sqlite:///" + str(tmp_path / "schedule.db"), seed=False, start_dispatcher=False)
    start = datetime.fromisoformat(AT)
    staff = [
        {"staff_id": f"S-{i:03}", "role": "RT" if i % 5 == 0 else "RN", "capabilities": ["critical_care"]}
        for i in range(230)
    ]
    assignments = []
    for index, person in enumerate(staff):
        shift_start = start + timedelta(hours=index % 10)
        shift_end = shift_start + timedelta(hours=8)
        # Mixing equivalent UTC/local encodings must not change chronological order.
        if index % 2:
            shift_start = shift_start.astimezone(ZoneInfo("America/Chicago"))
            shift_end = shift_end.astimezone(ZoneInfo("America/Chicago"))
        assignments.append(
            {
                "assignment_id": f"A-{index:03}",
                "staff_id": person["staff_id"],
                "unit_id": "UNIT-WARD",
                "start_at": shift_start.isoformat(),
                "end_at": shift_end.isoformat(),
            }
        )
    staff.append({"staff_id": "S-EXTRA", "role": "RN", "capabilities": []})
    for identity, begin, finish, unit in (
        ("ends-at-start", start - timedelta(hours=8), start, "UNIT-WARD"),
        (
            "starts-at-end",
            datetime.fromisoformat(END),
            datetime.fromisoformat(END) + timedelta(hours=8),
            "UNIT-WARD",
        ),
        ("carry-in", start - timedelta(hours=4), start + timedelta(hours=1), "UNIT-WARD"),
        (
            "spans-window",
            start - timedelta(hours=2),
            datetime.fromisoformat(END) + timedelta(hours=2),
            "UNIT-WARD",
        ),
        ("other-unit", start, start + timedelta(hours=8), "UNIT-OTHER"),
    ):
        assignments.append(
            {
                "assignment_id": identity,
                "staff_id": "S-EXTRA",
                "unit_id": unit,
                "start_at": begin.isoformat(),
                "end_at": finish.isoformat(),
            }
        )
    dataset = {
        "snapshot_at": AT,
        "staff": staff,
        "assignments": list(reversed(assignments)),
        "units": [{"unit_id": "UNIT-WARD", "capacity_policy_id": "policy_ward"}],
        "capacity_policies": [{"capacity_policy_id": "policy_ward", "care_level": "ward"}],
    }
    with app.state.Session.begin() as session:
        session.add(
            Document(id="dataset_roster", workspace_id="workspace-main", kind="dataset", data=dataset)
        )
        session.add(
            Document(id="dataset_private", workspace_id="workspace-other", kind="dataset", data=dataset)
        )
    with TestClient(app) as client:
        client.seeded_assignments = assignments
        yield client
    app.state.engine.dispose()


def test_default_schedule_still_returns_first_100_future_assignments(roster_client):
    response = roster_client.get(PATH)
    assert response.status_code == 200, response.text
    page = response.json()
    assert len(page["assignments"]) == 100 and page["total"] == 233
    assert page["next_cursor"] == "100"
    assert page["at"] == datetime.fromisoformat(AT).isoformat()
    assert page["source"] == "declared_dataset_schedule"
    assert page["policy"]["capacity_policy_id"] == "policy_ward"
    assert page["end_at"] is None and page["role"] is None


def test_role_window_pages_cover_every_row_without_gaps_or_duplicates(roster_client):
    params = {"at": AT, "end_at": END, "role": "RN", "limit": 57}
    rows = []
    totals = []
    while True:
        response = roster_client.get(PATH, params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        assert len(page["assignments"]) <= 57
        rows.extend(page["assignments"])
        totals.append(page["total"])
        if page["next_cursor"] is None:
            break
        params["cursor"] = page["next_cursor"]
    assert totals == [186] * 4
    identities = [row["assignment_id"] for row in rows]
    assert len(set(identities)) == 186
    assert {"carry-in", "spans-window"}.issubset(identities)
    assert not {"ends-at-start", "starts-at-end", "other-unit"}.intersection(identities)
    assert all(row["role"] == "RN" and "capabilities" in row for row in rows)
    sort_key = lambda row: (
        datetime.fromisoformat(row["start_at"]),
        row["staff_id"],
        datetime.fromisoformat(row["end_at"]),
        row["assignment_id"],
    )
    assert rows == sorted(rows, key=sort_key)
    whole = roster_client.get(PATH, params={**params, "limit": 500, "cursor": "0"}).json()
    assert whole["assignments"] == rows and whole["next_cursor"] is None
    empty = roster_client.get(PATH, params={**params, "cursor": "186"}).json()
    assert empty["assignments"] == [] and empty["total"] == 186 and empty["next_cursor"] is None


def test_equivalent_time_offsets_and_custom_role_filter(roster_client):
    utc = roster_client.get(PATH, params={"at": AT, "end_at": END, "role": "RT", "limit": 500}).json()
    local = roster_client.get(
        PATH,
        params={
            "at": "2026-11-01T00:00:00-05:00",
            "end_at": "2026-11-02T00:00:00-06:00",
            "role": "RT",
            "limit": 500,
        },
    ).json()
    assert utc["assignments"] == local["assignments"] and utc["total"] == local["total"] == 46
    assert roster_client.get(PATH, params={"role": "declared-but-absent"}).json()["total"] == 0


@pytest.mark.parametrize(
    "params",
    [
        {"at": "2026-11-01T00:00:00"},
        {"end_at": "not-a-timestamp"},
        {"end_at": AT},
        {"end_at": "2026-10-31T00:00:00Z"},
        {"limit": 0},
        {"limit": 501},
        {"cursor": "-1"},
        {"cursor": "1.5"},
        {"cursor": "invalid"},
        {"role": ""},
    ],
)
def test_invalid_window_and_page_are_rejected(roster_client, params):
    assert roster_client.get(PATH, params=params).status_code == 422


def test_schedule_requires_owned_dataset_and_unit_but_allows_viewer(roster_client):
    assert roster_client.get(PATH.replace("dataset_roster", "dataset_private")).status_code == 404
    assert roster_client.get(PATH.replace("UNIT-WARD", "UNIT-UNKNOWN")).status_code == 404
    assert roster_client.post("/api/auth/login", json={"demo_role": "viewer"}).status_code == 200
    assert roster_client.get(PATH, params={"end_at": END, "limit": 500}).json()["total"] == 232
