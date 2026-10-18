import type {
  PlanningDraftSnapshot,
  PlanningDraftToken,
} from "../planningDraft";
import type { Metrics, PlanningContext, RunGroup } from "../types";
import { metricsMatchRun } from "../pages/decisionSummaryModel";
import { finiteStatistic } from "../pages/resultsMetrics";
import type {
  SunfireAction,
  SunfireContext,
  SunfireLink,
  SunfireTurnStatus,
} from "./sunfireTypes";

export const pendingSunfireTurn = (status: string | undefined) =>
  ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(status || "");
export const settledSunfireTurnCache = (
  historyStatus: string,
  cachedStatus?: string,
) => !pendingSunfireTurn(historyStatus) && cachedStatus === historyStatus;
export const pendingSimulation = (status: string | undefined) =>
  ["QUEUED", "RUNNING", "AGGREGATING", "CANCEL_REQUESTED"].includes(
    status || "",
  );
export function draftToken(value: PlanningDraftToken): PlanningDraftToken {
  return {
    scenario_id: value.scenario_id,
    saved_revision: value.saved_revision,
    dataset_version_id: value.dataset_version_id,
    draft_revision: value.draft_revision,
    draft_fingerprint: value.draft_fingerprint,
  };
}
export function sunfireContext(
  value: PlanningDraftSnapshot,
  ctx: PlanningContext,
): SunfireContext {
  return {
    ...draftToken(value),
    draft: structuredClone(value.draft),
    selected_run_group_id: ctx.run?.id || null,
    selected_replication_id:
      ctx.activeReplicationId || ctx.run?.selected_replication_id || null,
    selected_time: ctx.selectedTime || null,
    page: ctx.page,
    timezone:
      ctx.scenario?.timezone || ctx.dataset?.timezone || "America/Chicago",
  };
}
export function directActionEligible(
  action: SunfireAction,
  turnStatus: SunfireTurnStatus,
  scenarioId: string | undefined,
  canWrite: boolean,
) {
  return (
    turnStatus === "SUCCEEDED" &&
    action.status === "READY" &&
    action.mode === "direct" &&
    action.expected.scenario_id === scenarioId &&
    canWrite
  );
}
export function changeValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number")
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (Array.isArray(value))
    return `${value.length} ${value.length === 1 ? "planned item" : "planned items"}`;
  // Nested configuration is summarized by the adapter's individual named rows.
  // Never expose raw database fields or stringify an object into the product.
  return "Custom settings";
}
export function sunfireError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return "The assistant could not finish this request. Your configuration is preserved.";
}
/** Only typed, same-app destinations can become navigation controls. */
export function usableEvidenceLink(link: SunfireLink): boolean {
  const id = (value: string | undefined) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (link.kind === "run") return id(link.run_group_id);
  if (link.kind === "replay")
    return (
      id(link.replication_id) &&
      typeof link.at === "string" &&
      Number.isFinite(Date.parse(link.at))
    );
  if (link.kind === "comparison")
    return (
      id(link.left_scenario_id) &&
      id(link.right_scenario_id) &&
      link.left_scenario_id !== link.right_scenario_id
    );
  return false;
}
export function sunfireRunOutcomes(run: RunGroup, metrics?: Metrics | null) {
  const matched =
    run.status === "SUCCEEDED" &&
    metricsMatchRun({ run, metrics } as PlanningContext);
  const scalar = matched ? metrics?.scalar_metrics : null;
  return [
    {
      label: "Average wait per patient",
      value: finiteStatistic(scalar?.average_wait_per_patient_hours),
      unit: "hours",
    },
    {
      label: "Peak patients waiting for a bed",
      value: finiteStatistic(scalar?.peak_inpatient_queue),
      unit: "patients",
    },
    {
      label: "Started treatment within 24 hours",
      value: finiteStatistic(scalar?.success_score_percent),
      unit: "%",
    },
  ].map((row) => ({
    ...row,
    value:
      row.value !== null &&
      (row.value < 0 || (row.unit === "%" && row.value > 100))
        ? null
        : row.value,
  }));
}
