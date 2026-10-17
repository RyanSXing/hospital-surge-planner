"""Measure the real local API's yearlong pipeline and bounded read responses."""

import argparse
import json
import math
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "http://127.0.0.1:8000/api"


def request(path, value=None):
    data = None if value is None else json.dumps(value).encode()
    started = time.perf_counter()
    with urllib.request.urlopen(
        urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"}),
        timeout=120,
    ) as response:
        raw = response.read()
    return json.loads(raw), time.perf_counter() - started, len(raw)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--run-id", help="Reuse a completed 365-day run to remeasure read performance")
args = parser.parse_args()

summary, _, _ = request("/workspaces/workspace-main/summary")
dataset = summary["dataset"]
if args.run_id:
    run, _, _ = request("/run-groups/" + args.run_id)
    scenario = {"id": run["scenario_id"]}
    elapsed = None
    if run["status"] != "SUCCEEDED":
        raise RuntimeError("A completed run is required")
else:
    scenario, _, _ = request(
        "/scenarios",
        {
            "name": "Yearlong API verification",
            "dataset_version_id": dataset["id"],
            "start_at": dataset["snapshot_at"],
            "timezone": dataset["timezone"],
            "horizon_calendar_days": 365,
            "base_seed": 20261016,
            "replications": 1,
            "conditions": [
                {
                    "kind": "arrival_multiplier",
                    "entry_stream_id": "ED_MAIN",
                    "shape": "step",
                    "surge_percent": 70,
                }
            ],
            "interventions": [],
        },
    )
    started = time.perf_counter()
    run, _, _ = request("/run-groups", {"scenario_id": scenario["id"], "replications": 1})
    while run["status"] not in {"SUCCEEDED", "FAILED", "CANCELLED"}:
        time.sleep(1)
        run, _, _ = request("/run-groups/" + run["id"])
    if run["status"] != "SUCCEEDED":
        raise RuntimeError(run.get("error") or run["status"])
    elapsed = time.perf_counter() - started
replication = run["selected_replication_id"]
measurements = {}
for name, path in {
    "metrics_day": f"/run-groups/{run['id']}/metrics?grain=day",
    "metrics_week": f"/run-groups/{run['id']}/metrics?grain=week",
    "metrics_month": f"/run-groups/{run['id']}/metrics?grain=month",
    "end_state": f"/runs/{replication}/state?at={run['end_at']}",
    "end_census": f"/runs/{replication}/patients?at={run['end_at']}&limit=50",
}.items():
    value, cold, size = request(path)
    samples = [request(path)[1] for _ in range(5)]
    measurements[name] = {
        "cold_seconds": cold,
        "warm_seconds": samples,
        "p95_seconds": sorted(samples)[math.ceil(0.95 * len(samples)) - 1],
        "response_bytes": size,
    }
    if name == "end_state":
        measurements[name].update(
            patient_total=value["patient_total"],
            returned_patients=len(value["patients"]),
            exact_queue=value["queue_counts"],
        )
    if name.startswith("metrics"):
        measurements[name].update(series_points=len(value["series"]), interval_points=len(value["data"]))
report = {
    "recorded_at": datetime.now(timezone.utc).isoformat(),
    "measured": True,
    "scope": "Local HTTP, SQLite, simulation, durable artifacts, bounded response serialization; 365 days, one replication, 70% surge. Five warm samples per read; not an OCI or 100-replication benchmark.",
    "scenario_id": scenario["id"],
    "run_group_id": run["id"],
    "pipeline_seconds": elapsed,
    "measurements": measurements,
}
path = Path(__file__).resolve().parents[1] / "evidence" / "api-year-read-performance.json"
path.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2), flush=True)
