"""Curated generator upgrades append current fixtures without rewriting history."""

import copy

from fastapi.testclient import TestClient
from sqlalchemy import select
from surge_api.db import Document, Job, canonical, make_database
from surge_api.domain import seed_database
from surge_api.main import create_app
from surge_engine import generate_dataset, validate_dataset
from surge_engine.common import GENERATOR_VERSION, MODEL_VERSION, digest
from surge_engine.generator import fixture_identity


def rows(factory, kind):
    with factory() as session:
        return list(session.scalars(select(Document).where(Document.kind == kind)))


def persisted(factory):
    with factory() as session:
        return {
            row.id: canonical(
                {
                    "data": row.data,
                    "revision": row.revision,
                    "created_at": row.created_at,
                    "updated_at": row.updated_at,
                    "workspace_id": row.workspace_id,
                    "kind": row.kind,
                }
            )
            for row in session.scalars(select(Document))
        }


def test_generator_identity_truthfully_versions_deterministic_content():
    assert GENERATOR_VERSION == "1.1.0"
    assert MODEL_VERSION == "1.1.0"
    data = generate_dataset(days=1)
    assert data["id"] == fixture_identity("planning_baseline", 41021, 1)
    assert data["id"] != "demo-v1-planning_baseline-41021-1"
    assert data["generator_version"] == data["manifest"]["generator_version"] == GENERATOR_VERSION
    assert data["manifest"]["dataset_version_id"] == data["dataset_version_id"] == data["id"]
    assert canonical(data) == canonical(generate_dataset(days=1))


def test_new_install_has_three_versioned_fixtures_one_starter_and_idempotent_seed(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    engine, factory = make_database("sqlite:///" + str(tmp_path / "new.db"))
    try:
        seed_database(factory)
        datasets = rows(factory, "dataset")
        scenarios = rows(factory, "scenario")
        assert len(datasets) == 3 and len(scenarios) == 1
        assert {row.id for row in datasets} == {
            fixture_identity(name) for name in ("planning_baseline", "stress_snapshot", "hospital_baseline")
        }
        for row in datasets:
            assert row.data["generator_version"] == GENERATOR_VERSION
            assert row.data["manifest"]["coverage_days"] == 365
            assert row.data["manifest"]["dataset_version_id"] == row.id
            assert row.data["seed_provenance"] == {
                "identity": row.id,
                "generator_version": GENERATOR_VERSION,
                "fixture": row.data["fixture"],
                "seed": 41021,
                "coverage_days": 365,
            }
            assert row.data["input_sha256"] == digest(
                {
                    key: value
                    for key, value in row.data.items()
                    if key not in {"input_sha256", "committed_at", "validation"}
                }
            )
            assert validate_dataset(row.data)["valid"]
        assert scenarios[0].data["dataset_version_id"] == fixture_identity("hospital_baseline")
        # An edited starter is a user draft; a restart must not restore or duplicate it.
        with factory.begin() as session:
            starter = session.get(Document, scenarios[0].id)
            starter.data = {**starter.data, "name": "My revised planning draft"}
            starter.revision += 1
        before = persisted(factory)
        seed_database(factory)
        seed_database(factory)
        assert persisted(factory) == before
    finally:
        engine.dispose()


def test_upgrade_appends_current_seed_and_preserves_all_old_bytes_and_default_context(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.delenv("REDIS_URL", raising=False)
    url = "sqlite:///" + str(tmp_path / "upgrade.db")
    engine, factory = make_database(url)
    try:
        with factory.begin() as session:
            for fixture in ("planning_baseline", "stress_snapshot"):
                data = generate_dataset(fixture=fixture, days=1)
                identity = "legacy-" + fixture
                data.update(id=identity, dataset_version_id=identity, generator_version="1.0.0")
                data["manifest"] = {
                    **data["manifest"],
                    "dataset_version_id": identity,
                    "generator_version": "1.0.0",
                }
                for patient in data["patients"]:
                    patient.pop("admitted_at", None)
                    patient.pop("admission_requested_at", None)
                assert not validate_dataset(data)["valid"]
                session.add(
                    Document(
                        id=identity,
                        workspace_id="workspace-main",
                        kind="dataset",
                        data=data,
                        revision=7,
                        created_at="2025-01-01T00:00:00Z",
                        updated_at="2025-01-02T00:00:00Z",
                    )
                )
            for identity, name in (
                ("old-starter", "Sustained 70% surge"),
                ("custom-user-scenario", "User planning inputs"),
            ):
                session.add(
                    Document(
                        id=identity,
                        workspace_id="workspace-main",
                        kind="scenario",
                        revision=3,
                        data={
                            "id": identity,
                            "name": name,
                            "dataset_version_id": "legacy-planning_baseline",
                            "conditions": [{"kind": "arrival_multiplier", "surge_percent": 19}],
                        },
                        created_at="2025-02-01T00:00:00Z",
                        updated_at="2025-02-02T00:00:00Z",
                    )
                )
            session.add(
                Job(
                    id="old-run",
                    workspace_id="workspace-main",
                    kind="run",
                    status="SUCCEEDED",
                    payload={
                        "model_version": "1.0.0",
                        "scenario_id": "old-starter",
                        "dataset_version_id": "legacy-planning_baseline",
                        "input_sha256": "original-input-hash",
                    },
                    result={"manifest": {"generator_version": "1.0.0"}, "artifact": "retained-old-object"},
                    created_at="2025-02-03T00:00:00Z",
                )
            )
        before = persisted(factory)
        with factory() as session:
            old_job = session.get(Job, "old-run")
            job_before = copy.deepcopy((old_job.payload, old_job.result, old_job.status, old_job.created_at))
        seed_database(factory)
        assert len(rows(factory, "dataset")) == 5
        assert len(rows(factory, "scenario")) == 3
        after = persisted(factory)
        assert all(after[identity] == contents for identity, contents in before.items())
        seed_database(factory)
        assert persisted(factory) == after
        with factory() as session:
            old_job = session.get(Job, "old-run")
            assert (old_job.payload, old_job.result, old_job.status, old_job.created_at) == job_before
        app = create_app(url, seed=True, start_dispatcher=False)
        with TestClient(app) as client:
            summary = client.get("/api/workspaces/workspace-main/summary")
            assert summary.status_code == 200, summary.text
            value = summary.json()
            assert value["scenario"]["id"] == "scenario-" + fixture_identity("hospital_baseline")
            assert value["dataset"]["id"] == fixture_identity("hospital_baseline")
            assert value["dataset"]["generator_version"] == GENERATOR_VERSION
            assert value["run_group"] is None
        app.state.engine.dispose()
        assert all(persisted(factory)[identity] == contents for identity, contents in before.items())
    finally:
        engine.dispose()
