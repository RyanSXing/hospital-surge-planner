"""Shared exact-output scenarios for loop-index tests and historical benchmarks."""

from surge_engine import generate_dataset

CASES = ("planning", "stress", "resources", "branch", "reset", "dst", "care_mix")


def make_case(name):
    days = 21 if name == "dst" else 3
    dataset = generate_dataset(
        "stress_snapshot" if name in {"stress", "resources"} else "planning_baseline", days=days
    )
    scenario = {
        "horizon_calendar_days": days,
        "base_seed": 41021,
        "conditions": [{"kind": "arrival_multiplier", "surge_percent": 70}],
    }
    index = 0
    if name == "planning":
        dataset["units"].reverse()  # Static allocation ordering must remain by unit ID.
    if name == "resources":
        scenario["interventions"] = [
            {"id": "clinic", "kind": "clinic", "nurses": 2, "enabled_slots": 8, "activation_minutes": 60},
            {"id": "transport", "kind": "partner_transfer", "activation_minutes": 120},
            {"id": "nurses", "kind": "staff_existing", "nurses": 3, "activation_minutes": 180},
        ]
        scenario["conditions"].append(
            {
                "kind": "staff_unavailability",
                "unit_id": "UNIT-WARD-A",
                "count": 2,
                "start_at": "2026-10-16T10:00:00Z",
                "end_at": "2026-10-16T15:00:00Z",
            }
        )
        scenario["updates"] = [
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
        ]
    if name == "branch":
        scenario.update(
            branch_strategy="selected_replication",
            branch_at="2026-10-17T05:00:00Z",
            branch_replication_index=7,
        )
        index = 1
    if name == "reset":
        dataset["snapshot_at"] = "2026-10-16T17:30:00Z"
        scenario.update(
            start_at=dataset["snapshot_at"],
            state_origin="observed_reset",
            end_at="2026-10-17T05:00:00Z",
            horizon_calendar_days=1,
        )
    if name == "care_mix":
        scenario["conditions"][0]["care_mix_override"] = {"discharge": 0.7, "ward": 0.25, "icu": 0.05}
        scenario["conditions"].append(
            {
                "kind": "care_mix_override",
                "start_at": "2026-10-16T10:00:00Z",
                "end_at": "2026-10-17T15:00:00Z",
                "weights": {"discharge": 0.6, "ward": 0.3, "icu": 0.1},
            }
        )
    return dataset, scenario, index
