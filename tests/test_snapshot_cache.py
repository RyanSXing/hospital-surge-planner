"""Exact trace oracle for skipping unchanged public snapshot construction."""

from unittest.mock import patch

import pytest
from surge_engine import generate_dataset, run_replication, state_at
from surge_engine.simulation import HospitalSimulation

cached_update_blockers = HospitalSimulation.update_blockers


def uncached_update_blockers(sim):
    sim._blocker_inputs.clear()
    cached_update_blockers(sim)


def uncached_record_state(sim):
    """Pre-optimization recorder: build every public state at every event."""
    if not sim.keep:
        return
    for uid, unit in sim.units.items():
        snap = sim.unit_snapshot(unit)
        if snap != sim.last_unit_snapshots.get(uid):
            sim.unit_history[uid].append(dict(at=sim.at(sim.now), elapsed_minutes=sim.now, **snap))
            sim.last_unit_snapshots[uid] = snap
    for sid, slot in sim.slots.items():
        snap = sim.slot_snapshot(slot)
        if snap != sim.last_slot_snapshots.get(sid):
            sim.slot_history[sid].append(dict(at=sim.at(sim.now), elapsed_minutes=sim.now, **snap))
            sim.last_slot_snapshots[sid] = snap
    for vid, vehicle in sim.vehicles.items():
        snap = {
            "vehicle_id": vid,
            "location": vehicle["location"],
            "available_at": sim.at(vehicle["available_at"]),
            "mission": vehicle["mission"],
        }
        if snap != sim.last_vehicle_snapshots.get(vid):
            sim.vehicle_history[vid].append(dict(at=sim.at(sim.now), elapsed_minutes=sim.now, **snap))
            sim.last_vehicle_snapshots[vid] = snap
    for pool_id, pool in sim.pools.items():
        snap = sim.equipment_pool_snapshot(pool)
        if snap != sim.last_equipment_pool_snapshots.get(pool_id):
            sim.equipment_pool_history[pool_id].append(
                dict(at=sim.at(sim.now), elapsed_minutes=sim.now, **snap)
            )
            sim.last_equipment_pool_snapshots[pool_id] = snap


@pytest.mark.parametrize("fixture", ["planning_baseline", "stress_snapshot"])
def test_cached_recorder_preserves_complete_trace_and_reconstruction(fixture):
    dataset = generate_dataset(fixture, days=3)
    scenario = {
        "horizon_calendar_days": 3,
        "base_seed": 41021,
        "conditions": [{"kind": "arrival_multiplier", "surge_percent": 70}],
        "interventions": [
            {"id": "clinic", "kind": "clinic", "nurses": 2, "enabled_slots": 8, "activation_minutes": 60},
            {"id": "transport", "kind": "partner_transfer", "activation_minutes": 120},
        ],
        "updates": [
            {
                "update_id": "equipment-fails",
                "type": "equipment_change",
                "effective_at": "2026-10-16T08:00:00Z",
                "payload": {"equipment_pool_id": "EQ-ICU-VENT", "operation": "fail", "quantity": 3},
            },
            {
                "update_id": "equipment-recovers",
                "type": "equipment_change",
                "effective_at": "2026-10-17T08:00:00Z",
                "payload": {"equipment_pool_id": "EQ-ICU-VENT", "operation": "repair", "quantity": 3},
            },
        ],
    }
    with (
        patch.object(HospitalSimulation, "record_state", uncached_record_state),
        patch.object(HospitalSimulation, "update_blockers", uncached_update_blockers),
    ):
        expected = run_replication(dataset, scenario)
    actual = run_replication(dataset, scenario)
    assert actual == expected
    for checkpoint in actual["checkpoints"]:
        assert state_at(actual, checkpoint["at"]) == state_at(expected, checkpoint["at"])


def test_same_occupancy_slot_swap_and_context_changes_are_not_hidden():
    dataset = generate_dataset(days=1)
    sim = HospitalSimulation(dataset, {"horizon_calendar_days": 1}, 0, True)
    occupied = [s for s in sim.slots.values() if s.get("patient_id")]
    first = occupied[0]
    second = next(s for s in occupied if s["unit_id"] == first["unit_id"] and s is not first)
    before = len(sim.slot_history[first["slot_id"]])
    first["patient_id"], second["patient_id"] = second["patient_id"], first["patient_id"]
    sim.now += 1
    sim.record_state()
    assert len(sim.slot_history[first["slot_id"]]) == before + 1
    assert sim.last_slot_snapshots[first["slot_id"]]["patient_id"] == first["patient_id"]
    unit = sim.units[first["unit_id"]]
    ready = next(s for s in unit["slots"] if s in unit["_ready"])
    unit["_ready"].remove(ready)
    unit["cleaning"][ready] = sim.now + 30
    sim.record_state()
    assert sim.last_slot_snapshots[ready]["status"] == "cleaning"
    unit["cleaning"][ready] += 10
    sim.record_state()
    assert sim.last_slot_snapshots[ready]["cleaning_end_at"] == sim.at(sim.now + 40)


def test_unchanged_event_does_not_rebuild_public_snapshots(monkeypatch):
    sim = HospitalSimulation(generate_dataset(days=1), {"horizon_calendar_days": 1}, 0, True)

    def unexpected(*args):
        raise AssertionError("Unchanged state rebuilt a public snapshot")

    monkeypatch.setattr(sim, "slot_snapshot", unexpected)
    monkeypatch.setattr(sim, "unit_snapshot", unexpected)
    monkeypatch.setattr(sim, "equipment_pool_snapshot", unexpected)
    sim.now += 1
    sim.record_state()
    sim.sample()


def test_blocker_counts_update_without_recomputing_unchanged_reasons(monkeypatch):
    sim = HospitalSimulation(
        generate_dataset("stress_snapshot", days=1), {"horizon_calendar_days": 1}, 0, True
    )
    sim.update_blockers()
    group, members = next((group, members) for group, members in sim.queue_members.items() if members)
    kind, profile = group
    key = kind + ":" + ",".join(profile)
    initial_count = sim.current_blockers[key]["patient_count"]
    initial_history = len(sim.blocker_history[key])

    def unexpected(*args):
        raise AssertionError("Unchanged resources recomputed blocker eligibility")

    monkeypatch.setattr(sim, "equipment_bundle", unexpected)
    members.add("ADDITIONAL-WAITING-PATIENT")
    sim.update_blockers()
    assert sim.current_blockers[key]["patient_count"] == initial_count + 1
    assert len(sim.blocker_history[key]) == initial_history
