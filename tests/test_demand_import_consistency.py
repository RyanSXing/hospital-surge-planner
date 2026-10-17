"""Canonical imports never choose a convenient alias or stale zero-demand summary."""

import copy
import json

import pytest
from surge_api.db import Document
from surge_api.demand_summary import synchronize_demand_summary
from surge_engine import generate_dataset, validate_dataset
from test_dataset_contract_validation import client as contract_client


@pytest.fixture(scope="module")
def source():
    # JSON imports contain distinct aliases even when the generator shares objects.
    return json.loads(json.dumps(generate_dataset(days=2)))


@pytest.fixture(scope="module")
def client(tmp_path_factory, source):
    yield from contract_client.__wrapped__(tmp_path_factory, source)


def zero_demand(source, mode):
    data = copy.deepcopy(source)
    ed, direct = data["entry_streams"]
    if mode == "no_admissions":
        ed["disposition_weights"] = {"discharge": 1}
    else:
        ed["expected_arrivals_per_local_day"] = 0
    if mode in {"all_zero", "all_disabled"}:
        direct["expected_arrivals_per_local_day"] = 0
        ed["hour_weights"] = [1.0] + [0.0] * 23
        direct["hour_weights"] = [0.0, 1.0] + [0.0] * 22
        ed["weekday_weights"] = [7.0] + [0.0] * 6
        direct["weekday_weights"] = [0.0, 7.0] + [0.0] * 5
        if mode == "all_disabled":
            ed["enabled"] = direct["enabled"] = False
    synchronize_demand_summary(data)
    assert validate_dataset(data)["valid"], validate_dataset(data)["errors"]
    return data


@pytest.mark.parametrize(
    "field,value",
    [
        ("ed_arrivals_per_local_day", 999),
        ("direct_ward_arrivals_per_local_day", 999),
        ("ed_admission_probability", 0.5),
        ("icu_fraction_of_admissions", 0.5),
        ("hour_weights", [1.0] + [0.0] * 23),
        ("weekday_weights", [7.0] + [0.0] * 6),
        ("cohort_mix", {"ward": [0.3, 0.5, 0.2], "icu": [0.7, 0.3]}),
    ],
)
def test_supplied_baseline_alias_cannot_disagree_with_arrival_profiles(source, field, value):
    data = copy.deepcopy(source)
    data["baseline"][field] = value
    before = copy.deepcopy(data)
    report = validate_dataset(data)
    assert not report["valid"]
    assert any(error["file"] == "baseline" and error["field"].startswith(field) for error in report["errors"])
    assert data == before


@pytest.mark.parametrize("alias", [None, [], "stale", {"ed_arrivals_per_local_day": True}])
def test_malformed_secondary_alias_is_not_ignored(source, alias):
    data = copy.deepcopy(source)
    data["baseline"] = alias
    report = validate_dataset(data)
    assert not report["valid"]
    assert any(error["file"] == "baseline" for error in report["errors"])


def test_equivalent_derived_aliases_allow_independent_provenance_metadata(source):
    data = copy.deepcopy(source)
    data["baseline"]["source_note"] = "Imported source representation"
    data["arrival_profiles"]["source_note"] = "Application representation"
    assert validate_dataset(data)["valid"]
    data.pop("arrival_profiles")
    assert validate_dataset(data)["valid"]


@pytest.mark.parametrize(
    "mode,field",
    [
        ("zero_ed", "ed_admission_probability"),
        ("zero_ed", "icu_fraction_of_admissions"),
        ("no_admissions", "icu_fraction_of_admissions"),
        ("all_zero", "hour_weights"),
        ("all_zero", "weekday_weights"),
        ("all_disabled", "hour_weights"),
        ("all_disabled", "weekday_weights"),
    ],
)
def test_zero_denominators_still_require_the_exact_derived_summary(source, mode, field):
    data = zero_demand(source, mode)
    if field == "hour_weights":
        value = [1.0] + [0.0] * 23
        data["hour_of_day_baseline"] = [{"hour": i, "weight": weight} for i, weight in enumerate(value)]
    elif field == "weekday_weights":
        value = [7.0] + [0.0] * 6
        data["weekday_baseline"] = [{"weekday": i, "multiplier": weight} for i, weight in enumerate(value)]
    else:
        value = 0.5
    for name in ("baseline", "arrival_profiles"):
        data[name][field] = value
    report = validate_dataset(data)
    assert not report["valid"]
    assert any(error["file"] == "baseline" and error["field"] == field for error in report["errors"])


@pytest.mark.parametrize("mode", ["alias", "zero_ed", "no_admissions", "all_zero", "all_disabled"])
def test_inconsistent_import_cannot_commit_and_retains_original_input(client, source, mode):
    data = copy.deepcopy(source) if mode == "alias" else zero_demand(source, mode)
    field = "ed_arrivals_per_local_day" if mode == "alias" else "icu_fraction_of_admissions"
    data["baseline"][field] = 999 if mode == "alias" else 0.5
    if mode != "alias":
        data["arrival_profiles"][field] = 0.5
    stage = client.post("/api/imports", json={"dataset": data}).json()
    report = client.post(f"/api/imports/{stage['id']}/validate").json()
    assert not report["valid"] and any(error["field"] == field for error in report["errors"])
    assert client.post(f"/api/imports/{stage['id']}/commit").status_code == 422
    with client.app.state.Session() as session:
        saved = session.get(Document, stage["id"]).data
        assert saved["dataset"]["baseline"][field] == data["baseline"][field]
