"""Sunfire is a durable interpreter; existing validated app actions remain authoritative."""

import copy
import threading
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from surge_api import sunfire_provider, worker
from surge_api.db import AuditEvent, Document, Job
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_api.sunfire import configuration_overview, evidence_view, project_run
from surge_api.sunfire_schemas import PrepareArguments
from surge_api.sunfire_tools import (
    PlanningError,
    ToolRuntime,
    direct_authorized,
    public_draft,
)
from surge_engine import generate_dataset, run_replication
from surge_engine.common import dt, iso


@pytest.fixture(scope="module")
def generated():
    return normalize_dataset(generate_dataset("hospital_baseline", days=32))


@pytest.fixture
def sf(tmp_path, monkeypatch, generated):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("SUNFIRE_ENABLED", raising=False)
    url = "sqlite:///" + str(tmp_path / "sunfire.db")
    app = create_app(url, seed=False, start_dispatcher=False)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", generated)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.database_url = url
        client.dataset = generated
        response = client.post(
            "/api/scenarios",
            json={
                "name": "Current hospital plan",
                "dataset_version_id": generated["id"],
                "horizon_calendar_days": 1,
                "replications": 1,
            },
        )
        assert response.status_code == 201, response.text
        client.scenario = response.json()
        client.capture = {
            "scenario_id": client.scenario["id"],
            "saved_revision": client.scenario["revision"],
            "dataset_version_id": generated["id"],
            "draft_revision": 3,
            "draft_fingerprint": "browser-captured-before",
            "draft": public_draft(client.scenario),
            "selected_run_group_id": None,
            "selected_replication_id": None,
            "selected_time": None,
            "page": "overview",
            "timezone": "America/Chicago",
        }
        response = client.post("/api/sunfire/chats", json={"scenario_id": client.scenario["id"]})
        assert response.status_code == 201, response.text
        client.chat = response.json()
        yield client
    app.state.engine.dispose()


def scripted(monkeypatch, calls=None, final="Ready to review."):
    responses = (
        [
            {"text": "", "tool_calls": calls, "model": "test-boundary-model"},
            {"text": final, "tool_calls": [], "model": "test-boundary-model"},
        ]
        if calls
        else [{"text": final, "tool_calls": [], "model": "test-boundary-model"}]
    )
    seen = []

    def complete(messages, tools, **kwargs):
        seen.append(copy.deepcopy(messages))
        assert {tool["function"]["name"] for tool in tools} == {
            "get_current_context",
            "read_planning_guide",
            "read_results",
            "find_saved_scenarios",
            "compare_saved_scenarios",
            "prepare_action",
        }
        return responses.pop(0)

    monkeypatch.setattr(
        sunfire_provider, "availability", lambda: {"available": True, "model": "test-boundary-model"}
    )
    monkeypatch.setattr(sunfire_provider, "complete", complete)
    return seen


def call(name, arguments, identity="call1"):
    return {"id": identity, "name": name, "arguments": arguments}


def turn(sf, message, *, capture=None, key="turn-key", run=True):
    response = sf.post(
        f"/api/sunfire/chats/{sf.chat['id']}/turns",
        json={"message": message, "context": capture or sf.capture},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 202, response.text
    value = response.json()
    if run:
        worker.execute_job(value["id"], sf.database_url)
        value = sf.get(f"/api/sunfire/turns/{value['id']}").json()
    return value


def prepared(
    sf,
    monkeypatch,
    *,
    changes=None,
    terminal="edit",
    message="Add these changes to my current plan",
    mode="direct",
    run_id=None,
):
    arguments = {
        "changes": changes or [],
        "terminal": terminal,
        "mode": mode,
        "authorization_quote": message,
        "explanation": "Use the requested validated hospital settings.",
    }
    if run_id:
        arguments["run_group_id"] = run_id
    scripted(monkeypatch, [call("prepare_action", arguments)])
    value = turn(sf, message)
    assert value["status"] == "SUCCEEDED", value
    assert len(value["actions"]) == 1, value
    return value, value["actions"][0]


def ack_payload(action, *, sequence=None):
    return {
        "expected": action["expected"],
        "after": {
            "draft_revision": sequence if sequence is not None else action["expected"]["draft_revision"] + 1,
            "draft_fingerprint": "browser-after-" + action["id"],
            "draft": copy.deepcopy(action["validated_draft"]),
        },
    }


def runtime(sf, capture=None):
    session = sf.app.state.Session()
    user = {"id": "user-planner", "workspace_id": "workspace-main", "role": "admin"}
    return session, ToolRuntime(
        session, user, capture or sf.capture, "Add these changes to my plan", project_run
    )


def test_unavailable_provider_is_explicit_durable_and_other_app_paths_work(sf, monkeypatch):
    monkeypatch.setattr(
        sunfire_provider,
        "availability",
        lambda: {
            "available": False,
            "model": "xai.grok-4.7",
            "code": "quota_zero",
            "reason": "The configured model has no available account quota.",
            "retryable": False,
        },
    )
    monkeypatch.setattr(
        sunfire_provider,
        "complete",
        lambda *_args, **_kwargs: pytest.fail("unavailable provider must not be called"),
    )
    status = sf.get("/api/sunfire/status").json()
    assert status["available"] is False and status["code"] == "quota_zero"
    result = turn(sf, "What should I change?")
    assert result["status"] == "FAILED"
    assert result["error"]["code"] == "quota_zero"
    assert result["actions"] == []
    history = sf.get(f"/api/sunfire/chats/{sf.chat['id']}").json()
    assert [item["role"] for item in history["messages"]] == ["user", "assistant"]
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").status_code == 200
    assert sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).status_code == 202


def test_accident_batch_and_temporary_beds_preserve_usual_arrivals_and_installed_beds(sf, monkeypatch):
    start = dt(sf.scenario["start_at"])
    changes = [
        {
            "type": "arrival_batch",
            "count": 100,
            "at": iso(start + timedelta(hours=2)),
            "entry_stream_id": "ED_MAIN",
            "spread_minutes": 60,
        },
        {
            "type": "temporary_beds",
            "unit_id": "UNIT-WARD-A",
            "unavailable_count": 10,
            "start_at": iso(start + timedelta(hours=2)),
            "end_at": iso(start + timedelta(hours=10)),
        },
    ]
    _result, action = prepared(
        sf,
        monkeypatch,
        changes=changes,
        message="Add 100 extra arrivals on the scenario start date at 2 AM over 1 hour and make 10 Ward A beds unavailable from that time for 8 hours",
    )
    draft = action["validated_draft"]
    batches = [item for item in draft["conditions"] if item["kind"] == "arrival_batch"]
    assert len(batches) == 1 and batches[0]["count"] == 100
    assert batches[0]["care_mix"] == {"discharge": 0.8, "ward": 0.16, "icu": 0.04}
    assert not [
        item for item in draft["conditions"] if item["kind"] in {"arrival_multiplier", "unit_configuration"}
    ]
    events = [item for item in draft["updates"] if item["type"] == "capacity_change"]
    unit = next(unit for unit in sf.dataset["units"] if unit["unit_id"] == "UNIT-WARD-A")
    assert [item["payload"]["enabled_capacity"] for item in events] == [
        unit["enabled_capacity"] - 10,
        unit["enabled_capacity"],
    ]
    assert all(item["input_kind"] == "planned_assumption" for item in events)
    assert action["mode"] == "direct"
    assert "usual arrivals" in " ".join(action["warnings"]).lower()
    incident = next(row for row in action["before_after"] if row["field"].startswith("incident."))
    assert incident["before"] == 0 and incident["after"] == 100 and incident["start_at"] == batches[0]["at"]
    windows = [row for row in action["before_after"] if row["field"].startswith("capacity.")]
    assert [(row["before"], row["after"]) for row in windows] == [
        (unit["enabled_capacity"] - 10, unit["enabled_capacity"]),
        (unit["enabled_capacity"], unit["enabled_capacity"] - 10),
    ] or sorted((row["before"], row["after"]) for row in windows) == sorted(
        [
            (unit["enabled_capacity"], unit["enabled_capacity"] - 10),
            (unit["enabled_capacity"] - 10, unit["enabled_capacity"]),
        ]
    )
    assert any(row.get("end_at") == changes[1]["end_at"] for row in windows)
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").json()["conditions"] == []
    with sf.app.state.Session() as session:
        assert session.scalar(select(Job.id).where(Job.kind == "run")) is None


def test_ordinary_changes_remain_unsaved_ack_is_idempotent_and_undo_is_guarded(sf, monkeypatch):
    _result, action = prepared(sf, monkeypatch, changes=[{"type": "parameters", "name": "Edited unsaved"}])
    payload = ack_payload(action)
    first = sf.post(f"/api/sunfire/actions/{action['id']}/ack", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["action"]["status"] == "APPLIED"
    assert sf.post(f"/api/sunfire/actions/{action['id']}/ack", json=payload).json() == first.json()
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").json()["name"] == "Current hospital plan"
    current = {**sf.capture, **payload["after"], "draft": action["validated_draft"]}
    undo = sf.post(f"/api/sunfire/actions/{action['id']}/undo", json={"context": current})
    assert undo.status_code == 200, undo.text
    assert undo.json()["validated_draft"]["name"] == "Current hospital plan"
    conflict = sf.post(
        f"/api/sunfire/actions/{action['id']}/undo",
        json={
            "context": {
                **current,
                "draft_revision": current["draft_revision"] + 1,
                "draft_fingerprint": "manual-edit",
                "draft": {**current["draft"], "name": "Manual newer change"},
            }
        },
    )
    assert conflict.status_code == 409
    receipt = sf.get(f"/api/sunfire/actions/{action['id']}").json()
    assert receipt["receipt"] == first.json()


def test_save_then_run_uses_existing_frozen_job_once_and_rejects_wrong_endpoint(sf, monkeypatch):
    _result, action = prepared(
        sf,
        monkeypatch,
        changes=[{"type": "parameters", "name": "Exact run inputs"}],
        terminal="run",
        message="Run the simulation with these changes",
    )
    payload = ack_payload(action)
    assert sf.post(f"/api/sunfire/actions/{action['id']}/ack", json=payload).status_code == 422
    response = sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=payload)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt["saved_scenario"]["revision"] == sf.scenario["revision"] + 1
    run_id = receipt["run_group"]["id"]
    assert receipt["action"]["run_group_id"] == run_id
    reloaded_turn = sf.get(f"/api/sunfire/turns/{action['turn_id']}").json()
    assert reloaded_turn["actions"][0]["run_group_id"] == run_id
    assert "receipt" not in reloaded_turn["actions"][0]
    reloaded_chat = sf.get(f"/api/sunfire/chats/{sf.chat['id']}").json()
    assert action["turn_id"] in {item["id"] for item in reloaded_chat["turns"]}
    assert sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=payload).json() == receipt
    with sf.app.state.Session() as session:
        assert session.get(Document, action["id"]).data["run_group_id"] == run_id
        jobs = list(session.scalars(select(Job).where(Job.kind == "run")))
        assert len(jobs) == 1
        assert jobs[0].payload["scenario"]["name"] == "Exact run inputs"
        assert jobs[0].payload["source_draft_revision"] == receipt["saved_scenario"]["revision"]
        frozen_before = copy.deepcopy(jobs[0].payload)
    worker.execute_job(run_id, sf.database_url)
    with sf.app.state.Session() as session:
        run = session.get(Job, run_id)
        assert run.status == "SUCCEEDED", run.error
        assert run.payload == frozen_before


@pytest.mark.parametrize(
    "tamper",
    [
        None,
        "receipt_kind",
        "receipt_scenario",
        "saved_scenario",
        "job_kind",
        "workspace",
        "dataset",
        "revision",
    ],
)
def test_older_applied_run_receipt_recovers_only_its_matching_existing_run_without_read_writes(
    sf, monkeypatch, tamper
):
    _value, action = prepared(
        sf, monkeypatch, changes=[], terminal="run", message="Run the current simulation"
    )
    response = sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=ack_payload(action))
    assert response.status_code == 200, response.text
    run_id = response.json()["run_group"]["id"]
    with sf.app.state.Session.begin() as session:
        source = session.get(Document, action["id"])
        data = copy.deepcopy(source.data)
        data["run_group_id"] = None
        data["receipt"]["action"]["run_group_id"] = None
        if tamper == "receipt_kind":
            data["receipt"]["run_group"]["kind"] = "comparison"
        elif tamper == "receipt_scenario":
            data["receipt"]["run_group"]["scenario_id"] = "different-scenario"
        elif tamper == "saved_scenario":
            data["receipt"]["saved_scenario"]["id"] = "different-scenario"
        source.data = data
        run = session.get(Job, run_id)
        if tamper == "job_kind":
            run.kind = "comparison"
        elif tamper == "workspace":
            run.workspace_id = "another-workspace"
        elif tamper in {"dataset", "revision"}:
            run.payload = {
                **run.payload,
                **(
                    {"dataset_version_id": "different-dataset"}
                    if tamper == "dataset"
                    else {"source_draft_revision": 999}
                ),
            }
    with sf.app.state.Session() as session:
        before_action = copy.deepcopy(session.get(Document, action["id"]).data)
        before_scenario = copy.deepcopy(session.get(Document, sf.scenario["id"]).data)
        before_run = copy.deepcopy(session.get(Job, run_id).payload)
        before_result = copy.deepcopy(session.get(Job, run_id).result)
        before_audit = list(session.scalars(select(AuditEvent.id)))
    chat = sf.get(f"/api/sunfire/chats/{sf.chat['id']}").json()
    assert chat["turns"][0]["id"] == action["turn_id"]
    restored = sf.get(f"/api/sunfire/turns/{chat['turns'][0]['id']}").json()["actions"][0]
    assert restored["run_group_id"] == (run_id if tamper is None else None)
    assert "receipt" not in restored and "draft" not in restored and "before_draft" not in restored
    assert (
        sf.get(f"/api/sunfire/actions/{action['id']}").json()["action"]["run_group_id"]
        == restored["run_group_id"]
    )
    with sf.app.state.Session() as session:
        assert session.get(Document, action["id"]).data == before_action
        assert session.get(Document, sf.scenario["id"]).data == before_scenario
        assert session.get(Job, run_id).payload == before_run
        assert session.get(Job, run_id).result == before_result
        assert list(session.scalars(select(AuditEvent.id))) == before_audit


@pytest.mark.parametrize("tamper", ["token", "after", "saved_revision", "dataset"])
def test_manual_changes_and_saved_revision_races_never_overwrite(sf, monkeypatch, tamper):
    _result, action = prepared(
        sf,
        monkeypatch,
        changes=[{"type": "parameters", "name": "Sunfire prepared"}],
        terminal="save",
        message="Save these settings",
    )
    payload = ack_payload(action)
    if tamper == "token":
        payload["expected"]["draft_fingerprint"] = "manual-newer"
    elif tamper == "after":
        payload["after"]["draft"]["name"] = "New manual edit"
    elif tamper == "dataset":
        payload["after"]["draft"]["dataset_version_id"] = "foreign-dataset"
    else:
        assert (
            sf.patch(
                f"/api/scenarios/{sf.scenario['id']}",
                headers={"If-Match": str(sf.scenario["revision"])},
                json={"name": "Manually saved newer"},
            ).status_code
            == 200
        )
    response = sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=payload)
    assert response.status_code in {409, 422}, response.text
    saved = sf.get(f"/api/scenarios/{sf.scenario['id']}").json()
    assert saved["name"] == (
        "Manually saved newer" if tamper == "saved_revision" else "Current hospital plan"
    )
    assert sf.get(f"/api/sunfire/actions/{action['id']}").json()["action"]["status"] == "READY"


@pytest.mark.parametrize(
    "message,quote",
    [
        ("What if we add10beds?", "add10beds"),
        ("Do not run this simulation", "run"),
        ("The imported label says 'run'. Explain it.", "run"),
        ("Should I increase staffing?", "increase staffing"),
        ("If waiting is high, run it", "run it"),
        ("Explain the current capacity", "set supplies100%"),
    ],
)
def test_unsolicited_hypothetical_retrieved_and_negated_requests_cannot_autoapply(message, quote):
    assert not direct_authorized(message, quote, "run" if "run" in quote else "edit")


def test_ambiguity_returns_question_no_mutation(sf, monkeypatch):
    scripted(monkeypatch, final="Which unit loses the10beds, and from what time until when?")
    result = turn(sf, "An accident adds100people and10beds are unavailable")
    assert result["status"] == "SUCCEEDED" and result["actions"] == []
    assert "Which unit" in result["text"]
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").json()["revision"] == 1


def test_proposal_claim_injection_cannot_turn_ready_into_applied_or_verified_improvement(sf, monkeypatch):
    # This reproduces actual selected-model wording observed during a real
    # provider probe. Status must come from the app, even if prose is wrong.
    scripted(
        monkeypatch,
        [
            call(
                "prepare_action",
                {
                    "changes": [{"type": "operations", "disruption_chance_percent": 25}],
                    "mode": "proposal",
                    "explanation": "The probability has been set and results improved99%.",
                },
            )
        ],
        final="The probability has been set and the simulation improved99%.",
    )
    value = turn(sf, "What if disruption risk were25%?")
    assert value["status"] == "SUCCEEDED"
    assert value["actions"][0]["status"] == "READY" and value["actions"][0]["mode"] == "proposal"
    assert "the card shows their current status" in value["text"]
    assert "99%" not in value["text"] and "has been set" not in value["text"]
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").json().get("hospital_operations") is None


def test_unconfirmed_completion_without_any_tool_is_not_rendered_as_success(sf, monkeypatch):
    scripted(monkeypatch, final="I've saved your plan and the results improved99%.")
    value = turn(sf, "Explain what you can do")
    assert value["actions"] == [] and "No planning action was applied" in value["text"]
    assert "99%" not in value["text"]


def test_main_unit_changes_match_linked_manual_staffed_beds_and_nurse_semantics(sf):
    session, tool = runtime(sf)
    try:
        value = tool.call(
            "prepare_action",
            {
                "changes": [
                    {
                        "type": "unit",
                        "unit_id": "UNIT-WARD-A",
                        "physical_capacity": 48,
                        "staffed_capacity": 36,
                    }
                ],
                "mode": "proposal",
            },
        )
        config = next(
            item for item in value["validated_draft"]["conditions"] if item["kind"] == "unit_configuration"
        )
        assert config["physical_capacity"] == config["enabled_capacity"] == 48
        assert config["staffed_capacity"] == 36 and config["staff_counts"]["rn"] == 9
        changed = tool.call(
            "prepare_action",
            {
                "changes": [
                    {
                        "type": "unit",
                        "unit_id": "UNIT-WARD-A",
                        "staff_counts": {"rn": 8, "provider": 4, "support": 3},
                    }
                ]
            },
        )
        config = next(
            item for item in changed["validated_draft"]["conditions"] if item["kind"] == "unit_configuration"
        )
        assert config["staffed_capacity"] == 32
        assert config["staff_counts"] == {"rn": 8, "provider": 4, "support": 3}
        with pytest.raises(PlanningError, match="conflict"):
            tool.call(
                "prepare_action",
                {
                    "changes": [
                        {
                            "type": "unit",
                            "unit_id": "UNIT-WARD-A",
                            "staffed_capacity": 36,
                            "staff_counts": {"rn": 1},
                        }
                    ]
                },
            )
    finally:
        session.close()


def test_optional_operations_only_touch_supplied_section_and_risk_is_not_realized_event(sf):
    session, tool = runtime(sf)
    try:
        supplies = {
            "initial_percent": 80,
            "capacity": 10000,
            "usage_per_patient_day": 1,
            "refill_every_days": 7,
            "refill_percent": 70,
        }
        result = tool.call(
            "prepare_action",
            {
                "changes": [
                    {"type": "operations", "supplies": supplies},
                    {"type": "operations", "disruption_chance_percent": 25},
                ]
            },
        )
        operations = result["validated_draft"]["hospital_operations"]
        assert operations["supplies"] == supplies and operations["disruption_chance_percent"] == 25
        assert "severity_mix" not in operations and "disruptions" not in operations
        result = tool.call(
            "prepare_action", {"changes": [{"type": "operations", "disruption_chance_percent": 0}]}
        )
        assert result["validated_draft"]["hospital_operations"] == {"supplies": supplies}
        assert result["before_after"]
    finally:
        session.close()


@pytest.mark.parametrize(
    "name,arguments",
    [
        ("shell", {"command": "anything"}),
        (
            "prepare_action",
            {"changes": [{"type": "unit", "unit_id": "UNIT-WARD-A", "physical_capacity": True}]},
        ),
        ("prepare_action", {"changes": [{"type": "operations", "disruption_chance_percent": "30"}]}),
        ("prepare_action", {"changes": [], "execute": True}),
        (
            "prepare_action",
            {
                "changes": [
                    {
                        "type": "existing_control",
                        "collection": "interventions",
                        "record": {"kind": "activate_clinic", "unit_id": "UNIT-CLINIC-NORTH"},
                    }
                ]
            },
        ),
        (
            "prepare_action",
            {
                "changes": [
                    {
                        "type": "existing_control",
                        "collection": "conditions",
                        "record": {
                            "kind": "unit_configuration",
                            "unit_id": "UNIT-WARD-A",
                            "physical_capacity": 48,
                            "shell": "malicious",
                        },
                    }
                ]
            },
        ),
        (
            "prepare_action",
            {"changes": [{"type": "unit", "unit_id": "UNIT-PARTNER-WARD", "physical_capacity": 48}]},
        ),
    ],
)
def test_adversarial_unknown_tools_types_extra_fields_and_offsite_actions_are_rejected(sf, name, arguments):
    session, tool = runtime(sf)
    try:
        with pytest.raises(PlanningError):
            tool.call(name, arguments)
        assert tool.staged is None
    finally:
        session.close()


def test_context_and_model_messages_exclude_patient_rows_roster_and_credentials(sf, monkeypatch):
    seen = scripted(monkeypatch, final="I can help configure this hospital.")
    result = turn(sf, "Explain the current plan")
    assert result["status"] == "SUCCEEDED"
    encoded = str(seen)
    assert "patient_id" not in encoded and "password" not in encoded.lower()
    assert "staff_id" not in encoded
    assert all(patient["patient_id"] not in encoded for patient in sf.dataset["patients"])
    assert "UNIT-WARD-A" in encoded


def test_chat_role_workspace_and_downgrade_protect_actions(sf, monkeypatch):
    _result, action = prepared(
        sf,
        monkeypatch,
        changes=[{"type": "parameters", "name": "Blocked viewer save"}],
        terminal="save",
        message="Save these settings",
    )
    assert sf.post("/api/auth/login", json={"demo_role": "viewer"}).status_code == 200
    # Local test users differ; chat privacy is enforced even within a workspace.
    assert sf.get(f"/api/sunfire/chats/{sf.chat['id']}").status_code == 404
    with sf.app.state.Session.begin() as session:
        source = session.get(Document, action["id"])
        chat = session.get(Document, source.data["chat_id"])
        chat.data = {**chat.data, "created_by": "user-admin"}
    assert sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=ack_payload(action)).status_code == 403
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").json()["name"] == "Current hospital plan"
    with sf.app.state.Session.begin() as session:
        row = session.get(Document, sf.chat["id"])
        row.workspace_id = "another-workspace"
    assert sf.get(f"/api/sunfire/chats/{sf.chat['id']}").status_code == 404


def test_duplicate_turn_keys_busy_chat_cancel_retry_and_reconnection_are_durable(sf, monkeypatch):
    scripted(monkeypatch, final="Which simulation dates should I use?")
    first = turn(sf, "Help plan", run=False)
    duplicate = turn(sf, "Help plan", run=False)
    assert first["id"] == duplicate["id"]
    conflict = sf.post(
        f"/api/sunfire/chats/{sf.chat['id']}/turns",
        json={"message": "Different", "context": sf.capture},
        headers={"Idempotency-Key": "turn-key"},
    )
    assert conflict.status_code == 409
    busy = sf.post(
        f"/api/sunfire/chats/{sf.chat['id']}/turns",
        json={"message": "Another", "context": sf.capture},
        headers={"Idempotency-Key": "other-key"},
    )
    assert busy.status_code == 409
    assert sf.post(f"/api/sunfire/turns/{first['id']}/cancel").json()["status"] == "CANCELLED"
    retry = sf.post(f"/api/sunfire/turns/{first['id']}/retry")
    assert retry.status_code == 202 and retry.json()["id"] == first["id"]
    worker.execute_job(first["id"], sf.database_url)
    completed = sf.get(f"/api/sunfire/turns/{first['id']}").json()
    assert completed["status"] == "SUCCEEDED"
    assert sf.post(f"/api/sunfire/turns/{first['id']}/retry").json()["id"] == first["id"]
    history = sf.get(f"/api/sunfire/chats/{sf.chat['id']}").json()
    assert len(history["turns"]) == 1 and len(history["messages"]) == 2


def test_pending_provider_cancellation_cannot_publish_prepared_action(sf, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(sunfire_provider, "availability", lambda: {"available": True, "model": "test"})

    def waiting(*_args, **_kwargs):
        entered.set()
        assert release.wait(10)
        return {
            "text": "",
            "tool_calls": [
                call("prepare_action", {"changes": [{"type": "parameters", "name": "Must not apply"}]})
            ],
            "model": "test",
        }

    monkeypatch.setattr(sunfire_provider, "complete", waiting)
    queued = turn(sf, "Set a new name", run=False)
    thread = threading.Thread(target=worker.execute_job, args=(queued["id"], sf.database_url))
    thread.start()
    try:
        assert entered.wait(10)
        assert sf.post(f"/api/sunfire/turns/{queued['id']}/cancel").json()["status"] == "CANCEL_REQUESTED"
    finally:
        release.set()
        thread.join(10)
    result = sf.get(f"/api/sunfire/turns/{queued['id']}").json()
    assert result["status"] == "CANCELLED" and result["actions"] == []


def test_tool_loop_bound_ends_honestly_without_publishing_actions(sf, monkeypatch):
    monkeypatch.setattr(sunfire_provider, "availability", lambda: {"available": True, "model": "test"})
    counter = []

    def loop(*_args, **_kwargs):
        counter.append(1)
        return {
            "text": "",
            "tool_calls": [call("read_planning_guide", {"topic": "safety"}, f"call{len(counter)}")],
            "model": "test",
        }

    monkeypatch.setattr(sunfire_provider, "complete", loop)
    result = turn(sf, "Explain everything")
    assert result["status"] == "FAILED" and result["error"]["code"] == "planning_budget_exceeded"
    assert len(counter) == 6 and result["actions"] == []


def test_results_missing_is_unavailable_and_actual_ensemble_and_example_keep_source(sf):
    queued = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
    session, tool = runtime(sf)
    try:
        missing = tool.call("read_results", {"run_group_id": queued["id"]})
        assert missing["available"] is False and missing["scalar_metrics"] is None
    finally:
        session.close()
    worker.execute_job(queued["id"], sf.database_url)
    run = sf.get(f"/api/run-groups/{queued['id']}").json()
    session, tool = runtime(sf)
    try:
        actual = tool.call("read_results", {"run_group_id": run["id"]})
        assert actual["available"] is True and actual["source"]["scope"] == "ensemble"
        assert actual["source"]["matches_current_draft"] is True
        example = tool.call(
            "read_results",
            {
                "run_group_id": run["id"],
                "scope": "example_run",
                "replication_id": run["selected_replication_id"],
            },
        )
        assert example["source"]["scope"] == "example_run"
        assert isinstance(example["scalar_metrics"]["average_wait_per_patient_hours"], float)
        changed_capture = {
            **sf.capture,
            "draft": {**sf.capture["draft"], "name": "Name does not alter model", "replications": 2},
        }
        changed = ToolRuntime(session, tool.user, changed_capture, "Explain", project_run).call(
            "read_results", {"run_group_id": run["id"]}
        )
        assert changed["source"]["matches_current_draft"] is False
    finally:
        session.close()


def test_saved_scenario_comparison_reuses_missing_and_revision_compatibility(sf):
    other = sf.post(
        "/api/scenarios",
        json={
            "name": "Other saved plan",
            "dataset_version_id": sf.dataset["id"],
            "horizon_calendar_days": 1,
            "replications": 1,
        },
    ).json()
    session, tool = runtime(sf)
    try:
        result = tool.call(
            "compare_saved_scenarios",
            {"left_scenario_id": sf.scenario["id"], "right_scenario_id": other["id"]},
        )
        assert result["compatibility"]["comparable"] is False
        assert result["paired_evidence"] is None
        assert all(value["difference"] is None for value in result["deltas"])
        assert result["current_unsaved_draft_used"] is False
    finally:
        session.close()


def test_no_agent_changes_keeps_engine_trajectory_identical_and_tools_never_touch_source(sf, monkeypatch):
    before = copy.deepcopy(sf.capture["draft"])
    expected = run_replication(sf.dataset, {**sf.scenario, **before}, 0, keep_trace=True)
    scripted(
        monkeypatch, [call("get_current_context", {})], final="The current draft is ready for your review."
    )
    result = turn(sf, "Explain the current settings")
    assert result["status"] == "SUCCEEDED" and result["actions"] == []
    after = sf.get(f"/api/scenarios/{sf.scenario['id']}").json()
    actual = run_replication(sf.dataset, {**after, **public_draft(after)}, 0, keep_trace=True)
    assert actual["events"] == expected["events"]
    assert actual["scalar_metrics"] == expected["scalar_metrics"]
    with sf.app.state.Session() as session:
        assert session.get(Document, sf.dataset["id"]).data == sf.dataset
        audits = list(session.scalars(select(AuditEvent).where(AuditEvent.action.like("sunfire.%"))))
        assert {row.action for row in audits} >= {
            "sunfire.chat_created",
            "sunfire.turn_queued",
            "sunfire.tool_called",
            "sunfire.turn_completed",
        }


def test_strict_schema_cannot_coerce_booleans_or_unbounded_records():
    with pytest.raises(ValueError):
        PrepareArguments.model_validate(
            {
                "changes": [
                    {
                        "type": "temporary_beds",
                        "unit_id": "UNIT-WARD-A",
                        "unavailable_count": True,
                        "start_at": "x",
                        "end_at": "y",
                    }
                ]
            }
        )


@pytest.mark.parametrize(
    "message,quote,terminal",
    [
        ("Set daily disruption chance to25%. Explain how to run it.", "run", "run"),
        ("Can you explain how to cancel a run?", "cancel", "cancel_run"),
        ("Set the risk and describe how to save later.", "save", "save"),
        ("Run this simulation", "Run", "run"),
        ("Can you save this plan?", "save", "save"),
        ("Set risk to25% and then run the simulation", "run", "run"),
    ],
)
def test_terminal_direct_authority_binds_actual_request_clause(message, quote, terminal):
    expected = message.startswith(("Run", "Can you save", "Set risk to"))
    assert direct_authorized(message, quote, terminal) is expected


@pytest.mark.parametrize(
    "message,quote",
    [
        (
            "Apply this to the current draft without saving or running: exactly 100 additional emergency-department patients on 2026-10-17 at 10:00 AM America/Chicago, spread over 60 minutes using the emergency stream's usual care mix. Keep the usual arrival curve unchanged. Make exactly 10 currently enabled Ward A beds temporarily unavailable from 2026-10-17 at 8:00 AM until 2026-10-18 at 8:00 AM America/Chicago, then restore the previous availability. Keep installed beds and staff unchanged.",
            "Apply this to the current draft without saving or running",
        ),
        (
            "Set Ward A registered nurses to 10 per shift throughout this simulation and update the linked staffed-bed target as the normal nurse control does. Apply it to the draft now without saving or running. Leave other parameters unchanged.",
            "Apply it to the draft now without saving or running",
        ),
        ("Apply a25% disruption chance. Do not save or run.", "Apply a25% disruption chance"),
        ("Don't run the simulation; set the disruption chance to25%.", "set the disruption chance to25%"),
    ],
)
def test_explicit_draft_edit_excludes_save_run_without_losing_edit_authority(message, quote):
    assert direct_authorized(message, quote, "edit") is True
    assert direct_authorized(message, message, "save") is False
    assert direct_authorized(message, message, "run") is False


@pytest.mark.parametrize(
    "message,quote,terminal",
    [
        ("Do not apply these changes. Explain them first.", "apply", "edit"),
        ("Explain how to apply this without saving or running.", "apply", "edit"),
        ("Can you describe how to apply a change?", "apply", "edit"),
        ("What if I apply this without saving or running?", "apply", "edit"),
        ("Apply the disruption chance without saving or changing beds.", "Apply", "edit"),
        ("Never save or edit the current draft.", "edit", "edit"),
        ("Keep installed beds and staff unchanged.", "Keep", "save"),
        ("Set the disruption chance without running. Explain how to run it later.", "run", "run"),
    ],
)
def test_excluded_terminal_scope_never_authorizes_negative_or_informational_mutation(
    message, quote, terminal
):
    assert direct_authorized(message, quote, terminal) is False


def test_rejected_second_change_never_partially_publishes_first_change(sf, monkeypatch):
    scripted(
        monkeypatch,
        [
            call(
                "prepare_action",
                {
                    "changes": [{"type": "parameters", "name": "Partial should not apply"}],
                    "mode": "direct",
                    "authorization_quote": "Set a name and remove10beds",
                },
            ),
            call(
                "prepare_action",
                {
                    "changes": [
                        {
                            "type": "temporary_beds",
                            "unit_id": "UNIT-WARD-A",
                            "unavailable_count": 10,
                            "start_at": sf.scenario["start_at"],
                            "end_at": iso(dt(sf.scenario["start_at"]) + timedelta(hours=4)),
                        }
                    ]
                },
                "call2",
            ),
        ],
    )
    result = turn(sf, "Set a name and remove10beds")
    assert result["status"] == "SUCCEEDED" and result["actions"] == []
    assert "Which ward" in result["text"]
    assert "No action was applied" in result["text"]


def test_invalid_model_schema_can_repair_within_bounded_loop(sf, monkeypatch):
    responses = [
        {
            "text": "",
            "tool_calls": [call("prepare_action", {"changes": {"disruption_chance_percent": 25}})],
            "model": "test",
        },
        {
            "text": "",
            "tool_calls": [
                call(
                    "prepare_action",
                    {
                        "changes": [{"type": "operations", "disruption_chance_percent": 25}],
                        "mode": "direct",
                        "authorization_quote": "Set disruption chance to25%",
                    },
                    "repair",
                )
            ],
            "model": "test",
        },
        {"text": "It has been applied", "tool_calls": [], "model": "test"},
    ]
    monkeypatch.setattr(sunfire_provider, "availability", lambda: {"available": True, "model": "test"})

    def complete(messages, *_args, **_kwargs):
        if len(responses) == 2:
            assert "invalid_tool_arguments" in messages[-1]["content"]
        return responses.pop(0)

    monkeypatch.setattr(sunfire_provider, "complete", complete)
    result = turn(sf, "Set disruption chance to25%")
    assert result["status"] == "SUCCEEDED" and len(result["actions"]) == 1
    assert result["actions"][0]["validated_draft"]["hospital_operations"] == {"disruption_chance_percent": 25}
    assert "the card shows their current status" in result["text"]


def test_cancel_target_is_bound_to_selected_job_and_executes_once(sf, monkeypatch):
    first = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
    second = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
    capture = {**sf.capture, "selected_run_group_id": first["id"]}
    session, tool = runtime(sf, capture)
    try:
        tool.message = "Cancel this simulation"
        with pytest.raises(PlanningError, match="Which simulation"):
            tool.call(
                "prepare_action",
                {
                    "terminal": "cancel_run",
                    "run_group_id": second["id"],
                    "mode": "direct",
                    "authorization_quote": tool.message,
                },
            )
        assert tool.staged is None
    finally:
        session.close()
    sf.capture = capture
    _result, action = prepared(
        sf, monkeypatch, terminal="cancel_run", message="Cancel this simulation", run_id=first["id"]
    )
    payload = ack_payload(action)
    receipt = sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=payload)
    assert receipt.status_code == 200, receipt.text
    assert receipt.json()["cancelled_run"]["status"] == "CANCELLED"
    assert sf.post(f"/api/sunfire/actions/{action['id']}/apply", json=payload).json() == receipt.json()
    assert sf.get(f"/api/run-groups/{second['id']}").json()["status"] == "QUEUED"


def test_result_day_and_exact_moment_never_substitute_whole_horizon_and_hide_patient_ids(sf):
    run = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
    worker.execute_job(run["id"], sf.database_url)
    run = sf.get(f"/api/run-groups/{run['id']}").json()
    session, tool = runtime(sf)
    try:
        day = tool.call("read_results", {"run_group_id": run["id"], "local_date": "2026-10-16"})
        assert day["available"] and day["scalar_metrics"] is None
        assert day["period_metrics"]["local_date"] == "2026-10-16"
        missing = tool.call("read_results", {"run_group_id": run["id"], "local_date": "2026-10-17"})
        assert not missing["available"] and missing["scalar_metrics"] is None
        exact = tool.call(
            "read_results",
            {
                "run_group_id": run["id"],
                "scope": "example_run",
                "replication_id": run["selected_replication_id"],
                "at": sf.scenario["start_at"],
            },
        )
        assert exact["available"] and exact["scalar_metrics"] is None
        assert len(exact["snapshot"]["units"]) == 5
        assert "patient_id" not in str(exact) and "active_staff_ids" not in str(exact)
        assert exact["snapshot"]["treatment_status"] is None
    finally:
        session.close()


def test_saved_scenario_search_is_literal_bounded_and_workspace_owned(sf):
    session, tool = runtime(sf)
    try:
        result = tool.call("find_saved_scenarios", {"query": "hospital", "limit": 1})
        assert len(result["items"]) == 1 and result["items"][0]["id"] == sf.scenario["id"]
        assert tool.call("find_saved_scenarios", {"query": "%"})["items"] == []
        assert "conditions" not in result["items"][0]
    finally:
        session.close()


def test_null_draft_arrays_are_validation_errors_not_server_failures(sf):
    payload = {
        "message": "Help plan",
        "context": {**sf.capture, "draft": {**sf.capture["draft"], "updates": None}},
    }
    response = sf.post(
        f"/api/sunfire/chats/{sf.chat['id']}/turns", json=payload, headers={"Idempotency-Key": "invalid"}
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_failed"


def test_validated_handoff_needs_no_model_prose_tail_even_on_last_permitted_call(sf, monkeypatch):
    responses = [
        {
            "text": "",
            "tool_calls": [call("read_planning_guide", {"topic": "safety"}, f"guide{index}")],
            "model": "test",
        }
        for index in range(5)
    ]
    responses.append(
        {
            "text": "",
            "tool_calls": [
                call(
                    "prepare_action",
                    {
                        "changes": [{"type": "operations", "disruption_chance_percent": 25}],
                        "mode": "proposal",
                    },
                    "handoff",
                )
            ],
            "model": "test",
        }
    )
    monkeypatch.setattr(sunfire_provider, "availability", lambda: {"available": True, "model": "test"})

    def complete(*_args, **_kwargs):
        assert responses, "A validated handoff must not request a seventh/final prose call"
        return responses.pop(0)

    monkeypatch.setattr(sunfire_provider, "complete", complete)
    value = turn(sf, "Set disruption chance to 25 percent")
    assert value["status"] == "SUCCEEDED" and len(value["actions"]) == 1
    assert value["actions"][0]["mode"] == "direct"
    with sf.app.state.Session() as session:
        assert session.get(Job, value["id"]).result["model_calls"] == 6


def test_actual_provider_compound_shape_binds_direct_from_human_not_model_hint(sf, monkeypatch):
    sf.capture = {**sf.capture, "draft": {**sf.capture["draft"], "horizon_calendar_days": 3}}
    message = "Apply this to the current draft without saving or running: exactly 100 additional emergency-department patients on 2026-10-17 at 10:00 AM America/Chicago, spread over 60 minutes using the emergency stream's usual care mix. Keep the usual arrival curve unchanged. Make exactly 10 currently enabled Ward A beds temporarily unavailable from 2026-10-17 at 8:00 AM until 2026-10-18 at 8:00 AM America/Chicago, then restore the previous availability. Keep installed beds and staff unchanged."
    changes = [
        {
            "type": "arrival_batch",
            "count": 100,
            "at": "2026-10-17T10:00:00-05:00",
            "entry_stream_id": "ED_MAIN",
            "spread_minutes": 60,
            "care_mix": None,
        },
        {
            "type": "temporary_beds",
            "unit_id": "UNIT-WARD-A",
            "unavailable_count": 10,
            "start_at": "2026-10-17T08:00:00-05:00",
            "end_at": "2026-10-18T08:00:00-05:00",
        },
    ]
    _value, action = prepared(sf, monkeypatch, changes=changes, message=message, mode="proposal")
    assert action["mode"] == "direct" and action["kind"] == "edit"
    assert (
        len([item for item in action["validated_draft"]["conditions"] if item["kind"] == "arrival_batch"])
        == 1
    )
    assert len(action["validated_draft"]["updates"]) == 2
    assert "_change_intents" not in action


def test_actual_rn_shape_promotes_only_the_humans_requested_role_and_unit(sf, monkeypatch):
    message = "Set Ward A registered nurses to 10 per shift throughout this simulation and update the linked staffed-bed target as the normal nurse control does. Apply it to the draft now without saving or running. Leave other parameters unchanged."
    _value, action = prepared(
        sf,
        monkeypatch,
        changes=[{"type": "unit", "unit_id": "UNIT-WARD-A", "staff_counts": {"rn": 10}}],
        message=message,
        mode="proposal",
    )
    assert action["mode"] == "direct"
    session, tool = runtime(sf)
    try:
        tool.message = message
        unrequested = tool.call(
            "prepare_action",
            {
                "changes": [{"type": "unit", "unit_id": "UNIT-WARD-B", "staff_counts": {"rn": 10}}],
                "mode": "direct",
                "authorization_quote": message,
            },
        )
        assert unrequested["mode"] == "proposal"
    finally:
        session.close()


@pytest.mark.parametrize("kind", ["beds", "arrivals"])
def test_dates_and_clock_digits_never_corroborate_an_invented_material_count(sf, kind):
    sf.capture = {**sf.capture, "draft": {**sf.capture["draft"], "horizon_calendar_days": 3}}
    message = "Apply this to the draft: make Ward A beds unavailable and add emergency patients on 2026-10-17 at 10:00 AM until 2026-10-18 at 10:00 AM America/Chicago."
    changes = (
        [
            {
                "type": "temporary_beds",
                "unit_id": "UNIT-WARD-A",
                "unavailable_count": 10,
                "start_at": "2026-10-17T10:00:00-05:00",
                "end_at": "2026-10-18T10:00:00-05:00",
            }
        ]
        if kind == "beds"
        else [
            {
                "type": "arrival_batch",
                "count": 10,
                "at": "2026-10-17T10:00:00-05:00",
                "entry_stream_id": "ED_MAIN",
                "spread_minutes": 60,
            }
        ]
    )
    session, tool = runtime(sf)
    try:
        tool.message = message
        value = tool.call(
            "prepare_action", {"changes": changes, "mode": "direct", "authorization_quote": message}
        )
        assert value["mode"] == "proposal"
    finally:
        session.close()


def test_suggestion_clause_cannot_authorize_unsolicited_extra_changes(sf):
    session, tool = runtime(sf)
    try:
        tool.message = "Set disruption chance to 25 percent and suggest 10 registered nurses for Ward A."
        value = tool.call(
            "prepare_action",
            {
                "changes": [
                    {"type": "operations", "disruption_chance_percent": 25},
                    {"type": "unit", "unit_id": "UNIT-WARD-A", "staff_counts": {"rn": 10}},
                ],
                "mode": "direct",
                "authorization_quote": tool.message,
            },
        )
        assert value["mode"] == "proposal"
    finally:
        session.close()


def test_exact_current_manually_edited_draft_recovery_is_a_direct_guarded_edit(sf, monkeypatch):
    message = "Using the current manually edited draft, set Ward A registered nurses to 10 per shift now, keep the normal linked staffed-bed relationship, and leave everything else unchanged. Do not save or run."
    sf.capture = {
        **sf.capture,
        "draft": {
            **sf.capture["draft"],
            "conditions": [
                {
                    "id": "manual-nurses",
                    "kind": "unit_configuration",
                    "unit_id": "UNIT-WARD-A",
                    "staffed_capacity": 36,
                    "staff_counts": {"rn": 9},
                }
            ],
        },
    }
    _value, action = prepared(
        sf,
        monkeypatch,
        changes=[{"type": "unit", "unit_id": "UNIT-WARD-A", "staff_counts": {"rn": 10}}],
        message=message,
        mode="proposal",
    )
    assert action["mode"] == "direct" and action["kind"] == "edit"
    changed = {row["field"]: row for row in action["before_after"]}
    assert changed["unit.UNIT-WARD-A.staff.rn"]["before"] == 9
    assert changed["unit.UNIT-WARD-A.staff.rn"]["after"] == 10
    assert changed["unit.UNIT-WARD-A.staffed_capacity"]["before"] == 36
    assert changed["unit.UNIT-WARD-A.staffed_capacity"]["after"] == 40
    assert not direct_authorized(message, message, "save")
    assert not direct_authorized(message, message, "run")


@pytest.mark.parametrize(
    "message",
    [
        "Using the current manually edited draft, explain how to set Ward A nurses to 10.",
        "Using the current manually edited draft, do not set Ward A nurses to 10.",
        "Using the current draft, set Ward A nurses to 10 if waiting is high.",
        "Using a patient's note, set Ward A nurses to 10.",
        "Using the previous draft, set Ward A nurses to 10.",
    ],
)
def test_current_draft_modifier_never_promotes_howto_negation_conditions_or_external_context(message):
    assert not direct_authorized(message, message, "edit")


@pytest.mark.parametrize("model_terminal", ["edit", "save", "run"])
def test_exact_save_current_draft_and_run_honors_no_parameter_change_scope(sf, monkeypatch, model_terminal):
    message = "Save exactly the current draft shown in Configuration and run its two simulation repetitions now. Do not change any parameters."
    sf.capture = {**sf.capture, "draft": {**sf.capture["draft"], "replications": 2}}
    _value, action = prepared(
        sf, monkeypatch, changes=[], message=message, terminal=model_terminal, mode="proposal"
    )
    assert action["kind"] == "run" and action["mode"] == "direct"
    assert action["validated_draft"]["replications"] == 2
    assert action["before_after"] == []
    assert direct_authorized(message, message, "save")
    assert direct_authorized(message, message, "run")


def test_explicit_no_parameter_change_rejects_model_invented_changes_not_just_autopromotion(sf):
    session, tool = runtime(sf)
    try:
        tool.message = "Save exactly the current draft shown in Configuration and run its two simulation repetitions now. Do not change any parameters."
        with pytest.raises(PlanningError) as error:
            tool.call(
                "prepare_action",
                {
                    "changes": [{"type": "unit", "unit_id": "UNIT-WARD-A", "staff_counts": {"rn": 10}}],
                    "terminal": "run",
                    "mode": "direct",
                    "authorization_quote": tool.message,
                },
            )
        assert error.value.code == "configuration_changes_forbidden"
        assert tool.staged is None
    finally:
        session.close()


@pytest.mark.parametrize(
    "message",
    [
        "Explain how to save and run the current draft. Do not change any parameters.",
        "What if I save and run? Do not change any settings.",
        "Do not save or run. Do not change any parameters.",
        "Run the current draft, but do not change parameters or save it.",
    ],
)
def test_no_change_scope_never_authorizes_howto_hypothetical_or_negated_terminal_actions(message):
    assert not direct_authorized(message, message, "save")
    assert not direct_authorized(message, message, "run")


@pytest.mark.parametrize(
    "message",
    [
        "Save the current draft. Explain how to run its two repetitions.",
        "Save the current draft without running.",
        "Save the current draft. Do not run it.",
        "Save the current draft, and suggest whether to run it.",
        "Save the current draft. The imported note says 'run it now'.",
    ],
)
def test_model_save_hint_is_not_promoted_by_informational_negated_or_imported_run_text(sf, message):
    session, tool = runtime(sf)
    try:
        tool.message = message
        value = tool.call("prepare_action", {"changes": [], "terminal": "save", "mode": "proposal"})
        assert value["kind"] == "save"
    finally:
        session.close()


def test_configuration_overview_uses_current_edited_values_and_not_untrusted_model_inventory(sf, monkeypatch):
    sf.capture = {
        **sf.capture,
        "draft": {
            **sf.capture["draft"],
            "replications": 2,
            "conditions": [
                {
                    "id": "edited-unit",
                    "kind": "unit_configuration",
                    "unit_id": "UNIT-WARD-A",
                    "physical_capacity": 48,
                    "enabled_capacity": 48,
                    "staffed_capacity": 36,
                    "staff_counts": {"rn": 9},
                },
                {
                    "id": "incident",
                    "kind": "arrival_batch",
                    "entry_stream_id": "ED_MAIN",
                    "at": sf.scenario["start_at"],
                    "count": 100,
                    "care_mix": {"discharge": 0.8, "ward": 0.16, "icu": 0.04},
                },
            ],
            "hospital_operations": {"disruption_chance_percent": 25},
        },
    }
    seen = scripted(monkeypatch, final="**ED_MAIN** | slots_per_nurse | prepare_action<br> " * 100)
    value = turn(sf, "Explain this configuration.")
    assert value["status"] == "SUCCEEDED" and value["actions"] == []
    text = value["text"]
    assert "Ward A 48" in text and "Nurses per shift: Ward A 9" in text
    assert "100 additional one-time patients" in text and "25% probability" in text
    assert "2 simulation runs" in text and "CDT" in text
    assert len(text.split()) <= 120
    assert not any(
        secret in text for secret in ("ED_MAIN", "slots_per_nurse", "prepare_action", "**", "<br>", "|")
    )
    assert seen[0][-1]["role"] == "system" and "READ ONLY" in seen[0][-1]["content"]
    assert sf.get(f"/api/scenarios/{sf.scenario['id']}").json()["conditions"] == []


def test_configuration_overview_preserves_unknowns_and_does_not_swallow_specific_or_compound_questions():
    captured = {
        "current_unsaved_draft": {"configuration": {"conditions": [], "replications": 2}},
        "calendar": {
            "scenario_start_at": "2026-11-01T05:30:00Z",
            "scenario_end_at": "2026-11-02T06:00:00Z",
            "timezone": "America/Chicago",
        },
        "baseline": {
            "units": [
                {
                    "unit_id": "UNIT-MISSING",
                    "kind": "ward",
                    "enabled_beds": None,
                    "staff_counts": {"rn": None},
                }
            ]
        },
    }
    text = configuration_overview("Explain this configuration.", captured)
    assert "Ward unavailable" in text and "Ward 0" not in text
    assert "12:30 AM" in text and "CDT to CST" in text
    assert "UNIT-MISSING" not in text
    for question in (
        "Explain this configuration and run it",
        "Explain staffing in this configuration",
        "Explain this configuration in detail",
    ):
        assert configuration_overview(question, captured) is None


def test_main_bottleneck_question_ignores_model_invented_day_and_example_filters_and_reads_actual_saved_ensemble(
    sf, monkeypatch
):
    updated = sf.patch(
        f"/api/scenarios/{sf.scenario['id']}",
        headers={"If-Match": str(sf.scenario["revision"])},
        json={"hospital_operations": {"disruption_chance_percent": 100}},
    )
    assert updated.status_code == 200, updated.text
    sf.scenario = updated.json()
    sf.capture = {**sf.capture, "saved_revision": sf.scenario["revision"], "draft": public_draft(sf.scenario)}
    run = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
    worker.execute_job(run["id"], sf.database_url)
    run = sf.get(f"/api/run-groups/{run['id']}").json()
    session, tool = runtime(sf)
    message = "Where is the main bottleneck in the saved results for this scenario?"
    arguments = {
        "run_group_id": run["id"],
        "local_date": "2026-10-18",
        "scope": "example_run",
        "replication_id": run["selected_replication_id"],
        "at": sf.scenario["start_at"],
    }
    try:
        tool.message = message
        actual = tool.call("read_results", arguments)
        assert actual["available"] and actual["source"]["scope"] == "ensemble"
        assert "period_metrics" not in actual and "snapshot" not in actual
        assert actual["scalar_metrics"]["average_wait_per_patient_hours"]["p50"] is not None
        expected = actual["main_bottleneck"]
        assert expected and not expected.get("no_attributed_constraint")
        assert actual["source"]["matches_current_draft"] is True
        canonical = evidence_view("read_results", actual, 0)
    finally:
        session.close()
    scripted(
        monkeypatch,
        [call("read_results", arguments)],
        final="Nobody waits on October 18, so there is no bottleneck.",
    )
    answer = turn(sf, message)
    assert answer["status"] == "SUCCEEDED" and answer["actions"] == []
    assert answer["evidence"][0]["summary"] == canonical["summary"]
    assert expected["label"] in answer["text"] and expected["unit"] in answer["text"]
    assert "Across the completed simulations" in answer["text"]
    assert "Nobody waits" not in answer["text"]


@pytest.mark.parametrize("stale", [False, True])
def test_main_bottleneck_without_current_saved_results_is_missing_or_stale_never_zero(sf, stale):
    old_id = "unasked-model-run"
    if stale:
        queued = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
        old_id = queued["id"]
        worker.execute_job(old_id, sf.database_url)
        updated = sf.patch(
            f"/api/scenarios/{sf.scenario['id']}",
            headers={"If-Match": str(sf.scenario["revision"])},
            json={"name": "Later saved revision"},
        )
        assert updated.status_code == 200
        current = updated.json()
        sf.capture = {**sf.capture, "saved_revision": current["revision"], "draft": public_draft(current)}
    session, tool = runtime(sf)
    try:
        tool.message = "Where is the main bottleneck in the saved results for this scenario?"
        value = tool.call("read_results", {"run_group_id": old_id, "local_date": "2026-10-18"})
        assert value["available"] is False and value["scalar_metrics"] is None
        assert value["status"] == ("stale" if stale else "missing")
        answer = evidence_view("read_results", value, 0)
        assert all(item["value"] is None for item in answer["values"])
        assert answer["links"] == []
        assert (
            "different saved settings" in answer["summary"]
            if stale
            else "Run this saved configuration" in answer["summary"]
        )
    finally:
        session.close()


def test_bottleneck_question_preserves_actual_requested_day_exact_moment_and_example_scope(sf):
    queued = sf.post("/api/run-groups", json={"scenario_id": sf.scenario["id"]}).json()
    worker.execute_job(queued["id"], sf.database_url)
    run = sf.get(f"/api/run-groups/{queued['id']}").json()
    session, tool = runtime(sf)
    try:
        tool.message = "Where is the main bottleneck on 2026-10-16?"
        day = tool.call("read_results", {"run_group_id": run["id"], "local_date": "2026-10-16"})
        assert day["period_metrics"]["local_date"] == "2026-10-16" and day["scalar_metrics"] is None
        assert "local-day results for 2026-10-16" in evidence_view("read_results", day, 0)["summary"]
        tool.message = "Where is the main bottleneck in this one example run?"
        example = tool.call(
            "read_results",
            {
                "run_group_id": run["id"],
                "scope": "example_run",
                "replication_id": run["selected_replication_id"],
            },
        )
        assert example["source"]["scope"] == "example_run"
        assert "one example run" in evidence_view("read_results", example, 0)["summary"]
        tool.message = "Where is the main bottleneck at this exact moment in the example run?"
        exact = tool.call(
            "read_results",
            {
                "run_group_id": run["id"],
                "scope": "example_run",
                "replication_id": run["selected_replication_id"],
                "at": sf.scenario["start_at"],
            },
        )
        assert exact["snapshot"]["at"] == sf.scenario["start_at"] and exact["scalar_metrics"] is None
        assert exact["source"]["replication_id"] == run["selected_replication_id"]
    finally:
        session.close()
