"""Verify lease recovery after killing only this test's hosted RQ job process.

This creates a synthetic test run, waits for durable progress, verifies the RQ
job identity before SIGKILL, and checks that its pure simulation children exit.
The RQ supervisor, API, database and all saved runs remain intact.
"""
import argparse
import json
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args()
    settings = dotenv_values(ROOT / "data/deployment/production.env")
    base = settings["PUBLIC_BASE_URL"].rstrip("/")
    client = httpx.Client(base_url=base + "/api", timeout=90, headers={"Origin": base})

    def request(method, path, **kwargs):
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    def wait(identity, predicate, timeout=600):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = request("GET", f"/run-groups/{identity}")
            if predicate(run):
                return run
            if run["status"] in {"FAILED", "CANCELLED", "SUCCEEDED"}:
                raise AssertionError(f"Unexpected terminal status {run['status']}")
            time.sleep(1)
        raise TimeoutError("Controlled recovery exceeded its verification timeout")

    request("POST", "/auth/login", json={"username": "admin", "password": settings["ADMIN_PASSWORD"]})
    summary = request("GET", "/workspaces/workspace-main/summary")
    if any(run["status"] not in {"SUCCEEDED", "FAILED", "CANCELLED"} for run in summary["runs"]):
        raise RuntimeError("Refusing fault injection while an existing workload is active")
    scenario = request("POST", "/scenarios", json={
        "name": "Controlled worker recovery verification", "dataset_version_id": args.dataset_id,
        "horizon_calendar_days": 30, "replications": 30, "base_seed": 20261017,
    })
    run = request("POST", "/run-groups", json={"scenario_id": scenario["id"]})
    identity = run["id"]
    print(json.dumps({"run_group_id": identity, "phase": "waiting_for_durable_progress"}), flush=True)
    prior = wait(identity, lambda value: value["status"] == "RUNNING" and 0 < value["completed"] < 30)
    saved = request("GET", f"/run-groups/{identity}/replications?limit=200")["items"]
    fingerprints = {item["id"]: {"seed": item["seed"], "sha256": item["aggregate_artifact"]["sha256"]} for item in saved}
    assert fingerprints
    # The exact current RQ job identifies its supervisor. Only its direct job
    # child is killed; process-tree assertions prevent guessing another PID.
    remote = '''import json,os,signal,time
from pathlib import Path
from redis import Redis
from rq import Worker
identity=IDENTITY
connection=Redis.from_url(os.environ["REDIS_URL"])
workers=[w for w in Worker.all(connection=connection) if (w.get_current_job_id() or "").startswith(identity+"-attempt-")]
assert len(workers)==1
supervisor=workers[0].pid
assert supervisor and supervisor>1
def tree():
 result={}
 for item in Path("/proc").iterdir():
  if not item.name.isdigit():continue
  try:
   fields=(item/"stat").read_text().rsplit(")",1)[1].split()
   result[int(item.name)]={"state":fields[0],"ppid":int(fields[1]),"command":(item/"cmdline").read_bytes()}
  except (FileNotFoundError,PermissionError,ProcessLookupError):pass
 return result
before=tree();horses=[pid for pid,value in before.items() if value["ppid"]==supervisor]
assert len(horses)==1
horse=horses[0]
children=[pid for pid,value in before.items() if value["ppid"]==horse and b"spawn_main" in value["command"]]
assert horse>1 and children
os.kill(horse,signal.SIGKILL)
started=time.monotonic()
while time.monotonic()-started<10:
 current=tree();alive=[pid for pid in children if pid in current and current[pid]["state"]!="Z"]
 if not alive:break
 time.sleep(0.1)
assert not alive,"Simulation pool children survived their parent"
assert supervisor in tree()
print(json.dumps({"signal":"SIGKILL","target":"RQ job process only","supervisor_preserved":True,"pool_children_before":len(children),"pool_children_after":len(alive),"orphan_exit_seconds":time.monotonic()-started}))
'''.replace("identity=IDENTITY", "identity=" + repr(identity))
    started = time.monotonic()
    killed = subprocess.run([
        str(ROOT / ".venv/bin/python"), str(ROOT / "scripts/oci_ssh.py"), "bash", "-lc",
        "cd /opt/hospital-surge-planner && docker compose --env-file .env -f infra/compose.yaml exec -T worker python -",
    ], input=remote.encode(), capture_output=True, check=False)
    if killed.returncode:
        raise RuntimeError("Controlled process check failed; no unvalidated PID is targeted. Inspect private host diagnostics.")
    process_evidence = json.loads(killed.stdout)
    unavailable = client.get(f"/run-groups/{identity}/metrics")
    assert unavailable.status_code == 409
    print(json.dumps({"run_group_id": identity, "phase": "waiting_for_natural_lease_recovery", **process_evidence}), flush=True)
    complete = wait(identity, lambda value: value["status"] == "SUCCEEDED")
    after = request("GET", f"/run-groups/{identity}/replications?limit=200")["items"]
    assert len(after) == complete["completed"] == 30
    assert complete["input_sha256"] == prior["input_sha256"]
    assert complete["manifest"]["code_commit"] == args.expected_commit
    by_id = {item["id"]: item for item in after}
    assert len(by_id) == 30
    for key, frozen in fingerprints.items():
        assert by_id[key]["seed"] == frozen["seed"]
        assert by_id[key]["aggregate_artifact"]["sha256"] == frozen["sha256"]
    report = {
        "recorded_at": datetime.now(UTC).isoformat(), "base_url": base,
        "run_group_id": identity, "scenario_id": scenario["id"], "code_commit": args.expected_commit,
        "status": "passed", "process": process_evidence,
        "completed_before_kill": prior["completed"], "preserved_replications_checked": len(fingerprints),
        "completed_after_recovery": complete["completed"], "unique_replication_records": len(by_id),
        "recovery_seconds": time.monotonic() - started, "lease_expiry_accelerated": False,
        "incomplete_metrics_status": unavailable.status_code, "input_sha256": complete["input_sha256"],
        "saved_replication_seeds_and_checksums_preserved": True,
    }
    (ROOT / "evidence/hosted-worker-recovery.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
