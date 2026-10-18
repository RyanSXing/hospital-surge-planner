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

import { hospitalResponse, responseName } from "./resultsMetrics";

describe("hospital response options", () => {
  const dataset = {
    facilities: [{ facility_id: "FAC-MAIN" }, { facility_id: "FAC-OTHER" }],
    units: [
      {
        unit_id: "WARD-A",
        facility_id: "FAC-MAIN",
        kind: "ward",
        staffed_capacity: 4,
        capacity_policy_id: "WARD",
      },
      {
        unit_id: "WARD-C",
        facility_id: "FAC-MAIN",
        kind: "ward",
        staffed_capacity: 4,
        capacity_policy_id: "WARD",
      },
      {
        unit_id: "OFFSITE",
        facility_id: "FAC-OTHER",
        kind: "ward",
        staffed_capacity: 0,
      },
    ],
    capacity_policies: [{ capacity_policy_id: "WARD", slots_per_nurse: 4 }],
    slots: [
      ...Array.from({ length: 12 }, (_, index) => ({
        unit_id: "WARD-A",
        installation_status: "installed",
        slot_id: `A-${index}`,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        unit_id: "WARD-C",
        installation_status: index < 4 ? "installed" : "planned",
        slot_id: `C-${index}`,
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        unit_id: "OFFSITE",
        installation_status: "planned",
        slot_id: `X-${index}`,
      })),
    ],
  };

  it("uses spare capacity within the hospital for staffing", () => {
    expect(
      hospitalResponse(dataset, "staff_existing", "2026-10-16T05:00:00Z"),
    ).toMatchObject({
      kind: "staff_existing",
      facility_id: "FAC-MAIN",
      unit_id: "WARD-A",
      nurses: 2,
      activation_minutes: 0,
    });
  });

  it("opens declared hospital beds with an explicit target and enough extra staff", () => {
    expect(hospitalResponse(dataset, "staffed_overflow")).toMatchObject({
      facility_id: "FAC-MAIN",
      unit_id: "WARD-C",
      enabled_slots: 8,
      nurses: 1,
      providers: 1,
      support: 1,
      activation_minutes: 60,
    });
    expect(hospitalResponse(dataset, "physical_overflow")).not.toHaveProperty(
      "nurses",
    );
  });

  it("never falls back to an offsite unit when hospital expansion is unavailable", () => {
    const withoutPlannedHospitalBeds = {
      ...dataset,
      slots: dataset.slots.filter(
        (slot) =>
          slot.unit_id !== "WARD-C" || slot.installation_status === "installed",
      ),
    };
    expect(
      hospitalResponse(withoutPlannedHospitalBeds, "physical_overflow"),
    ).toBeNull();
    expect(hospitalResponse(dataset, "partner_transfer")).toBeNull();
  });

  it("uses plain response names instead of model codes", () => {
    expect(responseName({ kind: "staff_existing" })).toBe(
      "Staff more ward beds",
    );
    expect(responseName({ name: "staffed_overflow" })).toBe(
      "Open and staff extra beds",
    );
    expect(responseName({ kind: "unknown_model_code" })).toBe(
      "Hospital response",
    );
    expect(
      responseName({ name: "Evening shift", kind: "staff_existing" }),
    ).toBe("Evening shift");
  });
});
