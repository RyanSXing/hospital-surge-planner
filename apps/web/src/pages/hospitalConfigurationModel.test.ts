import { describe, expect, it } from "vitest";
import type { Dataset } from "../types";
import {
  applyConfigurationInputs,
  configurationTargets,
  minimumPhysicalBeds,
  scheduledStaff,
  staffedBedReadback,
} from "./hospitalConfigurationModel";
const dataset = (): Dataset => ({
  id: "D",
  fixture: "hospital_baseline",
  snapshot_at: "2026-10-16T05:00:00Z",
  timezone: "America/Chicago",
  facilities: [{ facility_id: "FAC-MAIN", kind: "hospital" }],
  units: [
    {
      unit_id: "WARD",
      name: "Ward",
      facility_id: "FAC-MAIN",
      kind: "ward",
      capacity_mode: "staff_derived",
      physical_capacity: 8,
      enabled_capacity: 8,
      baseline_staff: { rn: 2, provider: 1, support: 1 },
      capacity_policy_id: "POL",
    },
  ],
  patients: [
    { patient_id: "P", unit_id: "WARD", slot_id: "S1", state: "inpatient" },
    {
      patient_id: "T",
      state: "in_transit",
      pending_transfer: { destination_slot_id: "S2" },
    },
  ],
  slots: [
    { slot_id: "S1", unit_id: "WARD", status: "occupied" },
    { slot_id: "S2", unit_id: "WARD", status: "reserved" },
  ],
  staff: [
    { staff_id: "RN", role: "rn", capabilities: ["WARD_NURSING"] },
    { staff_id: "DR", role: "provider", capabilities: ["WARD_PROVIDER"] },
  ],
  equipment_pools: [],
  capacity_policies: [
    {
      capacity_policy_id: "POL",
      slots_per_nurse: 4,
      minimum_provider_count: 1,
      minimum_support_count: 1,
    },
  ],
});
const draft = () => ({
  conditions: [
    { id: "care", kind: "care_mix_override", weights: { "custom-cohort": 1 } },
    {
      id: "stay",
      kind: "stage_duration_multiplier",
      stage_kind: "ward",
      multiplier: 1.2,
    },
  ],
  interventions: [{ id: "existing", kind: "staff_existing", nurses: 1 }],
  updates: [
    { id: "equipment", type: "equipment_change", payload: { quantity: 2 } },
  ],
});
describe("main configuration inputs", () => {
  it("serializes editable stock and all real staff roles as canonical start settings without mutating source inputs", () => {
    const data = dataset(),
      before = JSON.stringify(data),
      original = draft(),
      prior = JSON.stringify(original);
    const next = applyConfigurationInputs(data, original, {
      units: {
        WARD: {
          physical_capacity: 20,
          enabled_capacity: 20,
          staffed_capacity: 15,
          rn: 4,
          provider: 3,
          support: 2,
        },
      },
    });
    expect(next.conditions.at(-1)).toMatchObject({
      kind: "unit_configuration",
      unit_id: "WARD",
      physical_capacity: 20,
      enabled_capacity: 20,
      staffed_capacity: 15,
      staff_counts: { rn: 4, provider: 3, support: 2 },
    });
    expect(next.conditions.slice(0, 2)).toEqual(original.conditions);
    expect(next.interventions).toEqual(original.interventions);
    expect(next.updates).toEqual(original.updates);
    expect(JSON.stringify(data)).toBe(before);
    expect(JSON.stringify(original)).toBe(prior);
  });
  it("round-trips loaded canonical controls byte-for-byte until edited", () => {
    const original = {
      ...draft(),
      conditions: [
        ...draft().conditions,
        {
          id: "imported",
          kind: "unit_configuration",
          unit_id: "WARD",
          physical_capacity: 20,
          enabled_capacity: 15,
          staff_counts: { rn: 3 },
          source: "user_assumption",
          custom_note: "retain",
        },
      ],
    };
    const targets = configurationTargets(original);
    expect(targets.units.WARD).toEqual({
      physical_capacity: 20,
      enabled_capacity: 15,
      rn: 3,
    });
    expect(applyConfigurationInputs(dataset(), original, targets)).toEqual(
      original,
    );
    const next = applyConfigurationInputs(dataset(), original, {
      units: { WARD: { ...targets.units.WARD, provider: 0 } },
    });
    expect(next.conditions.at(-1)).toMatchObject({
      id: "imported",
      custom_note: "retain",
      enabled_capacity: 15,
      staff_counts: { rn: 3, provider: 0 },
    });
  });
  it("allows staff shortages below the census but never removes occupied or reserved places", () => {
    const data = dataset();
    expect(minimumPhysicalBeds(data, data.units[0])).toBe(2);
    expect(() =>
      applyConfigurationInputs(data, draft(), {
        units: { WARD: { physical_capacity: 1 } },
      }),
    ).toThrow("occupied inventory");
    expect(() =>
      applyConfigurationInputs(data, draft(), {
        units: {
          WARD: { staffed_capacity: 0, rn: 0, provider: 0, support: 0 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      applyConfigurationInputs(data, draft(), {
        units: { WARD: { staffed_capacity: 9 } },
      }),
    ).toThrow("available beds");
  });
  it("reports nurse, equipment, and admission gate limits rather than promising the target", () => {
    const data = dataset(),
      unit = data.units[0],
      base = { rn: 2, provider: 1, support: 1 };
    expect(
      staffedBedReadback(data, unit, { staffed_capacity: 7, rn: 1 }, base),
    ).toEqual({ supported: 4, usable: 4, gate: true });
    expect(staffedBedReadback(data, unit, { provider: 0 }, base).usable).toBe(
      0,
    );
    data.capacity_policies[0].per_slot_resources = [
      { capability_code: "KIT", quantity: 1 },
    ];
    data.equipment_pools = [
      {
        unit_id: "WARD",
        capability_code: "KIT",
        quantity: 5,
        unserviceable_quantity: 1,
      },
    ];
    expect(staffedBedReadback(data, unit, {}, base).usable).toBe(4);
  });
  it("uses the active shift rather than counting the whole rotating roster", () => {
    const data = dataset();
    data.staff_assignments = [
      {
        staff_id: "RN",
        unit_id: "WARD",
        start_at: "2026-10-16T00:00:00Z",
        end_at: "2026-10-16T12:00:00Z",
      },
      {
        staff_id: "DR",
        unit_id: "WARD",
        start_at: "2026-10-16T12:00:00Z",
        end_at: "2026-10-17T00:00:00Z",
      },
    ];
    expect(scheduledStaff(data, data.units[0], data.snapshot_at)).toEqual({
      rn: 1,
      provider: 0,
      support: 0,
    });
  });
  it("adds repeated per-bed requirements before dividing the available equipment", () => {
    const data = dataset();
    data.capacity_policies[0].per_slot_resources = [
      { capability_code: "KIT", quantity: 1 },
      { capability_code: "KIT", quantity: 1 },
    ];
    data.equipment_pools = [
      { unit_id: "WARD", capability_code: "KIT", quantity: 8 },
    ];
    expect(
      staffedBedReadback(
        data,
        data.units[0],
        {},
        { rn: 2, provider: 1, support: 1 },
      ),
    ).toEqual({ supported: 4, usable: 4, gate: true });
  });
  it("excludes unavailable and unqualified assignments from supported staffing", () => {
    const data = dataset();
    data.staff.push({
      staff_id: "OTHER-RN",
      role: "rn",
      capabilities: ["ICU_NURSING"],
    });
    data.staff_assignments = [
      {
        staff_id: "RN",
        unit_id: "WARD",
        status: "unavailable",
        start_at: "2026-10-16T00:00:00Z",
        end_at: "2026-10-17T00:00:00Z",
      },
      {
        staff_id: "OTHER-RN",
        unit_id: "WARD",
        start_at: "2026-10-16T00:00:00Z",
        end_at: "2026-10-17T00:00:00Z",
      },
    ];
    expect(scheduledStaff(data, data.units[0], data.snapshot_at)).toEqual({
      rn: 0,
      provider: 0,
      support: 0,
    });
  });
});
