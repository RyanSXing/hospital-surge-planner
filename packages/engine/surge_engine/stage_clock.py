"""Shared validation of a reserved source stage that finishes before pickup."""

from .common import dt


def reserved_source_finishes_before_pickup(patient, snapshot_at):
    transfer = patient.get("pending_transfer")
    residual = patient.get("remaining_stage_spec")
    if (
        patient.get("state") != "transfer_reserved"
        or patient.get("stage_status") not in (None, "in_service")
        or not isinstance(transfer, dict)
        or transfer.get("status") != "reserved"
        or transfer.get("prior_state") != "inpatient"
        or not isinstance(residual, dict)
        or residual.get("kind") != "expected_end"
    ):
        return False
    try:
        return dt(snapshot_at) < dt(residual["expected_end_at"]) <= dt(transfer["planned_departure_at"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return False
