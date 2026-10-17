"""Consistent database backup and non-destructive restore verification."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import uuid

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
COMPOSE = ["docker", "compose", "--env-file", str(ROOT / ".env"), "-f", str(ROOT / "infra/compose.yaml")]


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "verify", "restore"])
    parser.add_argument("--file", type=Path)
    parser.add_argument("--compose", action="store_true", help="PostgreSQL in the Compose stack")
    parser.add_argument("--upload", action="store_true", help="Upload backup to configured private OCI bucket")
    parser.add_argument("--target", type=Path, help="New SQLite target, never an existing database")
    args = parser.parse_args()
    timestamp = datetime.now(timezone.utc)
    db_user = os.getenv("POSTGRES_USER", "hospital")
    db_name = os.getenv("POSTGRES_DB", "hospital")
    if args.action == "backup":
        directory = ROOT / "backups"
        directory.mkdir(exist_ok=True)
        suffix = "dump" if args.compose else "sqlite"
        path = directory / f"hospital-{timestamp:%Y%m%dT%H%M%SZ}.{suffix}"
        if path.exists():
            raise SystemExit("Backup already exists for this second; retry later.")
        if args.compose:
            with path.open("xb") as target:
                command(COMPOSE + ["exec", "-T", "postgres", "pg_dump", "-U", db_user, "-d", db_name, "-Fc"], stdout=target)
        else:
            url = os.getenv("DATABASE_URL", "sqlite:///data/hospital.db")
            if not url.startswith("sqlite:///"):
                raise SystemExit("Use --compose for the hosted PostgreSQL stack.")
            source = Path(url.removeprefix("sqlite:///"))
            if not source.exists():
                raise SystemExit("Source database does not exist.")
            with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(path) as dst:
                src.backup(dst)
        path.chmod(0o600)
        metadata = {"created_at": timestamp.isoformat(), "format": suffix, "file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "byte_size": path.stat().st_size}
        if args.upload:
            import oci
            signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner() if os.getenv("OCI_AUTH") == "instance_principal" else None
            client = oci.object_storage.ObjectStorageClient({}, signer=signer) if signer else oci.object_storage.ObjectStorageClient(oci.config.from_file(profile_name=os.getenv("OCI_CONFIG_PROFILE", "DEFAULT")))
            bucket = os.getenv("OCI_BACKUP_BUCKET") or os.environ["OCI_ARTIFACT_BUCKET"]
            object_name = f"backups/{path.name}"
            with path.open("rb") as source:
                client.put_object(os.environ["OCI_NAMESPACE"], bucket, object_name, source)
            metadata["object_key"] = object_name
            metadata["bucket"] = bucket
        path.with_suffix(path.suffix + ".json").write_text(json.dumps(metadata, indent=2) + "\n")
        print(f"Backup: {path} ({metadata['byte_size']} bytes, SHA256 {metadata['sha256']})")
        return
    if not args.file or not args.file.is_file():
        parser.error("--file must identify an existing backup")
    metadata_path = args.file.with_suffix(args.file.suffix + ".json")
    if metadata_path.exists():
        expected = json.loads(metadata_path.read_text())["sha256"]
        if hashlib.sha256(args.file.read_bytes()).hexdigest() != expected:
            raise SystemExit("Backup checksum mismatch; restore refused.")
    if args.action == "restore":
        if args.compose or args.file.suffix != ".sqlite" or not args.target:
            parser.error("Direct restore requires a SQLite backup and --target NEW_PATH. For PostgreSQL use the runbook controlled restore procedure.")
        if args.target.exists():
            raise SystemExit("Refusing to overwrite an existing database.")
        args.target.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(f"file:{args.file}?mode=ro", uri=True) as src, sqlite3.connect(args.target) as dst:
            src.backup(dst)
        args.target.chmod(0o600)
        print(f"Restored to new database {args.target}")
        return
    if args.compose:
        scratch = "restore_verify_" + uuid.uuid4().hex[:12]
        command(COMPOSE + ["exec", "-T", "postgres", "createdb", "-U", db_user, scratch])
        try:
            with args.file.open("rb") as source:
                command(COMPOSE + ["exec", "-T", "postgres", "pg_restore", "-U", db_user, "-d", scratch, "--exit-on-error", "--no-owner"], stdin=source)
            command(COMPOSE + ["exec", "-T", "postgres", "psql", "-U", db_user, "-d", scratch, "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM documents; SELECT count(*) FROM jobs;"])
        finally:
            command(COMPOSE + ["exec", "-T", "postgres", "dropdb", "-U", db_user, scratch])
    else:
        with tempfile.TemporaryDirectory(prefix="surge-restore-") as directory:
            with sqlite3.connect(f"file:{args.file}?mode=ro", uri=True) as src, sqlite3.connect(Path(directory) / "restored.sqlite") as dst:
                src.backup(dst)
                if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise SystemExit("Restored database failed integrity check")
                for table in ("documents", "jobs"):
                    dst.execute(f"SELECT count(*) FROM {table}").fetchone()
    evidence = {"recorded_at": timestamp.isoformat(), "backup": args.file.name, "database": "postgresql" if args.compose else "sqlite", "restored_into_isolated_database": True, "integrity_and_core_queries": "passed", "production_data_modified": False}
    (ROOT / "evidence").mkdir(exist_ok=True)
    (ROOT / "evidence/restore-verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print("Restore verification passed in an isolated database.")


if __name__ == "__main__":
    main()
