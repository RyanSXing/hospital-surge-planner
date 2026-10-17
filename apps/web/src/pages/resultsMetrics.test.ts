import { describe, expect, it } from "vitest";
import { comparisonResultPlan, finiteStatistic } from "./resultsMetrics";

describe("finiteStatistic", () => {
  it("keeps zero distinct from an unobserved percentile", () => {
    expect(finiteStatistic({ p50: 0 })).toBe(0);
    expect(finiteStatistic({ p50: null })).toBeNull();
    expect(finiteStatistic({})).toBeNull();
    expect(finiteStatistic({ max: 0 }, "max")).toBe(0);
    expect(finiteStatistic({ max: null }, "max")).toBeNull();
  });

  it("rejects non-finite values", () => {
    expect(finiteStatistic({ p50: Number.NaN })).toBeNull();
    expect(finiteStatistic(2.5)).toBe(2.5);
  });
});

describe("comparisonResultPlan", () => {
  const reference = { id: "reference", reference: true };
  const response = { id: "response", reference: false, kind: "staff_existing" };

  it("uses the reference plan when no response improves the objective", () => {
    expect(comparisonResultPlan([response, reference], true, response)).toBe(
      reference,
    );
  });

  it("uses the API ranking when improvement is present", () => {
    expect(comparisonResultPlan([reference, response], false, response)).toBe(
      response,
    );
  });
});
