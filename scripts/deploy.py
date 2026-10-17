"""Deploy the reviewed source to an existing authorized OCI host over verified SSH."""

import json
import os
import re
import shlex
import subprocess
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from code_version import code_version
from dotenv import dotenv_values, load_dotenv

ROOT = Path(__file__).resolve().parents[1]
revision = code_version()
if revision == "uncommitted-working-tree" or revision.endswith("-dirty"):
    raise SystemExit(
        "Deployment requires a committed clean source tree so run manifests identify the exact release."
    )
load_dotenv(ROOT / ".env")
required = ("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_ENV_FILE")
missing = [name for name in required if not os.getenv(name)]
if missing:
    raise SystemExit(
        "Deployment needs "
        + ", ".join(missing)
        + ". See docs/runbook.md; this command does not provision a VM."
    )
host, user = os.environ["DEPLOY_HOST"], os.environ["DEPLOY_USER"]
directory = os.getenv("DEPLOY_DIR", f"/home/{user}/hospital-surge-planner")
env_file = Path(os.environ["DEPLOY_ENV_FILE"]).expanduser()
if not env_file.is_file():
    raise SystemExit("DEPLOY_ENV_FILE does not exist.")
settings = dotenv_values(env_file)
problems = []
if settings.get("COMPOSE_APP_ENV", "production") != "production":
    problems.append("COMPOSE_APP_ENV must be production")
if settings.get("COMPOSE_ARTIFACT_BACKEND") != "oci":
    problems.append("COMPOSE_ARTIFACT_BACKEND must be oci for hosted delivery")
if not str(settings.get("PUBLIC_BASE_URL", "")).startswith("https://"):
    problems.append("PUBLIC_BASE_URL must be the public HTTPS endpoint")
if not settings.get("DOMAIN") or settings.get("DOMAIN") == "localhost":
    problems.append("DOMAIN must be the configured public hostname")
for name, minimum in (("ADMIN_PASSWORD", 16), ("SESSION_SECRET", 32), ("POSTGRES_PASSWORD", 16)):
    if len(str(settings.get(name, ""))) < minimum or settings.get(name) == "GENERATE_ON_SETUP":
        problems.append(f"{name} needs a unique generated secret")
for name in ("OCI_NAMESPACE", "OCI_ARTIFACT_BUCKET"):
    if not settings.get(name):
        problems.append(f"{name} is required")
if problems:
    raise SystemExit("Hosted configuration incomplete: " + "; ".join(problems))
excluded = {
    ".git",
    ".venv",
    ".cache",
    ".agents",
    ".codex",
    ".playwright-cli",
    "node_modules",
    "data",
    "artifacts",
    "backups",
    "logs",
    "evidence",
    "output",
    "test-results",
    "playwright-report",
    "__pycache__",
    ".pytest_cache",
    "dist",
}


def include(info):
    parts = Path(info.name).parts
    if (
        any(part in excluded for part in parts)
        or Path(info.name).name.startswith(".env")
        or info.name.endswith((".pem", ".key", ".pyc"))
    ):
        return None
    return info


ssh = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ConnectTimeout=15",
    "-i",
    os.path.expanduser(os.environ["DEPLOY_SSH_KEY"]),
    "-l",
    user,
    "--",
    host,
]
if os.getenv("DEPLOY_KNOWN_HOSTS"):
    ssh[1:1] = ["-o", "UserKnownHostsFile=" + os.path.expanduser(os.environ["DEPLOY_KNOWN_HOSTS"])]


def remote(command):
    subprocess.run(ssh + [command], check=True)


def upload(source, name):
    target = shlex.quote(directory + "/" + name)
    temporary = shlex.quote(directory + "/" + name + ".uploading")
    # Bytes stream over verified OpenSSH stdin, never through shell interpolation.
    with source.open("rb") as content:
        subprocess.run(
            ssh + [f"umask 077; cat > {temporary} && chmod 600 {temporary} && mv {temporary} {target}"],
            stdin=content,
            check=True,
        )


remote("mkdir -p " + shlex.quote(directory))
with tempfile.TemporaryDirectory(prefix="surge-release-") as temporary:
    archive = Path(temporary) / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        for path in ROOT.iterdir():
            bundle.add(path, arcname=path.name, filter=include)
    upload(archive, "release.tar.gz")
    release_env = Path(temporary) / "release.env"
    release_env.write_text(
        re.sub(r"(?m)^(?:CODE_COMMIT|IMAGE_TAG)=.*\n?", "", env_file.read_text()).rstrip()
        + "\nCODE_COMMIT="
        + revision
        + "\nIMAGE_TAG="
        + revision
        + "\n"
    )
    release_env.chmod(0o600)
    upload(release_env, ".env")
compose = "CODE_COMMIT=" + shlex.quote(revision) + " docker compose --env-file .env -f infra/compose.yaml"
steps = [
    "tar -xzf release.tar.gz",
    compose + " --profile tls build",
    compose + " up -d postgres redis",
    compose + " run --rm api .venv/bin/alembic -c infra/alembic.ini upgrade head",
    compose + " up -d api worker web",
    compose + " --profile tls up -d tls",
    compose + " ps",
]
remote("cd " + shlex.quote(directory) + " && " + " && ".join(steps))
evidence = {
    "deployed_at": datetime.now(UTC).isoformat(),
    "code_commit": revision,
    "image_tag": revision,
    "host": host,
    "directory": directory,
    "steps": steps,
    "status": "deployed_pending_acceptance",
    "required_next": [
        "authenticated smoke run",
        "OCI artifact upload/download",
        "full workflow verification",
        "backup and restore test",
        "record image digests and benchmark",
    ],
}
(ROOT / "evidence/deployment.json").write_text(json.dumps(evidence, indent=2) + "\n")
