import { describe, expect, it } from "vitest";
import { recordedConstraintMarkers } from "./constraintMarkers";
describe("recorded chart constraints", () => {
  it("marks actual positive evidence and preserves unknowns without inventing demand causes", () => {
    const rows = [
      {
        start_at: "2026-10-16T05:00:00Z",
        end_at: "2026-10-17T05:00:00Z",
        arrivals: { p50: 10000 },
        blocker_patient_hours: {
          nursing_capacity: { mean: 0 },
          medical_supplies: { mean: 5 },
          treatment_disruption: { mean: null, p50: null },
        },
      },
    ];
    expect(recordedConstraintMarkers(rows, rows)[0].reasons).toEqual([
      "medical_supplies",
    ]);
    expect(
      recordedConstraintMarkers(
        [{ ...rows[0], blocker_patient_hours: {} }],
        rows,
      ),
    ).toEqual([]);
  });
  it("associates hourly points with recorded daily shortage periods", () => {
    const daily = [
      {
        start_at: "2026-10-16T05:00:00Z",
        end_at: "2026-10-17T05:00:00Z",
        blocker_patient_hours: { treatment_disruption: { mean: 1 } },
      },
    ];
    expect(
      recordedConstraintMarkers(
        [{ at: "2026-10-16T06:00:00Z" }, { at: "2026-10-17T06:00:00Z" }],
        daily,
      ).map((row) => row.index),
    ).toEqual([0]);
  });
  it("marks recorded care outages before a waiting queue forms, without turning missing hours into zero", () => {
    const rows = [
      {
        start_at: "2026-10-16T05:00:00Z",
        end_at: "2026-10-17T05:00:00Z",
        blocker_patient_hours: {},
        medical_supplies_shortage_hours: { mean: 2 },
        treatment_disruption_hours: { mean: 24 },
      },
      {
        start_at: "2026-10-17T05:00:00Z",
        end_at: "2026-10-18T05:00:00Z",
        blocker_patient_hours: {},
        medical_supplies_shortage_hours: { mean: null },
        treatment_disruption_hours: 0,
      },
    ];
    const markers = recordedConstraintMarkers(rows, rows);
    expect(markers).toHaveLength(1);
    expect(markers[0].reasons).toEqual([
      "medical_supplies",
      "treatment_disruption",
    ]);
  });
});
