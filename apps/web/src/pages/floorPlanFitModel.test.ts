import { describe, expect, it } from "vitest";
import { floorPlanFitScale, floorPlanNaturalWidth } from "./floorPlanFitModel";

describe("complete hospital map fit", () => {
  it.each([
    {
      viewportWidth: 930,
      viewportHeight: 285,
      contentWidth: 1000,
      contentHeight: 440,
    },
    {
      viewportWidth: 1100,
      viewportHeight: 450,
      contentWidth: 1100,
      contentHeight: 470,
    },
    {
      viewportWidth: 1380,
      viewportHeight: 620,
      contentWidth: 1380,
      contentHeight: 420,
    },
    {
      viewportWidth: 940,
      viewportHeight: 275,
      contentWidth: 1000,
      contentHeight: 670,
    },
    {
      viewportWidth: 1560,
      viewportHeight: 850,
      contentWidth: 1560,
      contentHeight: 470,
    },
  ])(
    "fits every edge inside the measured canvas: $viewportWidth × $viewportHeight",
    (size) => {
      const scale = floorPlanFitScale(size);
      expect(size.contentWidth * scale).toBeLessThanOrEqual(
        size.viewportWidth - 1,
      );
      expect(size.contentHeight * scale).toBeLessThanOrEqual(
        size.viewportHeight - 1,
      );
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThanOrEqual(1);
    },
  );

  it("uses the tighter dimension and responds to sidebar, fullscreen and installed beds", () => {
    const compact = {
      viewportWidth: 930,
      viewportHeight: 285,
      contentWidth: 1000,
      contentHeight: 440,
    };
    const scale = floorPlanFitScale(compact);
    expect(scale).toBeCloseTo(284 / 440, 3);
    expect(floorPlanFitScale({ ...compact, contentHeight: 560 })).toBeLessThan(
      scale,
    );
    expect(
      floorPlanFitScale({
        ...compact,
        viewportWidth: 1550,
        viewportHeight: 800,
      }),
    ).toBe(1);
    expect(floorPlanNaturalWidth(930)).toBe(1000);
    expect(floorPlanNaturalWidth(1168.5)).toBe(1168);
  });

  it("does not emit an invalid scale before the viewport is measurable", () => {
    for (const value of [0, -1, NaN, Infinity])
      expect(
        floorPlanFitScale({
          viewportWidth: value,
          viewportHeight: 300,
          contentWidth: 1000,
          contentHeight: 440,
        }),
      ).toBe(1);
    expect(floorPlanNaturalWidth(NaN)).toBe(1000);
  });
});
