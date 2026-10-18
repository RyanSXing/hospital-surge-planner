import { describe, expect, it } from "vitest";
import { buildScenarioPatch } from "./scenarioEditor";
import {
  movePlan,
  planInterval,
  selectStaff,
  withPlan,
  withoutPlan,
  readinessError,
  inferMixBasis,
  mixForBasis,
  shiftKey,
  equipmentBeforeEvent,
  equipmentLimit,
  familyOf,
} from "./scenarioPlans";
import type { Dataset, Scenario } from "../types";

describe("complete scenario assumptions", () => {
  it("keeps combined hospital bed responses editable without reclassifying legacy offsite plans", () => {
    const dataset = {
      units: [
        { unit_id: "UNIT-WARD-C", facility_id: "FAC-MAIN" },
        { unit_id: "UNIT-SHELTER", facility_id: "FAC-SHELTER" },
      ],
    } as unknown as Dataset;
    const combined = {
      id: "saved-response",
      kind: "staffed_overflow",
      facility_id: "FAC-MAIN",
      unit_id: "UNIT-WARD-C",
      enabled_slots: 32,
      nurses: 4,
      providers: 1,
      support: 1,
    };
    expect(familyOf(combined, "interventions", dataset)).toBe("capacity");
    expect(
      familyOf(
        { ...combined, facility_id: undefined },
        "interventions",
        dataset,
      ),
    ).toBe("capacity");
    expect(
      familyOf(
        { ...combined, kind: "activate_overflow" },
        "interventions",
        dataset,
      ),
    ).toBe("capacity");
    const offsite = {
      ...combined,
      id: "legacy-shelter",
      facility_id: "FAC-SHELTER",
      unit_id: "UNIT-SHELTER",
    };
    expect(familyOf(offsite, "interventions", dataset)).toBe("sites");
    expect(
      familyOf({ kind: "staffed_overflow" }, "interventions", dataset),
    ).toBe("sites");
    const draft = {
      conditions: [],
      updates: [],
      interventions: [combined, offsite],
    };
    const edited = withPlan(
      draft,
      { collection: "interventions", id: combined.id },
      "interventions",
      { ...combined, enabled_slots: 28, nurses: 3 },
    );
    expect(edited.interventions).toEqual([
      { ...combined, enabled_slots: 28, nurses: 3 },
      offsite,
    ]);
    expect(draft.interventions).toEqual([combined, offsite]);
  });
  it("bounds equipment from earlier planned changes in stable time order and excludes the edited event", () => {
    const dataset = {
      equipment_pools: [
        { equipment_pool_id: "P", quantity: 10, unserviceable_quantity: 0 },
      ],
    } as unknown as Dataset;
    const update = (
      id: string,
      operation: string,
      quantity: number,
      effective_at: string,
    ) => ({
      id,
      type: "equipment_change",
      input_kind: "planned_assumption",
      effective_at,
      payload: { equipment_pool_id: "P", operation, quantity },
    });
    const updates = [
      update("repair", "repair", 3, "2026-10-16T06:00:00Z"),
      update("failure", "fail", 4, "2026-10-16T05:00:00Z"),
    ];
    expect(
      equipmentBeforeEvent(dataset, updates, "P", "2026-10-16T06:00:00Z", {
        collection: "updates",
        id: "repair",
        index: 0,
      }),
    ).toEqual({ total: 10, failed: 4 });
    const after = equipmentBeforeEvent(
      dataset,
      updates,
      "P",
      "2026-10-16T07:00:00Z",
      null,
    );
    expect(after).toEqual({ total: 10, failed: 1 });
    expect(equipmentLimit(after, "repair")).toBe(1);
    expect(equipmentLimit(after, "fail")).toBe(9);
    expect(equipmentLimit(after, "decommission")).toBe(10);
    expect(equipmentLimit(after, "add")).toBeUndefined();
    expect(
      equipmentBeforeEvent(dataset, updates, "P", "2026-10-16T07:00:00Z", {
        collection: "updates",
        id: "failure",
        index: 1,
      }),
    ).toEqual({ total: 10, failed: 0 });
  });
  it("folds earlier observed equipment reports with saturation before exact future plans", () => {
    const dataset = {
      equipment_pools: [
        { equipment_pool_id: "P", quantity: 12, unserviceable_quantity: 0 },
      ],
    } as unknown as Dataset;
    const report = (operation: string, quantity: number) => ({
      type: "equipment_change",
      effective_at: "2026-10-16T05:00:00Z",
      payload: { equipment_pool_id: "P", operation, quantity },
    });
    const failed = equipmentBeforeEvent(
      dataset,
      [report("fail", 100)],
      "P",
      "2026-10-16T05:01:00Z",
      null,
    );
    expect(failed).toEqual({ total: 12, failed: 12 });
    expect(equipmentLimit(failed, "fail")).toBe(0);
    expect(equipmentLimit(failed, "repair")).toBe(12);
    expect(
      equipmentBeforeEvent(
        dataset,
        [report("decommission", 100)],
        "P",
        "2026-10-16T05:01:00Z",
        null,
      ),
    ).toEqual({ total: 0, failed: 0 });
  });
  it("recognizes reopened cohorts and resets stream changes to a truthful compatible basis", () => {
    const dataset = {
      cohorts: [
        { cohort_id: "CW", care_level: "ward" },
        { cohort_id: "CI", care_level: "icu" },
      ],
      resource_profiles: [
        { resource_profile_id: "PW", stage_kind: "ward" },
        { resource_profile_id: "PI", stage_kind: "icu" },
      ],
      entry_streams: [
        { entry_stream_id: "D", entry_type: "direct_ward" },
        {
          entry_stream_id: "E",
          entry_type: "ed",
          disposition_weights: { discharge: 0.8, ward: 0.16, icu: 0.04 },
        },
      ],
    } as unknown as Dataset;
    expect(inferMixBasis(dataset, { CW: 0.7, CI: 0.3 })).toBe("cohorts");
    expect(mixForBasis(dataset, "D", "cohorts")).toEqual({ CW: 1 });
    expect(mixForBasis(dataset, "D", "profiles")).toEqual({ PW: 1 });
    const changed = mixForBasis(dataset, "D", "care");
    expect(changed).toEqual({ ward: 1 });
    expect(inferMixBasis(dataset, changed)).toBe("care");
    expect(inferMixBasis(dataset, { CW: 0.5, PW: 0.5 })).toBe("mixed");
  });
  it("requires readiness before the end, including exact equality", () => {
    const start = "2026-10-16T05:00:00Z",
      end = "2026-10-16T11:00:00Z";
    expect(readinessError(start, end, 360)).toContain("before");
    expect(readinessError(start, end, 720)).toContain("before");
    expect(readinessError(start, end, 359)).toBe("");
  });
  it("preserves untouched custom curves, staff conditions and unrelated collections", () => {
    const conditions = [
      {
        id: "curve",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        control_points: [
          { at: "2026-10-16T05:00:00Z", multiplier: 1.2 },
          { at: "2026-10-16T09:12:00Z", multiplier: 2.8 },
          { at: "2026-10-17T13:00:00Z", multiplier: 1.4 },
          { at: "2026-10-18T05:00:00Z", multiplier: 1.8 },
        ],
        source: "imported",
      },
      { id: "staff", kind: "staff_unavailability", staff_ids: ["P1"] },
    ];
    const scenario: Scenario = {
      id: "S",
      name: "Imported",
      dataset_version_id: "D",
      start_at: "2026-10-16T05:00:00Z",
      horizon_calendar_days: 3,
      base_seed: 1,
      replications: 10,
      interventions: [],
      conditions,
      timezone: "America/Chicago",
    };
    const patch = buildScenarioPatch(scenario, {
      name: "Renamed only",
      startAt: "2026-10-16T05:00:00Z",
      seed: 1,
      days: 3,
      replications: 10,
      stream: "ED_MAIN",
      conditionId: "curve",
      staffConditionId: "staff",
      percent: 180,
      shape: "custom",
      absence: 0,
      startDay: 0,
      endDay: 3,
      peakDay: 1,
      mixMode: "default",
      mix: {},
      editArrival: false,
      editLegacyStaff: false,
    });
    expect(patch.conditions).toEqual(conditions);
    const draft = {
      conditions: patch.conditions,
      interventions: [{ id: "existing", kind: "clinic" }],
      updates: [
        { update_id: "observed", type: "equipment_change", source: "reported" },
      ],
    };
    const added = withPlan(draft, null, "updates", {
      id: "planned",
      type: "capacity_change",
    });
    expect(added.conditions).toEqual(conditions);
    expect(added.interventions).toEqual(draft.interventions);
    expect(added.updates[0]).toEqual(draft.updates[0]);
    expect(
      withoutPlan(added, { collection: "updates", id: "planned" }),
    ).toEqual(draft);
  });
  it("preserves same-time event order when editing one planned change", () => {
    const draft = {
      conditions: [],
      interventions: [],
      updates: [
        {
          id: "failure",
          type: "equipment_change",
          payload: { operation: "fail", quantity: 1 },
        },
        {
          id: "repair",
          type: "equipment_change",
          payload: { operation: "repair", quantity: 1 },
        },
      ],
    };
    const next = withPlan(
      draft,
      { collection: "updates", id: "failure" },
      "updates",
      { ...draft.updates[0], payload: { operation: "fail", quantity: 2 } },
    );
    expect(next.updates.map((v) => v.id)).toEqual(["failure", "repair"]);
    expect(draft.updates[0].payload.quantity).toBe(1);
  });
  it("changes collection without leaving the previous capacity driver active", () => {
    const draft = {
      conditions: [],
      interventions: [],
      updates: [
        { id: "driver", type: "capacity_change" },
        { id: "other", type: "equipment_change" },
      ],
    };
    const next = withPlan(
      draft,
      { collection: "updates", id: "driver" },
      "interventions",
      { id: "driver", kind: "staff_existing" },
    );
    expect(next.updates).toEqual([draft.updates[1]]);
    expect(next.interventions[0].kind).toBe("staff_existing");
    expect(draft.updates).toHaveLength(2);
  });
  it("shift percentage and available count select exact provider IDs without affecting nurses or other shifts", () => {
    const roster = [
      { staff_id: "P1", role: "provider" },
      { staff_id: "P2", role: "provider" },
      { staff_id: "N1", role: "rn" },
    ];
    const assignments = roster
      .map((p) => ({ staff_id: p.staff_id, start_at: "A" }))
      .concat({ staff_id: "P1", start_at: "B" });
    expect(
      selectStaff(assignments, roster, "provider", "A|", "percentage", 50),
    ).toEqual(["P1"]);
    expect(
      selectStaff(assignments, roster, "provider", "A|", "available", 0),
    ).toEqual(["P1", "P2"]);
    expect(() =>
      selectStaff(assignments, roster, "provider", "A|", "count", 3),
    ).toThrow("declared shift");
  });
  it("keeps same-start shifts with different ends separate", () => {
    const roster = [
        { staff_id: "P1", role: "provider" },
        { staff_id: "P2", role: "provider" },
      ],
      assignments = [
        {
          staff_id: "P1",
          start_at: "2026-10-16T05:00:00Z",
          end_at: "2026-10-16T13:00:00Z",
        },
        {
          staff_id: "P2",
          start_at: "2026-10-16T05:00:00Z",
          end_at: "2026-10-16T17:00:00Z",
        },
      ];
    expect(shiftKey(assignments[0])).not.toBe(shiftKey(assignments[1]));
    expect(
      selectStaff(
        assignments,
        roster,
        "provider",
        shiftKey(assignments[0]),
        "percentage",
        100,
      ),
    ).toEqual(["P1"]);
    expect(
      selectStaff(
        assignments,
        roster,
        "provider",
        shiftKey(assignments[1]),
        "percentage",
        100,
      ),
    ).toEqual(["P2"]);
  });
  it("moves absolute intervals including expiration while preserving reports and DST elapsed time", () => {
    const input = {
      id: "E",
      effective_at: "2026-11-01T06:30:00Z",
      payload: { until: "2026-11-01T08:30:00Z", quantity: 3 },
      source: "user_assumption",
    };
    const moved = movePlan(input, 60);
    expect(moved.effective_at).toBe("2026-11-01T07:30:00.000Z");
    expect(moved.payload.until).toBe("2026-11-01T09:30:00.000Z");
    expect(input.payload.until).toBe("2026-11-01T08:30:00Z");
    expect(
      planInterval(
        {
          kind: "arrival_multiplier",
          start_at: "ignored",
          control_points: [{ at: "first" }, { at: "last" }],
        },
        "S",
        "E",
      ),
    ).toEqual({ start: "first", end: "last" });
  });
});
