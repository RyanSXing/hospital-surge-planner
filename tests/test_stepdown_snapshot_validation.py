import copy

import pytest
from surge_engine import generate_dataset, validate_dataset


@pytest.fixture(scope="module")
def observed_stepdown():
    data = generate_dataset(days=2)
    patient = next(patient for patient in data["patients"] if patient["care_level"] == "icu")
    patient.update(
        care_level="ward",
        target_unit_kind="ward",
        stage_status="ready_to_exit",
        admission_requested_at=data["snapshot_at"],
        queue_entered_at=data["snapshot_at"],
        # This is the already selected destination profile, not the held ICU resources.
        resource_profile_id="RP-WARD-BASIC",
    )
    for field in (
        "remaining_stage_spec",
        "remaining_stay_minutes",
        "remaining_stay_template_id",
        "assessment_remaining_minutes",
    ):
        patient.pop(field, None)
    return data, patient["patient_id"]


def test_completed_icu_stage_requires_no_residual_and_reconciles_held_resources(observed_stepdown):
    data, identity = observed_stepdown
    result = validate_dataset(data)
    assert result["valid"], result["errors"]
    patient = next(patient for patient in data["patients"] if patient["patient_id"] == identity)
    assert patient["resource_requirements"][0]["capability_code"] == "ICU_MONITOR"
    assert (
        next(row for row in result["capacity_reconciliation"] if row["unit_id"] == "UNIT-ICU")["occupied"]
        == 8
    )


@pytest.mark.parametrize(
    "key,value,field",
    [
        ("admission_requested_at", None, "admission_requested_at"),
        ("queue_entered_at", None, "queue_entered_at"),
        ("care_level", "icu", "stage_status"),
        ("target_unit_kind", "icu", "stage_status"),
        ("unit_id", "UNIT-WARD-A", "stage_status"),
        ("cohort_template_id", "COHORT-WARD-SHORT", "cohort_template_id"),
        (
            "resource_requirements",
            [{"capability_code": "WARD_OXYGEN", "quantity": 1}],
            "resource_requirements",
        ),
        ("queue_entered_at", "2026-10-15T23:59:00Z", "queue_entered_at"),
    ],
)
def test_completed_icu_stage_rejects_inconsistent_observations(observed_stepdown, key, value, field):
    data, identity = observed_stepdown
    data = copy.deepcopy(data)
    patient = next(patient for patient in data["patients"] if patient["patient_id"] == identity)
    patient[key] = value
    result = validate_dataset(data)
    assert not result["valid"]
    assert any(error["field"] == field for error in result["errors"]), result["errors"]


def test_ongoing_inpatient_stage_still_requires_current_residual(observed_stepdown):
    data, identity = observed_stepdown
    data = copy.deepcopy(data)
    patient = next(patient for patient in data["patients"] if patient["patient_id"] == identity)
    patient.update(stage_status="in_service", care_level="icu", target_unit_kind=None)
    result = validate_dataset(data)
    assert not result["valid"]
    assert any(error["field"] == "remaining_stage_spec" for error in result["errors"])
