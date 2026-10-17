"""Pure trace work overlaps parent finalization without publishing partial results."""

# ruff: noqa: F811 -- imported shared pytest fixture is injected by name.
import copy
import json
import os
import select
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest
import surge_engine
from surge_api import worker
from surge_api.db import Document, Job
from surge_engine.aggregate import aggregate_results, representative_replication
from test_api import client, create_short_scenario, setup_context  # noqa: F401


def test_representative_selector_preserves_median_ties_and_input_order():
    rows = [
        {
            "replication_index": index,
            "replication_id": f"R{index}",
            "scalar_metrics": {"inpatient_waiting_patient_hours": waiting},
        }
        for index, waiting in [(9, 20), (2, 0), (4, 10), (1, 30)]
    ]
    original = copy.deepcopy(rows)
    assert representative_replication(rows)["replication_index"] == 4
    assert aggregate_results(rows)["selected_replication_index"] == 4
    assert representative_replication(list(reversed(rows)))["replication_index"] == 4
    assert rows == original
    rows[0]["status"] = "FAILED"
    with pytest.raises(ValueError, match="Incomplete"):
        representative_replication(rows)


def test_real_spawn_selected_trace_matches_serial_and_removes_private_inputs(monkeypatch, tmp_path):
    monkeypatch.setattr(worker.tempfile, "tempdir", str(tmp_path))
    dataset = surge_engine.generate_dataset("stress_snapshot", days=1)
    scenario = {"horizon_calendar_days": 1, "base_seed": 1701, "conditions": []}
    expected = surge_engine.run_replication(dataset, scenario, 1, keep_trace=True)
    with worker.private_replication_pool(dataset, scenario, 2, worker.AttemptToken(1, 0, 0)) as pool:
        # Reuse a child that has already executed an ordinary trajectory.
        pool.submit(worker._replication_task, 0).result(timeout=20)
        actual = pool.submit(worker._selected_trace_task, 1).result(timeout=20)
        assert list(tmp_path.glob("hsp-pool-*/inputs.pickle"))
    actual.pop("execution_metrics")
    assert actual == expected
    assert not list(tmp_path.glob("hsp-pool-*"))


def test_selected_trace_child_exits_after_parent_sigkill_and_inputs_are_scavenged(tmp_path):
    script = tmp_path / "trace_parent.py"
    script.write_text("""import json,os,sys
from pathlib import Path
from surge_api import worker
from surge_engine import generate_dataset

def trace(index):
    print(json.dumps({"trace_child":os.getpid()}),flush=True)
    result=worker._selected_trace_task(index)
    # A very fast machine must not make natural task completion masquerade as
    # the parent's orphan watchdog stopping this child.
    while True:
        worker.time.sleep(1)
    return result

if __name__ == "__main__":
    worker.tempfile.tempdir=sys.argv[1]
    dataset=generate_dataset("stress_snapshot",days=365)
    scenario={"horizon_calendar_days":365,"base_seed":41021,"conditions":[]}
    with worker.private_replication_pool(dataset,scenario,1,worker.AttemptToken(1,0,0)) as pool:
        print(json.dumps({"parent":os.getpid()}),flush=True)
        pool.submit(trace,0).result()
""")
    parent = subprocess.Popen(
        [sys.executable, str(script), str(tmp_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
    )
    child = None
    alive = False
    try:
        messages = []
        for _ in range(2):
            assert select.select([parent.stdout], [], [], 30)[0], "Spawned trace did not start"
            line = parent.stdout.readline()
            assert line, parent.stderr.read().decode()
            messages.append(json.loads(line))
        assert messages[0]["parent"] == parent.pid
        child = messages[1]["trace_child"]
        assert child not in {os.getpid(), parent.pid} and child > 1
        alive = True
        assert list(tmp_path.glob(f"hsp-pool-{parent.pid}-*/inputs.pickle"))
        parent.kill()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                alive = False
                break
            alive = True
            # Linux may retain an exited orphan briefly as a zombie. Inspect
            # only the known child, without requiring global process listing.
            proc = Path(f"/proc/{child}/stat")
            try:
                if proc.exists() and proc.read_text().rsplit(")", 1)[1].split()[0] == "Z":
                    alive = False
                    break
            except FileNotFoundError:
                alive = False
                break
            time.sleep(0.1)
        assert not alive, "Trace child survived its killed parent"
        assert worker.scavenge_private_inputs(root=tmp_path) == 1
        assert not list(tmp_path.glob("hsp-pool-*"))
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if child is not None and alive:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        parent.stdout.close()
        parent.stderr.close()


@pytest.mark.parametrize("failure", [None, "aggregate", "trace", "cancel", "timeout", "lease"])
def test_overlap_barriers_and_finalization_failures_never_publish_incomplete_run(
    client, monkeypatch, failure
):
    monkeypatch.setenv("SIMULATION_WORKERS", "2")
    scenario = create_short_scenario(client, setup_context(client), replications=6)
    identity = client.post("/api/run-groups", json={"scenario_id": scenario["id"]}).json()["id"]
    Session = client.app.state.Session
    trace_started, aggregation_started, inputs_uploaded = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )
    stop = threading.Event()
    lock = threading.Lock()
    ordinary_finished = 0
    active = 0
    maximum_active = 0
    parent_thread = threading.get_ident()
    original_aggregate = surge_engine.aggregate_results
    original_write = worker.ArtifactStore.write
    original_time = worker.time
    advance = 0
    pool_closed = False

    class Clock:
        def monotonic(self):
            return original_time.monotonic() + advance

        def __getattr__(self, name):
            return getattr(original_time, name)

    monkeypatch.setattr(worker, "time", Clock())

    @contextmanager
    def pool_context(dataset, frozen_scenario, workers, token):
        nonlocal pool_closed
        assert workers == 2

        class Pool:
            def submit(self, function, index):
                def compute():
                    nonlocal ordinary_finished, active, maximum_active
                    with lock:
                        active += 1
                        maximum_active = max(maximum_active, active)
                    try:
                        if function is worker._selected_trace_task:
                            assert ordinary_finished == 6
                            trace_started.set()
                            assert aggregation_started.wait(10), "Aggregation never overlapped trace work"
                            if failure == "trace":
                                raise ValueError("injected trace failure")
                            while not inputs_uploaded.wait(0.01):
                                if stop.is_set():
                                    raise surge_engine.SimulationCancelled("Parent finalization stopped")
                            assert not stop.is_set()
                            return worker.timed_replication(
                                dataset, frozen_scenario, index, keep_trace=True, cancel_check=stop.is_set
                            )
                        assert function is worker._replication_task
                        result = worker.timed_replication(
                            dataset, frozen_scenario, index, cancel_check=stop.is_set
                        )
                        with lock:
                            ordinary_finished += 1
                        return result
                    finally:
                        with lock:
                            active -= 1

                return executor.submit(compute)

        try:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                try:
                    yield Pool()
                finally:
                    stop.set()
        finally:
            pool_closed = True

    def aggregate(rows, scenario=None, *, cancel_check=None):
        nonlocal advance
        assert trace_started.wait(10), "Trace was not submitted before aggregation"
        aggregation_started.set()
        if failure == "aggregate":
            raise ValueError("injected aggregate failure")
        if failure in {"cancel", "lease"}:
            with Session.begin() as session:
                job = session.get(Job, identity)
                if failure == "cancel":
                    job.cancelled = True
                    job.status = "CANCEL_REQUESTED"
                else:
                    job.attempts += 1
                    job.status = "RUNNING"
                    job.result = {"new_owner": "must remain unchanged"}
            advance = 1  # Exercise the real job_control DB check, past its throttle.
        if failure == "timeout":
            advance = 7201  # Exercise the real configured deadline without sleeping.
        return original_aggregate(rows, scenario=scenario, cancel_check=cancel_check)

    def write(store, workspace, owner, name, data, media_type="application/json"):
        assert threading.get_ident() == parent_thread, "A computation child attempted artifact publication"
        artifact = original_write(store, workspace, owner, name, data, media_type)
        if name == "inputs.json.gz":
            with Session() as session:
                assert session.get(Job, identity).status == "AGGREGATING"
                assert not session.get(Job, identity).result.get("manifest")
            assert trace_started.is_set() and aggregation_started.is_set()
            inputs_uploaded.set()
        return artifact

    monkeypatch.setattr(worker, "private_replication_pool", pool_context)
    monkeypatch.setattr(surge_engine, "aggregate_results", aggregate)
    monkeypatch.setattr(worker.ArtifactStore, "write", write)
    worker.execute_job(identity, client.database_url)
    assert pool_closed and active == 0 and maximum_active <= 2
    assert ordinary_finished == 6 and aggregation_started.is_set()
    with Session() as session:
        job = session.get(Job, identity)
        reps = [session.get(Document, f"{identity}_rep_{index:04d}") for index in range(6)]
        assert all(rep.data["status"] == "SUCCEEDED" for rep in reps)
        if failure:
            assert job.status == {"cancel": "CANCELLED", "lease": "RUNNING"}.get(failure, "FAILED")
            assert "manifest" not in job.result
            assert all("trace_artifact" not in rep.data for rep in reps)
            if failure == "lease":
                assert job.result == {"new_owner": "must remain unchanged"} and job.attempts == 2
            retained = set(worker.artifact_keys([rep.data for rep in reps]))
            assert {
                str(path.relative_to(worker.ArtifactStore().root))
                for path in worker.ArtifactStore().root.rglob("*.gz")
            } == retained
        else:
            assert job.status == "SUCCEEDED" and inputs_uploaded.is_set()
            selected = job.result["selected_replication_id"]
            rep = session.get(Document, selected)
            actual = worker.ArtifactStore().get_json(rep.data["trace_artifact"])
            dataset = session.get(Document, job.payload["dataset_version_id"]).data
            expected = surge_engine.run_replication(
                dataset, job.payload["scenario"], rep.data["replication_index"], keep_trace=True
            )
            expected.update(
                replication_id=selected,
                replication_index=rep.data["replication_index"],
                run_group_id=identity,
                start_at=job.payload["scenario"]["start_at"],
            )
            for event in expected.get("events", []):
                event.update(
                    run_group_id=identity,
                    replication_id=selected,
                    replication_index=rep.data["replication_index"],
                )
            actual.pop("execution_metrics")
            assert actual == expected


def test_long_aggregation_checks_cancellation_inside_batches():
    rows = [
        {
            "replication_index": 0,
            "replication_id": "R0",
            "scalar_metrics": {"inpatient_waiting_patient_hours": 0},
            "series": [{"elapsed_minutes": i, "occupied": i} for i in range(200)],
        }
    ]
    calls = 0

    def cancel():
        nonlocal calls
        calls += 1
        return calls == 5

    with pytest.raises(surge_engine.SimulationCancelled):
        aggregate_results(rows, cancel_check=cancel)
    assert calls == 5
    with pytest.raises(worker.Cancelled):
        worker.period_aggregation([{"daily": []}], "week", cancel_check=lambda: True)
