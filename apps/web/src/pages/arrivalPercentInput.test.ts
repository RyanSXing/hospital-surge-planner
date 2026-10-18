import { describe, expect, it } from "vitest";
import {
  clampArrivalPercent,
  completeArrivalPercent,
} from "./arrivalPercentInput";

describe("arrival percentage input", () => {
  it("keeps empty and partial input separate from the simulation value", () => {
    for (const text of ["", "-", ".", "-.", "20.", "-20."])
      expect(completeArrivalPercent(text)).toBeNull();
    expect(completeArrivalPercent("-2")).toBe(-2);
    expect(completeArrivalPercent("-20")).toBe(-20);
    expect(completeArrivalPercent("20")).toBe(20);
    expect(completeArrivalPercent("20.5")).toBe(20.5);
    expect(completeArrivalPercent(0)).toBe(0);
  });

  it("rejects nonfinite values and normalizes only valid finished values", () => {
    expect(completeArrivalPercent(Number.NaN)).toBeNull();
    expect(completeArrivalPercent(Infinity)).toBeNull();
    expect(completeArrivalPercent("1e309")).toBeNull();
    expect(clampArrivalPercent(-200)).toBe(-100);
    expect(clampArrivalPercent(20000)).toBe(10000);
    expect(clampArrivalPercent(-20)).toBe(-20);
  });
});
