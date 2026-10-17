"""Compression changes storage bytes, never the checked JSON payload contract."""

import gzip
import hashlib

import pytest
from surge_api.artifacts import ArtifactStore
from surge_api.db import canonical


def test_level_six_preserves_exact_canonical_bytes_and_metadata(monkeypatch, tmp_path):
    monkeypatch.setenv("ARTIFACT_BACKEND", "local")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path))
    store = ArtifactStore()
    value = {
        "unicode": "Ward café — 病棟",
        "items": [None, False, 0, -0.0, 1.25] * 100,
        "nested": {"z": 3, "a": 1},
    }
    expected = canonical(value)
    first = store.put_json("workspace-main", "run-test", "trace", value)
    second = store.put_json("workspace-main", "run-test", "trace", value)
    packed = store.read(first)
    assert packed == gzip.compress(expected, compresslevel=6, mtime=0)
    assert gzip.decompress(packed) == expected
    assert first["sha256"] == second["sha256"] == hashlib.sha256(packed).hexdigest()
    assert first["byte_size"] == len(packed)
    assert first["object_key"] != second["object_key"]
    assert canonical(store.get_json(first)) == expected
    legacy = store.write(
        "workspace-main",
        "run-test",
        "legacy.json.gz",
        gzip.compress(expected, compresslevel=9, mtime=0),
        "application/gzip",
    )
    assert canonical(store.get_json(legacy)) == expected


def test_nonfinite_payload_is_rejected_before_artifact_write(monkeypatch, tmp_path):
    monkeypatch.setenv("ARTIFACT_BACKEND", "local")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path))
    store = ArtifactStore()
    with pytest.raises(ValueError):
        store.put_json("workspace-main", "run-test", "invalid", {"value": float("nan")})
    assert not list(tmp_path.rglob("*.gz"))
