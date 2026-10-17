"""Durable infrastructure retry policy, with no model/RNG input changes."""

import copy
import sqlite3
import time

import pytest
from oci._vendor.requests import exceptions as network
from oci.exceptions import RequestException, ServiceError
from sqlalchemy.exc import OperationalError
from surge_api import worker
from surge_api.db import Document, Job, make_database
from test_api import client, create_short_scenario, setup_context  # noqa: F401


@pytest.fixture
def jobs(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    url = "sqlite:///" + str(tmp_path / "retry.db")
    engine, Session = make_database(url)
    with Session.begin() as session:
        session.add(
            Job(
                id="retry-run",
                workspace_id="W",
                kind="run",
                payload={
                    "input_sha256": "frozen-input-hash",
                    "scenario": {"base_seed": 41021, "replications": 2},
                },
                total=2,
            )
        )
    yield url, Session
    engine.dispose()


def make_due(Session):
    with Session.begin() as session:
        session.get(Job, "retry-run").lease_until = 0


def test_retry_preserves_inputs_completed_replications_and_attempt_history(jobs, monkeypatch):
    url, Session = jobs
    inputs = []

    def run(identity, factory, token, uploads):
        with factory.begin() as session:
            job = session.get(Job, identity)
            inputs.append(copy.deepcopy(job.payload))
            if job.attempts == 1:
                session.add(
                    Document(
                        id="completed-rep",
                        workspace_id="W",
                        kind="replication",
                        data={"replication_index": 0, "seed": 41021, "aggregate_artifact": "kept"},
                    )
                )
                job.completed = 1
            else:
                assert job.completed == 1
                assert session.get(Document, "completed-rep").data["aggregate_artifact"] == "kept"
            attempt = job.attempts
            if attempt == 3:
                job.status = "SUCCEEDED"
                job.result = {"artifact": "completed", "selected_replication_id": "rep-0"}
        if attempt < 3:
            raise RequestException(network.ConnectionError("secret connection details"))

    monkeypatch.setattr(worker, "run_job", run)
    for attempt in (1, 2, 3):
        before = time.time()
        worker.execute_job("retry-run", url)
        with Session() as session:
            job = session.get(Job, "retry-run")
            assert job.attempts == attempt
            assert len(job.result["attempt_history"]) == attempt
            if attempt < 3:
                delay = 5 * 2 ** (attempt - 1)
                assert job.status == "QUEUED" and job.dispatched is False
                assert before + delay <= job.lease_until <= time.time() + delay
                assert job.completed_at is None
                assert "secret" not in job.error
                assert job.result["retry"]["not_before"] == job.lease_until
            else:
                assert job.status == "SUCCEEDED" and job.error is None
                assert job.result["artifact"] == "completed"
                assert "retry" not in job.result
                assert [item["status"] for item in job.result["attempt_history"]] == [
                    "QUEUED",
                    "QUEUED",
                    "SUCCEEDED",
                ]
        if attempt < 3:
            # A duplicate old delivery cannot bypass the persisted backoff.
            worker.execute_job("retry-run", url)
            assert len(inputs) == attempt
            make_due(Session)
    assert inputs[0] == inputs[1] == inputs[2]


def test_retry_stops_after_two_retries_and_cannot_reclaim_terminal_job(jobs, monkeypatch):
    url, Session = jobs

    def fail(*args):
        raise ServiceError(503, "Unavailable", {}, "private cloud details")

    monkeypatch.setattr(worker, "run_job", fail)
    for _ in range(3):
        make_due(Session)
        worker.execute_job("retry-run", url)
    worker.execute_job("retry-run", url)
    with Session() as session:
        job = session.get(Job, "retry-run")
        assert job.status == "FAILED" and job.attempts == 3
        assert "automatic retries exhausted" in job.error
        assert "private" not in job.error
        assert job.completed_at and job.lease_until == 0
        assert job.result["retry"]["automatic"] is False


@pytest.mark.parametrize(
    "error",
    [
        ValueError("invalid model"),
        AssertionError("conservation"),
        KeyError("programming"),
        TimeoutError("configured job deadline"),
        ServiceError(401, "NotAuthenticated", {}, "invalid auth"),
    ],
)
def test_deterministic_failures_are_not_automatically_retried(jobs, monkeypatch, error):
    url, Session = jobs

    def fail(*args):
        raise error

    monkeypatch.setattr(worker, "run_job", fail)
    worker.execute_job("retry-run", url)
    with Session() as session:
        job = session.get(Job, "retry-run")
        assert job.status == "FAILED" and job.attempts == 1
        assert job.result["retry"]["automatic"] is False


@pytest.mark.parametrize("finish_successfully", [False, True])
def test_cancellation_wins_over_retry_or_late_success(jobs, monkeypatch, finish_successfully):
    url, Session = jobs

    def cancel(identity, factory, token, uploads):
        with factory.begin() as session:
            job = session.get(Job, identity)
            job.cancelled = True
            job.status = "SUCCEEDED" if finish_successfully else "CANCEL_REQUESTED"
        if not finish_successfully:
            raise network.ConnectTimeout("temporary outage")

    monkeypatch.setattr(worker, "run_job", cancel)
    worker.execute_job("retry-run", url)
    with Session() as session:
        job = session.get(Job, "retry-run")
        assert job.status == "CANCELLED" and job.error is None
        assert job.attempts == 1 and job.lease_until == 0


def test_dispatcher_waits_for_durable_backoff(jobs, monkeypatch):
    _, Session = jobs
    monkeypatch.delenv("REDIS_URL", raising=False)
    with Session.begin() as session:
        session.get(Job, "retry-run").lease_until = time.time() + 60
    calls = []
    monkeypatch.setattr(worker.subprocess, "Popen", lambda *args, **kwargs: calls.append(args))

    class OneIteration:
        stopped = False

        def is_set(self):
            return self.stopped

        def wait(self, seconds):
            self.stopped = True

    worker.dispatch_loop(Session, OneIteration(), "sqlite:///unused")
    assert not calls


def test_dependency_exception_classification_is_narrow():
    class DatabaseError(Exception):
        sqlstate = "40001"

    assert worker.transient_failure(OperationalError("query", {}, DatabaseError()))
    DatabaseError.sqlstate = "28P01"  # invalid database password
    assert worker.transient_failure(OperationalError("query", {}, DatabaseError())) is None
    locked = sqlite3.OperationalError("database is locked")
    locked.sqlite_errorcode = sqlite3.SQLITE_BUSY
    assert worker.transient_failure(OperationalError("query", {}, locked)) == "database_busy"
    assert worker.transient_failure(OperationalError("query", {}, Exception("connection refused")))
    assert worker.transient_failure(OperationalError("query", {}, Exception("no such table"))) is None
    assert worker.transient_failure(RequestException(network.ReadTimeout("temporary")))
    assert worker.transient_failure(RequestException(network.SSLError("bad certificate"))) is None
    assert worker.transient_failure(ServiceError(501, "NotImplemented", {}, "unsupported")) is None
    assert worker.transient_failure(ServiceError(429, "Throttled", {}, "retry later"))


def test_real_run_resumes_after_storage_outage_without_recomputing_saved_replication(client, monkeypatch):  # noqa: F811
    import surge_engine

    context = setup_context(client)
    scenario = create_short_scenario(client, context, replications=2)
    response = client.post("/api/run-groups", json={"scenario_id": scenario["id"]})
    assert response.status_code == 202, response.text
    identity = response.json()["id"]
    original_run = surge_engine.run_replication
    original_put = worker.ArtifactStore.put_json
    computations = []
    interrupted = False

    def compute(*args, **kwargs):
        computations.append((kwargs["replication_index"], kwargs["keep_trace"]))
        return original_run(*args, **kwargs)

    def put(store, workspace, owner, name, value):
        nonlocal interrupted
        if name == "replication-1" and not interrupted:
            interrupted = True
            raise ServiceError(503, "Unavailable", {}, "injected storage outage")
        return original_put(store, workspace, owner, name, value)

    monkeypatch.setattr(surge_engine, "run_replication", compute)
    monkeypatch.setattr(worker.ArtifactStore, "put_json", put)
    worker.execute_job(identity, client.database_url)
    with client.app.state.Session.begin() as session:
        job = session.get(Job, identity)
        assert job.status == "QUEUED" and job.completed == 1
        frozen = copy.deepcopy(job.payload)
        saved = copy.deepcopy(session.get(Document, f"{identity}_rep_0000").data)
        job.lease_until = 0
    worker.execute_job(identity, client.database_url)
    with client.app.state.Session() as session:
        job = session.get(Job, identity)
        assert job.status == "SUCCEEDED" and job.completed == 2 and job.attempts == 2
        assert job.payload == frozen
        final_rep = session.get(Document, f"{identity}_rep_0000").data
        assert {key: final_rep[key] for key in saved} == saved
    assert computations.count((0, False)) == 1
    assert computations.count((1, False)) == 2
