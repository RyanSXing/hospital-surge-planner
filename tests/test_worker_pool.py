"""Private input handoff keeps spawn semantics and cleans up every exit path."""

import multiprocessing
import os
import pickle
import stat
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pytest
from surge_api import worker
from surge_engine import generate_dataset, run_replication


def without_timing(result):
    return {key: value for key, value in result.items() if key != "execution_metrics"}


def test_serial_inline_spawn_and_private_file_spawn_have_identical_outputs():
    dataset = generate_dataset("stress_snapshot", days=1)
    scenario = {
        "horizon_calendar_days": 1,
        "base_seed": 41021,
        "conditions": [{"kind": "arrival_multiplier", "surge_percent": 70}],
    }
    expected = [run_replication(dataset, scenario, index, keep_trace=False) for index in range(2)]
    spawn = multiprocessing.get_context("spawn")
    stop = spawn.Event()
    with ProcessPoolExecutor(
        max_workers=2,
        mp_context=spawn,
        initializer=worker._replication_initializer,
        initargs=(dataset, scenario, stop),
    ) as pool:
        inline = list(pool.map(worker._replication_task, range(2)))
    with worker.private_replication_pool(dataset, scenario, 2, worker.AttemptToken(7, 2, 6)) as pool:
        private = list(pool.map(worker._replication_task, range(2)))
    assert [without_timing(result) for result in inline] == expected
    assert [without_timing(result) for result in private] == expected


@pytest.mark.parametrize("failure", [None, RuntimeError, worker.Cancelled, worker.LeaseLost])
def test_private_inputs_permissions_uniqueness_and_cleanup(monkeypatch, failure):
    pools = []

    class Pool:
        def __init__(self, **kwargs):
            self.path, self.stop = kwargs["initargs"]
            self.path = Path(self.path)
            self.closed = False
            assert kwargs["initializer"] is worker._replication_file_initializer
            assert stat.S_IMODE(self.path.stat().st_mode) == 0o600
            assert stat.S_IMODE(self.path.parent.stat().st_mode) == 0o700
            with self.path.open("rb") as stream:
                assert pickle.load(stream) == ({"frozen": [1, 2]}, {"base_seed": 123})
            pools.append(self)

        def shutdown(self, *, wait, cancel_futures):
            assert wait and cancel_futures and self.stop.is_set()
            self.closed = True

    monkeypatch.setattr(worker, "ProcessPoolExecutor", Pool)
    token = worker.AttemptToken(2, 0, 0)
    for _ in range(2):
        try:
            with worker.private_replication_pool({"frozen": [1, 2]}, {"base_seed": 123}, 2, token):
                if failure:
                    raise failure("injected exit")
        except Exception as exc:  # noqa: BLE001 - test all deliberate exit paths.
            assert failure is not None and isinstance(exc, failure)
    assert pools[0].path != pools[1].path
    assert all(pool.closed and not pool.path.parent.exists() for pool in pools)


def test_pool_constructor_failure_cleans_private_inputs(monkeypatch):
    created = []

    def fail(**kwargs):
        created.append(Path(kwargs["initargs"][0]))
        raise RuntimeError("pool constructor failed")

    monkeypatch.setattr(worker, "ProcessPoolExecutor", fail)
    with (
        pytest.raises(RuntimeError, match="constructor"),
        worker.private_replication_pool({}, {}, 2, worker.AttemptToken(1, 0, 0)),
    ):
        pytest.fail("Unreachable")
    assert created and not created[0].parent.exists()


def test_initializer_rejects_public_or_symlinked_file_before_deserializing(tmp_path, monkeypatch):
    path = tmp_path / "inputs.pickle"
    path.write_bytes(b"untrusted bytes")
    path.chmod(0o644)

    def unexpected(*args):
        pytest.fail("Untrusted file reached pickle decoder")

    monkeypatch.setattr(worker.pickle, "load", unexpected)
    with pytest.raises(ValueError, match="private regular file"):
        worker._replication_file_initializer(str(path), None)
    path.chmod(0o600)
    link = tmp_path / "link.pickle"
    link.symlink_to(path)
    with pytest.raises(OSError):
        worker._replication_file_initializer(str(link), None)


def private_input(root, pid, suffix):
    folder = root / f"hsp-pool-{pid}-a1-{suffix}"
    folder.mkdir(mode=0o700)
    path = folder / "inputs.pickle"
    path.write_bytes(b"trusted input placeholder")
    path.chmod(0o600)
    return folder


def test_scavenger_removes_killed_parent_inputs_and_preserves_live_or_unexpected_files(tmp_path):
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        dead = private_input(tmp_path, parent.pid, "dead")
        assert worker.scavenge_private_inputs(root=tmp_path) == 0
    finally:
        parent.kill()
        parent.wait(timeout=10)
    live = private_input(tmp_path, os.getpid(), "live")
    wrong_directory = private_input(tmp_path, parent.pid, "publicdir")
    wrong_directory.chmod(0o755)
    wrong_file = private_input(tmp_path, parent.pid, "publicfile")
    (wrong_file / "inputs.pickle").chmod(0o644)
    extra = private_input(tmp_path, parent.pid, "extra")
    (extra / "unexpected").write_text("preserve")
    linked = private_input(tmp_path, parent.pid, "linked")
    (linked / "inputs.pickle").unlink()
    (linked / "inputs.pickle").symlink_to(live / "inputs.pickle")
    link = tmp_path / f"hsp-pool-{parent.pid}-a1-symlink"
    link.symlink_to(live, target_is_directory=True)
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    huge_pid = private_input(tmp_path, 10**50, "overflow")
    assert worker.scavenge_private_inputs(root=tmp_path) == 1
    assert not dead.exists()
    for folder in (live, wrong_directory, wrong_file, extra, linked, link, unrelated, huge_pid):
        assert folder.exists()


def test_scavenger_is_bounded_and_rejects_other_owners(tmp_path, monkeypatch):
    parent = subprocess.Popen([sys.executable, "-c", "pass"])
    parent.wait(timeout=10)
    folders = [private_input(tmp_path, parent.pid, suffix) for suffix in ("one", "two", "three")]
    original_uid = os.getuid()
    with monkeypatch.context() as patch:
        patch.setattr(worker.os, "getuid", lambda: original_uid + 1)
        assert worker.scavenge_private_inputs(root=tmp_path) == 0
    assert worker.scavenge_private_inputs(root=tmp_path, max_deletions=1) == 1
    assert sum(folder.exists() for folder in folders) == 2
    assert worker.scavenge_private_inputs(root=tmp_path, max_entries=1) == 1
    assert sum(folder.exists() for folder in folders) == 1
