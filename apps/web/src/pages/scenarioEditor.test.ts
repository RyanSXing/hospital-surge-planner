import { describe, expect, it } from "vitest";
import type { Scenario } from "../types";
import {
  buildScenarioPatch,
  clampWindow,
  conditionWindow,
  inputDifferences,
  horizonDays,
  mixError,
  planningEnd,
  resizedArrivalWindow,
  applyShortArrivalPulse,
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
  it.each([14, 30, 3])(
    "resizes a saved whole-week arrival preset to all %i local days",
    (days) => {
      const scenario = { ...source(), horizon_calendar_days: 7 };
      const original = {
        ...values(),
        days: 7,
        endDay: 7,
        windowStartAt: scenario.start_at,
        // Chicago has changed to standard time by the end of this week.
        windowEndAt: "2026-11-08T06:00:00Z",
      };
      const resized = resizedArrivalWindow(scenario, original, days);
      expect(resized).not.toBeNull();
      const patch = buildScenarioPatch(scenario, {
        ...original,
        ...resized!,
        days,
        percent: 115,
      });
      const condition = patch.conditions.find((c) => c.id === "ed")!;
      expect(condition.control_points).toEqual([
        { at: scenario.start_at, multiplier: 2.15 },
        {
          at: planningEnd(scenario, scenario.start_at, days),
          multiplier: 2.15,
        },
      ]);
      expect(condition.end_at).toBe(
        planningEnd(scenario, scenario.start_at, days),
      );
    },
  );
  it("keeps deliberate shorter windows, custom curves, and reset endpoints fixed", () => {
    const scenario = source();
    expect(resizedArrivalWindow(scenario, values(), 30)).toBeNull();
    expect(
      resizedArrivalWindow(
        scenario,
        { ...values(), endDay: 3, shape: "custom" },
        30,
      ),
    ).toBeNull();
    expect(
      resizedArrivalWindow(
        scenario,
        { ...values(), endDay: 3, windowStartAt: "2026-11-01T17:00:00Z" },
        30,
      ),
    ).toBeNull();
    expect(
      resizedArrivalWindow(
        { ...scenario, end_at: "2026-11-04T06:00:00Z" },
        { ...values(), endDay: 3 },
        30,
      ),
    ).toBeNull();
  });
  it("does not replace an invalid or skipped local-time input with the default window", () => {
    for (const field of ["windowStartAt", "windowEndAt"] as const) {
      expect(() =>
        buildScenarioPatch(source(), { ...values(), [field]: "" }),
      ).toThrow();
    }
  });
  it("keeps a reset branch's fractional exclusive endpoint in defaults and validation", () => {
    const branch = {
      ...source(),
      end_at: "2026-11-02T17:00:00Z",
      horizon_calendar_days: 2,
    };
    expect(planningEnd(branch, branch.start_at, 2)).toBe(branch.end_at);
    const patch = buildScenarioPatch(branch, {
      ...values(),
      days: 2,
      endDay: 2,
    });
    expect(
      patch.conditions
        .find((c) => c.kind === "arrival_multiplier")
        ?.control_points.at(-1).at,
    ).toBe(new Date(branch.end_at).toISOString());
    expect(() =>
      buildScenarioPatch(branch, {
        ...values(),
        days: 2,
        endDay: 2,
        windowEndAt: "2026-11-03T06:00:00Z",
      }),
    ).toThrow("horizon");
  });
  it("turns a nonzero baseline percentage into a modeled step without requiring another preset click", () => {
    const baseline = { ...source(), conditions: [] };
    for (const percent of [70, -30]) {
      const patch = buildScenarioPatch(baseline, {
        ...values(),
        conditionId: "",
        shape: "baseline",
        percent,
        mixMode: "default",
      });
      expect(patch.conditions).toHaveLength(1);
      expect(patch.conditions[0]).toMatchObject({
        kind: "arrival_multiplier",
        shape: "step",
        surge_percent: percent,
      });
      expect(
        patch.conditions[0].control_points.map(
          (p: { multiplier: number }) => p.multiplier,
        ),
      ).toEqual([1 + percent / 100, 1 + percent / 100]);
    }
  });
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

describe("short arrival pulse preset", () => {
  it("replaces only the selected multiplier with the exact additive PRESET-PULSE inputs", () => {
    const scenario = source();
    scenario.conditions.push(
      {
        id: "other-ed-window",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        surge_percent: 10,
      },
      {
        id: "unrelated-batch",
        kind: "arrival_batch",
        count: 7,
        at: "2026-11-01T08:00:00Z",
      },
    );
    const before = JSON.stringify(scenario);
    const conditions = applyShortArrivalPulse(
      scenario,
      scenario.start_at,
      3,
      "pulse",
      "ed",
    );
    expect(conditions[0]).toEqual({
      id: "pulse",
      name: "Short arrival pulse",
      preset_id: "PRESET-PULSE",
      kind: "arrival_batch",
      entry_stream_id: "ED_MAIN",
      at: "2026-11-02T18:00:00.000Z",
      count: 20,
      spread_minutes: 60,
      care_mix: { discharge: 0.8, ward: 0.16, icu: 0.04 },
      source: "synthetic_preset",
      description: "Hypothetical additive arrival batch at local day 2, noon.",
    });
    expect(conditions.slice(1)).toEqual(scenario.conditions.slice(1));
    expect(JSON.stringify(scenario)).toBe(before);
    const saved = buildScenarioPatch(
      { ...scenario, conditions },
      {
        ...values(),
        editArrival: false,
        editLegacyStaff: false,
      },
    );
    expect(saved.conditions).toEqual(conditions);
  });

  it("uses noon on the second local date rather than adding 36 hours to a fractional snapshot", () => {
    const scenario = { ...source(), start_at: "2026-10-31T19:37:42.123Z" };
    const [pulse] = applyShortArrivalPulse(
      scenario,
      scenario.start_at,
      3,
      "pulse",
      "ed",
    );
    expect(pulse.at).toBe("2026-11-01T18:00:00.000Z");
    const nepal = {
      ...scenario,
      timezone: "Asia/Kathmandu",
      start_at: "2026-10-16T23:45:30+05:45",
    };
    const [localPulse] = applyShortArrivalPulse(
      nepal,
      nepal.start_at,
      3,
      "pulse",
      "ed",
    );
    expect(localPulse.at).toBe("2026-10-17T06:15:00.000Z");
  });

  it("preserves direct-ward and other inputs when adding an ED pulse from another stream", () => {
    const scenario = source();
    const conditions = applyShortArrivalPulse(
      scenario,
      scenario.start_at,
      3,
      "pulse",
    );
    expect(conditions.slice(0, -1)).toEqual(scenario.conditions);
    expect(conditions.at(-1)).toMatchObject({
      kind: "arrival_batch",
      entry_stream_id: "ED_MAIN",
    });
  });

  it("does not duplicate the pulse when the preset is applied again", () => {
    const scenario = source();
    const first = applyShortArrivalPulse(
      scenario,
      scenario.start_at,
      3,
      "pulse",
      "ed",
    );
    const second = applyShortArrivalPulse(
      { ...scenario, conditions: first },
      scenario.start_at,
      3,
      "new-id",
    );
    expect(second).toEqual(first);
  });

  it("preserves unrelated ED multipliers when the UI has no selected arrival", () => {
    const scenario = source();
    const first = applyShortArrivalPulse(
      scenario,
      scenario.start_at,
      3,
      "pulse",
      "ed",
    );
    const later = {
      ...scenario.conditions[0],
      id: "later-ed",
      kind: "arrival_multiplier",
      entry_stream_id: "ED_MAIN",
    };
    const conditions = [...first, later];
    expect(
      applyShortArrivalPulse(
        { ...scenario, conditions },
        scenario.start_at,
        3,
        "new",
        "",
      ),
    ).toEqual(conditions);
  });

  it("requires the full one-hour pulse to fit the exact scenario horizon", () => {
    const scenario = source();
    expect(() =>
      applyShortArrivalPulse(scenario, scenario.start_at, 1, "pulse", "ed"),
    ).toThrow("local day 2 from 12:00 to 13:00");
    expect(() =>
      applyShortArrivalPulse(
        { ...scenario, end_at: "2026-11-02T18:30:00Z" },
        scenario.start_at,
        2,
        "pulse",
        "ed",
      ),
    ).toThrow("Extend the horizon");
    expect(
      applyShortArrivalPulse(
        { ...scenario, end_at: "2026-11-02T19:00:00Z" },
        scenario.start_at,
        2,
        "pulse",
        "ed",
      )[0].at,
    ).toBe("2026-11-02T18:00:00.000Z");
  });
});
