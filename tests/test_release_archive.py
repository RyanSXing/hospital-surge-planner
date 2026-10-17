"""Deployment bytes must match the named commit and exclude private material."""

import hashlib
import importlib.util
import subprocess
import tarfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "release_archive", Path(__file__).resolve().parents[1] / "scripts/release_archive.py"
)
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


def test_release_archive_uses_commit_bytes_and_excludes_private_runtime_files(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()

    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=root, check=True, capture_output=True, text=True
        ).stdout.strip()

    git("init", "-q")
    tracked = {
        "app.py": "original committed code\n",
        "infra/config.yaml": "committed configuration\n",
        "data/deployment/private.env": "private deployment value\n",
        "evidence/report.json": "retained local evidence\n",
        ".env.example": "excluded environment template\n",
        "private.key": "excluded key material\n",
    }
    for name, value in tracked.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    git("add", ".")
    git("-c", "user.name=Archive test", "-c", "user.email=archive@example.invalid", "commit", "-qm", "fixture")
    revision = git("rev-parse", "HEAD")
    # A subsequent editor write cannot change the immutable archived release.
    (root / "app.py").write_text("later working-tree changes\n")
    (root / "unexpected-local-file.txt").write_text("untracked private value\n")
    (root / ".coverage").write_text("ignored runtime value\n")
    destination = tmp_path / "release.tar.gz"
    metadata = archive.build_release_archive(root, revision, destination)
    with tarfile.open(destination) as bundle:
        files = {member.name for member in bundle if member.isfile()}
        assert files == {"app.py", "infra/config.yaml"}
        assert bundle.extractfile("app.py").read().decode() == tracked["app.py"]
    assert metadata["commit"] == revision
    assert metadata["members"] == 3  # Two files plus their infra directory.
    assert metadata["sha256"] == hashlib.sha256(destination.read_bytes()).hexdigest()
