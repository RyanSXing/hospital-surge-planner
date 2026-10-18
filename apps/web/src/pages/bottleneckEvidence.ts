import type { Entity } from "../types";
import { humanLabel } from "../presentation";

const reasons: Record<string, string> = {
  no_matching_physical_place: "Not enough suitable beds",
  nursing_capacity: "No staffed bed available",
  minimum_operating_team: "Minimum medical or support team missing",
  required_equipment_unavailable: "Required equipment unavailable",
  unsupported_care_capability: "Required care capability unavailable",
  place_turnover: "Beds being cleaned",
  incoming_reservation: "Beds reserved for incoming patients",
  destination_inactive: "Unit not open",
  medical_supplies: "Out of medical supplies",
  treatment_disruption: "Treatment interrupted",
};

export function bottleneckLabel(reason: string) {
  return reasons[reason] || humanLabel(reason);
}

/** Means add across intervals; percentile totals cannot be recovered by adding medians. */
export function meanConstraintHours(daily: Entity[]): Entity[] {
  const totals = new Map<string, number>();
  for (const day of daily) {
    for (const [reason, value] of Object.entries(
      day.blocker_patient_hours || {},
    )) {
      const mean = typeof value === "number" ? value : (value as Entity)?.mean;
      if (typeof mean !== "number" || !Number.isFinite(mean)) continue;
      totals.set(reason, (totals.get(reason) || 0) + mean);
    }
  }
  return Array.from(totals, ([reason, patient_hours]) => ({
    reason,
    patient_hours,
  }))
    .filter((row) => row.patient_hours > 0)
    .sort(
      (a, b) =>
        b.patient_hours - a.patient_hours || a.reason.localeCompare(b.reason),
    );
}

export function namedConstraintResources(
  resources: Entity[],
  reason: string,
  units: Entity[] = [],
): string[] {
  return Array.from(
    new Set(
      resources
        .filter((resource) => resource.reason === reason)
        .map((resource) => {
          const unit = units.find((item) => item.unit_id === resource.unit_id);
          const name = unit?.name;
          const label =
            name &&
            name.toLowerCase() !== String(resource.unit_kind).toLowerCase()
              ? humanLabel(name)
              : humanLabel(resource.unit_kind);
          return `${label} · ${humanLabel(resource.code)}`;
        }),
    ),
  );
}
