import type { Dataset, Entity } from "../types";
import { num } from "../api";

/** Comparison cards use the declared baseline until completed metrics exist. */
export function comparisonWardInventory(
  dataset: Dataset | null,
  sourceDatasetId?: string,
  last?: Entity,
) {
  if (last)
    return {
      physical: Math.round(num(last.ward_physical)),
      staffed: Math.round(num(last.ward_staffed)),
      basis:
        typeof last.ward_physical === "object"
          ? "HORIZON END · MEDIAN"
          : "HORIZON END",
    };
  if (!dataset || (sourceDatasetId && sourceDatasetId !== dataset.id))
    return null;
  const units = (dataset.units || []).filter(
    (unit) =>
      unit.kind === "ward" && unit.capacity_mode !== "advertised_aggregate",
  );
  return {
    physical: units.reduce(
      (total, unit) =>
        total +
        Number(
          unit.physical_capacity ??
            (dataset.slots || []).filter(
              (slot) =>
                slot.unit_id === unit.unit_id &&
                slot.installation_status === "installed",
            ).length,
        ),
      0,
    ),
    staffed: units.reduce(
      (total, unit) => total + Number(unit.staffed_capacity ?? 0),
      0,
    ),
    basis: "SOURCE SNAPSHOT",
  };
}
