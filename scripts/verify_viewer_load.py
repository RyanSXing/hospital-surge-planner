"""Exercise ten real read-only sessions against the public HTTPS deployment."""

import hashlib
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
MEMBERS_PATH = "/api/workspaces/workspace-main/members"


def verification_provenance(deployment, run):
    manifest = run["manifest"]
    return {
        "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "serving_commit": deployment["code_commit"],
        "serving_commit_source": "evidence/deployment.json (deployment evidence; not inferred from a retained run)",
        "referenced_run_commit": manifest["code_commit"],
        "referenced_run_model_version": manifest["model_version"],
        "referenced_run_generator_version": manifest["generator_version"],
        "referenced_dataset_version_id": manifest["dataset_version_id"],
        "provenance_scope": "Serving-release read/auth behavior over retained completed outputs; does not assert fresh forecast provenance",
    }


def member_catalog(admin):
    response = admin.get(MEMBERS_PATH)
    response.raise_for_status()
    return response.json()["items"]


def create_temporary_member(admin, attempts, username, password, index):
    """Record identity before sending; replay an ambiguous create with the same key."""
    candidate = {"username": username}
    attempts.append(candidate)
    payload = {
        "username": username,
        "name": f"Temporary load verification {index + 1}",
        "password": password,
        "role": "viewer",
    }
    headers = {"Idempotency-Key": f"viewer-proof-{secrets.token_hex(16)}"}
    for _ in range(2):
        try:
            response = admin.post(MEMBERS_PATH, json=payload, headers=headers)
            response.raise_for_status()
            candidate.update(response.json())
            return candidate
        except (httpx.TransportError, httpx.HTTPStatusError):
            pass
    # A server may have committed even when both responses were lost. The
    # unique name is retained for reconciliation in the final cleanup too.
    matches = [row for row in member_catalog(admin) if row.get("username") == username]
    if len(matches) == 1:
        candidate.update(matches[0])
        return candidate
    raise RuntimeError("Temporary viewer creation could not be confirmed")


def cleanup_temporary_members(admin, attempts):
    """Attempt every disable and confirm account state independently afterward."""
    errors = []

    def error(phase, exc, member=None):
        # Do not persist exception text, credentials, request bodies or cookies.
        item = {"phase": phase, "error_type": type(exc).__name__}
        if member:
            item["username"] = member["username"]
        errors.append(item)

    try:
        catalog = member_catalog(admin)
    except Exception as exc:  # noqa: BLE001 - cleanup must continue after any per-step failure
        error("reconcile_before_cleanup", exc)
        catalog = []
    for candidate in attempts:
        matches = [row for row in catalog if row.get("username") == candidate["username"]]
        targets = matches or ([candidate] if candidate.get("id") else [])
        for member in targets:
            if member.get("enabled") is False:
                continue
            try:
                response = admin.patch(
                    MEMBERS_PATH + "/" + member["id"],
                    json={"enabled": False},
                    headers={"If-Match": str(member["revision"])},
                )
                response.raise_for_status()
            except Exception as exc:  # noqa: BLE001 - one account must not prevent later disables
                error("disable", exc, candidate)
    disabled = []
    unresolved = []
    try:
        final_catalog = member_catalog(admin)
        for candidate in attempts:
            matches = [row for row in final_catalog if row.get("username") == candidate["username"]]
            if any(row.get("enabled") is not False for row in matches):
                unresolved.append(candidate["username"])
            else:
                disabled.extend(row["id"] for row in matches)
    except Exception as exc:  # noqa: BLE001 - failed verification must become durable failure evidence
        error("verify_cleanup", exc)
        unresolved = [candidate["username"] for candidate in attempts]
    return {
        "temporary_accounts_attempted": len(attempts),
        "temporary_accounts_disabled": len(set(disabled)),
        "cleanup_complete": not unresolved,
        "cleanup_unresolved_usernames": unresolved,
        "cleanup_errors": errors,
    }


def finish_verification(admin, clients, attempts, report, output):
    """Always persist cleanup evidence, including when the workload failed."""
    client_errors = []
    for client in clients:
        try:
            client.close()
        except Exception as exc:  # noqa: BLE001 - transport disposal must not prevent account cleanup
            client_errors.append(type(exc).__name__)
    report.update(cleanup_temporary_members(admin, attempts))
    try:
        admin.close()
    except Exception as exc:  # noqa: BLE001 - still persist cleanup results if transport disposal fails
        client_errors.append(type(exc).__name__)
    report["client_close_errors"] = client_errors
    if not report["cleanup_complete"]:
        report["status"] = "FAILED"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    if not report["cleanup_complete"]:
        raise RuntimeError("Temporary viewer cleanup incomplete; see persisted verification report")


def main():
    settings = dotenv_values(ROOT / "data/deployment/production.env")
    proof = json.loads((ROOT / "evidence/cloud-benchmark-30d-100r.json").read_text())
    deployment = json.loads((ROOT / "evidence/deployment.json").read_text())
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
        **verification_provenance(deployment, run),
        "run_group_id": run["id"],
        "viewers": 10,
        "status": "RUNNING",
    }
    try:
        for index in range(10):
            password = secrets.token_urlsafe(32)
            username = f"verification-viewer-{secrets.token_hex(4)}-{index}"
            create_temporary_member(admin, members, username, password, index)
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
    except BaseException as exc:
        report.update(status="FAILED", failure_type=type(exc).__name__)
        raise
    finally:
        finish_verification(admin, clients, members, report, ROOT / "evidence/cloud-ten-viewers.json")
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
