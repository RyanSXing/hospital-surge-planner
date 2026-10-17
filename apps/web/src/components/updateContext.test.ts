import { describe, expect, it } from "vitest";
import type { PlanningContext } from "../types";
import { updateDefaults } from "./updateContext";

const context = {
  selectedTime: "2026-11-01T07:30:17.250Z",
  selectedFacility: "FAC-A",
  selectedUnit: "",
  selectedPatient: null,
  selectedResource: null,
  dataset: {
    id: "frozen-dataset",
    snapshot_at: "2026-10-16T05:00:00Z",
    facilities: [{ facility_id: "FAC-A" }],
    units: [
      { unit_id: "WARD-A", facility_id: "FAC-A", enabled_capacity: 20 },
      {
        unit_id: "PARTNER-WARD",
        facility_id: "PARTNER",
        capacity_mode: "advertised_aggregate",
        advertised_staffed_capacity: 12,
      },
    ],
    equipment_pools: [
      { equipment_pool_id: "POOL-A", facility_id: "FAC-A" },
      { equipment_pool_id: "POOL-P", facility_id: "PARTNER" },
    ],
    staff: [{ staff_id: "S-P", home_unit_id: "WARD-A" }],
    slots: [{ slot_id: "BED-P", unit_id: "PARTNER-WARD" }],
    routes: [{ route_id: "ROUTE-P", travel_minutes: 37 }],
    patients: [],
  },
  state: {
    units: [
      {
        unit_id: "PARTNER-WARD",
        facility_id: "PARTNER",
        advertised_staffed_capacity: 9,
        active_staff_ids: ["S-P"],
      },
    ],
    equipment_pools: [
      { equipment_pool_id: "SPLIT-POOL", facility_id: "PARTNER" },
    ],
  },
} as unknown as PlanningContext;

describe("inspector update drafts", () => {
  it("uses the selected unit's recorded capacity and exact timestamp, not default Ward A", () => {
    expect(
      updateDefaults(context, { kind: "unit", id: "PARTNER-WARD" }),
    ).toMatchObject({
      type: "advertised_capacity_change",
      unit: "PARTNER-WARD",
      facility: "PARTNER",
      count: 9,
      effectiveAt: "2026-11-01T07:30:17.250Z",
    });
    expect(
      updateDefaults(context, { kind: "slot", id: "BED-P" }),
    ).toMatchObject({ unit: "PARTNER-WARD", count: 9 });
  });
  it("targets the selected staff identity at its recorded assignment", () => {
    expect(updateDefaults(context, { kind: "staff", id: "S-P" })).toMatchObject(
      {
        type: "staff_unavailable",
        staffIds: ["S-P"],
        count: 1,
        unit: "PARTNER-WARD",
        facility: "PARTNER",
      },
    );
  });
  it("retains equipment and route identity instead of substituting first inventory rows", () => {
    expect(
      updateDefaults(context, { kind: "equipment_pool", id: "POOL-P" }),
    ).toMatchObject({
      type: "equipment_change",
      equipment: "POOL-P",
      facility: "PARTNER",
      observedReset: false,
    });
    expect(
      updateDefaults(context, { kind: "route", id: "ROUTE-P" }),
    ).toMatchObject({ type: "route_change", route: "ROUTE-P", count: 37 });
  });
  it("does not pretend generated inventory or vehicles have editable snapshot rows", () => {
    expect(
      updateDefaults(context, { kind: "equipment_pool", id: "SPLIT-POOL" }),
    ).toMatchObject({ equipment: "SPLIT-POOL", observedReset: true });
    expect(
      updateDefaults(context, { kind: "vehicle", id: "V-1" }),
    ).toMatchObject({
      target: { kind: "vehicle", id: "V-1" },
      observedReset: true,
    });
  });
  it("keeps an explicitly selected patient even outside a bounded census", () => {
    expect(
      updateDefaults(
        { ...context, selectedPatient: { patient_id: "P1200" } },
        { kind: "patient", id: "P1200" },
      ),
    ).toMatchObject({ type: "patient_departure", person: "P1200" });
    expect(updateDefaults(context)).toMatchObject({
      type: "arrival_batch",
      target: null,
    });
  });
});
