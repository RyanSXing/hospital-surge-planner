import { describe, expect, it } from "vitest";
import {
  plannedArrivals,
  arrivalControlPercent,
  displayArrivalPercent,
} from "./plannedArrivalSeries";
const base = {
  start: "2026-10-16T05:00:00Z",
  end: "2026-10-19T05:00:00Z",
  days: 3,
  timeZone: "America/Chicago",
  stream: "ED_MAIN",
  baselineRate: 100,
};
describe("editable arrivals preview", () => {
  it("shows usual arrivals with no demand change", () => {
    expect(
      plannedArrivals({ ...base, conditions: [] }).map((x) =>
        Number(x.planned.toFixed(8)),
      ),
    ).toEqual([100, 100, 100]);
  });
  it("integrates exact partial-day changes and preserves other arrival intervals", () => {
    const conditions = [
      {
        kind: "arrival_multiplier",
        start_at: "2026-10-16T17:00:00Z",
        end_at: "2026-10-17T05:00:00Z",
        surge_percent: 100,
      },
      {
        kind: "arrival_multiplier",
        start_at: "2026-10-18T05:00:00Z",
        end_at: base.end,
        surge_percent: 50,
      },
      {
        kind: "arrival_multiplier",
        entry_stream_id: "DIRECT_WARD_MAIN",
        surge_percent: 100,
      },
    ];
    expect(
      plannedArrivals({ ...base, conditions }).map((x) =>
        Number(x.planned.toFixed(8)),
      ),
    ).toEqual([150, 100, 150]);
  });
  it("integrates a linear wave and scheduled extra patients", () => {
    const conditions = [
      {
        kind: "arrival_multiplier",
        shape: "piecewise_linear",
        control_points: [
          { at: base.start, multiplier: 1 },
          { at: "2026-10-17T05:00:00Z", multiplier: 2 },
          { at: base.end, multiplier: 1 },
        ],
      },
      { kind: "arrival_batch", at: "2026-10-17T17:00:00Z", count: 20 },
    ];
    expect(
      plannedArrivals({ ...base, conditions }).map((x) =>
        Number(x.planned.toFixed(8)),
      ),
    ).toEqual([150, 195, 125]);
  });
  it("keeps the local-day rate stable across the fall daylight-saving change", () => {
    const values = plannedArrivals({
      ...base,
      start: "2026-10-31T05:00:00Z",
      end: "2026-11-03T06:00:00Z",
      conditions: [],
    });
    expect(values.map((x) => Number(x.planned.toFixed(8)))).toEqual([
      100, 100, 100,
    ]);
    expect(values.map((x) => x.at)).toEqual([
      "2026-10-31T05:00:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
    ]);
  });
  it("weights exact arrival windows using local hour and weekday profiles", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => (hour < 12 ? 1 : 3));
    const [first] = plannedArrivals({
      ...base,
      hourWeights: hours,
      weekdayWeights: [1, 1, 1, 1, 1.2, 1, 1],
      conditions: [
        {
          kind: "arrival_multiplier",
          start_at: "2026-10-16T17:00:00Z",
          end_at: "2026-10-17T05:00:00Z",
          surge_percent: 100,
        },
      ],
    });
    expect(first.baseline).toBeCloseTo(120);
    expect(first.planned).toBeCloseTo(210);
  });
  it("reuses calendar exposure without retaining earlier slider values", () => {
    const options = {
      ...base,
      hourWeights: Array.from({ length: 24 }, () => 1),
      conditions: [{ kind: "arrival_multiplier", surge_percent: 50 }],
    };
    const first = plannedArrivals(options);
    const higher = plannedArrivals({
      ...options,
      conditions: [{ kind: "arrival_multiplier", surge_percent: 100 }],
    });
    expect(higher[0].planned / higher[0].baseline).toBeCloseTo(2);
    expect(first[0].planned / first[0].baseline).toBeCloseTo(1.5);
    expect(plannedArrivals(options)).toEqual(first);
    const changedWeights = plannedArrivals({
      ...options,
      weekdayWeights: [2, 2, 2, 2, 2, 2, 2],
    });
    expect(changedWeights[0].planned).toBeCloseTo(first[0].planned * 2);
  });
  it("matches the engine legacy 70% default and canonical point precedence", () => {
    const legacy = { kind: "arrival_multiplier", multiplier: 2 };
    const [day] = plannedArrivals({ ...base, conditions: [legacy] });
    expect(day.planned / day.baseline).toBeCloseTo(1.7);
    expect(arrivalControlPercent(legacy)).toBe(70);
    expect(arrivalControlPercent(undefined)).toBe(0);
    expect(arrivalControlPercent({ surge_percent: 0 })).toBe(0);
    expect(
      arrivalControlPercent({
        shape: "step",
        surge_percent: 90,
        control_points: [{ multiplier: 1.2 }, { multiplier: 1.2 }],
      }),
    ).toBeCloseTo(20);
    expect(
      arrivalControlPercent({
        shape: "piecewise_linear",
        control_points: [{ multiplier: 1 }, { multiplier: 0.5 }],
      }),
    ).toBe(-50);
    expect(
      arrivalControlPercent({
        shape: "piecewise_linear",
        control_points: [
          { multiplier: 1 },
          { multiplier: 0.3 },
          { multiplier: 0.8 },
          { multiplier: 1 },
        ],
      }),
    ).toBe(-70);
    expect(
      arrivalControlPercent({
        shape: "piecewise_linear",
        control_points: [
          { multiplier: 1 },
          { multiplier: 0.3 },
          { multiplier: 1 },
        ],
      }),
    ).toBe(-70);
  });
  it("formats control strength cleanly without changing canonical curve points or exposure", () => {
    const condition = {
      kind: "arrival_multiplier",
      shape: "step",
      control_points: [
        { at: base.start, multiplier: 1.4 },
        { at: base.end, multiplier: 1.4 },
      ],
    };
    const canonical = JSON.stringify(condition);
    const raw = arrivalControlPercent(condition);
    const exposure = plannedArrivals({ ...base, conditions: [condition] });
    expect(raw).toBe((1.4 - 1) * 100);
    expect(displayArrivalPercent(raw)).toBe(40);
    expect(displayArrivalPercent((1.35 - 1) * 100)).toBe(35);
    expect(displayArrivalPercent((0.3 - 1) * 100)).toBe(-70);
    expect(JSON.stringify(condition)).toBe(canonical);
    expect(plannedArrivals({ ...base, conditions: [condition] })).toEqual(
      exposure,
    );
  });
});
