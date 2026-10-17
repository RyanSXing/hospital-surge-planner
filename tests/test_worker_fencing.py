"""Two live attempts must never publish over a lease takeover."""

import copy
import threading
import time

import pytest
from oci.exceptions import ServiceError
from sqlalchemy import select
from surge_api import worker
from surge_api.db import Document, Job
from test_api import client, create_short_scenario, setup_context  # noqa: F401


def snapshot(Session, identity):
    with Session() as session:
        job = session.get(Job, identity)
        return copy.deepcopy(
            {
                "job": {
                    key: getattr(job, key)
                    for key in (
                        "attempts",
                        "status",
                        "payload",
                        "result",
                        "completed",
                        "completed_at",
                        "error",
                        "lease_until",
                    )
                },
                "replications": {
                    row.id: row.data
                    for row in session.scalars(select(Document).where(Document.kind == "replication"))
                },
            }
        )


@pytest.mark.parametrize(
    "kind,boundary",
    [
        ("run", "replication-0.json.gz"),
        ("run", "inputs.json.gz"),
        ("run", "compute_failure"),
        ("trace", "trace-0.json.gz"),
        ("export", "hospital-surge-planner.json"),
    ],
)
def test_live_old_attempt_cannot_publish_or_fail_new_attempt(client, monkeypatch, kind, boundary):  # noqa: F811
    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=1)
    run = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()
    Session = client.app.state.Session
    identity = run["id"]
    if kind != "run":
        worker.execute_job(identity, client.database_url)
        with Session.begin() as session:
            completed = session.get(Job, identity)
            assert completed.status == "SUCCEEDED"
            identity = kind + "-fencing-test"
            session.add(
                Job(
                    id=identity,
                    workspace_id=completed.workspace_id,
                    kind=kind,
                    total=1,
                    payload={
                        "run_group_id": completed.id,
                        "format": "json",
                        "include_events": False,
                        "replication_id": completed.result["selected_replication_id"],
                    },
                )
            )
    paused, release = threading.Event(), threading.Event()
    replacement_paused, release_replacement = threading.Event(), threading.Event()
    failures = []
    written = {"stale-attempt": [], "replacement-attempt": []}
    original_write = worker.ArtifactStore.write
    original_compute = worker.timed_replication
    original_control = worker.job_control

    def is_old():
        return threading.current_thread().name == "stale-attempt"

    def write(store, workspace, owner, name, data, media_type="application/json"):
        artifact = original_write(store, workspace, owner, name, data, media_type)
        thread = threading.current_thread().name
        if thread in written:
            written[thread].append(artifact)
        if is_old() and name == boundary:
            paused.set()
            assert release.wait(30), "test did not release old upload"
        elif threading.current_thread().name == "replacement-attempt" and name == boundary:
            replacement_paused.set()
            assert release_replacement.wait(30), "test did not release replacement upload"
        return artifact

    def compute(*args, **kwargs):
        if is_old() and boundary == "compute_failure":
            paused.set()
            assert release.wait(30), "test did not release old computation"
            raise ValueError("late deterministic failure from old attempt")
        if threading.current_thread().name == "replacement-attempt" and boundary == "compute_failure":
            replacement_paused.set()
            assert release_replacement.wait(30), "test did not release replacement computation"
        return original_compute(*args, **kwargs)

    # Simulate a stalled CPU/SDK call whose cancellation callback never runs.
    # The database publication fence must independently reject the old writer.
    def control(*args):
        return (lambda: False) if is_old() else original_control(*args)

    monkeypatch.setattr(worker.ArtifactStore, "write", write)
    monkeypatch.setattr(worker, "timed_replication", compute)
    monkeypatch.setattr(worker, "job_control", control)

    def old_attempt():
        try:
            worker.execute_job(identity, client.database_url)
        except Exception as exc:  # noqa: BLE001 - propagate thread failures into the test assertion.
            failures.append(exc)

    old = threading.Thread(target=old_attempt, name="stale-attempt")
    replacement = threading.Thread(target=old_attempt, name="replacement-attempt")
    old.start()
    try:
        assert paused.wait(20), "old attempt never reached publication boundary"
        with Session.begin() as session:
            job = session.get(Job, identity)
            assert job.attempts == 1
            job.lease_until = time.time() - 1
        replacement.start()
        assert replacement_paused.wait(20)
        current = snapshot(Session, identity)
        assert current["job"]["status"] in {"RUNNING", "AGGREGATING"}, current["job"]
        assert current["job"]["attempts"] == 2
        release.set()
        old.join(20)
        assert not old.is_alive() and not failures
        assert snapshot(Session, identity) == current
        referenced = set(worker.artifact_keys(current))
        store = worker.ArtifactStore()
        for artifact in written["stale-attempt"]:
            assert (store.root / artifact["object_key"]).exists() == (artifact["object_key"] in referenced)
        assert all((store.root / item["object_key"]).exists() for item in written["replacement-attempt"])
    finally:
        release.set()
        release_replacement.set()
        old.join(30)
        if replacement.ident is not None:
            replacement.join(30)
    assert not replacement.is_alive() and not failures
    final = snapshot(Session, identity)
    assert final["job"]["status"] == "SUCCEEDED"
    assert all(row["status"] == "SUCCEEDED" for row in final["replications"].values())
    store = worker.ArtifactStore()
    assert all((store.root / key).exists() for key in worker.artifact_keys(final))


def test_manual_retry_starts_fresh_budget_without_reusing_fence(client, monkeypatch):  # noqa: F811
    scenario = create_short_scenario(client, setup_context(client), replications=1)
    identity = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()["id"]
    Session = client.app.state.Session
    inputs = []

    def run(identity, factory, token, uploads):
        with factory.begin() as session:
            job = worker.lock_attempt(session, identity, token)
            inputs.append(copy.deepcopy(job.payload))
            if token.attempt == 6:
                job.status = "SUCCEEDED"
                job.result = worker.result_with_generation(job, {"finished": True})
                job.lease_until = 0
                return
        raise ServiceError(503, "Unavailable", {}, "temporary service failure")

    monkeypatch.setattr(worker, "run_job", run)
    for attempt in (1, 2, 3):
        worker.execute_job(identity, client.database_url)
        with Session.begin() as session:
            job = session.get(Job, identity)
            assert job.attempts == attempt
            job.lease_until = 0
    assert client.get(f"/api/run-groups/{identity}").json()["status"] == "FAILED"
    assert client.post(f"/api/run-groups/{identity}/retry").status_code == 202
    assert client.post(f"/api/run-groups/{identity}/retry").status_code == 409
    with Session.begin() as session:
        job = session.get(Job, identity)
        assert job.attempts == 3
        assert job.result["retry_generation"] == {"number": 1, "attempt_base": 3}
        with pytest.raises(worker.LeaseLost):
            worker.lock_attempt(session, identity, worker.AttemptToken(3, 0, 0), active=False)
    for attempt in (4, 5, 6):
        worker.execute_job(identity, client.database_url)
        with Session.begin() as session:
            job = session.get(Job, identity)
            assert job.attempts == attempt
            assert job.result["retry_generation"] == {"number": 1, "attempt_base": 3}
            if attempt < 6:
                assert job.status == "QUEUED"
                assert job.result["retry"]["attempt"] == attempt - 3
                assert job.result["retry"]["automatic"] is True
            else:
                assert job.status == "SUCCEEDED"
                assert job.result["finished"] is True
            job.lease_until = 0
    assert all(payload == inputs[0] for payload in inputs)
