import type { Entity } from "../types";
import { finiteStatistic } from "./resultsMetrics";
import { bottleneckLabel } from "./bottleneckEvidence";

function recordedAmount(value: unknown): number | null {
  const mean =
    value && typeof value === "object" ? (value as Entity).mean : value;
  return typeof mean === "number" && Number.isFinite(mean)
    ? mean
    : finiteStatistic(value);
}

/** Shade recorded waiting constraints or care outages; never infer causes from arrivals. */
export function recordedConstraintMarkers(rows: Entity[], daily: Entity[]) {
  return rows.flatMap((row, index) => {
    const at = Date.parse(row.at || row.start_at);
    const end = Date.parse(
      row.end_at || rows[index + 1]?.at || rows[index + 1]?.start_at,
    );
    const days = row.blocker_patient_hours
      ? [row]
      : daily.filter(
          (day) =>
            Date.parse(day.start_at) <= at && at < Date.parse(day.end_at),
        );
    const reasons = new Set<string>();
    for (const day of days) {
      for (const [reason, value] of Object.entries(
        day.blocker_patient_hours || {},
      )) {
        const amount = recordedAmount(value);
        if (amount !== null && amount > 0) reasons.add(reason);
      }
      for (const [field, reason] of [
        ["medical_supplies_shortage_hours", "medical_supplies"],
        ["treatment_disruption_hours", "treatment_disruption"],
      ]) {
        const amount = recordedAmount(day[field]);
        if (amount !== null && amount > 0) reasons.add(reason);
      }
    }
    if (!reasons.size) return [];
    return [
      {
        index,
        at: Number.isFinite(at) ? new Date(at).toISOString() : null,
        endAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
        reasons: [...reasons].sort(),
        label: [...reasons].sort().map(bottleneckLabel).join(" · "),
      },
    ];
  });
}
