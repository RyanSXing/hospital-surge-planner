import { Check, Pause } from "lucide-react";
import { localDate } from "../api";
import {
  treatmentPauseLabel,
  type RecordedTreatmentStatus,
} from "./replayTreatmentModel";

export default function ReplayTreatmentStatus({
  status,
}: {
  status: RecordedTreatmentStatus | null;
}) {
  const state = !status
    ? "unknown"
    : status.carePaused
      ? "paused"
      : status.lastResumedAt
        ? "resumed"
        : "available";
  const date = (at: string) =>
    localDate(at, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const label = !status
    ? "Care status unavailable"
    : status.carePaused
      ? treatmentPauseLabel(status)
      : status.lastResumedAt
        ? `Treatment resumed ${date(status.lastResumedAt)}`
        : "Treatment available";
  const detail = !status
    ? "Treatment status was not recorded for this moment."
    : status.carePaused
      ? `${label}. Since ${date(status.sinceAt)}. Red rooms cannot treat patients; arrivals continue. Beds and occupancy remain recorded separately.`
      : status.lastResumedAt
        ? `Treatment resumed on ${date(status.lastResumedAt)}. This describes treatment availability; other resource constraints may remain.`
        : `Treatment has been available since ${date(status.sinceAt)}. Other resource constraints may still limit care.`;
  return (
    <span
      className="replay-treatment-status"
      data-testid="replay-treatment-status"
      data-state={state}
      data-reasons={status?.reasons.join(" ") || ""}
      data-since-at={status?.sinceAt || ""}
      data-last-resumed-at={status?.lastResumedAt || ""}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title={detail}
    >
      {status ? (
        status.carePaused ? (
          <Pause size={12} aria-hidden="true" />
        ) : (
          <Check size={12} aria-hidden="true" />
        )
      ) : null}
      <span>{label}</span>
    </span>
  );
}
