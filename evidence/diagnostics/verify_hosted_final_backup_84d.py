"""Download an OCI database backup and verify it in an isolated Compose database.

Run on the deployment host: python3 scripts/verify_hosted_backup.py --object-key backups/NAME.dump
"""
import argparse
import hashlib
import json
import os
import subprocess
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path("/opt/hospital-surge-planner")
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "infra/compose.yaml"]


def command(args, **kwargs):
    result = subprocess.run(COMPOSE + args, cwd=ROOT, capture_output=True, check=False, **kwargs)
    if result.returncode:
        raise RuntimeError("Backup verification command failed; inspect the private host logs.")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--object-key", required=True)
    args = parser.parse_args()
    if not args.object_key.startswith("backups/") or not args.object_key.endswith(".dump"):
        parser.error("The object must be a database dump under backups/.")
    identity = uuid.uuid4().hex[:12]
    downloaded = f"restore-proof-{identity}.dump"
    script = '''import hashlib,json,os,urllib.error,urllib.parse,urllib.request
from pathlib import Path
import oci
client=oci.object_storage.ObjectStorageClient({},signer=oci.auth.signers.InstancePrincipalsSecurityTokenSigner())
namespace=os.environ["OCI_NAMESPACE"];bucket=os.environ["OCI_BACKUP_BUCKET"]
key=KEY;path=Path("/backup")/FILENAME
metadata=json.loads(client.get_object(namespace,bucket,key+".json").data.content)
with path.open("xb") as destination:
 for chunk in client.get_object(namespace,bucket,key).data.raw.stream(1024*1024,decode_content=False):
  destination.write(chunk)
path.chmod(0o600)
with path.open("rb") as source: digest=hashlib.file_digest(source,"sha256").hexdigest()
assert digest==metadata["sha256"]
access=client.get_bucket(namespace,bucket).data.public_access_type
assert access=="NoPublicAccess"
url="https://objectstorage."+os.environ["OCI_REGION"]+".oraclecloud.com/n/"+namespace+"/b/"+bucket+"/o/"+urllib.parse.quote(key,safe="/")
try:
 urllib.request.urlopen(url,timeout=15)
 raise AssertionError("Anonymous backup read succeeded")
except urllib.error.HTTPError as error:
 status=error.code
 assert status in (403,404)
print(json.dumps(dict(metadata,public_access_type=access,anonymous_read_status=status,download_sha256=digest)))
'''.replace("key=KEY", "key=" + repr(args.object_key)).replace("/FILENAME", "/" + repr(downloaded))
    backup_dir = ROOT / "backups"
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    scratch = "restore_proof_" + identity
    created = False
    started = time.perf_counter()
    try:
        metadata = json.loads(command([
            "run", "--rm", "--no-deps", "-T", "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", f"{backup_dir}:/backup", "api", "python", "-",
        ], input=script.encode()))
        command(["exec", "-T", "postgres", "createdb", "-U", "hospital", scratch])
        created = True
        with (backup_dir / downloaded).open("rb") as source:
            command(["exec", "-T", "postgres", "pg_restore", "-U", "hospital", "-d", scratch,
                     "--exit-on-error", "--no-owner"], stdin=source)
        counts = json.loads(command([
            "exec", "-T", "postgres", "psql", "-U", "hospital", "-d", scratch,
            "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c",
            "SELECT json_build_object('documents',(SELECT count(*) FROM documents),'jobs',(SELECT count(*) FROM jobs),'audit_events',(SELECT count(*) FROM audit_events),'current_seed_datasets',(SELECT json_agg(json_build_object('id',id,'revision',revision,'generator_version',data->>'generator_version','input_sha256',data->>'input_sha256','validation_valid',data->'validation'->'valid')) FROM documents WHERE id IN ('demo-v1-1-0-planning_baseline-41021-365','demo-v1-1-0-stress_snapshot-41021-365')),'final_release_successful_runs',(SELECT count(*) FROM jobs WHERE kind='run' AND status='SUCCEEDED' AND result->'manifest'->>'code_commit'='84d225e2776630cf84e17bf7d0913b01553e0cd4'),'active_jobs',(SELECT count(*) FROM jobs WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELLED')));",
        ]))
        assert counts["documents"] > 0
        assert len(counts["current_seed_datasets"]) == 2
        assert all(row["generator_version"] == "1.1.0" and row["validation_valid"] for row in counts["current_seed_datasets"])
        assert counts["final_release_successful_runs"] >= 4
        assert counts["active_jobs"] == 0
    finally:
        # Always remove the private downloaded dump, including if scratch cleanup fails.
        # A failed drop remains an exception, so this path cannot claim a passed gate.
        try:
            if created:
                command(["exec", "-T", "postgres", "dropdb", "-U", "hospital", scratch])
        finally:
            (backup_dir / downloaded).unlink(missing_ok=True)
    evidence = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "code_commit": "84d225e2776630cf84e17bf7d0913b01553e0cd4",
        "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "scope": "Hosted PostgreSQL backup downloaded from private OCI storage and restored into a separate scratch database",
        "backup": metadata, "restored_counts": counts,
        "download_and_restore_seconds": time.perf_counter() - started,
        "production_database_replaced": False, "scratch_database_dropped": True,
    }
    (ROOT / "evidence").mkdir(exist_ok=True)
    (ROOT / "evidence/hosted-backup-restore.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
