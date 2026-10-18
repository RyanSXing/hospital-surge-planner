import { describe, expect, it } from "vitest";
import { formatOutcomeStatistic } from "./OutcomeSummaryCards";

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
