import { describe, expect, it } from "vitest";
import { atDay, localDayIndex } from "./api";
import { patientsOf, queueStats, statsFor, unitsOf } from "./model";
import type { PlanningContext } from "./types";

describe("local calendar time", () => {
  it("preserves Chicago midnight through the 25-hour autumn day", () => {
    expect(atDay("2026-11-01T05:00:00Z", 1)).toBe("2026-11-02T06:00:00.000Z");
    expect(localDayIndex("2026-11-01T05:00:00Z", "2026-11-02T05:30:00Z")).toBe(
      0,
    );
    expect(localDayIndex("2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z")).toBe(
      1,
    );
  });
  it("preserves Chicago midnight through the 23-hour spring day", () => {
    expect(atDay("2026-03-08T06:00:00Z", 1)).toBe("2026-03-09T05:00:00.000Z");
    expect(localDayIndex("2026-03-08T06:00:00Z", "2026-03-09T05:00:00Z")).toBe(
      1,
    );
  });
  it("uses deterministic compatible handling for repeated and skipped wall hours", () => {
    expect(atDay("2026-11-01T05:00:00Z", 0, 1)).toBe(
      "2026-11-01T06:00:00.000Z",
    );
    expect(atDay("2026-03-08T06:00:00Z", 0, 2)).toBe(
      "2026-03-08T08:00:00.000Z",
    );
  });
  it("keeps the local wall time and supports another dataset timezone", () => {
    expect(atDay("2026-10-31T17:45:03.123Z", 2)).toBe(
      "2026-11-02T18:45:03.123Z",
    );
    expect(atDay("2026-10-31T00:00:00Z", 2, 0, "UTC")).toBe(
      "2026-11-02T00:00:00.000Z",
    );
  });
});
const initial = () =>
  ({
    dataset: {
      units: [
        {
          unit_id: "U",
          facility_id: "F",
          kind: "ward",
          physical_capacity: 100,
          staffed_capacity: 80,
          enabled_capacity: 100,
          background_occupied: 20,
        },
      ],
      patients: [],
      facilities: [{ facility_id: "F", status: "active" }],
      slots: [],
    },
    state: null,
    run: null,
    selectedFacility: "F",
    stateLoading: false,
  }) as unknown as PlanningContext;
describe("capacity and selected-time state", () => {
  it("counts source partner background occupancy before a run", () => {
    expect(statsFor(initial()).occupied).toBe(20);
  });
  it("uses authoritative available capacity despite cleaning on unstaffed places", () => {
    const ctx = initial();
    ctx.state = {
      units: [
        {
          unit_id: "U",
          facility_id: "F",
          kind: "ward",
          physical: 100,
          enabled: 100,
          staffed: 80,
          occupied: 70,
          cleaning: 5,
          reserved: 0,
          ready: 25,
          available: 10,
          active: true,
        },
      ],
      patients: [],
    };
    expect(statsFor(ctx)).toMatchObject({
      physical: 100,
      staffed: 80,
      occupied: 70,
      cleaning: 5,
      available: 10,
    });
  });
  it("does not substitute initial inventory or patients while replay is pending", () => {
    const ctx = initial();
    ctx.run = {
      id: "R",
      status: "SUCCEEDED",
      replications_completed: 1,
      replications_requested: 1,
    };
    expect(unitsOf(ctx)).toEqual([]);
    expect(patientsOf(ctx)).toEqual([]);
    expect(statsFor(ctx).unavailable).toBe(true);
    ctx.state = {
      inpatient_queue: 99,
      units: [{ unit_id: "U", occupied: 99 }],
      patients: [{ patient_id: "P", state: "direct_waiting" }],
    };
    ctx.stateLoading = true;
    expect(unitsOf(ctx)).toEqual([]);
    expect(queueStats(ctx)).toMatchObject({ total: 0, unavailable: true });
  });
  it("scopes facility queues without substituting the regional queue", () => {
    const ctx = initial();
    ctx.state = {
      units: [{ unit_id: "U", facility_id: "F" }],
      inpatient_queue: 2,
      patients: [
        {
          patient_id: "A",
          facility_id: "F",
          state: "ed_boarding",
          target_unit_kind: "ward",
          admission_pending: true,
        },
        {
          patient_id: "B",
          facility_id: "PARTNER",
          state: "direct_waiting",
          target_unit_kind: "icu",
          admission_pending: true,
        },
      ],
    };
    expect(queueStats(ctx)).toMatchObject({ total: 1, ward: 1, icu: 0 });
    expect(queueStats(ctx, "PARTNER")).toMatchObject({
      total: 1,
      ward: 0,
      icu: 1,
    });
    expect(queueStats(ctx, "all").total).toBe(2);
  });
  it("uses full queue aggregates when selected-time patients are paginated", () => {
    const ctx = initial();
    ctx.state = {
      partial_collections: ["patients"],
      patient_total: 54000,
      patients: [],
      units: [],
      queue_counts: {
        F: {
          total: 5000,
          ward: 4000,
          icu: 1000,
          ed: 300,
          ed_boarding: 2000,
          direct_waiting: 2900,
          stepdown: 100,
        },
        PARTNER: { total: 2, ward: 2, icu: 0, ed: 0 },
      },
    };
    expect(queueStats(ctx)).toMatchObject({
      total: 5000,
      ward: 4000,
      icu: 1000,
      ed: 300,
    });
    expect(queueStats(ctx, "PARTNER").total).toBe(2);
    expect(queueStats(ctx, "all").total).toBe(5002);
    expect(queueStats(ctx, "UNKNOWN").total).toBe(0);
  });
  it("keeps empty authoritative patient collections empty", () => {
    const ctx = initial();
    ctx.dataset!.patients = [
      { patient_id: "P", state: "inpatient", unit_id: "U", slot_id: "S" },
    ];
    ctx.state = { units: [], patients: [] };
    expect(patientsOf(ctx)).toEqual([]);
  });
});
