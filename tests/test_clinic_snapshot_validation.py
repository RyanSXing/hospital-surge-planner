"""Observed clinic commitments must validate before they reach the engine."""

import copy

import pytest
from surge_engine import run_replication, validate_dataset
from test_clinic_policy import observed_clinic_snapshot, scenario
from test_clinic_policy import source as clinic_source


@pytest.fixture(scope="module")
def observed():
    data = clinic_source.__wrapped__()
    data["clinic_policies"][0]["transport_required"] = True
    result = run_replication(data, scenario(data))
    snapshot = observed_clinic_snapshot(data, result, 65)
    assert validate_dataset(snapshot)["valid"]
    return snapshot


@pytest.mark.parametrize(
    "case,field",
    [
        ("missing_expiry", "expiry_at"),
        ("expired_before_arrival", "expiry_at"),
        ("request_after_departure", "expiry_at"),
        ("policy_requires_no_transport", "clinic_policy_id"),
        ("request_before_open", "requested_at"),
        ("arrival_at_close", "planned_arrival_at"),
        ("wrong_vehicle", "vehicle_id"),
        ("wrong_slot_capability", "destination_slot_id"),
        ("occupied_source", "prior_state"),
    ],
)
def test_clinic_snapshot_rejects_contradictory_commitment_before_execution(observed, case, field):
    data = copy.deepcopy(observed)
    transfer = data["patients"][0]["pending_transfer"]
    policy = data["clinic_policies"][0]
    if case == "missing_expiry":
        transfer.pop("expiry_at")
    elif case == "expired_before_arrival":
        transfer["expiry_at"] = transfer["planned_arrival_at"]
    elif case == "request_after_departure":
        transfer["requested_at"] = transfer["planned_arrival_at"]
    elif case == "policy_requires_no_transport":
        policy["transport_required"] = False
    elif case == "request_before_open":
        policy["admission_start_at"] = transfer["planned_departure_at"]
    elif case == "arrival_at_close":
        policy["admission_end_at"] = transfer["planned_arrival_at"]
    elif case == "wrong_vehicle":
        vehicle = next(v for v in data["vehicles"] if v["vehicle_id"] == transfer["vehicle_id"])
        vehicle["capabilities"] = ["ICU_TRANSPORT"]
    elif case == "wrong_slot_capability":
        slot = next(s for s in data["slots"] if s["slot_id"] == transfer["destination_slot_id"])
        slot["capabilities"] = ["WARD_CARE"]
    elif case == "occupied_source":
        transfer["source_unit_id"] = "UNIT-ED"
    result = validate_dataset(data)
    assert not result["valid"]
    assert any(error["field"].endswith(field) for error in result["errors"]), result["errors"]
