"""The destructive harness must target the requested phase with durable progress."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "cloud_worker_recovery", Path(__file__).resolve().parents[1] / "scripts/cloud_worker_recovery.py"
)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def test_phase_parser_preserves_running_default_and_accepts_aggregation():
    required = ["--dataset-id", "dataset-fixture", "--expected-commit", "a" * 40]
    assert harness.parse_args(required).phase == "RUNNING"
    assert harness.parse_args([*required, "--phase", "aggregating"]).phase == "AGGREGATING"
    with pytest.raises(SystemExit):
        harness.parse_args([*required, "--phase", "SUCCEEDED"])


def test_phase_gate_rejects_early_late_and_incomplete_aggregation():
    assert harness.phase_ready({"status": "RUNNING", "completed": 1}, "RUNNING")
    assert not harness.phase_ready({"status": "RUNNING", "completed": 0}, "RUNNING")
    assert not harness.phase_ready({"status": "RUNNING", "completed": 30}, "RUNNING")
    assert not harness.phase_ready({"status": "RUNNING", "completed": 30}, "AGGREGATING")
    assert not harness.phase_ready({"status": "AGGREGATING", "completed": 29}, "AGGREGATING")
    assert harness.phase_ready({"status": "AGGREGATING", "completed": 30}, "AGGREGATING")
    for terminal in ("SUCCEEDED", "FAILED", "CANCELLED", "CANCEL_REQUESTED"):
        for phase in ("RUNNING", "AGGREGATING"):
            assert not harness.phase_ready({"status": terminal, "completed": 30}, phase)
    with pytest.raises(ValueError):
        harness.phase_ready({"status": "SUCCEEDED", "completed": 30}, "SUCCEEDED")
