"""Verify lease recovery after killing only this test's hosted RQ job process.

This creates a synthetic test run, waits for the requested execution phase,
verifies its database phase and RQ identity before SIGKILL, and checks that its
pure simulation children exit. RUNNING is the default; AGGREGATING exercises
selected-trace overlap after all ordinary replications have been saved.
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


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--phase", type=str.upper, choices=("RUNNING", "AGGREGATING"), default="RUNNING")
    return parser.parse_args(argv)


def phase_ready(run, phase, replications=30):
    """Require durable progress, including every ordinary result for aggregation."""
    if phase not in {"RUNNING", "AGGREGATING"}:
        raise ValueError("Unsupported fault-injection phase")
    completed = int(run.get("completed", 0))
    return run.get("status") == phase and (
        completed == replications if phase == "AGGREGATING" else 0 < completed < replications
    )


def main():
    args = parse_args()
    settings = dotenv_values(ROOT / "data/deployment/production.env")
    base = settings["PUBLIC_BASE_URL"].rstrip("/")
    client = httpx.Client(base_url=base + "/api", timeout=90, headers={"Origin": base})

    def request(method, path, **kwargs):
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()

    def wait(identity, predicate, timeout=600, poll_seconds=1):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = request("GET", f"/run-groups/{identity}")
            if predicate(run):
                return run
            if run["status"] in {"FAILED", "CANCELLED", "SUCCEEDED"}:
                raise AssertionError(f"Unexpected terminal status {run['status']}")
            time.sleep(poll_seconds)
        raise TimeoutError("Controlled recovery exceeded its verification timeout")

    request("POST", "/auth/login", json={"username": "admin", "password": settings["ADMIN_PASSWORD"]})
    summary = request("GET", "/workspaces/workspace-main/summary")
    if any(run["status"] not in {"SUCCEEDED", "FAILED", "CANCELLED"} for run in summary["runs"]):
        raise RuntimeError("Refusing fault injection while an existing workload is active")
    scenario = request(
        "POST",
        "/scenarios",
        json={
            "name": f"Controlled {args.phase.lower()} worker recovery verification",
            "dataset_version_id": args.dataset_id,
            "horizon_calendar_days": 30,
            "replications": 30,
            "base_seed": 20261017,
        },
    )
    run = request("POST", "/run-groups", json={"scenario_id": scenario["id"]})
    identity = run["id"]
    print(json.dumps({"run_group_id": identity, "phase": f"waiting_for_{args.phase.lower()}"}), flush=True)
    prior = wait(
        identity,
        lambda value: phase_ready(value, args.phase),
        poll_seconds=0.15 if args.phase == "AGGREGATING" else 1,
    )
    saved = request("GET", f"/run-groups/{identity}/replications?limit=200")["items"]
    fingerprints = {
        item["id"]: {"seed": item["seed"], "sha256": item["aggregate_artifact"]["sha256"]} for item in saved
    }
    assert fingerprints
    # The exact current RQ job identifies its supervisor. Only its direct job
    # child is killed; process-tree assertions prevent guessing another PID.
    remote = """import json,os,signal,time,tempfile
from pathlib import Path
from redis import Redis
from rq import Worker
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from surge_api.db import Job
from scripts.cloud_worker_recovery import phase_ready
identity=IDENTITY
phase=PHASE
expected_commit=EXPECTED_COMMIT
input_sha256=INPUT_SHA256
assert os.environ.get("CODE_COMMIT")==expected_commit,"Unexpected deployed release; refusing signal"
connection=Redis.from_url(os.environ["REDIS_URL"])
workers=[w for w in Worker.all(connection=connection) if (w.get_current_job_id() or "").startswith(identity+"-attempt-")]
assert len(workers)==1
supervisor=workers[0].pid
rq_job_id=workers[0].get_current_job_id()
assert supervisor and supervisor>1
def tree():
 result={}
 for item in Path("/proc").iterdir():
  if not item.name.isdigit():continue
  try:
   fields=(item/"stat").read_text().rsplit(")",1)[1].split()
   result[int(item.name)]={"state":fields[0],"ppid":int(fields[1]),"started":fields[19],"command":(item/"cmdline").read_bytes()}
  except (FileNotFoundError,PermissionError,ProcessLookupError):pass
 return result
before=tree();horses=[pid for pid,value in before.items() if value["ppid"]==supervisor]
assert len(horses)==1
horse=horses[0]
children=[pid for pid,value in before.items() if value["ppid"]==horse and b"spawn_main" in value["command"]]
assert horse>1 and children
input_directories=[item.name for item in Path(tempfile.gettempdir()).glob(f"hsp-pool-{horse}-a*") if item.is_dir()]
assert input_directories,"Expected private pool input directory is absent"
# Lock only this job while validating and signalling it. A final publication
# cannot race the phase check; no job fields or lease timestamps are changed.
engine=create_engine(os.environ["DATABASE_URL"])
with Session(engine) as session,session.begin():
 job=session.scalar(select(Job).where(Job.id==identity).with_for_update())
 assert job and phase_ready({"status":job.status,"completed":job.completed},phase),"Requested phase ended; refusing signal"
 assert job.payload.get("input_sha256")==input_sha256,"Frozen inputs changed; refusing signal"
 remaining_lease=job.lease_until-time.time()
 assert 0<remaining_lease<=120.5,"Unexpected lease window; refusing signal"
 current=tree()
 assert horse in current and current[horse]["ppid"]==supervisor and current[horse]["started"]==before[horse]["started"],"Job process changed; refusing signal"
 verified=[w for w in Worker.all(connection=connection) if w.pid==supervisor and w.get_current_job_id()==rq_job_id]
 assert len(verified)==1,"RQ job ownership changed; refusing signal"
 phase_evidence={"phase_at_signal":job.status,"completed_at_signal":job.completed,"attempt_at_signal":job.attempts,"lease_seconds_remaining_at_signal":remaining_lease,"database_phase_locked_during_signal":True}
 os.kill(horse,signal.SIGKILL)
engine.dispose()
started=time.monotonic()
while time.monotonic()-started<10:
 current=tree();alive=[pid for pid in children if pid in current and current[pid]["state"]!="Z"]
 if not alive:break
 time.sleep(0.1)
assert not alive,"Simulation pool children survived their parent"
assert supervisor in tree()
print(json.dumps({"signal":"SIGKILL","target":"RQ job process only","job_process_pid":horse,"supervisor_preserved":True,"pool_children_before":len(children),"pool_children_after":len(alive),"orphan_exit_seconds":time.monotonic()-started,"private_input_directories_before":input_directories,**phase_evidence}))
"""
    for name, value in {
        "IDENTITY": identity,
        "PHASE": args.phase,
        "EXPECTED_COMMIT": args.expected_commit,
        "INPUT_SHA256": prior["input_sha256"],
    }.items():
        remote = remote.replace("=" + name + "\n", "=" + repr(value) + "\n")
    started = time.monotonic()
    killed = subprocess.run(
        [
            str(ROOT / ".venv/bin/python"),
            str(ROOT / "scripts/oci_ssh.py"),
            "bash",
            "-lc",
            "cd /opt/hospital-surge-planner && docker compose --env-file .env -f infra/compose.yaml exec -T worker python -",
        ],
        input=remote.encode(),
        capture_output=True,
        check=False,
    )
    if killed.returncode:
        raise RuntimeError(
            "Controlled process check failed; no unvalidated PID is targeted. Inspect private host diagnostics."
        )
    process_evidence = json.loads(killed.stdout)
    unavailable = client.get(f"/run-groups/{identity}/metrics")
    assert unavailable.status_code == 409
    print(
        json.dumps(
            {"run_group_id": identity, "phase": "waiting_for_natural_lease_recovery", **process_evidence}
        ),
        flush=True,
    )
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
    check_inputs = """import json,tempfile
from pathlib import Path
names=NAMES
remaining=[name for name in names if (Path(tempfile.gettempdir())/name).exists()]
print(json.dumps({"abandoned_private_inputs_remaining":remaining}))
""".replace("names=NAMES", "names=" + repr(process_evidence["private_input_directories_before"]))
    checked = subprocess.run(
        [
            str(ROOT / ".venv/bin/python"),
            str(ROOT / "scripts/oci_ssh.py"),
            "bash",
            "-lc",
            "cd /opt/hospital-surge-planner && docker compose --env-file .env -f infra/compose.yaml exec -T worker python -",
        ],
        input=check_inputs.encode(),
        capture_output=True,
        check=True,
    )
    input_cleanup = json.loads(checked.stdout)
    assert input_cleanup["abandoned_private_inputs_remaining"] == []
    process_evidence.update(input_cleanup)
    report = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "base_url": base,
        "run_group_id": identity,
        "scenario_id": scenario["id"],
        "code_commit": args.expected_commit,
        "status": "passed",
        "requested_phase": args.phase,
        "process": process_evidence,
        "completed_before_kill": prior["completed"],
        "preserved_replications_checked": len(fingerprints),
        "completed_after_recovery": complete["completed"],
        "unique_replication_records": len(by_id),
        "recovery_seconds": time.monotonic() - started,
        "lease_expiry_accelerated": False,
        "incomplete_metrics_status": unavailable.status_code,
        "input_sha256": complete["input_sha256"],
        "saved_replication_seeds_and_checksums_preserved": True,
    }
    report_name = (
        "hosted-worker-recovery-aggregating.json"
        if args.phase == "AGGREGATING"
        else "hosted-worker-recovery.json"
    )
    (ROOT / "evidence" / report_name).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
