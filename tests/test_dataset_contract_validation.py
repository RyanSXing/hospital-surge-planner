"""Invalid input is rejected at import/draft boundaries, before jobs or commit."""

import copy

import pytest
from fastapi.testclient import TestClient
from surge_api.domain import add_document, normalize_dataset
from surge_api.main import create_app
from surge_engine import generate_dataset, run_replication, validate_dataset


@pytest.fixture(scope="module")
def source():
    return generate_dataset(days=3)


def changed(source, path, value):
    data = copy.deepcopy(source)
    target = data
    for key in path[:-1]:
        target = target[key]
    if value == "__DELETE__":
        target.pop(path[-1], None)
    else:
        target[path[-1]] = value
    return data


@pytest.mark.parametrize(
    "path,value",
    [
        (("patients", 0, "entry_type"), "__DELETE__"),
        (("patients", 0, "source_type"), "invented_source"),
        (("patients", 0, "acuity_rank"), True),
        (("patients", 0, "arrival_at"), "2026-10-16T00:00:00"),
        (("patients", 0, "admitted_at"), "__DELETE__"),
        (("patients", 0, "remaining_stage_spec"), "bad"),
        (("patients", 0, "remaining_stage_spec"), {"kind": "fixed_minutes", "minutes": float("nan")}),
        (
            ("patients", 0, "remaining_stage_spec"),
            {"kind": "conditional_total", "distribution_id": "LOS-WARD-SHORT", "elapsed_minutes": -1},
        ),
        (
            ("patients", 0, "remaining_stage_spec"),
            {"kind": "fixed_minutes", "minutes": 60, "expected_end_at": "2026-10-17T00:00:00Z"},
        ),
        (("patients", 0, "resource_requirements"), [None]),
        (("patients", 0, "pending_transfer"), []),
        (("patients", 0, "unit_id"), []),
        (("patients", 0, "eligible_for_transfer"), 1),
        (("cohorts", 0, "los_template_id"), "MISSING-TEMPLATE"),
        (("cohorts", 0, "selection_weight"), 0.9),
        (
            ("cohorts", 0, "resource_profile_weights"),
            [{"resource_profile_id": "MISSING-PROFILE", "weight": 1}],
        ),
        (("entry_streams", 0, "assessment_template_id"), "MISSING-ASSESSMENT"),
        (("entry_streams", 0, "disposition_weights"), {"ward": 2}),
        (("entry_streams", 0, "hour_weights"), []),
        (("entry_streams", 0, "destination_facility_id"), "MISSING-SITE"),
        (("resource_profiles", 0, "required_equipment"), [{"capability_code": "WARD_CARE", "quantity": 1}]),
        (("capacity_policies",), "__DELETE__"),
        (("capacity_policies", 0, "slots_per_nurse"), 0),
        (("units", 0, "capacity_policy_id"), "MISSING-POLICY"),
        (("units", 0, "turnover_minutes"), -1),
        (("slots", 0, "enabled"), "false"),
        (("slots", 0, "layout_x"), 2),
        (("staff", 0, "role"), "untyped_role"),
        (("staff", 0, "capabilities"), ["WARD_OXYGEN"]),
        (("assignments", 0, "allocation_fraction"), True),
        (("equipment_pools", 0, "quantity"), True),
        (("partner_equipment", 0, "quantity"), -1),
        (("facilities", 0, "latitude"), 91),
        (("facilities", 0, "organization_id"), "MISSING-ORG"),
        (("routes", 0, "travel_minutes"), -20),
        (("routes", 0, "to_facility_id"), "MISSING-SITE"),
        (("vehicles", 0, "patient_capacity"), 0),
        (("vehicles", 0, "available_until"), "2026-01-01T00:00:00Z"),
        (("clinic_policies", 0, "service_template_id"), "MISSING-SERVICE"),
        (("clinic_policies", 0, "eligibility_tag"), "anything"),
        (("clinic_policies", 0, "admission_end_at"), "2026-01-01T00:00:00Z"),
        (("pathway_profiles", 0, "ward_cohort_weights"), [0.5, 0.5]),
        (("los_templates", 0, "family"), "unsupported_distribution"),
        (("timezone",), "Not/A_Zone"),
        (("schema_version",), "99.0"),
    ],
)
def test_canonical_fields_are_typed_and_cross_referenced(source, path, value):
    value = changed(source, path, value)
    before = copy.deepcopy(value)
    result = validate_dataset(value)
    assert not result["valid"], path
    assert result["errors"] and all({"file", "row", "field", "message"} <= set(e) for e in result["errors"])
    assert any(e["file"] == path[0] or path[0] in {"timezone", "schema_version"} for e in result["errors"])
    # The validator never normalizes/repairs the supplied object in place.
    assert repr(value) == repr(before)


@pytest.mark.parametrize(
    "table",
    [
        "patients",
        "units",
        "slots",
        "staff",
        "assignments",
        "equipment_pools",
        "cohorts",
        "routes",
        "entry_streams",
        "capacity_policies",
    ],
)
@pytest.mark.parametrize("malformed", [None, {}, [None], [42]])
def test_malformed_containers_return_structured_errors(source, table, malformed):
    result = validate_dataset(changed(source, (table,), malformed))
    assert not result["valid"] and result["errors"][0]["file"] == table


def test_valid_fixture_and_equivalent_legacy_remaining_aliases_stay_unchanged(source):
    before = copy.deepcopy(source)
    assert validate_dataset(source)["valid"]
    assert source == before
    flat = copy.deepcopy(source)
    for patient in flat["patients"]:
        spec = patient.pop("remaining_stage_spec", None)
        for key in ("remaining_stay_minutes", "assessment_remaining_minutes", "remaining_stay_template_id"):
            patient.pop(key, None)
        if spec and spec["kind"] == "fixed_minutes":
            patient["remaining_stay_minutes"] = spec["minutes"]
        elif spec and spec["kind"] == "remaining_distribution":
            patient["remaining_stay_template_id"] = spec["distribution_id"]
    assert validate_dataset(flat)["valid"]


@pytest.fixture(scope="module")
def client(tmp_path_factory, source):
    root = tmp_path_factory.mktemp("input-contract")
    patch = pytest.MonkeyPatch()
    patch.setenv("APP_ENV", "development")
    patch.setenv("DEMO_MODE", "true")
    patch.setenv("ARTIFACT_LOCAL_DIR", str(root / "artifacts"))
    patch.delenv("REDIS_URL", raising=False)
    app = create_app("sqlite:///" + str(root / "test.db"), seed=False, start_dispatcher=False)
    data = normalize_dataset(source)
    with app.state.Session.begin() as session:
        add_document(session, "workspace-main", "dataset", data)
    with TestClient(app, raise_server_exceptions=False) as result:
        result.dataset = data
        yield result
    patch.undo()


@pytest.mark.parametrize(
    "path,value",
    [
        (("patients", 0, "remaining_stage_spec"), "bad"),
        (("cohorts", 0, "los_template_id"), "MISSING-TEMPLATE"),
        (("routes", 0, "travel_minutes"), -1),
    ],
)
def test_import_invalid_data_never_commits_or_raises_server_error(client, source, path, value):
    invalid = changed(source, path, value)
    stage = client.post("/api/imports", json={"dataset": invalid})
    assert stage.status_code == 201, stage.text
    checked = client.post(f"/api/imports/{stage.json()['id']}/validate", json={})
    assert checked.status_code == 200, checked.text
    assert not checked.json()["valid"] and checked.json()["errors"]
    assert client.post(f"/api/imports/{stage.json()['id']}/commit").status_code == 422


def test_invalid_typed_draft_is_reviewable_but_cannot_commit(client):
    original = client.dataset
    draft = client.post("/api/dataset-drafts", json={"source_dataset_version_id": original["id"]}).json()
    route = {**original["routes"][0], "to_facility_id": "MISSING-SITE", "travel_minutes": -20}
    edited = client.patch(
        f"/api/dataset-drafts/{draft['id']}/entities",
        headers={"If-Match": str(draft["revision"])},
        json={"operations": [{"collection": "routes", "action": "upsert", "entity": route}]},
    )
    assert edited.status_code == 200, edited.text
    assert not edited.json()["validation"]["valid"]
    checked = client.post(f"/api/dataset-drafts/{draft['id']}/validate")
    assert checked.status_code == 200 and not checked.json()["valid"]
    assert {e["field"] for e in checked.json()["errors"]} >= {"to_facility_id", "travel_minutes"}
    committed = client.post(
        f"/api/dataset-drafts/{draft['id']}/commit", headers={"If-Match": str(edited.json()["revision"])}
    )
    assert committed.status_code == 422
    assert client.get("/api/datasets/" + original["id"]).json()["routes"] == original["routes"]


@pytest.mark.parametrize(
    "path,value",
    [
        (("patients", 0, "inpatient_resource_requirements"), None),
        (("patients", 0, "inpatient_resource_requirements"), [None]),
        (("patients", 0, "inpatient_resource_requirements"), [{"capability_code": [], "quantity": 1}]),
        (("patients", 0, "inpatient_resource_requirements"), ["WARD_CARE"]),
        (("history", 0, "arrival_at"), "2026-10-01T00:00:00"),
        (("history", 0, "cohort_id"), "MISSING-COHORT"),
        (("history", 0, "censored"), "false"),
        (("history", 0, "departure_at"), "2020-01-01T00:00:00Z"),
        (("history",), [None]),
        (("pathway_profiles", 0, "ed_disposition_weights"), {"ward": True}),
        (("pathway_profiles", 0, "ward_cohort_weights"), [{"cohort_id": "COHORT-ICU-STANDARD", "weight": 1}]),
        (("pathway_profiles", 0, "ward_cohort_weights"), [{"cohort_id": [], "weight": 1}]),
        (
            ("pathway_profiles", 0, "ward_cohort_weights"),
            [{"cohort_id": "COHORT-WARD-SHORT", "weight": 0.5}, None],
        ),
        (("entry_streams",), []),
    ],
)
def test_nested_and_historical_shapes_are_safe(source, path, value):
    report = validate_dataset(changed(source, path, value))
    assert not report["valid"]
    assert report["errors"] and all({"file", "row", "field", "message"} <= set(e) for e in report["errors"])


@pytest.mark.parametrize(
    "key,value",
    [
        ("ed_arrivals_per_local_day", 101),
        ("direct_ward_arrivals_per_local_day", 5),
        ("ed_admission_probability", 0.3),
        ("icu_fraction_of_admissions", 0.4),
        ("hour_weights", [1 / 24] * 24),
        ("weekday_weights", [1] * 7),
    ],
)
def test_baseline_cannot_disagree_with_executed_entry_streams(source, key, value):
    data = changed(source, ("arrival_profiles", key), value)
    # Keep the display-only weight table consistent, isolating disagreement
    # with the authoritative stream schedule rather than a second bad summary.
    if key == "hour_weights":
        data["hour_of_day_baseline"] = [{"hour": i, "weight": v} for i, v in enumerate(value)]
    elif key == "weekday_weights":
        data["weekday_baseline"] = [{"weekday": i, "multiplier": v} for i, v in enumerate(value)]
    report = validate_dataset(data)
    assert not report["valid"]
    assert any(e["file"] == "baseline" and e["field"] == key for e in report["errors"])


def test_declared_pathway_cohort_weights_and_disabled_optional_modules(source):
    data = copy.deepcopy(source)
    for row in data["pathway_profiles"]:
        row["ward_cohort_weights"] = [{"cohort_id": "COHORT-WARD-SHORT", "weight": 1}]
        row["icu_stepdown_probability"] = 1
        row["stepdown_ward_cohort_weights"] = [{"cohort_id": "COHORT-WARD-EXTENDED", "weight": 1}]
    assert validate_dataset(data)["valid"]
    data["pathway_profiles"][0]["stepdown_ward_cohort_weights"] = [
        {"cohort_id": "COHORT-ICU-STANDARD", "weight": 1}
    ]
    assert not validate_dataset(data)["valid"]

    hospital = copy.deepcopy(source)
    hospital["facilities"] = [f for f in hospital["facilities"] if f["facility_id"] == "FAC-MAIN"]
    hospital["units"] = [u for u in hospital["units"] if u["facility_id"] == "FAC-MAIN"]
    hospital["geometry"] = [u for u in hospital["geometry"] if u["facility_id"] == "FAC-MAIN"]
    unit_ids = {u["unit_id"] for u in hospital["units"]}
    hospital["slots"] = [s for s in hospital["slots"] if s["unit_id"] in unit_ids]
    for key in (
        "clinic_policies",
        "partner_equipment",
        "routes",
        "vehicles",
        "history",
        "intervention_templates",
        "update_fixtures",
    ):
        hospital.pop(key, None)
    for row in hospital["pathway_profiles"]:
        row["clinic_policy_id"] = None
    report = validate_dataset(hospital)
    assert report["valid"], report["errors"]
    result = run_replication(hospital, {"horizon_calendar_days": 1, "base_seed": 42}, keep_trace=False)
    assert result["scalar_metrics"]["patient_conservation_ok"]
    assert result["scalar_metrics"]["arrivals"] > 0


def test_duplicate_directed_routes_and_pathways_cannot_silently_override(source):
    for table, identity in (("routes", "route_id"), ("pathway_profiles", "pathway_profile_id")):
        data = copy.deepcopy(source)
        data[table].append({**data[table][0], identity: "SECOND-DECLARATION"})
        report = validate_dataset(data)
        assert not report["valid"] and any(e["file"] == table for e in report["errors"])


def test_snapshot_preview_computes_qualified_capacity_and_blanket_equipment(source):
    data = copy.deepcopy(source)
    unit = next(u for u in data["units"] if u["unit_id"] == "UNIT-WARD-A")
    unit["staffed_capacity"] = 999  # A cached display value is never authoritative.
    report = validate_dataset(data)
    assert report["valid"], report["errors"]
    row = next(u for u in report["capacity_reconciliation"] if u["unit_id"] == unit["unit_id"])
    assert row["staffed"] == 32 and row["qualified_staff_by_role"] == {"rn": 8, "provider": 1, "support": 4}
    assert row["available"] == 6 and row["admission_gate"]
    policy = next(p for p in data["capacity_policies"] if p["unit_kind"] == "ward")
    policy["slots_per_nurse"] = 3
    row = next(
        u for u in validate_dataset(data)["capacity_reconciliation"] if u["unit_id"] == unit["unit_id"]
    )
    assert row["staffed"] == 24 and row["capacity_deficit"] == 2 and row["available"] == 0
    policy["minimum_provider_count"] = 2
    row = next(
        u for u in validate_dataset(data)["capacity_reconciliation"] if u["unit_id"] == unit["unit_id"]
    )
    assert not row["admission_gate"] and row["occupied"] == 26

    data = copy.deepcopy(source)
    policy = next(p for p in data["capacity_policies"] if p["unit_kind"] == "icu")
    policy["per_slot_resources"] = [{"capability_code": "ICU_MONITOR", "quantity": 1}] * 2
    report = validate_dataset(data)
    assert report["valid"], report["errors"]
    row = next(u for u in report["capacity_reconciliation"] if u["unit_id"] == "UNIT-ICU")
    assert row["staffed"] == 8  # 16 serviceable monitors /2 each, eight current patients.
    policy["per_slot_resources"][0]["quantity"] = 2
    report = validate_dataset(data)
    assert not report["valid"] and any("oversubscribed" in e["message"] for e in report["errors"])


@pytest.mark.parametrize(
    "path,value",
    [
        (("historical_daily_summaries", 0, "ed_arrivals"), -1),
        (("historical_daily_summaries", 0, "ed_arrivals"), 500),
        (("historical_daily_summaries", 0, "local_date"), "bad"),
        (("hour_of_day_baseline", 0, "weight"), 0.5),
        (("weekday_baseline", 0, "weekday"), 9),
    ],
)
def test_historical_and_profile_summary_reconciliation(source, path, value):
    result = validate_dataset(changed(source, path, value))
    assert not result["valid"] and any(e["file"] == path[0] for e in result["errors"])


@pytest.mark.parametrize("keep", [0, 1])
def test_each_enabled_entry_stream_requires_a_pathway(source, keep):
    data = copy.deepcopy(source)
    data["pathway_profiles"] = data["pathway_profiles"][:keep]
    report = validate_dataset(data)
    assert not report["valid"]
    expected_missing = {s["entry_stream_id"] for s in data["entry_streams"]} - {
        p["entry_stream_id"] for p in data["pathway_profiles"]
    }
    errors = [
        e for e in report["errors"] if e["file"] == "pathway_profiles" and e["field"] == "entry_stream_id"
    ]
    assert len(errors) == len(expected_missing)
    assert all(any(ident in e["message"] for e in errors) for ident in expected_missing)


def test_disabled_stream_does_not_require_a_pathway(source):
    data = copy.deepcopy(source)
    direct = next(s for s in data["entry_streams"] if s["entry_type"] == "direct_ward")
    direct["enabled"] = False
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    data["pathway_profiles"] = [
        p for p in data["pathway_profiles"] if p["entry_stream_id"] != direct["entry_stream_id"]
    ]
    report = validate_dataset(data)
    assert report["valid"], report["errors"]


def test_clinic_facility_requires_policy_even_without_pathway_reference(source):
    data = copy.deepcopy(source)
    data["clinic_policies"] = []
    for pathway in data["pathway_profiles"]:
        pathway["clinic_policy_id"] = None
    report = validate_dataset(data)
    assert not report["valid"]
    assert any(
        e["file"] == "clinic_policies" and e["field"] == "site_id" and "FAC-CLINIC-NORTH" in e["message"]
        for e in report["errors"]
    )


def test_multiple_clinic_policies_remain_valid_for_explicit_selection(source):
    data = copy.deepcopy(source)
    data["clinic_policies"].append(
        {**data["clinic_policies"][0], "clinic_policy_id": "CLINIC-ALTERNATIVE-POLICY"}
    )
    report = validate_dataset(data)
    assert report["valid"], report["errors"]


@pytest.mark.parametrize(
    "state,index,cohort",
    [
        ("ed_assessment", -1, "COHORT-WARD-SHORT"),
        ("ed_waiting", -1, "COHORT-WARD-SHORT"),
        ("direct_waiting", 0, "COHORT-ED"),
        ("ed_boarding", -1, "COHORT-ED"),
        ("clinic_assessment", -1, "COHORT-WARD-SHORT"),
    ],
)
def test_patient_cohort_matches_current_service_or_request_stage(source, state, index, cohort):
    data = copy.deepcopy(source)
    patient = data["patients"][index]
    patient.update(state=state, cohort_template_id=cohort)
    if state in {"ed_boarding", "direct_waiting"}:
        patient.update(care_level="ward", target_unit_kind="ward", admission_requested_at=data["snapshot_at"])
    report = validate_dataset(data)
    assert not report["valid"]
    assert any(
        e["field"] == "cohort_template_id" and "source stage" in e["message"] for e in report["errors"]
    )
