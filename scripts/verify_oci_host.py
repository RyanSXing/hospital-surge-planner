"""Trust an SSH host key obtained from authenticated OCI serial console history."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
import oci

ROOT = Path(__file__).resolve().parents[1]
state = json.loads((ROOT / "data/deployment/oci-resources.json").read_text())
client = oci.core.ComputeClient(oci.config.from_file(profile_name="CODEX_API_KEY"))
history = client.capture_console_history(oci.core.models.CaptureConsoleHistoryDetails(
    instance_id=state["instance_id"], display_name="Hospital deployment SSH host verification"
)).data
try:
    for _ in range(20):
        if client.get_console_history(history.id).data.lifecycle_state == "SUCCEEDED":
            break
        time.sleep(3)
    content = client.get_console_history_content(history.id, length=1048576).data
    if not isinstance(content, str):
        content = content.decode() if isinstance(content, bytes) else content.content.decode()
    (ROOT / "data/deployment/console-history.txt").write_text(content)
    keys = re.findall(r"(?:HSP_SSH_HOST_KEY )?(ssh-ed25519 [A-Za-z0-9+/=]+)(?:\s|$)", content)
    if not keys:
        raise SystemExit("Host public key is not in the serial console yet; wait for cloud-init and retry.")
    if len(set(keys)) != 1:
        raise SystemExit("Ambiguous SSH host keys; inspect authenticated console evidence before trusting a key.")
    known = ROOT / "data/deployment/known_hosts"
    known.write_text(state["public_ip"] + " " + keys[0] + "\n")
    known.chmod(0o600)
    (ROOT / "evidence/oci-host-key-verification.json").write_text(json.dumps({
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "instance_id": state["instance_id"], "source": "Authenticated OCI serial console API",
        "public_key": keys[0], "strict_host_key_checking": True,
    }, indent=2) + "\n")
    print("SSH host public key verified through OCI; strict known_hosts file prepared.")
finally:
    client.delete_console_history(history.id)
