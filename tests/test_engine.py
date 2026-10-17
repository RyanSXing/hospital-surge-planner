import copy
from itertools import pairwise

import pytest
from surge_engine import *
from surge_engine.common import dt


@pytest.fixture(scope="module")
def planning():
    return generate_dataset(days=365)


@pytest.fixture(scope="module")
def stress():
    return generate_dataset("stress_snapshot", days=365)


def zero(d):
    data = copy.deepcopy(d)
    data["arrival_profiles"]["ed_arrivals_per_local_day"] = 0
    data["arrival_profiles"]["direct_ward_arrivals_per_local_day"] = 0
    return data


def test_generator_exact_counts(planning, stress):
    for d, n in [(planning, 84), (stress, 116)]:
        assert validate_dataset(d)["valid"]
        assert len(d["patients"]) == n
        assert len(d["staff"]) == 236
        assert len(d["slots"]) == 274
        assert len(d["assignments"]) == 43129
        assert len(d["routes"]) == 30
        assert len(d["history"]) == 9360
        assert sum(h["entry_type"] == "ed" for h in d["history"]) == 9000
        assert sum(h["entry_type"] == "ed" and h["admitted_at"] is not None for h in d["history"]) == 1800
    assert sum(p["state"] == "ed_boarding" for p in stress["patients"]) == 14
    assert not any(p["state"] == "ed_boarding" for p in planning["patients"])


def test_generator_deterministic():
    assert generate_dataset(days=1)["input_sha256"] == generate_dataset(days=1)["input_sha256"]


def test_dst_calendar(planning):
    r = run_replication(zero(planning), {"horizon_calendar_days": 30}, keep_trace=False)
    assert r["horizon_elapsed_minutes"] == 721 * 60
    assert len(r["daily"]) == 30
    assert (dt(r["daily"][16]["end_at"]) - dt(r["daily"][16]["start_at"])).total_seconds() == 25 * 3600
    assert r["scalar_metrics"]["arrivals"] == 0
    assert r["scalar_metrics"]["patient_conservation_ok"]


def test_stress_queue_and_reproducibility(stress):
    d = zero(stress)
    s = {"horizon_calendar_days": 1, "base_seed": 17}
    a = run_replication(d, s)
    b = run_replication(d, s)
    assert a["events"] == b["events"]
    assert a["scalar_metrics"] == b["scalar_metrics"]
    assert a["scalar_metrics"]["time_to_first_shortage_hours"] == 0
    assert a["scalar_metrics"]["inpatient_waiting_patient_hours"] > 0
    first = state_at(a, 0)
    assert first["inpatient_queue"] == 14
    assert sum(u["modeled_occupied"] for u in first["units"]) == 116
    assert a["scalar_metrics"]["patient_conservation_ok"]


def test_physical_only_does_not_create_staff(stress):
    d = zero(stress)
    s = {"horizon_calendar_days": 2, "base_seed": 12}
    base = run_replication(d, s, keep_trace=False)
    physical = run_replication(d, {**s, "interventions": [{"kind": "physical_overflow"}]}, keep_trace=False)
    staffed = run_replication(d, {**s, "interventions": [{"kind": "staff_existing"}]}, keep_trace=False)
    assert (
        physical["scalar_metrics"]["inpatient_waiting_patient_hours"]
        == base["scalar_metrics"]["inpatient_waiting_patient_hours"]
    )
    assert (
        staffed["scalar_metrics"]["inpatient_waiting_patient_hours"]
        < base["scalar_metrics"]["inpatient_waiting_patient_hours"]
    )
    assert staffed["scalar_metrics"]["additional_staff_hours"] > 0


def test_transfer_reservations_transport_and_resources(stress):
    r = run_replication(
        zero(stress), {"horizon_calendar_days": 2, "interventions": [{"kind": "partner_transfer"}]}
    )
    assert r["scalar_metrics"]["patients_transferred"] > 0
    assert r["scalar_metrics"]["patient_conservation_ok"]
    assert any(e["event_type"] == "transfer_departed" for e in r["events"])
    for row in r["series"]:
        for u in row["units"]:
            assert u["occupied"] + u["reserved"] <= u["staffed"] or u["capacity_deficit"] > 0
            for e in u["equipment"].values():
                assert e["available"] >= 0
    departure = next(e for e in r["events"] if e["event_type"] == "transfer_departed")
    state = state_at(r, departure["elapsed_minutes"] + 0.01)
    p = next(p for p in state["patients"] if p["patient_id"] == departure["patient_id"])
    assert p["state"] == "in_transit" and p["admission_pending"]
    assert p["slot_id"] is None


def test_clinic_distinct_from_inpatient_capacity(planning):
    scenario = {"horizon_calendar_days": 2, "base_seed": 1, "interventions": [{"kind": "clinic"}]}
    r = run_replication(planning, scenario)
    assert r["scalar_metrics"]["temporary_site_patients_served"] > 0
    assert all(x["ward_staffed"] == 80 for x in r["series"])
    assert all(
        p["care_level"] == "ambulatory"
        for p in r["patients"]
        if any(i["state"] == "clinic_assessment" for i in p["state_intervals"])
    )


def test_update_idempotency_and_branch_preservation(planning):
    d = zero(planning)
    s = {"horizon_calendar_days": 2, "base_seed": 2}
    update = {
        "update_id": "REPORT-1",
        "idempotency_key": "REPORT-1",
        "type": "arrival_batch",
        "effective_at": "2026-10-16T17:00:00Z",
        "payload": {
            "count": 20,
            "entry_stream_id": "ED_MAIN",
            "spread_minutes": 0,
            "care_mix": {"discharge": 1},
        },
    }
    base = run_replication(d, s)
    one = run_replication(d, {**s, "updates": [update]})
    two = run_replication(d, {**s, "updates": [update, update]})
    assert one["scalar_metrics"] == two["scalar_metrics"]
    assert one["scalar_metrics"]["arrivals"] == 20
    assert [e for e in base["events"] if e["elapsed_minutes"] < 720] == [
        e for e in one["events"] if e["elapsed_minutes"] < 720
    ]


def test_import_atomic_validation_and_zip(planning):
    assert dataset_from_zip(dataset_to_zip(planning))["input_sha256"] == planning["input_sha256"]
    bad = copy.deepcopy(planning)
    bad["patients"][1]["slot_id"] = bad["patients"][0]["slot_id"]
    result = validate_dataset(bad)
    assert not result["valid"]
    assert any(e["field"] == "slot_id" for e in result["errors"])


def test_equipment_failure_keeps_patient(stress):
    d = zero(stress)
    event = {
        "type": "equipment_change",
        "update_id": "FAIL-1",
        "effective_at": "2026-10-16T05:01:00Z",
        "payload": {"equipment_pool_id": "EQ-ICU-VENT", "operation": "fail", "quantity": 6},
    }
    r = run_replication(d, {"horizon_calendar_days": 1, "updates": [event]})
    assert r["scalar_metrics"]["equipment_deficit_hours"] > 0
    assert r["scalar_metrics"]["patient_conservation_ok"]
    assert all(
        e["available"] >= 0 for row in r["series"] for u in row["units"] for e in u["equipment"].values()
    )


def test_ensemble_selected_actual_trace(planning):
    rows = [run_replication(zero(planning), {"horizon_calendar_days": 1}, i, False) for i in range(3)]
    out = aggregate_results(rows, {"replications": 3})
    assert out["selected_replication_index"] in (0, 1, 2)
    assert out["replications_completed"] == 3
    assert len(out["daily"]) == 1
    assert paired_improvement(rows, rows)["absolute_change"]["p50"] == 0


def test_selected_replication_branch_preserves_history_and_splits_future(planning):
    scenario = {"horizon_calendar_days": 2, "base_seed": 913}
    parent = run_replication(planning, scenario, replication_index=7)
    branched = {
        **scenario,
        "branch_at": "2026-10-16T17:30:00Z",
        "branch_replication_index": 7,
        "branch_strategy": "selected_replication",
    }
    a = run_replication(planning, branched, replication_index=0)
    b = run_replication(planning, branched, replication_index=1)

    def before(r):
        return [
            (e["elapsed_minutes"], e["event_type"], e["patient_id"], e["from_unit_id"], e["to_unit_id"])
            for e in r["events"]
            if e["elapsed_minutes"] < 750
        ]

    assert before(parent) == before(a) == before(b)
    assert (
        a["scalar_metrics"]["arrivals"] != b["scalar_metrics"]["arrivals"]
        or a["scalar_metrics"]["ed_waiting_patient_hours"] != b["scalar_metrics"]["ed_waiting_patient_hours"]
    )
    assert state_at(a, 749)["patients"] == state_at(b, 749)["patients"]


def test_single_bed_turnover_exact_wait(stress):
    d = zero(stress)
    first = next(p for p in d["patients"] if p["unit_id"] == "UNIT-WARD-A")
    waiting = next(p for p in d["patients"] if p["state"] == "ed_boarding" and p["care_level"] == "ward")
    first["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 60}
    first["resource_requirements"] = []
    d["patients"] = [first, waiting]
    for u in d["units"]:
        if u["kind"] == "ward":
            u["capacity_mode"] = "advertised_aggregate"
            u["advertised_staffed_capacity"] = 0
    target = next(u for u in d["units"] if u["unit_id"] == "UNIT-WARD-A")
    target["capacity_mode"] = "staff_derived"
    for slot in d["slots"]:
        if slot["unit_id"].startswith("UNIT-WARD-"):
            slot["enabled"] = slot["slot_id"] == first["slot_id"]
    r = run_replication(d, {"horizon_calendar_days": 1})
    admission = next(
        e for e in r["events"] if e["event_type"] == "admission" and e["patient_id"] == waiting["patient_id"]
    )
    assert admission["elapsed_minutes"] == 90
    assert r["scalar_metrics"]["inpatient_waiting_patient_hours"] == 1.5
    assert (
        next(s for s in state_at(r, 75)["slots"] if s["slot_id"] == first["slot_id"])["status"] == "cleaning"
    )
    assert (
        next(s for s in state_at(r, 91)["slots"] if s["slot_id"] == first["slot_id"])["patient_id"]
        == waiting["patient_id"]
    )


def test_measurement_cutoff_excludes_inherited_wait(stress):
    d = zero(stress)
    for p in d["patients"]:
        if p["state"] in ("inpatient", "ed_assessment"):
            p["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 100000}
    scenario = {"horizon_calendar_days": 1, "measurement_start_at": "2026-10-16T17:00:00Z"}
    r = run_replication(d, scenario)
    assert r["scalar_metrics"]["inpatient_waiting_patient_hours"] == 14 * 12
    assert r["scalar_metrics"]["time_to_first_shortage_hours"] == 0
    assert r["scalar_metrics"]["patient_conservation_ok"]


def test_staff_loss_does_not_eject(stress):
    d = zero(stress)
    for p in d["patients"]:
        if p["state"] in ("inpatient", "ed_assessment"):
            p["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 100000}
    r = run_replication(
        d,
        {
            "horizon_calendar_days": 1,
            "conditions": [
                {
                    "kind": "staff_unavailability",
                    "unit_id": "UNIT-WARD-A",
                    "count": 2,
                    "start_at": "2026-10-16T05:00:00Z",
                    "end_at": "2026-10-17T05:00:00Z",
                }
            ],
        },
    )
    state = state_at(r, 1)
    u = next(u for u in state["units"] if u["unit_id"] == "UNIT-WARD-A")
    assert u["occupied"] == 32 and u["staffed"] == 24 and u["available"] == 0
    assert r["scalar_metrics"]["patient_conservation_ok"]


def test_custom_clinic_target_and_quantity(planning):
    d = copy.deepcopy(planning)
    facility = next(f for f in d["facilities"] if f["facility_id"] == "FAC-CLINIC-NORTH")
    facility["facility_id"] = "FAC-CUSTOM-CLINIC"
    unit = next(u for u in d["units"] if u["unit_id"] == "UNIT-CLINIC-NORTH")
    unit["unit_id"] = "UNIT-CUSTOM-CLINIC"
    unit["facility_id"] = "FAC-CUSTOM-CLINIC"
    for s in d["slots"]:
        if s["unit_id"] == "UNIT-CLINIC-NORTH":
            s["unit_id"] = "UNIT-CUSTOM-CLINIC"
    r = run_replication(
        d,
        {
            "horizon_calendar_days": 2,
            "interventions": [
                {"kind": "clinic", "facility_id": "FAC-CUSTOM-CLINIC", "nurses": 1, "enabled_slots": 4}
            ],
        },
    )
    assert r["scalar_metrics"]["temporary_site_patients_served"] > 0
    assert any(
        u["unit_id"] == "UNIT-CUSTOM-CLINIC" and u["staffed"] == 4
        for row in r["series"]
        for u in row["units"]
    )
    assert all(
        i["unit_id"] == "UNIT-CUSTOM-CLINIC"
        for p in r["patients"]
        for i in p["state_intervals"]
        if i["state"] == "clinic_assessment"
    )


def test_no_resources_partial_allocation_and_impossible_demand(stress):
    d = zero(stress)
    for p in d["patients"]:
        if p["state"] in ("inpatient", "ed_assessment"):
            p["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 100000}
    r = run_replication(d, {"horizon_calendar_days": 1})
    assert r["scalar_metrics"]["inpatient_waiting_patient_hours"] == 14 * 24
    assert r["scalar_metrics"]["unserved_at_horizon"] == 14
    for u in state_at(r, 100)["units"]:
        assert u["reserved"] == 0
        for e in u["equipment"].values():
            assert e["reserved"] == 0


def test_observed_reset_preserves_explicit_end(planning):
    d = zero(planning)
    d["snapshot_at"] = "2026-10-16T17:00:00Z"
    r = run_replication(
        d,
        {
            "start_at": d["snapshot_at"],
            "state_origin": "observed_reset",
            "end_at": "2026-10-17T05:00:00Z",
            "horizon_calendar_days": 1,
        },
    )
    assert r["horizon_elapsed_minutes"] == 12 * 60
    assert r["end_at"] == "2026-10-17T05:00:00Z"


def test_heatmap_peak_capacity_loss_and_blockers(stress):
    d = zero(stress)
    for p in d["patients"]:
        if p["state"] in ("inpatient", "ed_assessment"):
            p["remaining_stage_spec"] = {"kind": "fixed_minutes", "minutes": 100000}
    r = run_replication(
        d,
        {
            "horizon_calendar_days": 1,
            "conditions": [
                {
                    "kind": "staff_unavailability",
                    "unit_id": "UNIT-WARD-A",
                    "count": 2,
                    "start_at": "2026-10-16T05:15:00Z",
                    "end_at": "2026-10-17T05:00:00Z",
                }
            ],
        },
    )
    assert r["daily"][0]["peak_staffed_utilization"] == 32 / 24
    assert r["daily"][0]["capacity_shortfall_hours"] == 24
    assert r["daily"][0]["ward_peak_occupied"] == 80
    assert r["daily"][0]["ward_end_occupied"] == 80
    assert r["daily"][0]["staff_deficit_hours"] == pytest.approx(8 * 23.75)
    assert r["daily"][0]["capacity_deficit_hours"] == pytest.approx(8 * 23.75)
    assert r["daily"][0]["equipment_deficit_hours"] == 0
    assert r["daily"][0]["blocker_patient_hours"] == dict(r["blocker_patient_hours"])
    summary = aggregate_results([r])
    assert summary["daily"][0]["ward_end_occupied"]["p50"] == 80
    assert summary["daily"][0]["blocker_patient_hours"]["nursing_capacity"]["p50"] > 0
    assert not r["daily"][0]["zero_capacity"]
    patient = next(p for p in state_at(r, 30)["patients"] if p["state"] == "ed_boarding")
    assert "nursing_capacity" in patient["blockers"]
    assert r["blocker_history"]
    assert r["blocker_patient_hours"]["nursing_capacity"] > 0


def test_care_profile_override_targets_new_stream(planning):
    d = zero(planning)
    d["patients"] = []
    d["arrival_profiles"]["ed_arrivals_per_local_day"] = 30
    scenario = {
        "horizon_calendar_days": 1,
        "base_seed": 81,
        "conditions": [
            {
                "kind": "arrival_multiplier",
                "entry_stream_id": "ED_MAIN",
                "surge_percent": 0,
                "care_mix_override": {"RP-ICU-VENTILATED": 1},
            }
        ],
    }
    r = run_replication(d, scenario)
    requests = [e for e in r["events"] if e["event_type"] == "admission_request"]
    assert requests and all(e["reason_code"] == "icu" for e in requests)
    for p in state_at(r, 1440)["patients"]:
        if p["state"] in ("ed_boarding", "inpatient"):
            assert p["inpatient_resource_requirements"] == ["ICU_MONITOR", "VENTILATOR"]


def test_imported_transport_continues_commitments(stress):
    from datetime import timedelta

    for state in ("transfer_reserved", "in_transit"):
        d = zero(stress)
        p = copy.deepcopy(
            next(p for p in d["patients"] if p["state"] == "ed_boarding" and p["care_level"] == "ward")
        )
        p.update(state=state, inpatient_resource_requirements=[], source_type="initial_census")
        destination = next(u for u in d["units"] if u["unit_id"] == "UNIT-EAST-WARD")
        sid = max(s["slot_id"] for s in d["slots"] if s["unit_id"] == destination["unit_id"])
        p["pending_transfer"] = {
            "request_id": "TRANSFER-OBSERVED",
            "requested_at": "2026-10-16T04:45:00Z",
            "planned_departure_at": "2026-10-16T05:10:00Z"
            if state == "transfer_reserved"
            else "2026-10-16T04:55:00Z",
            "planned_arrival_at": "2026-10-16T05:40:00Z",
            "expiry_at": "2026-10-16T06:45:00Z",
            "status": "reserved" if state == "transfer_reserved" else "departed",
            "prior_state": "ed_boarding",
            "destination_unit_id": destination["unit_id"],
            "destination_slot_id": sid,
            "vehicle_id": d["vehicles"][0]["vehicle_id"],
            "remaining_stage_minutes": 200,
        }
        if state == "in_transit":
            p.update(unit_id=None, slot_id=None, unit_entered_at=None, resource_requirements=[])
        d["patients"] = [p]
        valid = validate_dataset(d)
        assert valid["valid"], valid["errors"]
        r = run_replication(d, {"horizon_calendar_days": 1})
        before = state_at(r, 0)
        assert before["patients"][0]["state"] == state
        assert before["inpatient_queue"] == 1
        assert any(s.get("reservation_id") == p["patient_id"] for s in before["slots"])
        after = state_at(r, 40)["patients"][0]
        assert after["state"] == "inpatient" and after["slot_id"] == sid
        assert dt(after["expected_stage_end_at"]) == dt(d["snapshot_at"]) + timedelta(minutes=240)
        assert r["scalar_metrics"]["inpatient_waiting_patient_hours"] == pytest.approx(40 / 60)
        assert r["scalar_metrics"]["patient_conservation_ok"]
        assert not state_at(r, 240)["patients"]


def test_site_ready_exact_staff_and_equipment(planning):
    d = zero(planning)
    active = [
        a["staff_id"]
        for a in d["assignments"]
        if a.get("reserve_pool_id") and dt(a["start_at"]) <= dt(d["snapshot_at"]) < dt(a["end_at"])
    ]
    staff = {p["staff_id"]: p for p in d["staff"]}
    chosen = [
        next(sid for sid in active if staff[sid]["role"] == role) for role in ("rn", "provider", "support")
    ]
    pool = next(p for p in d["equipment_pools"] if p["capability_code"] == "CLINIC_KIT" and p["portable"])
    update = {
        "update_id": "READY-EXPLICIT",
        "type": "site_ready",
        "effective_at": d["snapshot_at"],
        "payload": {
            "facility_id": "FAC-CLINIC-NORTH",
            "enabled_slots": 4,
            "assigned_staff_ids": chosen,
            "equipment_allocations": [{"equipment_pool_id": pool["equipment_pool_id"], "quantity": 4}],
        },
    }
    result = run_replication(d, {"horizon_calendar_days": 1, "updates": [update]})
    unit = next(u for u in state_at(result, 0)["units"] if u["unit_id"] == "UNIT-CLINIC-NORTH")
    assert unit["staffed"] == 4
    assert unit["equipment"]["CLINIC_KIT"]["available"] == 4
    update["payload"]["equipment_allocations"][0]["quantity"] = 3
    with pytest.raises(ValueError, match="kit"):
        run_replication(d, {"horizon_calendar_days": 1, "updates": [update]})


def test_temporary_route_changes_expire_without_overwriting_newer(planning):
    from surge_engine.simulation import HospitalSimulation

    d = zero(planning)
    route = d["routes"][0]
    changes = [
        {
            "update_id": "ROUTE-1",
            "type": "route_change",
            "effective_at": d["snapshot_at"],
            "payload": {
                "route_id": route["route_id"],
                "travel_minutes": 120,
                "until": "2026-10-16T06:00:00Z",
            },
        },
        {
            "update_id": "ROUTE-2",
            "type": "route_change",
            "effective_at": "2026-10-16T05:30:00Z",
            "payload": {"route_id": route["route_id"], "travel_minutes": 90},
        },
    ]
    sim = HospitalSimulation(d, {"horizon_calendar_days": 1, "updates": changes}, 0, True)
    result = sim.run()
    assert sim.routes[(route["from_facility_id"], route["to_facility_id"])]["travel_minutes"] == 90
    assert any(e["event_type"] == "route_restored" and e["elapsed_minutes"] == 60 for e in result["events"])


def test_observed_reset_partial_day_uses_partial_arrival_exposure(planning):
    d = copy.deepcopy(planning)
    d["snapshot_at"] = "2026-10-16T17:30:00Z"
    d["patients"] = []
    d["arrival_profiles"]["hour_weights"] = [1 / 24] * 24
    d["arrival_profiles"]["weekday_weights"] = [1] * 7
    for stream in d["entry_streams"]:
        stream["hour_weights"] = [1 / 24] * 24
        stream["weekday_weights"] = [1] * 7
    r = run_replication(
        d,
        {
            "horizon_calendar_days": 1,
            "state_origin": "observed_reset",
            "start_at": d["snapshot_at"],
            "end_at": "2026-10-17T05:00:00Z",
        },
        keep_trace=False,
    )
    assert r["horizon_elapsed_minutes"] == 11.5 * 60
    assert r["scalar_metrics"]["expected_arrivals"] == pytest.approx(
        (
            d["arrival_profiles"]["ed_arrivals_per_local_day"]
            + d["arrival_profiles"]["direct_ward_arrivals_per_local_day"]
        )
        * 11.5
        / 24
    )


def test_hourly_checkpoint_index_reconstructs_exact_ledger(stress):
    result = run_replication(zero(stress), {"horizon_calendar_days": 2, "base_seed": 17})
    checkpoints = result["checkpoints"]
    assert checkpoints[0]["elapsed_minutes"] == 0
    assert checkpoints[-1]["elapsed_minutes"] == result["horizon_elapsed_minutes"]
    assert all(b["elapsed_minutes"] - a["elapsed_minutes"] <= 60 for a, b in pairwise(checkpoints))
    for checkpoint in checkpoints:
        assert checkpoint["state_encoding"] == "interval-ledger-v1"
        assert "patients" not in checkpoint  # shared ledger, not duplicated lifetime history
        state = state_at(result, checkpoint["at"])
        row = next(r for r in result["series"] if r["elapsed_minutes"] == checkpoint["elapsed_minutes"])
        assert state["inpatient_queue"] == row["inpatient_queue"]
        for unit in state["units"]:
            stored = next(u for u in row["units"] if u["unit_id"] == unit["unit_id"])
            assert unit["occupied"] == stored["occupied"]
            assert unit["reserved"] == stored["reserved"]


def test_arrival_preflight_matches_engine_exposure(planning):
    for conditions in (
        [],
        [{"kind": "arrival_multiplier", "shape": "wave", "surge_percent": 70, "entry_stream_id": "ED_MAIN"}],
    ):
        scenario = {"horizon_calendar_days": 30, "conditions": conditions}
        expected = estimate_expected_arrivals(planning, scenario)
        result = run_replication(planning, scenario, keep_trace=False)
        assert expected == result["scalar_metrics"]["expected_arrivals"]
    data = copy.deepcopy(planning)
    data["snapshot_at"] = "2026-10-16T17:30:00Z"
    scenario = {
        "horizon_calendar_days": 1,
        "start_at": data["snapshot_at"],
        "end_at": "2026-10-17T05:00:00Z",
        "state_origin": "observed_reset",
    }
    assert estimate_expected_arrivals(data, scenario) < estimate_expected_arrivals(
        planning, {"horizon_calendar_days": 1}
    )


def test_concurrent_reserve_matching_uses_qualified_people_atomically(planning):
    data = zero(planning)
    nurses = sorted(
        s["staff_id"] for s in data["staff"] if s["employment_pool"] == "reserve" and s["role"] == "rn"
    )
    for index, sid in enumerate(nurses):
        person = next(s for s in data["staff"] if s["staff_id"] == sid)
        person["capabilities"] = ["WARD_NURSING"] + (["CLINIC_NURSING"] if index % 5 >= 3 else [])
    result = run_replication(
        data,
        {
            "horizon_calendar_days": 1,
            "interventions": [
                {
                    "id": "A-CLINIC",
                    "kind": "clinic",
                    "nurses": 2,
                    "enabled_slots": 8,
                    "activation_minutes": 0,
                },
                {"id": "B-WARD", "kind": "staff_existing", "nurses": 3, "activation_minutes": 0},
            ],
        },
    )
    assert all(plan["status"] == "active" for plan in result["interventions"])
    for at in (1, 12 * 60, 23 * 60):
        state = state_at(result, at)
        clinic = next(u for u in state["units"] if u["unit_id"] == "UNIT-CLINIC-NORTH")
        assert clinic["staffed"] == 8
        ward = sum(
            u["staffed"] for u in state["units"] if u["facility_id"] == "FAC-MAIN" and u["kind"] == "ward"
        )
        assert ward == 92
