"""The default hospital is a usable canonical model, not a decorative fixture."""
from surge_api.domain import scenario_defaults, validate_scenario
from surge_engine import generate_dataset, run_replication, state_at, validate_dataset


def test_single_hospital_has_feasible_census_and_complete_reserve_inventory():
    data = generate_dataset("hospital_baseline", days=7)
    validation = validate_dataset(data)
    assert validation["valid"], validation["errors"]
    assert data["input_sha256"] == generate_dataset("hospital_baseline", days=7)["input_sha256"]
    assert [f["facility_id"] for f in data["facilities"]] == ["FAC-MAIN"]
    assert {u["kind"] for u in data["units"]} == {"ward", "icu", "ed"}
    assert not data["routes"] and not data["vehicles"] and not data["partner_equipment"]
    assert not data["clinic_policies"]
    assert not any(p["eligible_for_transfer"] for p in data["patients"])
    assert all(p["clinic_policy_id"] is None for p in data["pathway_profiles"])
    assert all(row["capacity_deficit"] == 0 and row["available"] > 0 for row in validation["capacity_reconciliation"])
    assert len([s for s in data["slots"] if s["installation_status"] == "planned"]) == 12
    assert all(s["unit_id"] == "UNIT-WARD-C" for s in data["slots"] if s["installation_status"] == "planned")
    scenario = scenario_defaults({"name": "demo", "horizon_calendar_days": 7, "replications": 10}, data)
    assert validate_scenario(scenario, data)["valid"]


def test_single_hospital_runs_and_opens_only_internal_beds_with_real_staff_limits():
    data = generate_dataset("hospital_baseline", days=2)
    scenario = {"horizon_calendar_days": 1, "base_seed": 20261016}
    base = run_replication(data, scenario)
    assert base["scalar_metrics"]["patient_conservation_ok"]
    assert all(u["facility_id"] == "FAC-MAIN" for u in state_at(base, 0)["units"])
    response = run_replication(data, {**scenario, "interventions": [{
        "kind": "staffed_overflow", "facility_id": "FAC-MAIN", "unit_id": "UNIT-WARD-C",
        "enabled_slots": 32, "nurses": 3, "providers": 1, "support": 1,
        "activation_minutes": 60,
    }]})
    assert response["scalar_metrics"]["patient_conservation_ok"]
    after = next(u for u in state_at(response, 120)["units"] if u["unit_id"] == "UNIT-WARD-C")
    assert after["physical"] == 32
    assert after["staffed"] == 28
    assert {u["facility_id"] for u in state_at(response, 120)["units"]} == {"FAC-MAIN"}
