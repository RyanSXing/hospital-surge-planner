"""Durable queue dispatcher and isolated simulation/export jobs.

PostgreSQL/SQLite job rows form the transactional outbox and source of truth.
Redis/RQ is used when configured; local development launches bounded subprocesses.
"""

from __future__ import annotations

import copy
import csv
import io
import json
import logging
import multiprocessing
import os
import resource
import subprocess
import sys
import threading
import time
import zipfile
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import and_, or_, select, update

from .artifacts import ArtifactStore
from .db import Document, Job, canonical, digest, make_database, now
from .domain import date


def execution_started():
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return (time.perf_counter(), time.process_time(), children.ru_utime + children.ru_stime)


def execution_metrics(start):
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    memory_scale = 1 if sys.platform == "darwin" else 1024
    return {
        "wall_seconds": max(0, time.perf_counter() - start[0]),
        "cpu_seconds": max(0, time.process_time() - start[1]),
        "terminated_children_cpu_seconds": max(0, children.ru_utime + children.ru_stime - start[2]),
        "process_peak_rss_bytes": int(own.ru_maxrss * memory_scale),
        "largest_terminated_child_peak_rss_bytes": int(children.ru_maxrss * memory_scale),
        "cpu_scope": "current process plus separately reported terminated child CPU",
        "memory_scope": "process-lifetime high-water RSS, not an incremental allocation or sum of child peaks",
    }


def timed_replication(dataset, scenario, index, *, keep_trace=False, cancel_check=None):
    from surge_engine import run_replication

    started = execution_started()
    try:
        result = run_replication(
            dataset, scenario, replication_index=index, keep_trace=keep_trace, cancel_check=cancel_check
        )
    except Exception as exc:
        exc.execution_metrics = execution_metrics(started)
        raise
    result["execution_metrics"] = execution_metrics(started)
    return result


def log_job_metrics(identity, kind, status, metrics):
    logger = logging.getLogger("surge_api.requests")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.propagate = False
    logger.info(
        json.dumps(
            {"event": "job_execution", "job_id": identity, "kind": kind, "status": status, **metrics},
            separators=(",", ":"),
        )
    )


class Cancelled(Exception):
    pass


def job_control(Session, identity):
    deadline = time.monotonic() + int(os.getenv("JOB_TIMEOUT_SECONDS", "7200"))
    last = 0.0
    cancelled = False

    def check():
        nonlocal last, cancelled
        if time.monotonic() > deadline:
            raise TimeoutError("Job exceeded the configured timeout")
        if time.monotonic() - last > 0.25:
            with Session() as session:
                cancelled = bool(session.get(Job, identity).cancelled)
            last = time.monotonic()
        if cancelled:
            raise Cancelled()
        return False

    return check


def _replication_initializer(dataset, scenario, stop):
    global _pool_dataset, _pool_scenario, _pool_stop
    _pool_dataset = dataset
    _pool_scenario = scenario
    _pool_stop = stop
    parent = os.getppid()

    def stop_orphan():
        # Pool children only compute pure results. A dead worker must not leave
        # expensive simulations competing with its durable replacement job.
        while os.getppid() == parent:
            time.sleep(0.5)
        os._exit(0)

    threading.Thread(target=stop_orphan, daemon=True).start()


def _replication_task(index):
    return timed_replication(_pool_dataset, _pool_scenario, index, cancel_check=_pool_stop.is_set)


def execute_job(identity, database_url=None):
    started = execution_started()
    engine, Session = make_database(database_url)
    with Session.begin() as session:
        claimed = session.execute(
            update(Job)
            .where(
                Job.id == identity,
                or_(
                    Job.status == "QUEUED",
                    and_(Job.status.in_(["RUNNING", "AGGREGATING"]), Job.lease_until < time.time()),
                ),
            )
            .values(status="RUNNING", lease_until=time.time() + 120, attempts=Job.attempts + 1)
        )
        if claimed.rowcount != 1:
            return
        job = session.get(Job, identity)
        if job.cancelled:
            job.status = "CANCELLED"
            job.completed_at = now()
            job.result = {**(job.result or {}), "execution_metrics": execution_metrics(started)}
            log_job_metrics(identity, job.kind, job.status, job.result["execution_metrics"])
            return
        kind = job.kind
    stopped = threading.Event()

    def heartbeat():
        while not stopped.wait(10):
            with Session.begin() as session:
                session.execute(
                    update(Job)
                    .where(Job.id == identity, Job.status.in_(["RUNNING", "AGGREGATING", "CANCEL_REQUESTED"]))
                    .values(lease_until=time.time() + 120)
                )

    beat = threading.Thread(target=heartbeat, daemon=True)
    beat.start()
    try:
        if kind == "run":
            run_job(identity, Session)
        elif kind == "export":
            export_job(identity, Session)
        elif kind == "trace":
            trace_job(identity, Session)
        else:
            raise ValueError("Unknown job kind")
    except Exception as exc:  # noqa: BLE001 - persist a terminal status at the isolated job boundary.
        cancelled = isinstance(exc, Cancelled) or type(exc).__name__ == "SimulationCancelled"
        with Session.begin() as session:
            job = session.get(Job, identity)
            job.status = "CANCELLED" if cancelled or job.cancelled else "FAILED"
            job.error = None if cancelled else f"{type(exc).__name__}: {str(exc)[:1000]}"
            job.completed_at = now()
            job.lease_until = 0
    finally:
        stopped.set()
        measured = execution_metrics(started)
        with Session.begin() as session:
            job = session.get(Job, identity)
            if job:
                job.result = {**(job.result or {}), "execution_metrics": measured}
                log_job_metrics(identity, kind, job.status, measured)
        engine.dispose()


def run_job(identity, Session):
    from surge_engine import aggregate_results

    store = ArtifactStore()
    with Session() as session:
        job = session.get(Job, identity)
        payload = copy.deepcopy(job.payload)
        workspace = job.workspace_id
        created_at = job.created_at
        dataset = copy.deepcopy(session.get(Document, payload["dataset_version_id"]).data)
        scenario = payload["scenario"]
        if digest({"dataset": dataset, "scenario": scenario}) != payload["input_sha256"]:
            raise ValueError("Frozen input checksum mismatch")
    last_check = 0.0
    is_cancelled = False
    deadline = time.monotonic() + int(os.getenv("JOB_TIMEOUT_SECONDS", "7200"))

    def cancel_check():
        nonlocal last_check, is_cancelled
        if time.monotonic() > deadline:
            raise TimeoutError("Simulation exceeded the configured job timeout")
        if time.monotonic() - last_check > 0.25:
            with Session() as session:
                is_cancelled = bool(session.get(Job, identity).cancelled)
            last_check = time.monotonic()
        return is_cancelled

    results_by_index = {}
    with Session() as session:
        saved_reps = list(
            session.scalars(
                select(Document).where(
                    Document.workspace_id == workspace,
                    Document.kind == "replication",
                    Document.data["run_group_id"].as_string() == identity,
                )
            )
        )
        for saved in saved_reps:
            if saved.data.get("aggregate_artifact"):
                results_by_index[saved.data["replication_index"]] = store.get_json(
                    saved.data["aggregate_artifact"]
                )

    def persist_result(index, result):
        replication_id = f"{identity}_rep_{index:04d}"
        result.update(replication_id=replication_id, replication_index=index)
        for key in ("events", "checkpoints", "patients", "ledger_snapshots"):
            result.pop(key, None)
        artifact = store.put_json(workspace, identity, f"replication-{index}", result)
        results_by_index[index] = result
        with Session.begin() as session:
            existing = session.get(Document, replication_id)
            value = {
                "id": replication_id,
                "replication_id": replication_id,
                "run_group_id": identity,
                "replication_index": index,
                "seed": result.get("seed"),
                "scalar_metrics": result["scalar_metrics"],
                "execution_metrics": result.get("execution_metrics", {}),
                "status": "SUCCEEDED",
                "aggregate_artifact": artifact,
            }
            if existing:
                existing.data = value
            else:
                session.add(
                    Document(id=replication_id, workspace_id=workspace, kind="replication", data=value)
                )
            job = session.get(Job, identity)
            job.completed = len(results_by_index)
            if job.cancelled:
                raise Cancelled()

    def persist_failure(index, error):
        replication_id = f"{identity}_rep_{index:04d}"
        with Session.begin() as session:
            row = session.get(Document, replication_id)
            value = {
                "id": replication_id,
                "replication_id": replication_id,
                "run_group_id": identity,
                "replication_index": index,
                "status": "CANCELLED"
                if isinstance(error, Cancelled) or type(error).__name__ == "SimulationCancelled"
                else "FAILED",
                "error_category": type(error).__name__,
                "execution_metrics": getattr(error, "execution_metrics", {}),
            }
            if row:
                row.data = value
            else:
                session.add(
                    Document(id=replication_id, workspace_id=workspace, kind="replication", data=value)
                )

    pending_indices = [i for i in range(scenario["replications"]) if i not in results_by_index]
    workers = max(1, min(4, int(os.getenv("SIMULATION_WORKERS", str(min(4, os.cpu_count() or 1))))))
    if workers == 1 or len(pending_indices) < 5:
        for index in pending_indices:
            if cancel_check():
                raise Cancelled()
            try:
                result = timed_replication(dataset, scenario, index, cancel_check=cancel_check)
            except Exception as exc:
                persist_failure(index, exc)
                raise
            persist_result(index, result)
    else:
        spawn = multiprocessing.get_context("spawn")
        halt = spawn.Event()
        pool = ProcessPoolExecutor(
            max_workers=workers,
            mp_context=spawn,
            initializer=_replication_initializer,
            initargs=(dataset, scenario, halt),
        )
        pending = {}
        indices = iter(pending_indices)

        def submit_next():
            index = next(indices, None)
            if index is not None:
                pending[pool.submit(_replication_task, index)] = index

        try:
            for _ in range(workers):
                submit_next()
            while pending:
                if cancel_check():
                    raise Cancelled()
                ready, _ = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
                for future in ready:
                    index = pending.pop(future)
                    try:
                        result = future.result()
                    except Exception as exc:
                        persist_failure(index, exc)
                        raise
                    persist_result(index, result)
                    submit_next()
        finally:
            halt.set()
            pool.shutdown(wait=True, cancel_futures=True)
    results = [results_by_index[i] for i in range(scenario["replications"])]
    with Session.begin() as session:
        job = session.get(Job, identity)
        job.status = "AGGREGATING"
    aggregate = aggregate_results(results, scenario=scenario)
    selected = aggregate.get("selected_replication_index", 0)
    selected_id = f"{identity}_rep_{selected:04d}"
    if cancel_check():
        raise Cancelled()
    trace = timed_replication(dataset, scenario, selected, keep_trace=True, cancel_check=cancel_check)
    trace.update(
        replication_id=selected_id,
        replication_index=selected,
        run_group_id=identity,
        start_at=scenario["start_at"],
    )
    for event in trace.get("events", []):
        event.update(run_group_id=identity, replication_id=selected_id, replication_index=selected)
    trace_artifact = store.put_json(workspace, identity, "selected-trace", trace)
    from .comparisons import compact_summary

    aggregate["comparison_summary"] = compact_summary(results)
    aggregate["periods"] = {grain: period_aggregation(results, grain) for grain in ("week", "month")}
    aggregate_artifact = store.put_json(workspace, identity, "aggregate", aggregate)
    replications_artifact = store.put_json(workspace, identity, "replications", results)
    inputs_artifact = store.put_json(
        workspace, identity, "inputs", {"dataset": dataset, "scenario": scenario}
    )
    manifest = {
        "schema_version": "1.0",
        "run_group_id": identity,
        "workspace_id": workspace,
        "dataset_version_id": payload["dataset_version_id"],
        "scenario_revision_id": payload["scenario_revision_id"],
        "model_version": trace.get("model_version", payload["model_version"]),
        "code_commit": os.getenv("CODE_COMMIT", "local-working-tree"),
        "input_sha256": payload["input_sha256"],
        "generator_version": dataset.get("manifest", {}).get("generator_version", "synthetic-demo-1.0.0"),
        "timezone": scenario["timezone"],
        "start_at": scenario["start_at"],
        "end_at": trace["end_at"],
        "created_at": created_at,
        "replications_requested": scenario["replications"],
        "replications_completed": len(results),
        "seed_policy": "keyed-streams-v1",
        "base_seed": scenario["base_seed"],
        "selected_replication_id": selected_id,
        "selected_replication_index": selected,
        "status": "SUCCEEDED",
        "data_origin": "synthetic" if dataset.get("synthetic", True) else "user-supplied",
        "artifacts": [aggregate_artifact, replications_artifact, trace_artifact, inputs_artifact],
        "completed_at": now(),
        "warnings": aggregate.get("warnings", []),
    }
    with Session.begin() as session:
        rep = session.get(Document, selected_id)
        rep.data = {
            **rep.data,
            "trace_artifact": trace_artifact,
            "selected": True,
            "trace_execution_metrics": trace.get("execution_metrics", {}),
        }
        job = session.get(Job, identity)
        if job.cancelled:
            raise Cancelled()
        job.result = {
            "aggregate_artifact": aggregate_artifact,
            "replications_artifact": replications_artifact,
            "inputs_artifact": inputs_artifact,
            "selected_replication_id": selected_id,
            "manifest": manifest,
            "warnings": aggregate.get("warnings", []),
        }
        job.status = "SUCCEEDED"
        job.completed_at = now()
        job.lease_until = 0


def csv_bytes(rows):
    if not rows:
        return b""
    keys = list(dict.fromkeys(key for row in rows for key in row))
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=keys)
    writer.writeheader()
    for row in rows:
        safe = {}
        for key, value in row.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, separators=(",", ":"))
            if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
                value = "'" + value
            safe[key] = value
        writer.writerow(safe)
    return output.getvalue().encode()


def trace_job(identity, Session):
    store = ArtifactStore()
    with Session() as session:
        job = session.get(Job, identity)
        replication = session.get(Document, job.payload["replication_id"])
        run = session.get(Job, job.payload["run_group_id"])
        if not replication or not run or run.workspace_id != job.workspace_id or run.status != "SUCCEEDED":
            raise ValueError("Trace requires a completed owned replication")
        dataset = copy.deepcopy(session.get(Document, run.payload["dataset_version_id"]).data)
        scenario = copy.deepcopy(run.payload["scenario"])
        index = replication.data["replication_index"]
        replication_id = replication.id
        workspace = job.workspace_id
        run_id = run.id
    check = job_control(Session, identity)
    check()
    trace = timed_replication(dataset, scenario, index, keep_trace=True, cancel_check=check)
    trace.update(
        replication_id=replication_id,
        replication_index=index,
        run_group_id=run_id,
        start_at=scenario["start_at"],
    )
    for event in trace.get("events", []):
        event.update(run_group_id=run_id, replication_id=replication_id, replication_index=index)
    artifact = store.put_json(workspace, run_id, f"trace-{index}", trace)
    check()
    with Session.begin() as session:
        replication = session.get(Document, replication_id)
        refreshed = {
            **replication.data,
            "trace_artifact": artifact,
            "trace_execution_metrics": trace.get("execution_metrics", {}),
            "trace_generated_at": now(),
        }
        refreshed.pop("trace_expired_at", None)
        refreshed.pop("retention_purged_at", None)
        replication.data = refreshed
        job = session.get(Job, identity)
        job.status = "SUCCEEDED"
        job.completed = 1
        job.completed_at = now()
        job.result = {"trace_artifact": artifact}
        job.lease_until = 0


def export_job(identity, Session):
    store = ArtifactStore()
    check = job_control(Session, identity)
    check()
    with Session() as session:
        job = session.get(Job, identity)
        payload = copy.deepcopy(job.payload)
        workspace = job.workspace_id
        data = {}
        files = {}
        if payload.get("run_group_id"):
            run = session.get(Job, payload["run_group_id"])
            if not run or run.workspace_id != workspace or run.status != "SUCCEEDED":
                raise ValueError("A completed run is required for export")
            inputs = store.get_json(run.result["inputs_artifact"])
            metrics = store.get_json(run.result["aggregate_artifact"])
            manifest = copy.deepcopy(run.result["manifest"])
            data = {**inputs, "metrics": metrics, "manifest": manifest}
            selected = payload.get("replication_id") or run.result["selected_replication_id"]
            manifest["export_replication_id"] = selected
            manifest["export_includes_events"] = payload.get("include_events", True)
            if payload.get("include_events", True):
                replication = session.get(Document, selected)
                if (
                    not replication
                    or replication.workspace_id != workspace
                    or replication.data.get("run_group_id") != run.id
                ):
                    raise ValueError("Export replication does not belong to this run")
                trace_meta = replication.data.get("trace_artifact")
                if trace_meta:
                    trace = store.get_json(trace_meta)
                else:
                    from surge_engine import run_replication

                    trace = run_replication(
                        inputs["dataset"],
                        inputs["scenario"],
                        replication_index=replication.data["replication_index"],
                        keep_trace=True,
                        cancel_check=check,
                    )
                    for event in trace.get("events", []):
                        event.update(run_group_id=run.id, replication_id=selected)
                files["events.csv"] = csv_bytes(trace.get("events", []))
                files["events.jsonl"] = (
                    b"\n".join(canonical(event) for event in trace.get("events", [])) + b"\n"
                )
            files["daily.csv"] = csv_bytes(metrics.get("daily", []))
            files["metrics.csv"] = files["daily.csv"]
            files["manifest.json"] = canonical(manifest)
            files["model-manifest.json"] = canonical(manifest)
        else:
            if payload.get("scenario_revision_id"):
                revision = session.get(Document, payload["scenario_revision_id"])
                if not revision or revision.workspace_id != workspace:
                    raise ValueError("Export revision not found")
                scenario = revision.data
                dataset = session.get(Document, scenario["dataset_version_id"])
                data = {"scenario": scenario, "dataset": dataset.data}
            else:
                dataset = session.get(Document, payload["dataset_version_id"])
                if not dataset or dataset.workspace_id != workspace:
                    raise ValueError("Export dataset not found")
                data = {"dataset": dataset.data}
        format = payload.get("format", "zip")
        if payload.get("comparison_snapshot"):
            data["comparison"] = payload["comparison_snapshot"]
            files["comparison.csv"] = csv_bytes(payload["comparison_snapshot"]["plans"])
            files["comparison.json"] = canonical(payload["comparison_snapshot"])
        if format == "json":
            raw = canonical(data)
            name = "hospital-surge-planner.json"
            media = "application/json"
        elif format == "csv":
            raw = files.get("daily.csv") or csv_bytes(data["dataset"].get("patients", []))
            name = "hospital-surge-planner.csv"
            media = "text/csv"
        else:
            files["dataset.json"] = canonical(data["dataset"])
            if data.get("scenario"):
                files["scenario.json"] = canonical(data["scenario"])
            if data.get("metrics"):
                files["metrics.json"] = canonical(data["metrics"])
            for collection in [
                "patients",
                "facilities",
                "units",
                "slots",
                "staff",
                "assignments",
                "equipment_pools",
                "routes",
                "vehicles",
            ]:
                files[f"inputs/{collection}.csv"] = csv_bytes(data["dataset"].get(collection, []))
            files["dataset-manifest.json"] = canonical(data["dataset"].get("manifest", {}))
            files["manifest.json"] = canonical(
                {
                    "schema_version": "1.0",
                    "dataset_version_id": data["dataset"]["id"],
                    "files": [
                        {
                            "name": "dataset.json",
                            "sha256": __import__("hashlib").sha256(files["dataset.json"]).hexdigest(),
                            "row_count": 1,
                        }
                    ],
                }
            )
            origin = "synthetic" if data["dataset"].get("synthetic", True) else "user-supplied"
            files["assumptions.csv"] = csv_bytes(
                [
                    {"assumption": str(a), "data_origin": origin}
                    for a in data["dataset"].get("assumptions", [])
                ]
            )
            files["README.md"] = (
                f"# Hospital Surge Planner\n\nDataset origin: {origin}. Model is not clinically validated.\nUse dataset.json for exact round-trip import. Scenario and result metadata preserve seed, versions and hashes.\n\nWaiting is integrated over event intervals in patient-hours. Daily buckets use America/Chicago local-calendar boundaries, including daylight-saving transitions. Replication percentiles summarize conditional simulation uncertainty; they are not validated prediction intervals.\n"
            ).encode()
            files["checksums.json"] = canonical(
                {name: __import__("hashlib").sha256(content).hexdigest() for name, content in files.items()}
            )
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                for filename, content in files.items():
                    check()
                    archive.writestr(filename, content)
            raw = buffer.getvalue()
            name = "hospital-surge-planner.zip"
            media = "application/zip"
    artifact = store.write(workspace, identity, name, raw, media)
    check()
    with Session.begin() as session:
        job = session.get(Job, identity)
        job.result = {"artifact": artifact}
        job.completed = 1
        job.status = "SUCCEEDED"
        job.completed_at = now()
        job.lease_until = 0


def period_aggregation(replications, grain):
    """Aggregate each trajectory first; only then calculate ensemble percentiles."""
    import numpy as np

    per_rep = []
    metadata = {}
    for replication in replications:
        groups = defaultdict(list)
        for row in replication.get("daily", []):
            day = datetime.fromisoformat(row["local_date"]).date()
            key = (
                (day - timedelta(days=day.weekday())).isoformat()
                if grain == "week"
                else day.replace(day=1).isoformat()
            )
            groups[key].append(row)
        result = {}
        for key, rows in groups.items():
            numeric = {
                k
                for row in rows
                for k, v in row.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            }
            metrics = {}
            for metric in numeric:
                valid_rows = [row for row in rows if row.get(metric) is not None]
                values = [row[metric] for row in valid_rows]
                if not values:
                    metrics[metric] = None
                    continue
                if "peak" in metric or metric.startswith("max_"):
                    metrics[metric] = max(values)
                elif (
                    "hours" in metric
                    or "arrivals" in metric
                    or "departures" in metric
                    or "discharges" in metric
                    or "transfers" in metric
                ):
                    metrics[metric] = sum(values)
                elif metric.endswith("_start") or "_start_" in metric:
                    metrics[metric] = values[0]
                elif metric.endswith("_end") or "_end_" in metric:
                    metrics[metric] = values[-1]
                else:
                    durations = [
                        (date(r["end_at"]) - date(r["start_at"])).total_seconds() for r in valid_rows
                    ]
                    metrics[metric] = sum(v * d for v, d in zip(values, durations)) / sum(durations)
            for care in ("ward", "icu", "ed"):
                denominator = metrics.get(f"{care}_staffed_hours", 0)
                metrics[f"{care}_utilization"] = (
                    metrics.get(f"{care}_occupied_hours", 0) / denominator if denominator else None
                )
            result[key] = metrics
            metadata[key] = {
                "local_date": key,
                "start_at": rows[0]["start_at"],
                "end_at": rows[-1]["end_at"],
                "days": len(rows),
                "partial": len(rows)
                < (
                    7
                    if grain == "week"
                    else __import__("calendar").monthrange(int(key[:4]), int(key[5:7]))[1]
                ),
            }
        per_rep.append(result)
    output = []
    for key, meta in sorted(metadata.items()):
        keys = set().union(*(rep.get(key, {}) for rep in per_rep))
        item = {**meta}
        for metric in keys:
            values = [
                rep[key][metric]
                for rep in per_rep
                if key in rep and metric in rep[key] and rep[key][metric] is not None
            ]
            if not values:
                item[metric] = {"p10": None, "p50": None, "p90": None, "mean": None}
                continue
            item[metric] = {
                "p10": float(np.percentile(values, 10)),
                "p50": float(np.median(values)),
                "p90": float(np.percentile(values, 90)),
                "mean": float(np.mean(values)),
            }
        output.append(item)
    return output


def dispatch_loop(Session, stop, database_url):
    processes = {}
    while not stop.is_set():
        try:
            for identity, process in list(processes.items()):
                if process.poll() is not None:
                    processes.pop(identity)
            with Session.begin() as session:
                expired = list(
                    session.scalars(
                        select(Job).where(
                            Job.status.in_(["RUNNING", "AGGREGATING", "CANCEL_REQUESTED"]),
                            Job.lease_until < time.time(),
                        )
                    )
                )
                for job in expired:
                    if job.cancelled:
                        job.status = "CANCELLED"
                        job.completed_at = now()
                    elif job.attempts >= 3:
                        job.status = "FAILED"
                        job.error = "Worker lease expired after two recovery attempts"
                        job.completed_at = now()
                    else:
                        job.status = "QUEUED"
                        job.dispatched = False
                for waiting in session.scalars(
                    select(Job).where(
                        Job.status == "QUEUED", Job.dispatched == True, Job.lease_until < time.time()
                    )
                ):
                    waiting.dispatched = False
                jobs = list(
                    session.scalars(
                        select(Job)
                        .where(Job.status == "QUEUED", Job.dispatched == False)
                        .order_by(Job.created_at)
                        .limit(20)
                    )
                )
                for job in jobs:
                    if job.cancelled:
                        job.status = "CANCELLED"
                        continue
                    if os.getenv("REDIS_URL"):
                        from redis import Redis
                        from rq import Queue

                        queue = Queue("hospital-surge", connection=Redis.from_url(os.environ["REDIS_URL"]))
                        queue_id = f"{job.id}-attempt-{job.attempts}"
                        existing = queue.fetch_job(queue_id)
                        if existing is None or existing.get_status() not in {
                            "queued",
                            "started",
                            "deferred",
                            "scheduled",
                        }:
                            queue.enqueue(
                                "surge_api.worker.execute_job",
                                job.id,
                                database_url,
                                job_id=queue_id,
                                job_timeout=int(os.getenv("JOB_TIMEOUT_SECONDS", "7200")),
                                result_ttl=86400,
                            )
                        job.dispatched = True
                        job.lease_until = time.time() + 120
                    elif len(processes) < int(os.getenv("WORKER_CONCURRENCY", "2")):
                        environment = {**os.environ, "DATABASE_URL": database_url}
                        root = Path(__file__).resolve().parents[3]
                        environment["PYTHONPATH"] = os.pathsep.join(
                            [
                                str(root / "apps/api"),
                                str(root / "packages/engine"),
                                environment.get("PYTHONPATH", ""),
                            ]
                        )
                        processes[job.id] = subprocess.Popen(
                            [sys.executable, "-m", "surge_api.worker", "--once", job.id], env=environment
                        )
                        job.dispatched = True
                        job.lease_until = time.time() + 120
        except Exception as exc:  # noqa: BLE001 - durable dispatcher retries dependency outages.
            logging.getLogger("surge_api.requests").warning(
                json.dumps({"event": "dispatcher_error", "error_category": type(exc).__name__})
            )
        stop.wait(2)


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--once":
        execute_job(sys.argv[2])
        return
    if os.getenv("REDIS_URL"):
        from redis import Redis
        from rq import Worker

        connection = Redis.from_url(os.environ["REDIS_URL"])
        Worker(["hospital-surge"], connection=connection).work()
    else:
        engine, Session = make_database()
        try:
            dispatch_loop(Session, threading.Event(), engine.url.render_as_string(hide_password=False))
        finally:
            engine.dispose()


if __name__ == "__main__":
    main()
