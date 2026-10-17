"""Inject bounded local Compose outages and retain measured recovery evidence.

This script targets only the local stack on 127.0.0.1:8080. It creates its own
scenarios/jobs and always restarts Redis and the worker. It never drops data.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time

from dotenv import dotenv_values
import httpx

ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "COMPOSE_APP_ENV": "development"}
COMPOSE = ["docker", "compose", "--env-file", str(ROOT / ".env"), "-f", str(ROOT / "infra/compose.yaml")]
client = httpx.Client(base_url="http://127.0.0.1:8080/api", timeout=45)
report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "environment": "local Docker Desktop, PostgreSQL, Redis, RQ; no OCI assertion", "checks": []}


def compose(*args):
    result = subprocess.run(COMPOSE + list(args), env=ENV, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f"Compose {args[0]} failed: {result.stderr[-1500:]}")
    return result.stdout


def request(method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json()


def wait_for(path, predicate, timeout=240):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        value = request("GET", path)
        if predicate(value):
            return value
        if value.get("status") in {"FAILED", "CANCELLED"}:
            raise AssertionError(value)
        time.sleep(1)
    raise TimeoutError(f"{path}: {value}")


def wait_ready():
    start = time.monotonic()
    while time.monotonic() - start < 60:
        if client.get("/health/ready").status_code == 200:
            return
        time.sleep(1)
    raise TimeoutError("Local dependencies did not recover")


def enqueue(dataset_id, label, days=1, repetitions=1):
    scenario = request("POST", "/scenarios", json={"name": f"Recovery verification {label} {time.time()}", "dataset_version_id": dataset_id, "horizon_calendar_days": days, "replications": repetitions})
    return request("POST", "/run-groups", json={"scenario_id": scenario["id"]})


def finish(label, **data):
    report["checks"].append({"check": label, "passed": True, **data})
    (ROOT / "evidence/compose-recovery.json").write_text(json.dumps(report, indent=2) + "\n")
    print(label + ": passed", flush=True)


def main():
    request("POST", "/auth/login", json={"username": "admin", "password": dotenv_values(ROOT / ".env")["ADMIN_PASSWORD"]})
    datasets = request("GET", "/datasets?limit=200")["items"]
    dataset = sorted((d for d in datasets if d.get("fixture") == "planning_baseline" and not d.get("source_dataset_version_id")), key=lambda d: d["created_at"])[0]
    active = [r for r in request("GET", "/workspaces/workspace-main/summary")["runs"] if r["status"] not in {"SUCCEEDED", "FAILED", "CANCELLED"}]
    if active:
        raise RuntimeError("Refusing to interrupt an existing local Compose run")
    try:
        print("Stopping Redis; testing durable enqueue during queue outage", flush=True)
        compose("stop", "redis")
        assert client.get("/health/ready").status_code == 503
        run = enqueue(dataset["id"], "queue outage")
        assert run["status"] == "QUEUED"
        started = time.monotonic()
        compose("start", "redis")
        wait_ready()
        complete = wait_for("/run-groups/" + run["id"], lambda r: r["status"] == "SUCCEEDED")
        finish("Redis outage preserves outbox and recovers queued job", run_group_id=run["id"], completed=complete["completed"], recovery_seconds=time.monotonic() - started, readiness_during_outage=503)

        print("Killing a running worker after durable replication progress; waiting for natural 120-second lease expiry", flush=True)
        run = enqueue(dataset["id"], "worker SIGKILL", days=30, repetitions=30)
        prior = wait_for("/run-groups/" + run["id"], lambda r: r["status"] == "RUNNING" and r["completed"] > 0)
        started = time.monotonic()
        compose("kill", "-s", "SIGKILL", "worker")
        compose("start", "worker")
        incomplete = client.get("/run-groups/" + run["id"] + "/metrics")
        assert incomplete.status_code == 409
        complete = wait_for("/run-groups/" + run["id"], lambda r: r["status"] == "SUCCEEDED", timeout=240)
        assert complete["completed"] == 30
        assert complete["input_sha256"] == prior["input_sha256"]
        finish("Killed worker resumes immutable job after lease expiry", run_group_id=run["id"], completed_before_kill=prior["completed"], completed_after_recovery=complete["completed"], recovery_seconds=time.monotonic() - started, incomplete_metrics_status=409, input_sha256=complete["input_sha256"])

        print("Injecting an unwritable artifact path in an isolated one-shot worker", flush=True)
        compose("stop", "worker")
        run = enqueue(dataset["id"], "artifact failure")
        compose("run", "--rm", "--no-deps", "-e", "ARTIFACT_LOCAL_DIR=/proc/surge-storage-fault", "worker", "python", "-m", "surge_api.worker", "--once", run["id"])
        failed = request("GET", "/run-groups/" + run["id"])
        assert failed["status"] == "FAILED" and failed["error"]
        assert client.get("/run-groups/" + run["id"] + "/metrics").status_code == 409
        request("POST", "/run-groups/" + run["id"] + "/retry", json={})
        compose("start", "worker")
        complete = wait_for("/run-groups/" + run["id"], lambda r: r["status"] == "SUCCEEDED")
        assert complete["input_sha256"] == failed["input_sha256"]
        finish("Artifact write failure stays terminal until explicit retry", run_group_id=run["id"], failure_message=failed["error"], final_status=complete["status"], input_sha256=complete["input_sha256"])
    finally:
        compose("start", "redis", "worker")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
