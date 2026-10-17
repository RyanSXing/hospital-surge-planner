"""Scan the deployed images locally with Trivy and retain complete HIGH/CRITICAL findings."""
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "evidence" / "container-scans"
SCANNER = "aquasec/trivy:0.76.0"
DEFAULT_IMAGES = [
    "hospital-surge-planner-api:1.0.0",
    "hospital-surge-planner-web:1.0.0",
    "hospital-surge-planner-postgres:17.11-patched",
    "hospital-surge-planner-redis:7.4.11-patched",
    "hospital-surge-planner-caddy:2.11.7-patched",
]


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)
    summaries = []
    for image in sys.argv[1:] or DEFAULT_IMAGES:
        name = image.replace("/", "_").replace(":", "-") + ".json"
        subprocess.run([
            "docker", "run", "--rm",
            "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
            "-v", "hospital-trivy-cache:/root/.cache/trivy",
            "-v", f"{REPORTS}:/reports",
            SCANNER, "image", "--scanners", "vuln", "--platform", "linux/arm64",
            "--severity", "HIGH,CRITICAL", "--format", "json",
            "--output", f"/reports/{name}", "--timeout", "10m", image,
        ], check=True)
        report = json.loads((REPORTS / name).read_text())
        findings = [v for result in report.get("Results", []) for v in result.get("Vulnerabilities", [])]
        summaries.append({
            "image": image,
            "image_id": report.get("Metadata", {}).get("ImageID"),
            "repo_digests": report.get("Metadata", {}).get("RepoDigests", []),
            "high": sum(v["Severity"] == "HIGH" for v in findings),
            "critical": sum(v["Severity"] == "CRITICAL" for v in findings),
            "fixed_available": sum(bool(v.get("FixedVersion")) for v in findings),
            "report": f"evidence/container-scans/{name}",
        })
    summary = {
        "checked_at": datetime.now(timezone.utc).isoformat(), "scanner": SCANNER,
        "scope": "Linux ARM64 runtime images; HIGH/CRITICAL OS and language vulnerabilities, including unfixed findings",
        "images": summaries,
    }
    (ROOT / "evidence/container-security.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
