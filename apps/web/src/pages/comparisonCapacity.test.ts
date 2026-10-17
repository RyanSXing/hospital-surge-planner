import { expect, it } from "vitest";
import { comparisonWardInventory } from "./comparisonCapacity";
import type { Dataset } from "../types";
const dataset = {
  id: "baseline",
  units: [
    {
      unit_id: "main",
      kind: "ward",
      capacity_mode: "staff_derived",
      physical_capacity: 100,
      staffed_capacity: 80,
    },
    {
      unit_id: "overflow",
      kind: "ward",
      capacity_mode: "staff_derived",
      physical_capacity: 4,
      staffed_capacity: 0,
    },
    {
      unit_id: "partner",
      kind: "ward",
      capacity_mode: "advertised_aggregate",
      physical_capacity: 50,
      staffed_capacity: 50,
    },
  ],
  slots: [],
} as unknown as Dataset;
it("uses source inventory independently of selected trajectory values", () => {
  const context = {
    dataset,
    state: { units: [{ unit_id: "main", physical: 120, staffed: 110 }] },
  };
  expect(comparisonWardInventory(context.dataset)).toEqual({
    physical: 104,
    staffed: 80,
    basis: "SOURCE SNAPSHOT",
  });
  expect(
    comparisonWardInventory(context.dataset, "baseline", {
      ward_physical: 120,
      ward_staffed: 110,
    }),
  ).toEqual({ physical: 120, staffed: 110, basis: "HORIZON END" });
});
it("withholds a saved comparison's unavailable baseline instead of using a different draft", () => {
  expect(comparisonWardInventory(dataset, "other-baseline")).toBeNull();
});
it("reads the median from the actual aggregate percentile shape", () => {
  expect(
    comparisonWardInventory(dataset, "other-baseline", {
      ward_physical: {
        p10: 100,
        p50: 120,
        p90: 140,
        mean: 123,
        min: 100,
        max: 140,
      },
      ward_staffed: { p10: 80, p50: 96, p90: 110, mean: 95, min: 80, max: 110 },
    }),
  ).toEqual({ physical: 120, staffed: 96, basis: "HORIZON END · MEDIAN" });
});
