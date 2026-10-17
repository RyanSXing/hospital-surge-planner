import copy
import json

import pytest
from surge_api.demand_summary import synchronize_demand_summary
from surge_engine import generate_dataset, validate_dataset

DERIVED = {"arrival_profiles", "baseline", "hour_of_day_baseline", "weekday_baseline"}


@pytest.fixture
def dataset():
    return generate_dataset(days=1)


def spike(length, index, total=1):
    return [total if position == index else 0 for position in range(length)]


def test_heterogeneous_streams_resolve_weighted_demand_without_changing_inputs(dataset):
    ed, direct = dataset["entry_streams"]
    ed.update(hour_weights=spike(24, 0), weekday_weights=spike(7, 0, 7))
    direct.update(
        expected_arrivals_per_local_day=20, hour_weights=spike(24, 12), weekday_weights=spike(7, 1, 7)
    )
    extra = {
        **copy.deepcopy(ed),
        "entry_stream_id": "ED_EXTRA",
        "expected_arrivals_per_local_day": 50,
        "disposition_weights": {"discharge": 0.5, "ward": 0.3, "icu": 0.2},
        "hour_weights": spike(24, 23),
        "weekday_weights": spike(7, 6, 7),
    }
    dataset["entry_streams"].append(extra)
    dataset["pathway_profiles"].append(
        {
            **copy.deepcopy(dataset["pathway_profiles"][0]),
            "pathway_profile_id": "PATHWAY-ED-EXTRA",
            "entry_stream_id": "ED_EXTRA",
        }
    )
    dataset["hour_of_day_baseline"][12]["description"] = "Midday summary metadata"
    dataset["weekday_baseline"][1]["display_name"] = "Tuesday"
    before = copy.deepcopy({key: value for key, value in dataset.items() if key not in DERIVED})
    metadata = {
        key: value
        for key, value in dataset["arrival_profiles"].items()
        if key
        not in {
            "ed_arrivals_per_local_day",
            "direct_ward_arrivals_per_local_day",
            "ed_admission_probability",
            "icu_fraction_of_admissions",
            "hour_weights",
            "weekday_weights",
        }
    }
    assert synchronize_demand_summary(dataset) is None
    summary = dataset["arrival_profiles"]
    assert summary["ed_arrivals_per_local_day"] == 150
    assert summary["direct_ward_arrivals_per_local_day"] == 20
    assert summary["ed_admission_probability"] == pytest.approx(45 / 150)
    assert summary["icu_fraction_of_admissions"] == pytest.approx(14 / 45)
    assert [summary["hour_weights"][index] for index in (0, 12, 23)] == pytest.approx(
        [100 / 170, 20 / 170, 50 / 170]
    )
    assert [summary["weekday_weights"][index] for index in (0, 1, 6)] == pytest.approx(
        [700 / 170, 140 / 170, 350 / 170]
    )
    assert dataset["hour_of_day_baseline"][12]["description"] == "Midday summary metadata"
    assert dataset["weekday_baseline"][1]["display_name"] == "Tuesday"
    assert all(summary[key] == value for key, value in metadata.items())
    assert {key: value for key, value in dataset.items() if key not in DERIVED} == before
    result = validate_dataset(dataset)
    assert result["valid"], result["errors"]


def test_rate_disposition_disable_add_delete_edits_refresh_all_aliases(dataset):
    dataset = json.loads(json.dumps(dataset))  # Persisted aliases are separate dictionaries.
    ed = dataset["entry_streams"][0]
    ed["expected_arrivals_per_local_day"] = 40
    synchronize_demand_summary(dataset)
    assert dataset["arrival_profiles"]["ed_arrivals_per_local_day"] == 40
    ed["disposition_weights"] = {"discharge": 0.4, "ward": 0.4, "icu": 0.2}
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["ed_admission_probability"] == pytest.approx(0.6)
    assert dataset["baseline"]["icu_fraction_of_admissions"] == pytest.approx(1 / 3)
    ed["enabled"] = False
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["ed_arrivals_per_local_day"] == 0
    assert (
        dataset["baseline"]["ed_admission_probability"]
        == dataset["baseline"]["icu_fraction_of_admissions"]
        == 0
    )
    added = {
        **copy.deepcopy(ed),
        "entry_stream_id": "ED_ADDED",
        "enabled": True,
        "expected_arrivals_per_local_day": 80,
    }
    dataset["entry_streams"].append(added)
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["ed_arrivals_per_local_day"] == 80
    dataset["entry_streams"].remove(added)
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["ed_arrivals_per_local_day"] == 0
    assert dataset["baseline"] == dataset["arrival_profiles"]
    assert [row["weight"] for row in dataset["hour_of_day_baseline"]] == dataset["baseline"]["hour_weights"]


def test_zero_rate_profiles_use_enabled_then_all_declared_streams(dataset):
    ed, direct = dataset["entry_streams"]
    ed.update(expected_arrivals_per_local_day=0, hour_weights=spike(24, 0), weekday_weights=spike(7, 0, 7))
    direct.update(
        expected_arrivals_per_local_day=0, hour_weights=spike(24, 1), weekday_weights=spike(7, 1, 7)
    )
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["hour_weights"][:2] == [0.5, 0.5]
    assert dataset["baseline"]["weekday_weights"][:2] == [3.5, 3.5]
    direct["enabled"] = False
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["hour_weights"] == ed["hour_weights"]
    ed["enabled"] = False
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["hour_weights"][:2] == [0.5, 0.5]
    assert (
        dataset["baseline"]["ed_admission_probability"]
        == dataset["baseline"]["icu_fraction_of_admissions"]
        == 0
    )


def test_delete_all_streams_preserves_valid_profile_or_uses_uniform_default(dataset):
    old = copy.deepcopy(dataset["baseline"])
    dataset["entry_streams"] = []
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["hour_weights"] == old["hour_weights"]
    assert dataset["baseline"]["weekday_weights"] == old["weekday_weights"]
    assert (
        dataset["baseline"]["ed_arrivals_per_local_day"]
        == dataset["baseline"]["direct_ward_arrivals_per_local_day"]
        == 0
    )
    dataset["baseline"].update(hour_weights=[], weekday_weights=None)
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["hour_weights"] == [1 / 24] * 24
    assert dataset["baseline"]["weekday_weights"] == [1] * 7


def test_baseline_only_alias_and_shared_arrays_remain_safe(dataset):
    old_streams = copy.deepcopy(dataset["entry_streams"])
    shared_hours = dataset["entry_streams"][0]["hour_weights"]
    assert dataset["baseline"]["hour_weights"] is shared_hours
    del dataset["arrival_profiles"]
    synchronize_demand_summary(dataset)
    assert "arrival_profiles" not in dataset
    assert dataset["baseline"]["hour_weights"] is not shared_hours
    assert dataset["entry_streams"] == old_streams


@pytest.mark.parametrize(
    "field,value,error",
    [
        ("entry_type", {}, "entry_type"),
        ("enabled", "false", "enabled"),
        ("expected_arrivals_per_local_day", -1, "expected_arrivals_per_local_day"),
        ("expected_arrivals_per_local_day", float("nan"), "expected_arrivals_per_local_day"),
        ("expected_arrivals_per_local_day", True, "expected_arrivals_per_local_day"),
        ("hour_weights", [1], "hour_weights"),
        ("weekday_weights", [1] * 6 + [True], "weekday_weights"),
        ("disposition_weights", {"ward": 0.5}, "disposition_weights"),
        ("disposition_weights", {"invented": 1}, "disposition_weights"),
    ],
)
def test_invalid_computational_edit_raises_actionable_error_without_partial_mutation(
    dataset, field, value, error
):
    dataset["entry_streams"][0][field] = value
    before = json.dumps(dataset, sort_keys=True)
    with pytest.raises(ValueError, match=rf"entry_streams\[ED_MAIN\]\.{error}:"):
        synchronize_demand_summary(dataset)
    assert json.dumps(dataset, sort_keys=True) == before


def test_incomplete_or_duplicate_stream_and_direct_disposition_are_rejected(dataset):
    for replacement in ({"entry_stream_id": "ED_INCOMPLETE"}, copy.deepcopy(dataset["entry_streams"][0])):
        data = copy.deepcopy(dataset)
        data["entry_streams"].append(replacement)
        before = copy.deepcopy(data)
        with pytest.raises(ValueError, match="entry_streams"):
            synchronize_demand_summary(data)
        assert data == before
    dataset["entry_streams"][1]["disposition_weights"] = {"icu": 1}
    with pytest.raises(ValueError, match="direct ward demand must resolve to ward"):
        synchronize_demand_summary(dataset)


def test_no_admissions_produces_zero_probabilities_despite_positive_ed_demand(dataset):
    dataset["entry_streams"][0]["disposition_weights"] = {"discharge": 1}
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["ed_arrivals_per_local_day"] == 100
    assert (
        dataset["baseline"]["ed_admission_probability"]
        == dataset["baseline"]["icu_fraction_of_admissions"]
        == 0
    )


def test_cohort_summary_retains_dataset_order_and_reviewable_intermediate_totals(dataset):
    wards = [cohort for cohort in dataset["cohorts"] if cohort["care_level"] == "ward"]
    icus = [cohort for cohort in dataset["cohorts"] if cohort["care_level"] == "icu"]
    pathways = copy.deepcopy(dataset["pathway_profiles"])
    wards[0]["selection_weight"] = 0.6
    icus[0]["selection_weight"] = 0.3
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["cohort_mix"] == {"ward": [0.6, 0.45, 0.15], "icu": [0.3, 0.15]}
    assert not validate_dataset(dataset)["valid"]
    wards[1]["selection_weight"] = 0.25
    icus[1]["selection_weight"] = 0.7
    synchronize_demand_summary(dataset)
    assert dataset["baseline"]["cohort_mix"] == {"ward": [0.6, 0.25, 0.15], "icu": [0.3, 0.7]}
    result = validate_dataset(dataset)
    assert result["valid"], result["errors"]
    assert dataset["pathway_profiles"] == pathways
    assert [cohort["cohort_id"] for cohort in dataset["cohorts"] if cohort["care_level"] == "ward"] == [
        cohort["cohort_id"] for cohort in wards
    ]


@pytest.mark.parametrize("weight", [-1, 1.1, True, float("inf"), None])
def test_invalid_cohort_weight_leaves_every_derived_summary_unchanged(dataset, weight):
    ward = next(cohort for cohort in dataset["cohorts"] if cohort["care_level"] == "ward")
    ward["selection_weight"] = weight
    before = json.dumps(dataset, sort_keys=True)
    with pytest.raises(ValueError, match=r"cohorts\[.*\]\.selection_weight:"):
        synchronize_demand_summary(dataset)
    assert json.dumps(dataset, sort_keys=True) == before
