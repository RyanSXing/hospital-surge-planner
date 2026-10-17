"""Identify the source tree used for a build without presenting dirty code as a clean release."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def code_version() -> str:
    revision = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT, text=True, capture_output=True
    )
    if revision.returncode:
        return "uncommitted-working-tree"
    changes = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=ROOT, text=True, capture_output=True, check=True,
    )
    return revision.stdout.strip() + ("-dirty" if changes.stdout.strip() else "")


if __name__ == "__main__":
    print(code_version())
