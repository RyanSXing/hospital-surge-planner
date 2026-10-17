"""Read-only hosted diagnostic of saved annual aggregation and compression.

Run inside the deployed API/worker image, with an existing successful run ID.
No simulation, job, database mutation, or artifact upload is performed. Output
contains timing/count/checksum metadata only. Timings are single diagnostic
trials, not an application acceptance benchmark.
"""

import argparse
import gc
import gzip
import hashlib
import io
import json
import os
import resource
import time
from datetime import UTC, datetime

from sqlalchemy import text
from surge_api.artifacts import ArtifactStore
from surge_api.comparisons import compact_summary
from surge_api.db import Job, canonical, make_database
from surge_api.worker import period_aggregation
from surge_engine import aggregate_results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--skip-compression", action="store_true", help="Verify and time only aggregate phases")
    args = parser.parse_args()
    assert os.environ.get("CODE_COMMIT") == args.expected_commit
    # Leave headroom for the running API and database on the 16 GiB host.
    resource.setrlimit(resource.RLIMIT_AS, (10 * 2**30, 10 * 2**30))
    phases = []

    def measured(name, action):
        started, cpu = time.perf_counter(), time.process_time()
        result = action()
        row = {
            "phase": name,
            "wall_seconds": time.perf_counter() - started,
            "cpu_seconds": time.process_time() - cpu,
            "process_lifetime_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        }
        phases.append(row)
        print(json.dumps(row), flush=True)
        return result

    engine, Session = make_database()
    with Session() as session:
        session.execute(text("SET TRANSACTION READ ONLY"))
        job = session.get(Job, args.job_id)
        assert job and job.status == "SUCCEEDED"
        assert job.result["manifest"]["code_commit"] == args.expected_commit
        scenario = job.payload["scenario"]
        source = job.result["replications_artifact"]
        aggregate_source = job.result["aggregate_artifact"]
    engine.dispose()
    store = measured("artifact_client_setup", ArtifactStore)
    results = measured("read_and_decode_replications", lambda: store.get_json(source))
    assert len(results) == scenario["replications"]
    report = {
        "recorded_at": datetime.now(UTC).isoformat(),
        "scope": "Read-only, single-trial serial-phase diagnostic of exact completed OCI artifacts; no cProfile overhead",
        "run_group_id": args.job_id,
        "code_commit": args.expected_commit,
        "horizon_days": scenario["horizon_calendar_days"],
        "replications": len(results),
        "input_artifact_compressed_sha256": source["sha256"],
        "input_artifact_compressed_bytes": source["byte_size"],
        "memory_address_space_limit_bytes": 10 * 2**30,
        "phases": phases,
        "compression": [],
    }
    aggregate = measured("aggregate_results", lambda: aggregate_results(results, scenario=scenario))
    aggregate["comparison_summary"] = measured("compact_summary", lambda: compact_summary(results))
    aggregate["periods"] = {
        grain: measured("period_aggregation_" + grain, lambda grain=grain: period_aggregation(results, grain))
        for grain in ("week", "month")
    }
    expected = measured("read_and_decode_stored_aggregate", lambda: store.get_json(aggregate_source))
    aggregate_raw = measured("canonical_aggregate", lambda: canonical(aggregate))
    expected_sha = hashlib.sha256(canonical(expected)).hexdigest()
    aggregate_sha = hashlib.sha256(aggregate_raw).hexdigest()
    assert aggregate_sha == expected_sha, "Recomputed aggregate differs from saved result"
    report["recomputed_aggregate_sha256"] = aggregate_sha
    report["recomputed_aggregate_matches_saved"] = True
    if args.skip_compression:
        print(json.dumps({"report": report}), flush=True)
        return
    expected = aggregate = aggregate_raw = None
    gc.collect()
    raw = measured("canonical_replications", lambda: canonical(results))
    results = None
    gc.collect()
    raw_sha = hashlib.sha256(raw).hexdigest()
    report["canonical_replications_sha256"] = raw_sha
    report["canonical_replications_bytes"] = len(raw)
    for level in (1, 3, 6, 9):
        packed = measured(
            "gzip_level_" + str(level), lambda level=level: gzip.compress(raw, compresslevel=level, mtime=0)
        )
        digest = hashlib.sha256()
        offset = 0
        with gzip.GzipFile(fileobj=io.BytesIO(packed), mode="rb") as stream:
            while chunk := stream.read(2**20):
                assert chunk == raw[offset : offset + len(chunk)]
                digest.update(chunk)
                offset += len(chunk)
        assert offset == len(raw) and digest.hexdigest() == raw_sha
        packed_sha = hashlib.sha256(packed).hexdigest()
        row = {
            "level": level,
            "compressed_bytes": len(packed),
            "compressed_sha256": packed_sha,
            "decompressed_bytes": offset,
            "decompressed_sha256": digest.hexdigest(),
            "byte_for_byte_decompression_matches": True,
            "matches_stored_compressed_artifact": packed_sha == source["sha256"],
        }
        report["compression"].append(row)
        print(json.dumps({"compression_verification": row}), flush=True)
        del packed
        gc.collect()
    print(json.dumps({"report": report}), flush=True)


if __name__ == "__main__":
    main()
