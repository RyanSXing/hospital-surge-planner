"""Fixture generation, independent validation, simulation and measured benchmarks."""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/engine"))
from surge_engine import generate_dataset, validate_dataset, run_replication, aggregate_results
from surge_engine.common import dt, iso
from datetime import timedelta
from zoneinfo import ZoneInfo


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def run_one(args):
    dataset, scenario, index = args
    return run_replication(dataset, scenario, replication_index=index, keep_trace=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["generate", "validate", "simulate", "benchmark"])
    parser.add_argument("--fixture", default="planning_baseline")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--replications", type=int, default=10)
    parser.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--surge-percent", type=float, default=0, help="ED arrival increase during the full horizon")
    args = parser.parse_args()
    if not 1 <= args.days <= 365 or not 1 <= args.replications <= 500:
        parser.error("days must be 1–365 and replications 1–500")
    if args.command in ("generate", "validate"):
        failures = 0
        for fixture in ("planning_baseline", "stress_snapshot"):
            path = ROOT / "data/demo" / f"{fixture}.json"
            dataset = generate_dataset(fixture=fixture, days=365) if args.command == "generate" or not path.exists() else json.loads(path.read_text())
            report = validate_dataset(dataset)
            if args.command == "generate":
                save(path, dataset)
            save(ROOT / "evidence" / f"validation-{fixture}.json", report)
            failures += not report.get("valid", False)
            print(f"{fixture}: valid={report.get('valid')}, patients={len(dataset.get('patients', []))}, errors={len(report.get('errors', []))}")
        return int(failures > 0)
    dataset = generate_dataset(fixture=args.fixture, days=max(30, args.days))
    scenario = {"name": "Baseline CLI scenario", "dataset_version_id": dataset.get("dataset_version_id", dataset.get("id")), "start_at": dataset["snapshot_at"], "timezone": dataset["timezone"], "horizon_calendar_days": args.days, "base_seed": 20261016, "replications": args.replications, "conditions": [], "interventions": [], "updates": []}
    if args.surge_percent:
        scenario["conditions"] = [{"id": "benchmark-surge", "kind": "arrival_multiplier", "entry_stream_id": "ED_MAIN", "shape": "step", "surge_percent": args.surge_percent, "start_at": scenario["start_at"], "end_at": iso(dt(scenario["start_at"]).astimezone(ZoneInfo(dataset["timezone"])) + timedelta(days=args.days)), "multiplier": 1 + args.surge_percent / 100}]
    started = time.perf_counter()
    jobs = [(dataset, scenario, index) for index in range(args.replications)]
    if args.workers == 1:
        results = [run_one(job) for job in jobs]
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as executor:
            results = list(executor.map(run_one, jobs))
    aggregate = aggregate_results(results, scenario=scenario)
    selected_index = aggregate.get("selected_replication_index", 0)
    selected_trace = run_replication(dataset, scenario, replication_index=selected_index, keep_trace=True)
    elapsed = time.perf_counter() - started
    content = {"recorded_at": datetime.now(timezone.utc).isoformat(), "host": {"platform": platform.platform(), "python": platform.python_version(), "logical_cpus": os.cpu_count(), "workers": args.workers}, "measurement_scope": "engine process pool, aggregation and selected trace; excludes API, database and artifact serialization", "surge_percent": args.surge_percent, "selected_trace_events": len(selected_trace.get("events", [])), "fixture": args.fixture, "horizon_days": args.days, "replications": args.replications, "elapsed_seconds": elapsed, "input_sha256": hashlib.sha256(json.dumps({"dataset": dataset, "scenario": scenario}, sort_keys=True, separators=(",", ":")).encode()).hexdigest(), "scalar_metrics": aggregate.get("scalar_metrics"), "measured": True}
    output = ROOT / "evidence" / f"{args.command}-{args.days}d-{args.replications}r-surge{args.surge_percent:g}.json"
    save(output, content)
    if args.command == "simulate":
        save(ROOT / "data" / "simulation-result.json", aggregate)
    print(f"Completed {args.replications} replications × {args.days} days in {elapsed:.3f}s; {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
