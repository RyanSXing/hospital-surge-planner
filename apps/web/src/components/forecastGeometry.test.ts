import { describe, expect, it } from "vitest";
import { forecastXDomain, isolatedForecastIndexes } from "./forecastGeometry";

describe("sparse forecast observations", () => {
  it("centers a single monthly aggregate without inventing another time point", () => {
    expect(forecastXDomain(1)).toEqual([-0.5, 0.5]);
    expect(isolatedForecastIndexes([64], Number.isFinite)).toEqual([0]);
    expect(forecastXDomain(7)).toEqual([0, 6]);
  });

  it("marks real isolated values including zero and leaves missing values empty", () => {
    expect(
      isolatedForecastIndexes(
        [0, null, 4, 5, null, 6],
        (n) => n !== null && Number.isFinite(n),
      ),
    ).toEqual([0, 5]);
  });
});
