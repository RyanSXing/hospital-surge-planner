"""Static lookup caches must preserve complete event, state and metric outputs."""

from unittest.mock import patch

import pytest
from engine_hotloop_cases import CASES, make_case
from surge_engine import generate_dataset, run_replication, simulation
from surge_engine.simulation import HospitalSimulation


class UnindexedSimulation(HospitalSimulation):
    """Reference lookups rebuild directly from live records on every access."""

    @property
    def _ordered_units(self):
        return tuple(sorted(self.units.values(), key=lambda u: u["unit_id"]))

    @_ordered_units.setter
    def _ordered_units(self, _value):
        pass

    @property
    def _staff_units_by_kind(self):
        return {
            kind: tuple(
                u for u in self.units.values() if u["kind"] == kind and u["capacity_mode"] == "staff_derived"
            )
            for kind in ("ward", "icu", "ed")
        }

    @_staff_units_by_kind.setter
    def _staff_units_by_kind(self, _value):
        pass

    @property
    def _ordered_staff_units_by_kind(self):
        return {
            kind: tuple(sorted(units, key=lambda u: u["unit_id"]))
            for kind, units in self._staff_units_by_kind.items()
        }

    @_ordered_staff_units_by_kind.setter
    def _ordered_staff_units_by_kind(self, _value):
        pass

    @property
    def _main_care_units(self):
        main = self.data.get("entry_streams", [{"destination_facility_id": "FAC-MAIN"}])[0].get(
            "destination_facility_id", "FAC-MAIN"
        )
        return tuple(
            u for u in self.units.values() if u["facility_id"] == main and u["kind"] in ("ward", "icu", "ed")
        )

    @_main_care_units.setter
    def _main_care_units(self, _value):
        pass

    @property
    def _reserve_staff_count(self):
        return sum(
            sum(self.staff[s]["employment_pool"] == "reserve" for s in u["active_staff"])
            for u in self.units.values()
        )

    @_reserve_staff_count.setter
    def _reserve_staff_count(self, _value):
        pass

    def equipment_candidates(self, unit, cap):
        return sorted(
            (
                pool
                for pool in self.pools.values()
                if pool.get("unit_id") == unit and pool["capability_code"] == cap
            ),
            key=lambda pool: pool["equipment_pool_id"],
        )


@pytest.mark.parametrize("case", CASES)
def test_loop_indices_preserve_full_output_against_fresh_record_lookups(case):
    dataset, scenario, index = make_case(case)
    with patch.object(simulation, "HospitalSimulation", UnindexedSimulation):
        expected = run_replication(dataset, scenario, index)
    actual = run_replication(dataset, scenario, index)
    assert actual == expected


def test_equipment_index_tracks_new_relocated_pools_and_live_availability():
    sim = HospitalSimulation(generate_dataset(days=1), {"horizon_calendar_days": 1}, 0, True)
    target, cap = "UNIT-CLINIC-NORTH", "CLINIC_KIT"
    assert not sim.equipment_candidates(target, cap)
    sim.relocate_equipment("EQ-RES-CLINIC-KIT", target, 3)
    pools = sim.equipment_candidates(target, cap)
    assert len(pools) == 1 and pools[0]["quantity"] == 3
    sim.relocate_equipment("EQ-RES-CLINIC-KIT", target, 2)
    assert len(sim.equipment_candidates(target, cap)) == 1 and pools[0]["quantity"] == 5
    pools[0]["in_use"]["test-patient"] = 4
    assert sim.equipment_bundle(target, [{"capability_code": cap, "quantity": 2}]) is None
    pools[0]["in_use"].clear()
    assert sim.equipment_bundle(target, [{"capability_code": cap, "quantity": 2}]) == [
        (pools[0]["equipment_pool_id"], 2)
    ]
    second = "UNIT-OVERFLOW-SOUTH"
    assert not sim.equipment_candidates(second, cap)
    sim.relocate_equipment(pools[0]["equipment_pool_id"], second, 1)
    assert sim.equipment_candidates(second, cap)[0]["quantity"] == 1
    assert sim.equipment_candidates(target, cap)[0]["quantity"] == 4
