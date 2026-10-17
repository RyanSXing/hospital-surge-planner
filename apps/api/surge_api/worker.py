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
import pickle
import re
import resource
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import DBAPIError

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


class LeaseLost(Exception):
    """This attempt may compute but may never publish another durable change."""


def artifact_keys(value):
    if isinstance(value, dict):
        if isinstance(value.get("object_key"), str):
            yield value["object_key"]
        for item in value.values():
            yield from artifact_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from artifact_keys(item)


class AttemptArtifactStore(ArtifactStore):
    def __init__(self, uploads):
        super().__init__()
        self.uploads = uploads

    def write(self, workspace, owner, name, data, media_type="application/json"):
        artifact = super().write(workspace, owner, name, data, media_type)
        self.uploads.pending[artifact["object_key"]] = (workspace, owner, artifact)
        return artifact


class PendingUploads:
    """Track this attempt's new objects until their fenced transaction commits.

    Unknown upload outcomes, process death and cleanup outages are handled by
    the age-based orphan collector. Never delete on an unavailable DB check:
    a commit may have succeeded even when its acknowledgment was lost.
    """

    def __init__(self, Session, identity):
        self.Session = Session
        self.identity = identity
        self.pending = {}
        self._store = None

    @property
    def store(self):
        if self._store is None:
            self._store = AttemptArtifactStore(self)
        return self._store

    def retain(self, *artifacts):
        # Call only after exiting the publishing Session.begin() successfully.
        for artifact in artifacts:
            self.pending.pop(artifact["object_key"], None)

    def cleanup(self):
        if not self.pending:
            return
        try:
            workspaces = {entry[0] for entry in self.pending.values()}
            owners = {entry[1] for entry in self.pending.values()}
            with self.Session.begin() as session:
                # Serialize with a commit whose network acknowledgment was
                # lost. A plain SELECT could observe its pre-commit snapshot
                # while the server is still finishing the publication.
                resolved = session.execute(
                    update(Job)
                    .where(Job.id == self.identity)
                    .values(lease_until=Job.lease_until)
                    .execution_options(synchronize_session=False)
                )
                if resolved.rowcount != 1:
                    raise LeaseLost()
                # Worker outputs are published only in their owning job result
                # or replication documents. Include the trace job itself and
                # its parent run, without loading dataset JSON or other jobs.
                values = list(
                    session.scalars(
                        select(Job.result).where(
                            Job.workspace_id.in_(workspaces), Job.id.in_(owners | {self.identity})
                        )
                    )
                )
                values.extend(
                    session.scalars(
                        select(Document.data).where(
                            Document.workspace_id.in_(workspaces),
                            Document.kind == "replication",
                            Document.data["run_group_id"].as_string().in_(owners),
                        )
                    )
                )
                referenced = set(artifact_keys(values))
        except Exception as exc:  # noqa: BLE001 - failed verification must preserve uncertain commits.
            self._deferred(exc)
            return
        for key, (_, _, artifact) in list(self.pending.items()):
            if key not in referenced:
                try:
                    self.store.delete(artifact)
                except Exception as exc:  # noqa: BLE001 - age-based collection retries storage outages.
                    self._deferred(exc)
                    continue
            self.pending.pop(key, None)

    def _deferred(self, exc):
        logging.getLogger("surge_api.requests").warning(
            json.dumps(
                {
                    "event": "artifact_cleanup_deferred",
                    "job_id": self.identity,
                    "pending_count": len(self.pending),
                    "error_category": type(exc).__name__,
                }
            )
        )


@dataclass(frozen=True)
class AttemptToken:
    attempt: int
    generation: int
    attempt_base: int

    @property
    def generation_attempt(self):
        return self.attempt - self.attempt_base


def retry_generation(job):
    return job.result.get("retry_generation", {"number": 0, "attempt_base": 0})


def attempt_predicate(identity, token):
    return and_(
        Job.id == identity,
        Job.attempts == token.attempt,
        func.coalesce(Job.result["retry_generation"]["number"].as_integer(), 0) == token.generation,
    )


def lock_attempt(session, identity, token, *, active=True, allow_cancelled=False):
    """Fence and lock the job before any document/job mutation in this transaction.

    The conditional no-op UPDATE is a real write lock on both PostgreSQL and
    SQLite (where SELECT FOR UPDATE is ignored). A takeover cannot commit until
    this transaction finishes, and a previous owner cannot pass the predicate.
    External objects have unique immutable keys; only a fenced transaction may
    publish their references. Attempt cleanup removes unpublished uploads.
    """
    predicate = attempt_predicate(identity, token)
    if active:
        predicate = and_(
            predicate,
            Job.status.in_(["RUNNING", "AGGREGATING", "CANCEL_REQUESTED"]),
            Job.lease_until > time.time(),
        )
    locked = session.execute(
        update(Job)
        .where(predicate)
        .values(lease_until=Job.lease_until)
        .execution_options(synchronize_session=False)
    )
    if locked.rowcount != 1:
        raise LeaseLost()
    job = session.get(Job, identity, populate_existing=True)
    if job.cancelled and not allow_cancelled:
        raise Cancelled()
    return job


def check_attempt(job, token):
    generation = retry_generation(job)
    if (
        job.attempts != token.attempt
        or generation["number"] != token.generation
        or job.status not in {"RUNNING", "AGGREGATING", "CANCEL_REQUESTED"}
        or job.lease_until <= time.time()
    ):
        raise LeaseLost()
    if job.cancelled:
        raise Cancelled()


def result_with_generation(job, result):
    return {**result, "retry_generation": retry_generation(job)}


def transient_failure(exc):
    """Classify dependency failures, never arbitrary model/programming errors.

    A configured job deadline is a builtin TimeoutError and deliberately does
    not qualify. OCI's wrapper retains the original network exception in args.
    Authentication, certificates, missing objects, and invalid SQL are terminal.
    """
    from oci._vendor.requests import exceptions as network
    from oci.exceptions import RequestException, ServiceError

    if isinstance(exc, ServiceError):
        if exc.status in {408, 429} or 500 <= exc.status < 600 and exc.status != 501:
            return "storage_service_unavailable"
        if exc.status == 409 and exc.code in {"IncorrectState", "LockConflict"}:
            return "storage_service_conflict"
    if isinstance(exc, RequestException) and exc.args and isinstance(exc.args[0], Exception):
        exc = exc.args[0]
    if isinstance(exc, network.SSLError):
        return None
    if isinstance(exc, (network.ConnectionError, network.Timeout)):
        return "storage_connection_unavailable"
    if isinstance(exc, DBAPIError):
        original = exc.orig
        sqlstate = getattr(original, "sqlstate", None) or getattr(original, "pgcode", None) or ""
        if (
            exc.connection_invalidated
            or sqlstate.startswith("08")
            or sqlstate in {"40001", "40P01", "57P01", "57P02", "57P03", "53300"}
        ):
            return "database_temporarily_unavailable"
        if not sqlstate and any(
            message in str(original).lower()
            for message in (
                "connection refused",
                "connection timed out",
                "server closed the connection unexpectedly",
                "connection is closed",
                "connection not open",
                "temporary failure in name resolution",
            )
        ):
            return "database_temporarily_unavailable"
        sqlite_code = getattr(original, "sqlite_errorcode", None)
        if sqlite_code is not None and sqlite_code & 0xFF in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
            return "database_busy"
    return None


def log_persistence_failure(identity, exc):
    # Leave the durable lease to recover after a database outage. Do not send
    # SQL/connection exception text (which can contain credentials) to RQ logs.
    logging.getLogger("surge_api.requests").warning(
        json.dumps(
            {"event": "job_persistence_unavailable", "job_id": identity, "error_category": type(exc).__name__}
        )
    )


def job_control(Session, identity, token):
    deadline = time.monotonic() + int(os.getenv("JOB_TIMEOUT_SECONDS", "7200"))
    last = 0.0

    def check():
        nonlocal last
        if time.monotonic() > deadline:
            raise TimeoutError("Job exceeded the configured timeout")
        if time.monotonic() - last > 0.25:
            with Session() as session:
                check_attempt(session.get(Job, identity), token)
            last = time.monotonic()
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


def _selected_trace_task(index):
    # Pure computation only: artifacts and fenced DB publication stay in parent.
    return timed_replication(
        _pool_dataset, _pool_scenario, index, keep_trace=True, cancel_check=_pool_stop.is_set
    )


def _replication_file_initializer(input_path, stop):
    # This path is produced only by private_replication_pool, never by an API
    # payload. Refuse symlinks, other owners, and group/world-readable files.
    descriptor = os.open(input_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("Pool inputs must be an owned private regular file")
        dataset, scenario = pickle.load(stream)  # Trusted, service-created data in a private directory.
    _replication_initializer(dataset, scenario, stop)


def scavenge_private_inputs(*, root=None, max_entries=512, max_deletions=32):
    """Remove only our private pool inputs belonging to demonstrably dead PIDs.

    SIGKILL bypasses the normal context-manager cleanup. Worker entry retries
    this bounded scan; live/reused PIDs, symlinks, unexpected files, permissions
    and owners are left alone. No user-provided paths reach this operation.
    """
    deleted = 0
    root = Path(root or tempfile.gettempdir())
    try:
        with os.scandir(root) as entries:
            for number, entry in enumerate(entries):
                if number >= max_entries or deleted >= max_deletions:
                    break
                match = re.fullmatch(r"hsp-pool-([1-9][0-9]*)-a[1-9][0-9]*-[a-z0-9_]+", entry.name)
                if not match:
                    continue
                try:
                    try:
                        os.kill(int(match[1]), 0)
                    except ProcessLookupError:
                        pass
                    else:
                        continue
                    descriptor = os.open(entry.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        metadata = os.fstat(descriptor)
                        if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
                            continue
                        names = os.listdir(descriptor)
                        if names not in ([], ["inputs.pickle"]):
                            continue
                        if names:
                            inputs = os.stat("inputs.pickle", dir_fd=descriptor, follow_symlinks=False)
                            if (
                                not stat.S_ISREG(inputs.st_mode)
                                or inputs.st_uid != os.getuid()
                                or stat.S_IMODE(inputs.st_mode) != 0o600
                                or inputs.st_nlink != 1
                            ):
                                continue
                            os.unlink("inputs.pickle", dir_fd=descriptor)
                        os.rmdir(entry.path)
                        deleted += 1
                    finally:
                        os.close(descriptor)
                except (OSError, OverflowError):
                    continue  # Permission failures or another scavenger are harmless.
    except OSError:
        pass
    return deleted


@contextmanager
def private_replication_pool(dataset, scenario, workers, token):
    """Serialize frozen inputs once; spawn children read their own exact copy."""
    spawn = multiprocessing.get_context("spawn")
    halt = spawn.Event()
    with tempfile.TemporaryDirectory(prefix=f"hsp-pool-{os.getpid()}-a{token.attempt}-") as folder:
        input_path = Path(folder) / "inputs.pickle"
        descriptor = os.open(input_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            pickle.dump((dataset, scenario), stream, protocol=pickle.HIGHEST_PROTOCOL)
        pool = ProcessPoolExecutor(
            max_workers=workers,
            mp_context=spawn,
            initializer=_replication_file_initializer,
            initargs=(str(input_path), halt),
        )
        try:
            yield pool
        finally:
            halt.set()
            pool.shutdown(wait=True, cancel_futures=True)


def execute_job(identity, database_url=None):
    started = execution_started()
    scavenge_private_inputs()
    engine, Session = make_database(database_url)
    with Session.begin() as session:
        claimed = session.execute(
            update(Job)
            .where(
                Job.id == identity,
                or_(
                    and_(Job.status == "QUEUED", or_(Job.dispatched == True, Job.lease_until <= time.time())),
                    and_(
                        Job.status.in_(["RUNNING", "AGGREGATING"]),
                        Job.lease_until < time.time(),
                        Job.attempts
                        - func.coalesce(Job.result["retry_generation"]["attempt_base"].as_integer(), 0)
                        < 3,
                    ),
                ),
            )
            .values(
                status="RUNNING",
                lease_until=time.time() + 120,
                attempts=Job.attempts + 1,
                error=None,
                completed_at=None,
            )
        )
        if claimed.rowcount != 1:
            engine.dispose()
            return
        job = session.get(Job, identity)
        if job.cancelled:
            job.status = "CANCELLED"
            job.completed_at = now()
            job.result = {**(job.result or {}), "execution_metrics": execution_metrics(started)}
            log_job_metrics(identity, job.kind, job.status, job.result["execution_metrics"])
            job.lease_until = 0
            job.dispatched = False
            engine.dispose()
            return
        kind = job.kind
        attempt = job.attempts
        generation = retry_generation(job)
        job.result = {**job.result, "retry_generation": generation}
        token = AttemptToken(attempt, generation["number"], generation["attempt_base"])
        attempt_history = list(job.result.get("attempt_history", []))
    stopped = threading.Event()

    def heartbeat():
        while not stopped.wait(10):
            try:
                with Session.begin() as session:
                    session.execute(
                        update(Job)
                        .where(
                            attempt_predicate(identity, token),
                            Job.status.in_(["RUNNING", "AGGREGATING", "CANCEL_REQUESTED"]),
                            Job.lease_until > time.time(),
                        )
                        .values(lease_until=time.time() + 120)
                    )
            except DBAPIError as exc:
                log_persistence_failure(identity, exc)

    beat = threading.Thread(target=heartbeat, daemon=True)
    beat.start()
    failure_category = None
    outcome_committed = False
    uploads = PendingUploads(Session, identity)
    try:
        if kind == "run":
            run_job(identity, Session, token, uploads)
        elif kind == "export":
            export_job(identity, Session, token, uploads)
        elif kind == "trace":
            trace_job(identity, Session, token, uploads)
        else:
            raise ValueError("Unknown job kind")
        outcome_committed = True
    except LeaseLost:
        pass  # The current owner or expired-lease recovery controls this job.
    except Exception as exc:  # noqa: BLE001 - classify failures at the isolated durable job boundary.
        cancelled = isinstance(exc, Cancelled) or type(exc).__name__ == "SimulationCancelled"
        failure_category = transient_failure(exc)
        try:
            with Session.begin() as session:
                job = lock_attempt(session, identity, token, allow_cancelled=True)
                if job.status != "SUCCEEDED":
                    cancelled = cancelled or job.cancelled
                    retry = bool(failure_category and not cancelled and token.generation_attempt < 3)
                    delay = 5 * 2 ** (token.generation_attempt - 1) if retry else 0
                    job.status = "CANCELLED" if cancelled else "QUEUED" if retry else "FAILED"
                    job.error = (
                        None
                        if cancelled
                        else (
                            f"{failure_category}: attempt {token.generation_attempt} of 3 failed; "
                            + (f"retrying in {delay} seconds" if retry else "automatic retries exhausted")
                            if failure_category
                            else f"{type(exc).__name__}: {str(exc)[:1000]}"
                        )
                    )
                    job.completed_at = None if retry else now()
                    job.dispatched = False
                    job.lease_until = time.time() + delay if retry else 0
                    job.result = {
                        **(job.result or {}),
                        "retry": {
                            "automatic": retry,
                            "attempt": token.generation_attempt,
                            "fence_attempt": attempt,
                            "generation": token.generation,
                            "max_attempts": 3,
                            "not_before": job.lease_until if retry else None,
                            "error_category": failure_category or type(exc).__name__,
                        },
                    }
                outcome_committed = True
        except LeaseLost:
            pass
        except DBAPIError as persistence_error:
            log_persistence_failure(identity, persistence_error)
    finally:
        stopped.set()
        measured = execution_metrics(started)
        try:
            if outcome_committed:
                with Session.begin() as session:
                    job = lock_attempt(session, identity, token, active=False, allow_cancelled=True)
                    if job.cancelled:
                        job.status = "CANCELLED"
                        job.error = None
                        job.completed_at = now()
                        job.lease_until = 0
                        job.dispatched = False
                    # Job handlers replace result on success; restore prior
                    # attempt evidence without touching their final artifacts.
                    history = [
                        *attempt_history,
                        {
                            "attempt": attempt,
                            "generation": token.generation,
                            "generation_attempt": token.generation_attempt,
                            "status": job.status,
                            "finished_at": now(),
                            "error_category": failure_category,
                            "execution_metrics": measured,
                        },
                    ]
                    job.result = {
                        **(job.result or {}),
                        "execution_metrics": measured,
                        "attempt_history": history[-3:],
                        "retry_generation": generation,
                    }
                    if job.status == "SUCCEEDED":
                        job.error = None
                        job.result.pop("retry", None)
                    log_job_metrics(identity, kind, job.status, measured)
        except LeaseLost:
            pass
        except DBAPIError as persistence_error:
            log_persistence_failure(identity, persistence_error)
        finally:
            try:
                uploads.cleanup()
            finally:
                engine.dispose()


def run_job(identity, Session, token, uploads):
    from surge_engine import aggregate_results
    from surge_engine.aggregate import representative_replication

    store = uploads.store
    with Session() as session:
        job = session.get(Job, identity)
        check_attempt(job, token)
        payload = copy.deepcopy(job.payload)
        workspace = job.workspace_id
        created_at = job.created_at
        dataset = copy.deepcopy(session.get(Document, payload["dataset_version_id"]).data)
        scenario = payload["scenario"]
        if digest({"dataset": dataset, "scenario": scenario}) != payload["input_sha256"]:
            raise ValueError("Frozen input checksum mismatch")
    cancel_check = job_control(Session, identity, token)

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
        cancel_check()
        replication_id = f"{identity}_rep_{index:04d}"
        result.update(replication_id=replication_id, replication_index=index)
        for key in ("events", "checkpoints", "patients", "ledger_snapshots"):
            result.pop(key, None)
        artifact = store.put_json(workspace, identity, f"replication-{index}", result)
        results_by_index[index] = result
        with Session.begin() as session:
            job = lock_attempt(session, identity, token)
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
            job.completed = len(results_by_index)
        uploads.retain(artifact)

    def persist_failure(index, error):
        replication_id = f"{identity}_rep_{index:04d}"
        with Session.begin() as session:
            lock_attempt(session, identity, token, allow_cancelled=True)
            row = session.get(Document, replication_id)
            if row and row.data.get("status") == "SUCCEEDED":
                return  # A committed result is never demoted by a late failure.
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
    workers = max(1, min(8, int(os.getenv("SIMULATION_WORKERS", str(min(4, os.cpu_count() or 1))))))
    pool_context = (
        private_replication_pool(dataset, scenario, workers, token)
        if workers > 1 and scenario["replications"] >= 5
        else nullcontext(None)
    )
    with pool_context as pool:
        if pool is None or len(pending_indices) < 5:
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
            pending = {}
            indices = iter(pending_indices)

            def submit_next():
                index = next(indices, None)
                if index is not None:
                    pending[pool.submit(_replication_task, index)] = index

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
        results = [results_by_index[i] for i in range(scenario["replications"])]
        with Session.begin() as session:
            job = lock_attempt(session, identity, token)
            job.status = "AGGREGATING"
        selected = representative_replication(results)["replication_index"]
        selected_id = f"{identity}_rep_{selected:04d}"
        if cancel_check():
            raise Cancelled()
        # All ordinary futures have completed. Reuse one warm pure child while the
        # parent summarizes and serializes; no additional process pool is created.
        trace_future = pool.submit(_selected_trace_task, selected) if pool is not None else None

        def check_finalization():
            if cancel_check():
                raise Cancelled()
            if trace_future is not None and trace_future.done():
                trace_future.result()  # Propagate child failure before more uploads.
            return False

        aggregate = aggregate_results(results, scenario=scenario, cancel_check=check_finalization)
        if aggregate["selected_replication_index"] != selected:
            raise ValueError("Representative trajectory selection changed during aggregation")
        trace = (
            None
            if trace_future is not None
            else timed_replication(dataset, scenario, selected, keep_trace=True, cancel_check=cancel_check)
        )
        from .comparisons import compact_summary

        check_finalization()
        aggregate["comparison_summary"] = compact_summary(results)
        aggregate["periods"] = {
            grain: period_aggregation(results, grain, cancel_check=check_finalization)
            for grain in ("week", "month")
        }
        check_finalization()
        aggregate_artifact = store.put_json(workspace, identity, "aggregate", aggregate)
        check_finalization()
        replications_artifact = store.put_json(workspace, identity, "replications", results)
        check_finalization()
        inputs_artifact = store.put_json(
            workspace, identity, "inputs", {"dataset": dataset, "scenario": scenario}
        )
        if trace_future is not None:
            while not trace_future.done():
                check_finalization()
                wait((trace_future,), timeout=0.1)
            trace = trace_future.result()
        check_finalization()
        trace.update(
            replication_id=selected_id,
            replication_index=selected,
            run_group_id=identity,
            start_at=scenario["start_at"],
        )
        for event in trace.get("events", []):
            event.update(run_group_id=identity, replication_id=selected_id, replication_index=selected)
        trace_artifact = store.put_json(workspace, identity, "selected-trace", trace)
        check_finalization()
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
            job = lock_attempt(session, identity, token)
            rep = session.get(Document, selected_id)
            rep.data = {
                **rep.data,
                "trace_artifact": trace_artifact,
                "selected": True,
                "trace_execution_metrics": trace.get("execution_metrics", {}),
            }
            job.result = result_with_generation(
                job,
                {
                    "aggregate_artifact": aggregate_artifact,
                    "replications_artifact": replications_artifact,
                    "inputs_artifact": inputs_artifact,
                    "selected_replication_id": selected_id,
                    "manifest": manifest,
                    "warnings": aggregate.get("warnings", []),
                },
            )
            job.status = "SUCCEEDED"
            job.completed_at = now()
            job.lease_until = 0
        uploads.retain(trace_artifact, aggregate_artifact, replications_artifact, inputs_artifact)


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


def trace_job(identity, Session, token, uploads):
    store = uploads.store
    with Session() as session:
        job = session.get(Job, identity)
        check_attempt(job, token)
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
    check = job_control(Session, identity, token)
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
        job = lock_attempt(session, identity, token)
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
        job.status = "SUCCEEDED"
        job.completed = 1
        job.completed_at = now()
        job.result = result_with_generation(job, {"trace_artifact": artifact})
        job.lease_until = 0
    uploads.retain(artifact)


def export_job(identity, Session, token, uploads):
    store = uploads.store
    check = job_control(Session, identity, token)
    check()
    with Session() as session:
        job = session.get(Job, identity)
        check_attempt(job, token)
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
        job = lock_attempt(session, identity, token)
        job.result = result_with_generation(job, {"artifact": artifact})
        job.completed = 1
        job.status = "SUCCEEDED"
        job.completed_at = now()
        job.lease_until = 0
    uploads.retain(artifact)


def period_aggregation(replications, grain, *, cancel_check=None):
    """Aggregate each trajectory first; only then calculate ensemble percentiles."""
    import numpy as np

    per_rep = []
    metadata = {}
    for replication in replications:
        if cancel_check and cancel_check():
            raise Cancelled()
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
            if cancel_check and cancel_check():
                raise Cancelled()
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
        if cancel_check and cancel_check():
            raise Cancelled()
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
                    locked = session.execute(
                        update(Job)
                        .where(
                            Job.id == job.id,
                            Job.attempts == job.attempts,
                            Job.status.in_(["RUNNING", "AGGREGATING", "CANCEL_REQUESTED"]),
                            Job.lease_until < time.time(),
                        )
                        .values(lease_until=Job.lease_until)
                        .execution_options(synchronize_session=False)
                    )
                    if locked.rowcount != 1:
                        continue
                    session.refresh(job)
                    if job.cancelled:
                        job.status = "CANCELLED"
                        job.completed_at = now()
                    elif job.attempts - retry_generation(job)["attempt_base"] >= 3:
                        job.status = "FAILED"
                        job.error = "Worker lease expired after two recovery attempts"
                        job.completed_at = now()
                    else:
                        job.status = "QUEUED"
                        job.dispatched = False
                session.execute(
                    update(Job)
                    .where(Job.status == "QUEUED", Job.dispatched == True, Job.lease_until < time.time())
                    .values(dispatched=False)
                )
                jobs = list(
                    session.scalars(
                        select(Job)
                        .where(
                            Job.status == "QUEUED", Job.dispatched == False, Job.lease_until <= time.time()
                        )
                        .order_by(Job.created_at)
                        .limit(20)
                    )
                )
                for job in jobs:
                    locked = session.execute(
                        update(Job)
                        .where(
                            Job.id == job.id,
                            Job.status == "QUEUED",
                            Job.dispatched == False,
                            Job.lease_until <= time.time(),
                        )
                        .values(lease_until=Job.lease_until)
                        .execution_options(synchronize_session=False)
                    )
                    if locked.rowcount != 1:
                        continue
                    session.refresh(job)
                    if job.cancelled:
                        job.status = "CANCELLED"
                        job.completed_at = now()
                        job.lease_until = 0
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
                                job_id=queue_id,
                                description=f"Hospital Surge Planner {job.kind} {job.id}",
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
