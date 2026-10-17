"""Measure authenticated hosted execution, bounded reads, replay and verified ZIP export."""

import argparse
import hashlib
import io
import json
import time
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=ROOT / "data/deployment/production.env")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--replications", type=int, default=2)
    parser.add_argument("--surge-percent", type=float, default=70)
    parser.add_argument("--run-id", help="Resume polling an existing run without starting another")
    parser.add_argument("--skip-export", action="store_true")
    parser.add_argument("--expected-commit")
    parser.add_argument("--name", help="Readable name for the saved benchmark scenario")
    parser.add_argument("--dataset-id", help="Freeze a specific dataset across repeated measurements")
    parser.add_argument("--output", type=Path, default=ROOT / "evidence/cloud-acceptance.json")
    args = parser.parse_args()
    settings = dotenv_values(args.env_file)
    base = settings["PUBLIC_BASE_URL"].rstrip("/")
    if not base.startswith("https://"):
        parser.error("Hosted verification requires the actual HTTPS endpoint")
    client = httpx.Client(base_url=base, timeout=120, headers={"Origin": base})

    def call(method, path, **kwargs):
        response = client.request(method, "/api" + path, **kwargs)
        response.raise_for_status()
        return response.json()

    def wait(path, job, timeout=7200):
        deadline = time.monotonic() + timeout
        reported = -1
        while job["status"] not in ("SUCCEEDED", "FAILED", "CANCELLED"):
            if time.monotonic() > deadline:
                raise TimeoutError(f"Job {job['id']} exceeded verification timeout")
            if job.get("completed", 0) != reported:
                reported = job.get("completed", 0)
                print(
                    json.dumps({"job": job["id"], "status": job["status"], "completed": reported}), flush=True
                )
            time.sleep(1)
            job = call("GET", path + "/" + job["id"])
        if job["status"] != "SUCCEEDED":
            raise RuntimeError(f"Job {job['id']} ended {job['status']}: {job.get('error')}")
        return job

    health = call("GET", "/health/ready")
    call("POST", "/auth/login", json={"username": "admin", "password": settings["ADMIN_PASSWORD"]})
    summary = call("GET", "/workspaces/workspace-main/summary")
    dataset = summary["dataset"]
    if args.dataset_id:
        dataset = next((item for item in summary["datasets"] if item["id"] == args.dataset_id), None)
        if dataset is None:
            dataset = call("GET", "/datasets/" + args.dataset_id)
    if args.run_id:
        run = call("GET", "/run-groups/" + args.run_id)
        scenario = run["scenario_context"]
    else:
        start = datetime.fromisoformat(dataset["snapshot_at"])
        end = start.astimezone(ZoneInfo(dataset["timezone"])) + timedelta(days=args.days)
        scenario = call(
            "POST",
            "/scenarios",
            json={
                "name": args.name or f"OCI acceptance {args.days} days × {args.replications} replications",
                "dataset_version_id": dataset["id"],
                "start_at": dataset["snapshot_at"],
                "timezone": dataset["timezone"],
                "horizon_calendar_days": args.days,
                "replications": args.replications,
                "base_seed": 20261016,
                "conditions": [
                    {
                        "kind": "arrival_multiplier",
                        "entry_stream_id": "ED_MAIN",
                        "shape": "step",
                        "surge_percent": args.surge_percent,
                        "multiplier": 1 + args.surge_percent / 100,
                        "start_at": dataset["snapshot_at"],
                        "end_at": end.astimezone(UTC).isoformat(),
                    }
                ],
                "interventions": [],
            },
        )
        run = call("POST", "/run-groups", json={"scenario_id": scenario["id"]})
    started = time.perf_counter()
    report = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "base_url": base,
        "scope": "Actual public HTTPS, OCI A2 ARM8 physical cores/16GiB, PostgreSQL, Redis worker and private ObjectStorage",
        "scenario_id": run["scenario_id"],
        "run_group_id": run["id"],
        "dataset_version_id": run["dataset_version_id"],
        "input_sha256": run["input_sha256"],
        "scenario_revision_id": run["scenario_revision_id"],
        "start_at": run["start_at"],
        "end_at": run["end_at"],
        "horizon_days": scenario["horizon_calendar_days"],
        "replications": run.get("total", args.replications),
        "health": health,
        "status": "RUNNING",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    run = wait("/run-groups", run)
    report.update(
        status=run["status"],
        completed=run["completed"],
        pipeline_seconds=time.perf_counter() - started,
        pipeline_timing_is_resumed=args.run_id is not None,
        manifest=run.get("manifest"),
    )
    assert all(a["backend"] == "oci" for a in run["manifest"]["artifacts"])
    if args.expected_commit:
        assert run["manifest"]["code_commit"] == args.expected_commit, run["manifest"]
    selected = run["selected_replication_id"]
    report["reads"] = {}
    for label, path, params in [
        ("metrics", f"/run-groups/{run['id']}/metrics", {"grain": "day"}),
        ("end_state", f"/runs/{selected}/state", {"at": run["end_at"]}),
        ("census", f"/runs/{selected}/patients", {"at": run["end_at"], "limit": 50}),
        ("events", f"/runs/{selected}/events", {"limit": 20}),
        ("checkpoints", f"/runs/{selected}/checkpoints", {}),
    ]:
        samples = []
        for _ in range(6):
            began = time.perf_counter()
            value = call("GET", path, params=params)
            samples.append(time.perf_counter() - began)
        measurement = {
            "cold_seconds": samples[0],
            "warm_seconds": samples[1:],
            "warm_p95_seconds": max(samples[1:]),
        }
        if label == "end_state":
            measurement.update(patient_total=value["patient_total"], returned_patients=len(value["patients"]))
            assert len(value["patients"]) <= 500
        report["reads"][label] = measurement
    observations = call("GET", "/workspaces/workspace-main/execution-metrics")
    observed = next((job for job in observations["recent_jobs"] if job["id"] == run["id"]), None)
    assert observed and observed["execution_metrics"], "Worker completion metrics were not persisted"
    report["worker_execution_metrics"] = observed["execution_metrics"]
    report["worker_started_to_durable_completion_seconds"] = observed["execution_metrics"]["wall_seconds"]
    if not args.skip_export:
        export = wait("/exports", call("POST", "/exports", json={"run_group_id": run["id"], "format": "zip"}))
        response = client.get(export["download_url"])
        response.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
            checksums = json.loads(bundle.read("checksums.json"))
            for name, expected in checksums.items():
                assert hashlib.sha256(bundle.read(name)).hexdigest() == expected, name
            manifest = json.loads(bundle.read("model-manifest.json"))
            if args.expected_commit:
                assert manifest["code_commit"] == args.expected_commit
            report["export"] = {
                "id": export["id"],
                "bytes": len(response.content),
                "all_checksums_verified": True,
                "files": bundle.namelist(),
                "sha256": hashlib.sha256(response.content).hexdigest(),
            }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
