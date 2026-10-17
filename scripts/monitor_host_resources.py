"""Record bounded, read-only Docker/host resource samples on the deployment host."""

import argparse
import json
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=1200)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 7200 or not 5 <= args.interval <= 300:
        parser.error("Duration must be1–7200 seconds and interval5–300 seconds")
    report = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "label": args.label,
        "scope": "Periodic Docker CPU/memory gauges and host available memory; not a continuous peak measurement",
        "interval_seconds": args.interval,
        "samples": [],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline:
        result = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        containers = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        containers = [row for row in containers if row["Name"].startswith("hospital-surge-planner-")]
        memory = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, value = line.split(":", 1)
            if name in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
                memory[name + "_bytes"] = int(value.split()[0]) * 1024
        report["samples"].append(
            {"at": datetime.now(UTC).isoformat(), "containers": containers, "host_memory": memory}
        )
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(args.interval, remaining))
    print(json.dumps({"samples": len(report["samples"]), "output": str(args.output)}))


if __name__ == "__main__":
    main()
