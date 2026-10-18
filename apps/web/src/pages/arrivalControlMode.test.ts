import { describe, expect, it } from "vitest";
import { usesCustomArrivalSchedule } from "./arrivalControlMode";

describe("arrival schedule controls", () => {
  it("keeps global controls for usual arrivals and a single preset", () => {
    expect(usesCustomArrivalSchedule([], "ED_MAIN", "baseline")).toBe(false);
    for (const shape of ["sustained", "ramp", "wave"])
      expect(
        usesCustomArrivalSchedule(
          [{ kind: "arrival_multiplier", id: "preset" }],
          "ED_MAIN",
          shape,
        ),
      ).toBe(false);
  });
  it("shows custom state for independently edited windows and one edited day", () => {
    expect(
      usesCustomArrivalSchedule(
        [
          { kind: "arrival_multiplier", id: "one" },
          { kind: "arrival_multiplier", id: "two" },
        ],
        "ED_MAIN",
        "sustained",
      ),
    ).toBe(true);
    expect(
      usesCustomArrivalSchedule(
        [{ kind: "arrival_multiplier", id: "arrival-edit-ed-main-day1" }],
        "ED_MAIN",
        "sustained",
      ),
    ).toBe(true);
  });
  it("retains custom state for an imported exact curve", () => {
    expect(
      usesCustomArrivalSchedule(
        [{ kind: "arrival_multiplier", id: "imported" }],
        "ED_MAIN",
        "custom",
      ),
    ).toBe(true);
    expect(
      usesCustomArrivalSchedule(
        [
          {
            kind: "arrival_multiplier",
            id: "imported-stepped",
            shape: "step",
            control_points: [
              { multiplier: 1.2 },
              { multiplier: 2 },
              { multiplier: 1 },
            ],
          },
        ],
        "ED_MAIN",
        "baseline",
      ),
    ).toBe(true);
    expect(
      usesCustomArrivalSchedule(
        [
          {
            kind: "arrival_multiplier",
            id: "imported-linear",
            shape: "piecewise_linear",
            control_points: [{ multiplier: 1.2 }, { multiplier: 1.5 }],
          },
        ],
        "ED_MAIN",
        "baseline",
      ),
    ).toBe(true);
  });
  it("ignores other streams, batches and hospital configuration", () => {
    expect(
      usesCustomArrivalSchedule(
        [
          { kind: "arrival_multiplier", id: "preset" },
          {
            kind: "arrival_multiplier",
            id: "arrival-edit-direct-day1",
            entry_stream_id: "DIRECT_WARD_MAIN",
          },
          { kind: "arrival_batch" },
          { kind: "unit_configuration" },
        ],
        "ED_MAIN",
        "sustained",
      ),
    ).toBe(false);
  });
});
