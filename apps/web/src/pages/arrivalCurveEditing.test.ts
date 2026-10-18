import { describe, expect, it } from "vitest";
import type { Entity } from "../types";
import { editPlannedArrivalDay } from "./arrivalCurveEditing";
import { plannedArrivals } from "./plannedArrivalSeries";
import type { ArrivalPreviewOptions } from "./plannedArrivalSeries";

const base: ArrivalPreviewOptions = {
  start: "2026-10-16T05:00:00Z",
  end: "2026-10-19T05:00:00Z",
  days: 3,
  timeZone: "America/Chicago",
  stream: "ED_MAIN",
  baselineRate: 100,
  conditions: [],
};
const totals = (options: ArrivalPreviewOptions) =>
  plannedArrivals(options).map((point) => Number(point.planned.toFixed(9)));
function expectNoOverlap(conditions: Entity[], stream = "ED_MAIN") {
  const spans = conditions
    .filter(
      (condition) =>
        condition.kind === "arrival_multiplier" &&
        (condition.entry_stream_id || "ED_MAIN") === stream,
    )
    .map((condition) => condition.control_points)
    .sort((a, b) => Date.parse(a[0].at) - Date.parse(b[0].at));
  spans.forEach((points, index) => {
    expect(points.length).toBeGreaterThanOrEqual(2);
    points.forEach((point: Entity, p: number) => {
      expect(point.multiplier).toBeGreaterThanOrEqual(0);
      if (p > 0)
        expect(Date.parse(point.at)).toBeGreaterThan(
          Date.parse(points[p - 1].at),
        );
    });
    if (index > 0)
      expect(Date.parse(points[0].at)).toBeGreaterThanOrEqual(
        Date.parse(spans[index - 1].at(-1).at),
      );
  });
}

describe("daily arrival curve editing", () => {
  it("turns a daily total into an actual canonical, nonoverlapping multiplier window", () => {
    const edited = editPlannedArrivalDay(base, "2026-10-17T05:00:00Z", 170);
    expect(totals({ ...base, conditions: edited.conditions })).toEqual([
      100, 170, 100,
    ]);
    expect(edited.conditions[0]).toMatchObject({
      id: edited.conditionId,
      kind: "arrival_multiplier",
      shape: "step",
      start_at: "2026-10-17T05:00:00.000Z",
      end_at: "2026-10-18T05:00:00.000Z",
    });
    expect(edited.conditions[0].control_points[0].multiplier).toBeCloseTo(
      1.7,
      12,
    );
    expect(edited.conditions[0].control_points[1].multiplier).toBeCloseTo(
      1.7,
      12,
    );
    expectNoOverlap(edited.conditions);
  });
  it("clips imported custom curves exactly and retains their shape, care mix and other inputs", () => {
    const original: Entity = {
      id: "custom-ed",
      kind: "arrival_multiplier",
      source: "imported",
      shape: "piecewise_linear",
      care_mix_override: { discharge: 0.6, ward: 0.3, icu: 0.1 },
      control_points: [
        { at: base.start, multiplier: 0.7 },
        { at: "2026-10-17T00:00:00Z", multiplier: 1.4 },
        { at: "2026-10-17T17:30:00Z", multiplier: 2.3 },
        { at: "2026-10-18T20:00:00Z", multiplier: 0.4 },
        { at: base.end, multiplier: 1 },
      ],
    };
    const otherStream = {
      id: "direct",
      kind: "arrival_multiplier",
      entry_stream_id: "DIRECT_WARD_MAIN",
      surge_percent: 90,
    };
    const resource = {
      id: "beds",
      kind: "unit_configuration",
      physical_capacity: 95,
    };
    const care = {
      id: "mix",
      kind: "care_mix_override",
      care_mix: { ward: 0.5 },
    };
    const options = {
      ...base,
      conditions: [original, otherStream, resource, care],
    };
    const before = JSON.stringify(options),
      initial = totals(options),
      edited = editPlannedArrivalDay(options, "2026-10-17T05:00:00Z", 65),
      next = totals({ ...options, conditions: edited.conditions });
    expect(next[0]).toBeCloseTo(initial[0], 10);
    expect(next[1]).toBeCloseTo(65, 10);
    expect(next[2]).toBeCloseTo(initial[2], 10);
    expect(edited.conditions).toContain(otherStream);
    expect(edited.conditions).toContain(resource);
    expect(edited.conditions).toContain(care);
    const pieces = edited.conditions.filter(
      (condition) =>
        condition.kind === "arrival_multiplier" && condition.id !== "direct",
    );
    expect(pieces).toHaveLength(3);
    expect(
      pieces.every(
        (piece) =>
          piece.source === "imported" &&
          piece.shape === "piecewise_linear" &&
          piece.care_mix_override === original.care_mix_override,
      ),
    ).toBe(true);
    expect(pieces[0].control_points).toContainEqual(original.control_points[1]);
    expect(pieces[2].control_points).toContainEqual(original.control_points[3]);
    expect(
      pieces.find((piece) => piece.id === edited.conditionId)?.start_at,
    ).toBe("2026-10-17T05:00:00.000Z");
    expect(JSON.stringify(options)).toBe(before);
    expectNoOverlap(edited.conditions);
  });
  it("scales covered and usual hours together without double-counting fixed batches", () => {
    const batch = {
      id: "batch",
      kind: "arrival_batch",
      at: "2026-10-16T17:00:00Z",
      count: 40,
      spread_minutes: 60,
    };
    const options = {
      ...base,
      hourWeights: Array.from({ length: 24 }, (_, hour) => (hour < 12 ? 1 : 3)),
      weekdayWeights: [1, 1, 1, 1, 1.2, 1, 1],
      conditions: [
        {
          id: "afternoon",
          kind: "arrival_multiplier",
          start_at: "2026-10-16T17:00:00Z",
          end_at: "2026-10-17T05:00:00Z",
          surge_percent: 100,
        },
        batch,
      ],
    };
    const [initial] = plannedArrivals(options);
    expect(initial.variable).toBeCloseTo(210);
    expect(initial.scheduled).toBe(40);
    const edited = editPlannedArrivalDay(options, base.start, 145);
    expect(
      totals({ ...options, conditions: edited.conditions })[0],
    ).toBeCloseTo(145, 10);
    expect(edited.conditions).toContain(batch);
    expect(edited.minimum).toBe(40);
    const minimum = editPlannedArrivalDay(options, base.start, -20);
    expect(
      totals({ ...options, conditions: minimum.conditions })[0],
    ).toBeCloseTo(40);
    expectNoOverlap(edited.conditions);
  });
  it("keeps a batch spread across local midnight fixed in both days", () => {
    const batch = {
      kind: "arrival_batch",
      at: "2026-10-17T04:00:00Z",
      count: 30,
      spread_minutes: 180,
    };
    const options = { ...base, conditions: [batch] };
    const before = plannedArrivals(options);
    expect(before.map((point) => point.scheduled)).toEqual([10, 20, 0]);
    const edited = editPlannedArrivalDay(options, base.start, 60);
    expect(totals({ ...options, conditions: edited.conditions })).toEqual([
      60, 120, 100,
    ]);
    expect(edited.conditions[0]).toBe(batch);
  });
  it("uses actual local-day boundaries across fall and spring DST and partial horizons", () => {
    for (const range of [
      {
        start: "2026-10-31T17:00:00Z",
        end: "2026-11-02T18:00:00Z",
        day: "2026-11-01T05:00:00.000Z",
        next: "2026-11-02T06:00:00.000Z",
      },
      {
        start: "2026-03-07T18:00:00Z",
        end: "2026-03-09T17:00:00Z",
        day: "2026-03-08T06:00:00.000Z",
        next: "2026-03-09T05:00:00.000Z",
      },
    ]) {
      const options = { ...base, start: range.start, end: range.end };
      const initial = plannedArrivals(options);
      const edited = editPlannedArrivalDay(options, range.day, 175);
      const next = plannedArrivals({
        ...options,
        conditions: edited.conditions,
      });
      expect(next[1].planned).toBeCloseTo(175, 10);
      expect(next[0].planned).toBeCloseTo(initial[0].planned, 10);
      expect(next[2].planned).toBeCloseTo(initial[2].planned, 10);
      expect(edited.conditions[0].control_points.at(-1).at).toBe(range.next);
      expectNoOverlap(edited.conditions);
    }
  });
  it("preserves step discontinuities at neighboring day boundaries", () => {
    const options = {
      ...base,
      conditions: [
        {
          id: "step",
          kind: "arrival_multiplier",
          shape: "step",
          control_points: [
            { at: base.start, multiplier: 1 },
            { at: "2026-10-17T05:00:00Z", multiplier: 2 },
            { at: "2026-10-18T05:00:00Z", multiplier: 3 },
            { at: base.end, multiplier: 1 },
          ],
        },
      ],
    };
    const edited = editPlannedArrivalDay(options, "2026-10-17T05:00:00Z", 50);
    expect(totals({ ...options, conditions: edited.conditions })).toEqual([
      100, 50, 300,
    ]);
    expectNoOverlap(edited.conditions);
  });
  it("can increase a day previously set to zero without changing other days", () => {
    const zero = editPlannedArrivalDay(base, "2026-10-17T05:00:00Z", 0);
    const options = { ...base, conditions: zero.conditions };
    expect(totals(options)).toEqual([100, 0, 100]);
    const edited = editPlannedArrivalDay(options, "2026-10-17T05:00:00Z", 130);
    expect(totals({ ...options, conditions: edited.conditions })).toEqual([
      100, 130, 100,
    ]);
    expect(edited.conditions).toHaveLength(1);
    expect(edited.conditionId).toBe(zero.conditionId);
  });
  it("does not fragment an already edited day again on subsequent gestures", () => {
    const condition = {
      id: "whole",
      kind: "arrival_multiplier",
      surge_percent: 30,
    };
    const first = editPlannedArrivalDay(
      { ...base, conditions: [condition] },
      "2026-10-17T05:00:00Z",
      90,
    );
    const second = editPlannedArrivalDay(
      { ...base, conditions: first.conditions },
      "2026-10-17T05:00:00Z",
      160,
    );
    expect(second.conditions).toHaveLength(3);
    expect(second.conditions.map((piece) => piece.id)).toEqual(
      first.conditions.map((piece) => piece.id),
    );
    expect(second.conditionId).toBe(first.conditionId);
    expect(totals({ ...base, conditions: second.conditions })).toEqual([
      130, 160, 130,
    ]);
  });
  it("returns unchanged canonical conditions for unchanged totals and rejects invalid inputs", () => {
    expect(editPlannedArrivalDay(base, base.start, 100).conditions).toBe(
      base.conditions,
    );
    expect(() => editPlannedArrivalDay(base, base.start, NaN)).toThrow(
      "finite",
    );
    expect(() =>
      editPlannedArrivalDay(base, "2025-10-16T05:00:00Z", 100),
    ).toThrow("valid day");
    expect(() =>
      editPlannedArrivalDay({ ...base, baselineRate: 0 }, base.start, 100),
    ).toThrow("no usual arrivals");
  });
  it("refuses ambiguous overlapping schedules instead of silently corrupting a curve", () => {
    const options = {
      ...base,
      conditions: [
        { id: "one", kind: "arrival_multiplier", surge_percent: 10 },
        { id: "two", kind: "arrival_multiplier", surge_percent: 20 },
      ],
    };
    const before = JSON.stringify(options);
    expect(() => editPlannedArrivalDay(options, base.start, 160)).toThrow(
      "cannot overlap",
    );
    expect(JSON.stringify(options)).toBe(before);
  });
});
