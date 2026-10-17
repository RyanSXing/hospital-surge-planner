"""Package only an immutable Git release, excluding private and runtime files."""

import hashlib
import subprocess
import tarfile
import tempfile
from pathlib import Path

EXCLUDED = {
    ".git", ".venv", ".cache", ".agents", ".codex", ".playwright-cli",
    "node_modules", "data", "artifacts", "backups", "logs", "evidence", "output",
    "test-results", "playwright-report", "__pycache__", ".pytest_cache", ".ruff_cache",
    "htmlcov", "dist",
}


def include_release_member(member):
    path = Path(member.name)
    return not (
        any(part in EXCLUDED for part in path.parts)
        or path.name.startswith(".env")
        or path.name in {".coverage", ".DS_Store"}
        or path.suffix in {".pem", ".key", ".pyc", ".db", ".sqlite", ".sqlite3"}
    )


def build_release_archive(root, revision, destination):
    """Read committed bytes, never working-tree files or ignored local material.

    The caller verifies a clean tree before deployment. Using the immutable
    revision here also prevents a later editor change from entering that release.
    """
    root, destination = Path(root), Path(destination)
    count = 0
    with tempfile.TemporaryDirectory(prefix="surge-git-archive-", dir=destination.parent) as folder:
        source = Path(folder) / "committed.tar"
        subprocess.run(
            ["git", "archive", "--format=tar", f"--output={source}", revision],
            cwd=root,
            check=True,
        )
        with tarfile.open(source, "r:") as committed, tarfile.open(destination, "w:gz") as release:
            for member in committed:
                if include_release_member(member):
                    stream = committed.extractfile(member) if member.isfile() else None
                    try:
                        release.addfile(member, stream)
                    finally:
                        if stream is not None:
                            stream.close()
                    count += 1
    with destination.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"commit": revision, "members": count, "sha256": checksum}
