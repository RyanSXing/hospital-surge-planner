"""Summarize the versioned acceptance ledger without treating code as test evidence."""
from collections import Counter
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ledger = json.loads((ROOT / "docs/acceptance-tracker.json").read_text())
for section in ("features", "workflows", "acceptance"):
    entries = ledger[section]
    print(f"{section}: {dict(Counter(row['status'] for row in entries))}")
    required = [row["id"] for row in entries if row.get("stage") != "P2" and row["status"] != "verified"]
    if required:
        print("  Awaiting evidence: " + ", ".join(required))
