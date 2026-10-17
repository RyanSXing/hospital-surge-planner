import { describe, expect, it } from "vitest";
import type { Scenario } from "../types";
import {
  buildScenarioPatch,
  clampWindow,
  conditionWindow,
  inputDifferences,
  horizonDays,
  mixError,
} from "./scenarioEditor";
import type { EditorValues } from "./scenarioEditor";
const source = () =>
  ({
    id: "S",
    dataset_version_id: "D",
    interventions: [],
    name: "Saved scenario",
    start_at: "2026-11-01T05:00:00Z",
    timezone: "America/Chicago",
    horizon_calendar_days: 3,
    base_seed: 41,
    replications: 10,
    conditions: [
      {
        id: "ed",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        shape: "step",
        surge_percent: 70,
        start_at: "2026-11-01T05:00:00Z",
        end_at: "2026-11-03T06:00:00Z",
        care_mix_override: { "RP-ICU-VENT": 0.3, "RP-WARD": 0.7 },
        source: "imported",
      },
      {
        id: "failure",
        kind: "equipment_failure",
        equipment_pool_id: "POOL",
        quantity: 1,
      },
    ],
  }) as Scenario;
const values = (): EditorValues => ({
  name: "Saved scenario",
  startAt: "2026-11-01T05:00:00Z",
  seed: 41,
  days: 3,
  replications: 10,
  stream: "ED_MAIN",
  conditionId: "ed",
  staffConditionId: "",
  percent: 70,
  shape: "sustained",
  absence: 0,
  startDay: 0,
  endDay: 2,
  peakDay: 1,
  mixMode: "preserve",
  mix: { "RP-ICU-VENT": 0.3, "RP-WARD": 0.7 },
});
describe("scenario input edits", () => {
  it("preserves imported resource profiles and unrelated conditions without mutating saved inputs", () => {
    const s = source(),
      before = JSON.stringify(s),
      patch = buildScenarioPatch(s, { ...values(), percent: 90 });
    expect(patch.conditions.find((c) => c.id === "ed")).toMatchObject({
      surge_percent: 90,
      source: "imported",
      care_mix_override: { "RP-ICU-VENT": 0.3, "RP-WARD": 0.7 },
    });
    expect(patch.conditions.find((c) => c.id === "failure")).toEqual(
      s.conditions[1],
    );
    expect(JSON.stringify(s)).toBe(before);
  });
  it("retains a care-only condition at unchanged arrival volume and validates fractions", () => {
    const patch = buildScenarioPatch(source(), {
      ...values(),
      shape: "baseline",
      percent: 0,
      mixMode: "percentages",
      mix: { discharge: 0.6, ward: 0.3, icu: 0.1 },
    });
    const c = patch.conditions.find((c) => c.id === "ed");
    expect(c?.care_mix_override).toEqual({
      discharge: 0.6,
      ward: 0.3,
      icu: 0.1,
    });
    expect(
      c?.control_points.every(
        (p: { multiplier: number }) => p.multiplier === 1,
      ),
    ).toBe(true);
    expect(mixError("percentages", { ward: 0.8, icu: 0.4 })).toContain("100%");
    expect(() =>
      buildScenarioPatch(source(), { ...values(), mix: { ward: -1, icu: 2 } }),
    ).toThrow("nonnegative");
  });
  it("preserves staged changes when editing a second arrival stream", () => {
    const first = buildScenarioPatch(source(), { ...values(), percent: 110 });
    const second = buildScenarioPatch(
      { ...source(), conditions: first.conditions },
      {
        ...values(),
        stream: "DIRECT_WARD_MAIN",
        conditionId: "",
        percent: 20,
        mixMode: "default",
        mix: { ward: 1 },
      },
    );
    expect(second.conditions.find((c) => c.id === "ed")?.surge_percent).toBe(
      110,
    );
    expect(
      second.conditions.find((c) => c.entry_stream_id === "DIRECT_WARD_MAIN")
        ?.surge_percent,
    ).toBe(20);
    expect(second.conditions.find((c) => c.id === "failure")).toEqual(
      source().conditions[1],
    );
  });
  it("maps edited windows across daylight saving using local dates", () => {
    expect(conditionWindow(source(), source().conditions[0])).toEqual({
      startDay: 0,
      endDay: 2,
    });
    const c = buildScenarioPatch(source(), values()).conditions.find(
      (c) => c.id === "ed",
    );
    expect(c?.start_at).toBe("2026-11-01T05:00:00.000Z");
    expect(c?.end_at).toBe("2026-11-03T06:00:00.000Z");
    expect(Date.parse(c!.end_at) - Date.parse(c!.start_at)).toBe(49 * 3600000);
  });
  it("keeps a one-day wave strictly ordered when its peak input hits a boundary", () => {
    const c = buildScenarioPatch(source(), {
      ...values(),
      shape: "wave",
      startDay: 1,
      endDay: 2,
      peakDay: 1,
    }).conditions.find((c) => c.id === "ed");
    const times = c!.control_points.map((p: { at: string }) =>
      Date.parse(p.at),
    );
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
    expect(clampWindow(90, 120, 30)).toEqual({ startDay: 29, endDay: 30 });
  });
  it("compares meaningful frozen inputs while ignoring transient status and revision metadata", () => {
    const before = source(),
      after = {
        ...source(),
        revision: 8,
        status: "RUNNING",
        base_seed: 99,
        conditions: [
          ...source().conditions,
          { id: "extra", kind: "staff_absence" },
        ],
      };
    expect(inputDifferences(before, after).map((x) => x.field)).toEqual([
      "base seed",
      "conditions",
    ]);
  });
});

describe("calendar horizon units", () => {
  it("clamps month ends and counts leap dates in the local calendar", () => {
    expect(horizonDays("2028-01-31T06:00:00Z", 1, "months")).toBe(29);
    expect(horizonDays("2028-01-31T06:00:00Z", 2, "months")).toBe(60);
    expect(horizonDays("2028-01-01T06:00:00Z", 12, "months")).toBe(366);
    expect(horizonDays("2027-01-31T06:00:00Z", 1, "months")).toBe(28);
  });
  it("keeps weeks as seven calendar dates across daylight saving", () => {
    expect(horizonDays("2026-11-01T05:00:00Z", 1, "weeks")).toBe(7);
    expect(horizonDays("2026-03-08T06:00:00Z", 2, "weeks")).toBe(14);
    expect(() => horizonDays("2026-01-01T06:00:00Z", 1.5, "months")).toThrow();
  });
});
