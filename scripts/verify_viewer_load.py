"""Exercise ten real read-only sessions against the public HTTPS deployment."""

import json
import secrets
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def main():
    settings = dotenv_values(ROOT / "data/deployment/production.env")
    proof = json.loads((ROOT / "evidence/cloud-benchmark-30d-100r.json").read_text())
    base = settings["PUBLIC_BASE_URL"].rstrip("/")
    saved = json.loads((ROOT / "data/deployment/browser-auth.json").read_text())
    admin = httpx.Client(
        base_url=base,
        timeout=60,
        headers={"Origin": base},
        cookies={item["name"]: item["value"] for item in saved["cookies"]},
    )
    response = admin.get("/api/me")
    response.raise_for_status()
    assert response.json()["role"] == "admin"
    result = admin.get("/api/run-groups/" + proof["run_group_id"])
    result.raise_for_status()
    run = result.json()
    paths = {
        "metrics_week": f"/api/run-groups/{run['id']}/metrics?grain=week",
        "initial_state": f"/api/runs/{run['selected_replication_id']}/state?at={run['start_at']}",
        "census_50": f"/api/runs/{run['selected_replication_id']}/patients?at={run['start_at']}&limit=50",
        "events_20": f"/api/runs/{run['selected_replication_id']}/events?limit=20",
        "datasets": "/api/datasets?limit=50",
    }
    members = []
    clients = []
    report = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "base_url": base,
        "scope": "Ten distinct viewer accounts and HTTPS sessions; warmed, bounded reads from Chicago OCI to this workstation",
        "run_group_id": run["id"],
        "viewers": 10,
        "status": "RUNNING",
    }
    try:
        for index in range(10):
            password = secrets.token_urlsafe(32)
            username = f"verification-viewer-{secrets.token_hex(4)}-{index}"
            response = admin.post(
                "/api/workspaces/workspace-main/members",
                json={
                    "username": username,
                    "name": f"Temporary load verification {index + 1}",
                    "password": password,
                    "role": "viewer",
                },
            )
            response.raise_for_status()
            members.append(response.json())
            client = httpx.Client(base_url=base, timeout=60, headers={"Origin": base})
            clients.append(client)
            response = client.post("/api/auth/login", json={"username": username, "password": password})
            response.raise_for_status()
            assert response.json()["role"] == "viewer"
            assert client.post("/api/scenarios", json={}).status_code == 403
            for path in paths.values():
                client.get(path).raise_for_status()

        def read(client):
            samples = []
            for _ in range(5):
                for name, path in paths.items():
                    started = time.perf_counter()
                    response = client.get(path)
                    elapsed = time.perf_counter() - started
                    response.raise_for_status()
                    samples.append({"endpoint": name, "seconds": elapsed, "bytes": len(response.content)})
            return samples

        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=10) as pool:
            samples = [item for group in pool.map(read, clients) for item in group]
        report.update(
            status="PASSED",
            requests=len(samples),
            elapsed_seconds=time.perf_counter() - started,
            viewer_mutations_rejected=True,
            endpoints={},
        )
        for name in paths:
            values = [sample["seconds"] for sample in samples if sample["endpoint"] == name]
            p95 = statistics.quantiles(values, n=100, method="inclusive")[94]
            report["endpoints"][name] = {
                "samples": len(values),
                "p50_seconds": statistics.median(values),
                "p95_seconds": p95,
                "max_seconds": max(values),
                "within_500ms_target": p95 < 0.5,
            }
        report["all_p95_within_500ms"] = all(
            value["within_500ms_target"] for value in report["endpoints"].values()
        )
    finally:
        for client in clients:
            client.close()
        disabled = []
        for member in members:
            member_id = member["id"]
            response = admin.patch(
                "/api/workspaces/workspace-main/members/" + member_id,
                json={"enabled": False},
                headers={"If-Match": str(member["revision"])},
            )
            response.raise_for_status()
            disabled.append(member_id)
        report["temporary_accounts_disabled"] = len(disabled)
        admin.close()
        (ROOT / "evidence/cloud-ten-viewers.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "status",
                    "viewers",
                    "requests",
                    "all_p95_within_500ms",
                    "temporary_accounts_disabled",
                )
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
