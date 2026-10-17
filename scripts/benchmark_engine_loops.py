"""Compare complete outputs and interleaved timings against a historical engine.

Run from a checkout with the baseline commit available:
  PYTHONPATH=packages/engine .venv/bin/python scripts/benchmark_engine_loops.py \
    --baseline-ref c4ff451f09f3974198aa19f9e2f8305f03167899 --output /tmp/engine-loops.json

Only the simulation module is historical; shared unchanged helpers and the same
installed dependencies are used on both sides. This never changes tracked code.
"""

import argparse
import cProfile
import hashlib
import importlib.util
import json
import platform
import pstats
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-ref", required=True)
    parser.add_argument("--trials", type=int, default=6)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile-dir", type=Path)
    args = parser.parse_args()
    if not 1 <= args.trials <= 20:
        parser.error("trials must be between 1 and 20")
    root = Path(__file__).resolve().parents[1]
    sys.path[:0] = [str(root / "packages/engine"), str(root / "tests")]
    from engine_hotloop_cases import CASES, make_case
    from surge_engine import generate_dataset, run_replication

    baseline_source = subprocess.run(
        ["git", "show", f"{args.baseline_ref}:packages/engine/surge_engine/simulation.py"],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    report = {
        "platform": platform.platform(),
        "python": sys.version,
        "baseline_ref": args.baseline_ref,
        "baseline_module_sha256": hashlib.sha256(baseline_source).hexdigest(),
        "candidate_module_sha256": hashlib.sha256(
            (root / "packages/engine/surge_engine/simulation.py").read_bytes()
        ).hexdigest(),
        "exact_output_cases": {},
        "timings": {},
    }
    with tempfile.TemporaryDirectory(prefix="hsp-engine-oracle-") as directory:
        path = Path(directory) / "baseline.py"
        path.write_bytes(baseline_source)
        spec = importlib.util.spec_from_file_location("surge_engine._historical_loops", path)
        baseline = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(baseline)
        for case in CASES:
            dataset, scenario, index = make_case(case)
            expected = baseline.run_replication(dataset, scenario, index)
            actual = run_replication(dataset, scenario, index)
            if actual != expected:
                raise AssertionError(f"Complete trace differs for {case}")
            raw = encoded(actual)
            report["exact_output_cases"][case] = {
                "equal": True,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw),
            }
            print(f"Exact complete output: {case}", flush=True)
        dataset = generate_dataset("planning_baseline", days=365)
        scenario = {
            "horizon_calendar_days": 30,
            "base_seed": 41021,
            "conditions": [{"kind": "arrival_multiplier", "surge_percent": 70}],
        }
        for keep_trace in (False, True):
            name = "trace" if keep_trace else "nontrace"
            values = {"baseline": [], "candidate": []}
            expected = None
            for trial in range(args.trials):
                methods = [("baseline", baseline.run_replication), ("candidate", run_replication)]
                if trial % 2:
                    methods.reverse()
                for label, method in methods:
                    started = time.perf_counter()
                    result = method(dataset, scenario, keep_trace=keep_trace)
                    values[label].append(time.perf_counter() - started)
                    raw = encoded(result)
                    checksum = hashlib.sha256(raw).hexdigest()
                    if expected is not None and checksum != expected:
                        raise AssertionError(f"Complete 30-day output differs for {name}/{label}")
                    expected = checksum
            medians = {label: statistics.median(samples) for label, samples in values.items()}
            report["timings"][name] = {
                "seconds": values,
                "median_seconds": medians,
                "sha256": expected,
                "reduction_percent": 100 * (1 - medians["candidate"] / medians["baseline"]),
            }
            print(name, json.dumps(report["timings"][name]), flush=True)
            if args.profile_dir:
                args.profile_dir.mkdir(parents=True, exist_ok=True)
                for label, method in (("baseline", baseline.run_replication), ("candidate", run_replication)):
                    profile = cProfile.Profile()
                    profile.runcall(method, dataset, scenario, keep_trace=keep_trace)
                    with (args.profile_dir / f"{label}-{name}.txt").open("w") as stream:
                        pstats.Stats(profile, stream=stream).sort_stats("cumulative").print_stats(60)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
