import { describe, expect, it } from "vitest";
import { atDay } from "../api";
import type { Entity } from "../types";
import {
  arrivalPlanPercent,
  reshapeArrivalPlan,
  scaleArrivalPlan,
} from "./arrivalPlanControls";
import { plannedArrivals } from "./plannedArrivalSeries";
import type { ArrivalPreviewOptions } from "./plannedArrivalSeries";

function options(days = 14): ArrivalPreviewOptions {
  const start = "2026-10-16T05:00:00Z",
    timeZone = "America/Chicago",
    end = atDay(start, days, 0, timeZone);
  return {
    start,
    end,
    days,
    timeZone,
    stream: "ED_MAIN",
    baselineRate: 100,
    hourWeights: Array.from({ length: 24 }, (_, h) => (h < 12 ? 1 : 3)),
    weekdayWeights: [1, 0.9, 1.1, 1.2, 1.05, 0.8, 0.7],
    conditions: [
      {
        id: "custom-long",
        kind: "arrival_multiplier",
        shape: "step",
        source: "imported",
        care_mix_override: { discharge: 0.6, ward: 0.3, icu: 0.1 },
        custom_note: "retain",
        control_points: Array.from({ length: days + 1 }, (_, i) => ({
          at: atDay(start, i, 0, timeZone),
          multiplier: 0.5 + (Math.min(i, days - 1) % 7) * 0.25,
        })),
      },
    ],
  };
}
function apply(input: ArrivalPreviewOptions, conditions: Entity[]) {
  return { ...input, conditions };
}
function assertCanonical(conditions: Entity[]) {
  const windows = conditions
    .filter(
      (c) =>
        c.kind === "arrival_multiplier" &&
        (c.entry_stream_id || "ED_MAIN") === "ED_MAIN",
    )
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  windows.forEach((window, i) => {
    expect(window.control_points.length).toBeGreaterThanOrEqual(2);
    window.control_points.forEach((p: Entity, n: number) => {
      expect(Number.isFinite(p.multiplier)).toBe(true);
      expect(p.multiplier).toBeGreaterThanOrEqual(0);
      if (n)
        expect(Date.parse(p.at)).toBeGreaterThan(
          Date.parse(window.control_points[n - 1].at),
        );
    });
    if (i)
      expect(Date.parse(window.start_at)).toBeGreaterThanOrEqual(
        Date.parse(windows[i - 1].end_at),
      );
  });
}

describe("whole-period arrival controls", () => {
  it.each([14, 30])(
    "scales every day of a %i-day custom plan and retains relative demand and metadata",
    (days) => {
      const input = options(days),
        before = JSON.stringify(input),
        daily = plannedArrivals(input);
      const conditions = scaleArrivalPlan(input, 75),
        next = plannedArrivals(apply(input, conditions));
      const factor =
        next.reduce((sum, d) => sum + d.variable, 0) /
        daily.reduce((sum, d) => sum + d.variable, 0);
      next.forEach((day, i) =>
        expect(day.variable).toBeCloseTo(daily[i].variable * factor, 9),
      );
      expect(arrivalPlanPercent(apply(input, conditions))).toBeCloseTo(75, 10);
      expect(conditions[0]).toMatchObject({
        source: "imported",
        custom_note: "retain",
        care_mix_override: input.conditions[0].care_mix_override,
      });
      expect(JSON.stringify(input)).toBe(before);
      assertCanonical(conditions);
    },
  );
  it("fills ordinary uncovered hours while leaving fixed batches and other streams exact", () => {
    const input = options(14),
      custom = input.conditions[0];
    custom.control_points = [
      { at: atDay(input.start, 3, 0, input.timeZone), multiplier: 2 },
      { at: atDay(input.start, 7, 0, input.timeZone), multiplier: 2 },
    ];
    const batch = {
      id: "fixed",
      kind: "arrival_batch",
      entry_stream_id: "ED_MAIN",
      at: atDay(input.start, 4, 12, input.timeZone),
      count: 50,
      spread_minutes: 60,
      care_mix: { ward: 1 },
    };
    const direct = {
      id: "direct",
      kind: "arrival_multiplier",
      entry_stream_id: "DIRECT_WARD_MAIN",
      surge_percent: 90,
    };
    const care = {
      id: "care",
      kind: "care_mix_override",
      entry_stream_id: "ED_MAIN",
      weights: { "imported-cohort": 1 },
    };
    input.conditions.push(batch, direct, care);
    const current = plannedArrivals(input),
      conditions = scaleArrivalPlan(input, 30),
      next = plannedArrivals(apply(input, conditions));
    const factor = next[0].variable / current[0].variable;
    next.forEach((day, i) => {
      expect(day.variable).toBeCloseTo(current[i].variable * factor, 9);
      expect(day.scheduled).toBe(current[i].scheduled);
    });
    expect(conditions).toContain(batch);
    expect(conditions).toContain(direct);
    expect(conditions).toContain(care);
    expect(arrivalPlanPercent(apply(input, conditions))).toBeCloseTo(30, 10);
    expect(
      conditions.filter(
        (c) =>
          c.kind === "arrival_multiplier" && c.entry_stream_id === "ED_MAIN",
      ),
    ).toHaveLength(3);
    assertCanonical(conditions);
  });
  it("excludes fixed arrivals from the global percentage and supports zero then uniform recovery", () => {
    const input = options(14),
      batch = {
        kind: "arrival_batch",
        at: input.start,
        count: 200,
        spread_minutes: 60,
      };
    const baselinePercent = arrivalPlanPercent(input);
    input.conditions.push(batch);
    expect(arrivalPlanPercent(input)).toBeCloseTo(baselinePercent, 12);
    const stopped = apply(input, scaleArrivalPlan(input, -100));
    expect(arrivalPlanPercent(stopped)).toBe(-100);
    expect(plannedArrivals(stopped).every((day) => day.variable === 0)).toBe(
      true,
    );
    expect(plannedArrivals(stopped)[0].scheduled).toBe(200);
    const resumed = apply(stopped, scaleArrivalPlan(stopped, 25));
    expect(arrivalPlanPercent(resumed)).toBeCloseTo(25, 10);
    plannedArrivals(resumed).forEach((day) =>
      expect(day.variable).toBeCloseTo(day.baseline * 1.25, 9),
    );
    expect(resumed.conditions).toContain(batch);
    assertCanonical(resumed.conditions);
  });
  it.each([14, 30])(
    "reshapes all %i days, retaining the requested average and metadata boundaries",
    (days) => {
      const input = options(days),
        batch = {
          id: "fixed",
          kind: "arrival_batch",
          at: input.start,
          count: 25,
          spread_minutes: 60,
        };
      // Two different care/source windows survive a whole-period shape replacement.
      const second: Entity = {
        ...input.conditions[0],
        id: "second",
        source: "user_assumption",
        care_mix_override: { ward: 1 },
      };
      const middle = atDay(
        input.start,
        Math.floor(days / 2),
        0,
        input.timeZone,
      );
      input.conditions[0].control_points = [
        { at: input.start, multiplier: 3 },
        { at: middle, multiplier: 3 },
      ];
      second.control_points = [
        { at: middle, multiplier: 0.2 },
        { at: input.end, multiplier: 0.2 },
      ];
      const direct = {
        id: "direct",
        kind: "arrival_multiplier",
        entry_stream_id: "DIRECT_WARD_MAIN",
        surge_percent: 45,
      };
      input.conditions.push(second, batch, direct);
      for (const shape of ["sustained", "ramp", "wave"] as const) {
        const conditions = reshapeArrivalPlan(input, 60, shape),
          next = apply(input, conditions),
          daily = plannedArrivals(next);
        expect(arrivalPlanPercent(next)).toBeCloseTo(60, 10);
        expect(conditions.find((c) => c.id === "custom-long")).toMatchObject({
          arrival_plan_shape: shape,
          source: "imported",
          care_mix_override: input.conditions[0].care_mix_override,
        });
        expect(conditions.find((c) => c.id === "second")).toMatchObject({
          arrival_plan_shape: shape,
          source: "user_assumption",
          care_mix_override: { ward: 1 },
        });
        expect(conditions).toContain(batch);
        expect(conditions).toContain(direct);
        expect(
          scaleArrivalPlan(next, 70).find((c) => c.id === "custom-long")
            ?.arrival_plan_shape,
        ).toBe(shape);
        const ratios = daily.map((day) => day.variable / day.baseline);
        if (shape === "sustained")
          ratios.forEach((ratio) => expect(ratio).toBeCloseTo(1.6, 10));
        if (shape === "ramp")
          for (let i = 1; i < ratios.length; i++)
            expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
        if (shape === "wave") {
          expect(ratios[Math.floor(days / 2)]).toBeGreaterThan(ratios[0]);
          expect(ratios[Math.floor(days / 2)]).toBeGreaterThan(ratios.at(-1)!);
        }
        expect(daily[0].scheduled).toBe(25);
        assertCanonical(conditions);
      }
    },
  );
  it("keeps the average stable for fewer arrivals, zero demand and later positive presets", () => {
    let input = options(30);
    for (const [percent, shape] of [
      [-75, "ramp"],
      [-100, "wave"],
      [40, "wave"],
    ] as const) {
      input = apply(input, reshapeArrivalPlan(input, percent, shape));
      expect(arrivalPlanPercent(input)).toBeCloseTo(percent, 10);
      assertCanonical(input.conditions);
    }
  });
  it("returns exact source records for an unchanged scale and validates invalid percentages", () => {
    const input = options(14);
    expect(scaleArrivalPlan(input, arrivalPlanPercent(input))).toBe(
      input.conditions,
    );
    for (const percent of [-101, Infinity, NaN])
      expect(() => scaleArrivalPlan(input, percent)).toThrow("percentage");
    expect(() => reshapeArrivalPlan(input, 0, "invalid" as any)).toThrow(
      "supported",
    );
    expect(arrivalPlanPercent({ ...input, baselineRate: 0 })).toBe(0);
  });
});
