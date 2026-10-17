"""Read-only pool startup diagnostic using a completed job's frozen inputs."""

import os

for key in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[key] = "1"

import argparse
import copy
import json
import multiprocessing as mp
import pickle
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from surge_api.worker import _replication_initializer

_barrier = None


def init_inline(dataset, scenario, stop, barrier):
    global _barrier
    _replication_initializer(dataset, scenario, stop)
    _barrier = barrier


def init_file(path, stop, barrier):
    with open(path, "rb") as stream:
        dataset, scenario = pickle.load(stream)
    init_inline(dataset, scenario, stop, barrier)


def ready(index):
    _barrier.wait(timeout=90)
    return os.getpid()


def trial(method, mode, dataset, scenario, payload_path, count):
    context = mp.get_context(method)
    stop = context.Event()
    barrier = context.Barrier(count)
    initializer = init_inline if mode == "inline" else init_file
    args = (dataset, scenario, stop, barrier) if mode == "inline" else (str(payload_path), stop, barrier)
    started = time.perf_counter()
    cpu = time.process_time()
    with ProcessPoolExecutor(
        max_workers=count, mp_context=context, initializer=initializer, initargs=args
    ) as pool:
        futures = [pool.submit(ready, index) for index in range(count)]
        pids = [future.result(timeout=100) for future in futures]
        ready_seconds = time.perf_counter() - started
        parent_cpu = time.process_time() - cpu
    return {
        "method": method,
        "inputs": mode,
        "workers": count,
        "ready_seconds": ready_seconds,
        "parent_cpu_seconds": parent_cpu,
        "including_shutdown_seconds": time.perf_counter() - started,
        "distinct_children": len(set(pids)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    from surge_api.artifacts import ArtifactStore
    from surge_api.db import Document, Job, digest, make_database

    timings = {}
    started = time.perf_counter()
    ArtifactStore()
    timings["artifact_store_cold_init_seconds"] = time.perf_counter() - started
    started = time.perf_counter()
    engine, Session = make_database()
    with Session() as session:
        job = session.get(Job, args.job_id)
        if not job or job.status != "SUCCEEDED":
            raise RuntimeError("Completed source job required")
        dataset = session.get(Document, job.payload["dataset_version_id"]).data
        scenario = job.payload["scenario"]
        expected = job.payload["input_sha256"]
    engine.dispose()
    timings["database_load_seconds"] = time.perf_counter() - started
    started = time.perf_counter()
    dataset, scenario = copy.deepcopy(dataset), copy.deepcopy(scenario)
    timings["deepcopy_seconds"] = time.perf_counter() - started
    started = time.perf_counter()
    assert digest({"dataset": dataset, "scenario": scenario}) == expected
    timings["digest_seconds"] = time.perf_counter() - started
    mp.set_forkserver_preload(["surge_engine", "numpy"])
    report = {
        "scope": "Read-only frozen-input startup diagnostic; no simulations, jobs or artifacts written",
        "source_job": args.job_id,
        "code_commit": os.getenv("CODE_COMMIT"),
        "timings": timings,
        "trials": [],
    }
    with tempfile.TemporaryDirectory(prefix="pool-diagnostic-") as folder:
        payload_path = Path(folder) / "inputs.pickle"
        started = time.perf_counter()
        with payload_path.open("wb") as stream:
            os.chmod(payload_path, 0o600)
            pickle.dump((dataset, scenario), stream, protocol=pickle.HIGHEST_PROTOCOL)
        timings["private_pickle_write_seconds"] = time.perf_counter() - started
        report["pickle_bytes"] = payload_path.stat().st_size
        for method, mode in (
            ("spawn", "inline"),
            ("spawn", "file"),
            ("forkserver", "inline"),
            ("forkserver", "file"),
        ):
            result = trial(method, mode, dataset, scenario, payload_path, args.workers)
            report["trials"].append(result)
            print(json.dumps({"progress": result}), flush=True)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
