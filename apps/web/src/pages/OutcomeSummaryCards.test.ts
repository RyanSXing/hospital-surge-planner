import { describe, expect, it } from "vitest";
import {
  formatOutcomeStatistic,
  formatRecordedPercentage,
  outcomeSummaryFields,
} from "./OutcomeSummaryCards";

describe("formatOutcomeStatistic", () => {
  it("uses the frozen median and keeps a recorded zero visible", () => {
    expect(formatOutcomeStatistic({ p10: 2, p50: 3.799, p90: 5 })).toBe("3.8");
    expect(formatOutcomeStatistic({ p50: 0 })).toBe("0");
    expect(formatOutcomeStatistic({ p50: 0.965 }, "p50", true)).toBe("96.5%");
  });

  it("renders absent or invalid frozen values as unavailable", () => {
    expect(formatOutcomeStatistic({ p50: null })).toBe("—");
    expect(formatOutcomeStatistic({ p50: Number.NaN })).toBe("—");
    expect(formatOutcomeStatistic(undefined)).toBe("—");
  });
});

describe("planning summary cards", () => {
  it("uses direct 0–100 supply and success percentages", () => {
    expect(formatRecordedPercentage({ p50: 86.7 })).toBe("86.7%");
    expect(formatRecordedPercentage({ p50: 0 })).toBe("0%");
    expect(formatRecordedPercentage({ p50: 100 })).toBe("100%");
  });
  it("never turns missing, non-finite or invalid percentages into zero", () => {
    for (const value of [
      undefined,
      null,
      { p50: null },
      { p50: Number.NaN },
      { p50: -1 },
      { p50: 101 },
    ])
      expect(formatRecordedPercentage(value)).toBe("—");
  });
  it("replaces the old KPI strip with the requested patient, unit, supply and success measures", () => {
    expect(outcomeSummaryFields.map((field) => field.key)).toEqual([
      "average_wait_per_patient_hours",
      "most_constrained_department",
      "medical_supply_average_percent",
      "success_score_percent",
    ]);
  });
});
