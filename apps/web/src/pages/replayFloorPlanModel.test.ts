import { describe, expect, it } from "vitest";
import {
  buildReplayFloorPlan,
  dischargeHistoryPath,
} from "./replayFloorPlanModel";
import type { Entity } from "../types";

const at = "2026-10-16T05:00:00Z";
const units = [
  ["WARD-A", "Ward A", "ward"],
  ["WARD-B", "Ward B", "ward"],
  ["WARD-C", "Ward C", "ward"],
  ["ICU", "Intensive care", "icu"],
  ["ED", "Emergency department", "ed"],
].map(([unit_id, name, kind]) => ({
  unit_id,
  name,
  kind,
  facility_id: "FAC-MAIN",
}));
const dataset = {
  units: [
    ...units,
    {
      unit_id: "OFFSITE",
      kind: "ward",
      facility_id: "FAC-OTHER",
      name: "Other hospital",
    },
  ],
  slots: [{ slot_id: "OLD", unit_id: "WARD-A" }],
};
function fixture(): Entity {
  return {
    at,
    replication_id: "rep-7",
    patients: [],
    units: units.map((unit) => ({
      ...unit,
      physical: 3,
      enabled: 3,
      staffed: 3,
      occupied: 1,
      available: 2,
      active: true,
      admission_gate: true,
      qualified_staff_by_role: { rn: 1 },
    })),
    slots: units.flatMap((unit) =>
      [1, 2, 3].map((n) => ({
        slot_id: `${unit.unit_id}-${n}`,
        unit_id: unit.unit_id,
        display_label: `Bed ${n}`,
        status: n === 1 ? "occupied" : "ready",
        enabled: true,
      })),
    ),
    patient_counts: { by_facility: { "FAC-MAIN": 700 } },
    queue_counts: { "FAC-MAIN": { ed: 630, total: 35 } },
    flow_counts: {
      "FAC-MAIN": { arrivals: 800, discharges: 100 },
      "FAC-OTHER": { discharges: 800 },
    },
    blocker_counts_by_unit: {},
    partial_collections: ["patients"],
  };
}

describe("recorded hospital floor plan", () => {
  it("separates all actual wards, ICU and ED and excludes other facilities", () => {
    const state = fixture(),
      original = JSON.stringify([dataset, state]);
    const plan = buildReplayFloorPlan(dataset, state);
    expect(plan.units.map((unit) => unit.id)).toEqual([
      "WARD-A",
      "WARD-B",
      "WARD-C",
      "ED",
      "ICU",
    ]);
    expect(plan.units.map((unit) => unit.name)).toContain("Ward B");
    expect(plan.units.flatMap((unit) => unit.beds)).toHaveLength(15);
    expect(JSON.stringify([dataset, state])).toBe(original);
    expect(plan.at).toBe(at);
    expect(plan.replicationId).toBe("rep-7");
  });
  it("uses complete exact slots despite a bounded patient sample, and keeps patient identity", () => {
    const state = fixture();
    state.slots[0].patient_id = "OUTSIDE-SAMPLE";
    state.slots[1].background_occupied = true;
    const plan = buildReplayFloorPlan(dataset, state);
    expect(plan.units[0].beds[0]).toMatchObject({
      id: "WARD-A-1",
      patientId: "OUTSIDE-SAMPLE",
      patient: null,
      status: "occupied",
    });
    expect(plan.units[0].beds[1].status).toBe("occupied");
    expect(plan).toMatchObject({
      total: 700,
      edWaiting: 630,
      bedWaiting: 35,
      discharges: 100,
    });
  });
  it("does not reconstruct removed inventory from baseline when runtime slots is empty", () => {
    const state = fixture();
    state.slots = [];
    expect(
      buildReplayFloorPlan(dataset, state).units.flatMap((unit) => unit.beds),
    ).toEqual([]);
  });
  it("does not report baseline slot states as a current recorded state", () => {
    const plan = buildReplayFloorPlan(dataset, null);
    expect(plan.units[0].beds).toEqual([]);
    expect(plan.units[0].occupied).toBeNull();
    expect(plan.units[0].pressure).toBeNull();
    expect(plan.total).toBeNull();
    expect(plan.edWaiting).toBeNull();
    expect(plan.bedWaiting).toBeNull();
    expect(plan.discharges).toBeNull();
  });
  it("keeps installed states distinct and omits planned or removed places from current beds", () => {
    const state = fixture();
    state.slots = [
      {
        slot_id: "RES",
        unit_id: "WARD-A",
        status: "reserved",
        reservation_id: "P1",
        enabled: true,
      },
      {
        slot_id: "CLEAN",
        unit_id: "WARD-A",
        status: "cleaning",
        enabled: true,
      },
      {
        slot_id: "BLOCK",
        unit_id: "WARD-A",
        status: "disabled",
        enabled: false,
      },
      {
        slot_id: "PLAN",
        unit_id: "WARD-A",
        status: "disabled",
        installation_status: "planned",
      },
      {
        slot_id: "REMOVED",
        unit_id: "WARD-A",
        status: "disabled",
        installation_status: "removed",
      },
      { slot_id: "UNKNOWN", unit_id: "WARD-A", enabled: true },
    ];
    expect(
      Object.fromEntries(
        buildReplayFloorPlan(dataset, state).units[0].beds.map((bed) => [
          bed.id,
          bed.status,
        ]),
      ),
    ).toEqual({
      RES: "reserved",
      CLEAN: "cleaning",
      BLOCK: "blocked",
      UNKNOWN: "unknown",
    });
  });
  it("matches current installed inventory while preserving an occupied record if its installation metadata conflicts", () => {
    const state = fixture();
    state.slots.push({
      slot_id: "PLANNED",
      unit_id: "WARD-A",
      installation_status: "planned",
      status: "ready",
    });
    expect(buildReplayFloorPlan(dataset, state).units[0].beds).toHaveLength(3);
    state.slots.at(-1).patient_id = "P-CONFLICT";
    state.slots.at(-1).status = "occupied";
    expect(buildReplayFloorPlan(dataset, state).units[0].beds).toHaveLength(4);
  });
  it("marks a wholly unstaffed unit but never invents which individual beds have nurses", () => {
    const state = fixture();
    state.units[0].staffed = 1;
    expect(
      buildReplayFloorPlan(dataset, state).units[0].beds.map(
        (bed) => bed.status,
      ),
    ).toEqual(["occupied", "ready", "ready"]);
    state.units[0].staffed = 0;
    state.units[0].qualified_staff_by_role.rn = 0;
    const unit = buildReplayFloorPlan(dataset, state).units[0];
    expect(unit.beds.map((bed) => bed.status)).toEqual([
      "occupied",
      "unstaffed",
      "unstaffed",
    ]);
    expect(unit.unsupported).toBe(3);
    expect(unit.pressure).toBe(1);
  });
  it("preserves occupied and cleaning beds when a unit closes to new admissions", () => {
    const state = fixture();
    state.units[0].admission_gate = false;
    state.slots[1].status = "cleaning";
    expect(
      buildReplayFloorPlan(dataset, state).units[0].beds.map(
        (bed) => bed.status,
      ),
    ).toEqual(["occupied", "cleaning", "blocked"]);
  });
  it("uses exact full-population unit constraints, including paused care, without leaking across wards", () => {
    const state = fixture();
    state.blocker_counts_by_unit = {
      "WARD-B": {
        nursing_capacity: 630,
        medical_supplies: 1,
        treatment_disruption: 0,
      },
      ICU: { treatment_disruption: 1 },
    };
    const plan = buildReplayFloorPlan(dataset, state);
    expect(plan.units[1].pressure).toBe(1);
    expect(plan.units[1].reasons).toEqual([
      "nursing_capacity",
      "medical_supplies",
    ]);
    expect(plan.units[0].pressure).toBe(0);
    expect(plan.units.find((unit) => unit.id === "ICU")?.pressure).toBe(1);
  });
  it("does not leak sample fallback pause reasons to an unrelated unit", () => {
    const state = fixture();
    delete state.blocker_counts_by_unit;
    state.patients = [
      {
        patient_id: "P1",
        unit_id: "ICU",
        care_pause_reasons: ["medical_supplies"],
      },
    ];
    const plan = buildReplayFloorPlan(dataset, state);
    expect(plan.units[0].reasons).toEqual([]);
    expect(plan.units.find((unit) => unit.id === "ICU")?.reasons).toEqual([
      "medical_supplies",
    ]);
  });
  it("uses current capacity pressure and clears recovered historical constraints", () => {
    const state = fixture();
    state.units[0].occupied = 3;
    const full = buildReplayFloorPlan(dataset, state).units[0];
    expect(full.pressure).toBeCloseTo(1);
    expect(full.pressureText).toContain("100%");
    state.units[0].occupied = 2;
    expect(buildReplayFloorPlan(dataset, state).units[0].pressure).toBeLessThan(
      full.pressure!,
    );
    state.units[0].occupied = 0;
    expect(buildReplayFloorPlan(dataset, state).units[0].pressure).toBe(0);
  });
  it.each([null, undefined, NaN, Infinity, -1, "0", false])(
    "keeps missing or invalid counter %s unavailable",
    (invalid) => {
      const state = fixture();
      state.patient_counts.by_facility["FAC-MAIN"] = invalid;
      state.queue_counts["FAC-MAIN"] = { ed: invalid, total: invalid };
      state.flow_counts["FAC-MAIN"].discharges = invalid;
      const plan = buildReplayFloorPlan(dataset, state);
      expect(plan.total).toBeNull();
      expect(plan.edWaiting).toBeNull();
      expect(plan.bedWaiting).toBeNull();
      expect(plan.discharges).toBeNull();
    },
  );
  it("distinguishes proven zero counters and recalculates backwards without retaining future discharges", () => {
    const state = fixture();
    state.flow_counts["FAC-MAIN"].discharges = 20;
    expect(buildReplayFloorPlan(dataset, state).discharges).toBe(20);
    state.flow_counts["FAC-MAIN"].discharges = 0;
    state.queue_counts["FAC-MAIN"] = { ed: 0, total: 0 };
    expect(buildReplayFloorPlan(dataset, state)).toMatchObject({
      edWaiting: 0,
      bedWaiting: 0,
      discharges: 0,
    });
  });
  it("uses full aggregate groups when legacy exact queue counts are absent", () => {
    const state = fixture();
    delete state.patient_counts;
    delete state.queue_counts;
    state.patient_groups = [
      { facility_id: "FAC-MAIN", state: "ed_waiting", count: 600 },
      {
        facility_id: "FAC-MAIN",
        state: "ed_boarding",
        admission_pending: true,
        count: 30,
      },
      { facility_id: "FAC-OTHER", state: "ed_waiting", count: 100 },
    ];
    expect(buildReplayFloorPlan(dataset, state)).toMatchObject({
      total: 630,
      edWaiting: 600,
      bedWaiting: 30,
    });
  });
  it("builds cumulative inclusive discharge history queries for the exact selected run/time", () => {
    const path = dischargeHistoryPath("rep 1", at, "200"),
      url = new URL(path, "http://local");
    expect(url.pathname).toBe("/runs/rep%201/events");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      at,
      event_type: "discharge",
      direction: "before",
      cursor: "200",
      limit: "200",
    });
    expect(url.searchParams.get("before_sequence")).toBeTruthy();
  });
});
