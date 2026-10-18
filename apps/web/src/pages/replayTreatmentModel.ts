import type { Entity } from "../types";
import { floorRecordedTime } from "./floorPlanTransitModel";

export interface RecordedTreatmentStatus {
  carePaused: boolean;
  disrupted: boolean;
  reasons: string[];
  sinceAt: string;
  lastResumedAt: string | null;
}

/** Accept only a recorded status for the currently displayed moment. */
export function recordedTreatmentStatus(
  value: unknown,
  at: unknown,
): RecordedTreatmentStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Entity;
  const moment = typeof at === "string" ? floorRecordedTime(at) : NaN;
  const since =
    typeof row.since_at === "string" ? floorRecordedTime(row.since_at) : NaN;
  if (
    typeof row.care_paused !== "boolean" ||
    typeof row.treatment_disrupted !== "boolean" ||
    !Number.isFinite(moment) ||
    !Number.isFinite(since) ||
    since > moment ||
    !Array.isArray(row.reasons) ||
    row.reasons.some(
      (reason: unknown) =>
        reason !== "treatment_disruption" && reason !== "medical_supplies",
    )
  )
    return null;
  const reasons = [...new Set<string>(row.reasons)];
  if (
    (!row.care_paused && (row.treatment_disrupted || reasons.length > 0)) ||
    row.treatment_disrupted !== reasons.includes("treatment_disruption")
  )
    return null;
  let lastResumedAt: string | null = null;
  if (row.last_resumed_at !== null && row.last_resumed_at !== undefined) {
    const resumed =
      typeof row.last_resumed_at === "string"
        ? floorRecordedTime(row.last_resumed_at)
        : NaN;
    if (!Number.isFinite(resumed) || resumed > moment || resumed > since)
      return null;
    lastResumedAt = row.last_resumed_at;
  }
  return {
    carePaused: row.care_paused,
    disrupted: row.treatment_disrupted,
    reasons,
    sinceAt: row.since_at,
    lastResumedAt,
  };
}

export function treatmentPauseLabel(status: RecordedTreatmentStatus): string {
  return status.reasons.includes("treatment_disruption")
    ? status.reasons.includes("medical_supplies")
      ? "Treatment paused · disruption and supplies"
      : "Treatment paused · disruption"
    : status.reasons.includes("medical_supplies")
      ? "Treatment paused · supplies"
      : "Treatment paused";
}
