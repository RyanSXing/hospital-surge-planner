import json
import logging

import pytest
import surge_engine
from surge_api import worker
from surge_api.db import Job, make_database


def test_replication_timing_is_attached_on_success_and_failure(monkeypatch):
    monkeypatch.setattr(surge_engine, "run_replication", lambda *a, **kw: {"scalar_metrics": {}})
    result = worker.timed_replication({}, {}, 0)
    metrics = result["execution_metrics"]
    assert metrics["wall_seconds"] >= 0 and metrics["cpu_seconds"] >= 0
    assert metrics["process_peak_rss_bytes"] > 0
    assert "process-lifetime" in metrics["memory_scope"]

    def fail(*args, **kwargs):
        raise worker.Cancelled()

    monkeypatch.setattr(surge_engine, "run_replication", fail)
    with pytest.raises(worker.Cancelled) as error:
        worker.timed_replication({}, {}, 1)
    assert error.value.execution_metrics["wall_seconds"] >= 0


def test_job_success_failure_and_precancel_persist_safe_metrics(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    url = "sqlite:///" + str(tmp_path / "metrics.db")
    engine, Session = make_database(url)
    with Session.begin() as session:
        for identity, kind, cancelled in [
            ("success", "run", False),
            ("failed", "invalid", False),
            ("cancelled", "run", True),
        ]:
            session.add(
                Job(
                    id=identity,
                    workspace_id="W",
                    kind=kind,
                    status="QUEUED",
                    payload={"sensitive": "patient-secret"},
                    result={},
                    cancelled=cancelled,
                )
            )

    def succeed(identity, factory, token, uploads):
        with factory.begin() as session:
            job = session.get(Job, identity)
            job.status = "SUCCEEDED"
            job.result = {"preserved": "result"}

    monkeypatch.setattr(worker, "run_job", succeed)
    records = []
    monkeypatch.setattr(
        logging.getLogger("surge_api.requests"), "info", lambda record: records.append(json.loads(record))
    )
    for identity in ["success", "failed", "cancelled"]:
        worker.execute_job(identity, url)
    with Session() as session:
        for identity, status in [("success", "SUCCEEDED"), ("failed", "FAILED"), ("cancelled", "CANCELLED")]:
            job = session.get(Job, identity)
            assert job.status == status
            assert job.result["execution_metrics"]["wall_seconds"] >= 0
            assert job.result["execution_metrics"]["cpu_seconds"] >= 0
        assert session.get(Job, "success").result["preserved"] == "result"
    assert len(records) == 3
    assert "patient-secret" not in json.dumps(records)
    assert "error" not in records[1] and "payload" not in records[1]
    engine.dispose()
