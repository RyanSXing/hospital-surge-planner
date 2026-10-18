import { describe, expect, it } from "vitest";
import {
  bottleneckLabel,
  meanConstraintHours,
  namedConstraintResources,
} from "./bottleneckEvidence";

describe("recorded constraint presentation", () => {
  it("adds means instead of treating a sum of daily medians as a whole-run median", () => {
    const rows = meanConstraintHours([
      {
        blocker_patient_hours: {
          nursing_capacity: { p50: 1, mean: 4 },
          place_turnover: { mean: 0 },
        },
      },
      {
        blocker_patient_hours: {
          nursing_capacity: { p50: 2, mean: 6 },
          required_equipment_unavailable: { p50: 100 },
        },
      },
    ]);
    expect(rows).toEqual([{ reason: "nursing_capacity", patient_hours: 10 }]);
    expect(bottleneckLabel("nursing_capacity")).toBe(
      "No staffed bed available",
    );
  });
  it("names recorded roles and equipment without exposing technical codes", () => {
    expect(
      namedConstraintResources(
        [
          {
            reason: "required_equipment_unavailable",
            unit_kind: "icu",
            code: "VENTILATOR",
          },
          {
            reason: "required_equipment_unavailable",
            unit_kind: "icu",
            code: "VENTILATOR",
          },
          {
            reason: "minimum_operating_team",
            unit_kind: "icu",
            code: "support",
          },
        ],
        "required_equipment_unavailable",
      ),
    ).toEqual(["Intensive care · Ventilator"]);
  });
  it("keeps distinct ward names when several wards share a constraint", () => {
    const resources = ["A", "B"].map((id) => ({
      reason: "nursing_capacity",
      unit_kind: "ward",
      unit_id: id,
      code: "rn",
    }));
    expect(
      namedConstraintResources(resources, "nursing_capacity", [
        { unit_id: "A", name: "Ward A" },
        { unit_id: "B", name: "Ward B" },
      ]),
    ).toEqual(["Ward A · Registered nurse", "Ward B · Registered nurse"]);
  });
});
