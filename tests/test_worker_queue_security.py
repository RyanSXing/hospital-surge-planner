# ruff: noqa: F401,F811
import threading

import redis
import rq
from surge_api.db import Job
from surge_api.worker import dispatch_loop
from test_api import client


def test_rq_payload_does_not_contain_database_credentials(client, monkeypatch):
    stop = threading.Event()
    calls = []
    monkeypatch.setenv("REDIS_URL", "redis://queue-test")
    monkeypatch.setattr(redis.Redis, "from_url", lambda url: object())

    class Queue:
        def __init__(self, *args, **kwargs):
            pass

        def fetch_job(self, identity):
            return None

        def enqueue(self, *args, **kwargs):
            calls.append((args, kwargs))
            stop.set()

    monkeypatch.setattr(rq, "Queue", Queue)
    with client.app.state.Session.begin() as session:
        session.add(Job(id="queued-test", workspace_id="workspace-main", kind="run", payload={}))
    dispatch_loop(client.app.state.Session, stop, "postgresql://test-user:test-secret@private/test-db")
    assert calls[0][0] == ("surge_api.worker.execute_job", "queued-test")
    assert calls[0][1]["description"] == "Hospital Surge Planner run queued-test"
    assert "test-secret" not in str(calls)
