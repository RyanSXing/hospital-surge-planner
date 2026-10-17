"""Run a command on this project's verified OCI host using its dedicated deployment key."""
import json
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
state = json.loads((ROOT / "data/deployment/oci-resources.json").read_text())
if len(sys.argv) < 2:
    raise SystemExit("Supply a remote executable and its arguments.")
ssh = [
    "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=" + str(ROOT / "data/deployment/known_hosts"),
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "ConnectTimeout=15",
    "-i", str(ROOT / "data/deployment/oci_deploy_ed25519"),
    "-l", "ubuntu", "--", state["public_ip"], shlex.join(sys.argv[1:]),
]
raise SystemExit(subprocess.run(ssh).returncode)
