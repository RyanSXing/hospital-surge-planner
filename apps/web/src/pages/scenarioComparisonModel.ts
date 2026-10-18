import type { Entity } from "../types";
import { finiteStatistic } from "./resultsMetrics";

export interface ScenarioPair {
  left: string;
  right: string;
  warning: string | null;
}
export const comparisonMetrics = [
  {
    key: "average_wait_per_patient_hours",
    label: "Average wait per patient",
    unit: "h",
    kind: "number",
  },
  {
    key: "peak_inpatient_queue",
    label: "Most patients waiting for a bed",
    unit: "patients",
    kind: "number",
  },
  {
    key: "success_score_percent",
    label: "Success score",
    unit: "%",
    kind: "percent",
  },
  {
    key: "medical_supply_average_percent",
    label: "Average medical supplies",
    unit: "%",
    kind: "percent",
  },
  { key: "arrivals", label: "New patients", unit: "patients", kind: "number" },
  {
    key: "discharges",
    label: "Completed discharges",
    unit: "patients",
    kind: "number",
  },
] as const;
export const comparisonCharts = [
  {
    key: "inpatient_queue",
    label: "Bed waiting",
    title: "Patients waiting for a bed",
    source: "series",
    unit: "Patients",
  },
  {
    key: "ed_queue",
    label: "Emergency waiting",
    title: "Patients waiting for emergency assessment",
    source: "series",
    unit: "Patients",
  },
  {
    key: "ward_occupied",
    label: "Ward occupancy",
    title: "Patients in ward beds",
    source: "series",
    unit: "Patients",
  },
  {
    key: "icu_occupied",
    label: "ICU occupancy",
    title: "Patients in intensive care",
    source: "series",
    unit: "Patients",
  },
  {
    key: "medical_supply_average_percent",
    label: "Medical supplies",
    title: "Average medical supplies each day",
    source: "daily",
    unit: "Supply stock (%)",
  },
  {
    key: "arrivals",
    label: "Daily arrivals",
    title: "Patient arrivals each day",
    source: "daily",
    unit: "Patients per day",
  },
] as const;
export type ScenarioComparisonChart = (typeof comparisonCharts)[number];

export function resolveScenarioPair(
  library: Entity[],
  currentId?: string,
  requestedLeft?: string | null,
  requestedRight?: string | null,
): ScenarioPair {
  const available = library.filter(
    (scenario) => scenario.id && scenario.archived !== true,
  );
  const ids = new Set(available.map((scenario) => scenario.id));
  const left =
    requestedLeft && ids.has(requestedLeft)
      ? requestedLeft
      : currentId && ids.has(currentId)
        ? currentId
        : available[0]?.id || "";
  const right =
    requestedRight && requestedRight !== left && ids.has(requestedRight)
      ? requestedRight
      : available.find((scenario) => scenario.id !== left)?.id || "";
  let warning: string | null = null;
  if (requestedLeft && requestedRight && requestedLeft === requestedRight)
    warning =
      "Choose two different saved scenarios. Another available scenario has been selected.";
  else if (
    (requestedLeft && !ids.has(requestedLeft)) ||
    (requestedRight && !ids.has(requestedRight))
  )
    warning =
      "A selected scenario is no longer in the library. Choose another saved scenario.";
  return { left, right, warning };
}

/** A library refresh is useful before two scenarios exist; a comparison request is not. */
export function refreshScenarioComparison(
  pair: Pick<ScenarioPair, "left" | "right">,
  refreshLibrary: () => Promise<unknown>,
  refreshResults: () => Promise<unknown>,
): Promise<unknown[]> {
  const requests = [refreshLibrary()];
  if (pair.left && pair.right && pair.left !== pair.right)
    requests.push(refreshResults());
  return Promise.all(requests);
}

/** Saved-scenario selection must not carry an unrelated historical response plan. */
export function savedScenarioComparisonUrl(
  href: string,
  pair?: Pick<ScenarioPair, "left" | "right">,
): URL {
  const url = new URL(href);
  url.searchParams.delete("comparison");
  url.searchParams.delete("plan");
  if (pair) {
    if (pair.left) url.searchParams.set("compare_left", pair.left);
    else url.searchParams.delete("compare_left");
    if (pair.right) url.searchParams.set("compare_right", pair.right);
    else url.searchParams.delete("compare_right");
  }
  return url;
}

export function comparisonMatchesPair(
  value: Entity | null | undefined,
  left: string,
  right: string,
  library?: Entity[],
): boolean {
  if (!(
    value?.kind === "saved_scenarios" &&
    left &&
    right &&
    left !== right &&
    value.left?.scenario?.id === left &&
    value.right?.scenario?.id === right
  ))
    return false;
  if (!library) return true;
  return [value.left.scenario, value.right.scenario].every(
    (scenario: Entity) => {
      const saved = library.find((item) => item.id === scenario.id);
      return Boolean(
        saved &&
        Number.isInteger(saved.revision) &&
        scenario.revision === saved.revision,
      );
    },
  );
}

/** Defensive validation also prevents old results flashing during selection changes. */
export function scenarioSideReady(side: Entity | null | undefined): boolean {
  if (side?.state !== "ready" || !side.scenario || !side.run || !side.metrics)
    return false;
  const run = side.run,
    scenario = side.scenario,
    context = side.metrics.context;
  return Boolean(
    run.status === "SUCCEEDED" &&
    Number.isInteger(scenario.revision) &&
    run.source_draft_revision === scenario.revision &&
    run.scenario_id === scenario.id &&
    run.dataset_version_id === scenario.dataset_version_id &&
    context?.run_group_id === run.id &&
    context.scenario_id === scenario.id &&
    context.dataset_version_id === scenario.dataset_version_id &&
    context.scenario_revision_id === run.scenario_revision_id,
  );
}

export function savedScenarioRunRequest(
  side: Entity,
): { scenario_id: string; expected_scenario_revision: number } | null {
  if (
    !side?.scenario?.id ||
    !Number.isInteger(side.scenario.revision) ||
    side.scenario.revision < 1 ||
    side.can_run !== true ||
    side.scenario.archived
  )
    return null;
  return {
    scenario_id: side.scenario.id,
    expected_scenario_revision: side.scenario.revision,
  };
}

export function sideIsRunning(side: Entity | null | undefined): boolean {
  const status = side?.latest_run?.status;
  return Boolean(
    status && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(status),
  );
}

export function scenarioSideStatus(side: Entity | null | undefined): string {
  if (!side) return "Choose a saved scenario.";
  if (scenarioSideReady(side))
    return `Saved revision ${side.scenario.revision} · ${side.run.replications_completed ?? side.run.completed ?? "—"} simulation runs`;
  if (side.state === "running")
    return "Simulation in progress. Results will appear when every run is complete.";
  if (side.state === "stale")
    return (
      side.reasons?.[0]?.message ||
      "The configuration has changed. Run this saved revision for current results."
    );
  if (side.state === "failed")
    return "The latest simulation failed. Run the saved scenario again.";
  if (side.state === "cancelled")
    return "The latest simulation was cancelled. No current complete results are available.";
  if (side.state === "archived") return "This scenario is archived.";
  if (side.state === "missing")
    return "This saved scenario has not been simulated yet.";
  return "Current simulation results are unavailable.";
}

export function comparisonMetricValue(
  side: Entity | null | undefined,
  metric: string,
): number | null {
  if (!scenarioSideReady(side)) return null;
  const value = finiteStatistic(side!.metrics.scalar_metrics?.[metric]);
  if (
    value === null ||
    value < 0 ||
    (["success_score_percent", "medical_supply_average_percent"].includes(
      metric,
    ) &&
      value > 100)
  )
    return null;
  return value;
}

export function formatComparisonValue(
  value: number | null,
  unit: string,
): string {
  if (
    value === null ||
    !Number.isFinite(value) ||
    (unit === "%" && (value < 0 || value > 100))
  )
    return "—";
  const number = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(value);
  return unit === "%" ? `${number}%` : unit === "h" ? `${number} h` : number;
}

export function descriptiveDifference(
  comparison: Entity | null | undefined,
  metric: string,
): number | null {
  if (
    !comparison?.compatibility?.comparable ||
    !scenarioSideReady(comparison.left) ||
    !scenarioSideReady(comparison.right)
  )
    return null;
  const row = comparison.deltas?.find((item: Entity) => item.metric === metric);
  const left = comparisonMetricValue(comparison.left, metric),
    right = comparisonMetricValue(comparison.right, metric);
  if (
    row?.available !== true ||
    left === null ||
    right === null ||
    typeof row.difference !== "number" ||
    !Number.isFinite(row.difference)
  )
    return null;
  // Keep an incomplete or stale projection from implying a measured difference.
  if (
    Math.abs(right - left - row.difference) >
    Math.max(1e-8, Math.abs(right - left) * 1e-8)
  )
    return null;
  return row.difference;
}

export function formatComparisonDifference(
  value: number | null,
  unit: string,
): string {
  if (value === null) return "—";
  const number = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(Math.abs(value));
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${number}${unit === "%" ? " points" : unit === "h" ? " h" : ""}`;
}

/** Join exact observation timestamps; never align different plans by array index. */
export function scenarioComparisonRows(
  comparison: Entity | null | undefined,
  chart: ScenarioComparisonChart,
): Entity[] {
  if (
    !comparison?.compatibility?.comparable ||
    !scenarioSideReady(comparison.left) ||
    !scenarioSideReady(comparison.right)
  )
    return [];
  const sides = [comparison.left, comparison.right];
  const times = new Map<number, Entity>();
  for (const [index, side] of sides.entries()) {
    for (const row of side.metrics[chart.source] || []) {
      const at = row.at || row.start_at;
      const instant = typeof at === "string" ? Date.parse(at) : Number.NaN;
      if (!Number.isFinite(instant)) continue;
      const point = times.get(instant) || { at, left: null, right: null };
      const value = row[chart.key];
      if (finiteStatistic(value) !== null)
        point[index === 0 ? "left" : "right"] = value;
      times.set(instant, point);
    }
  }
  return [...times.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

export function formatComparisonSetting(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number")
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
      value,
    );
  if (typeof value === "string")
    return value
      .replaceAll("UNIT-WARD-", "Ward ")
      .replaceAll("UNIT-ICU", "Intensive care")
      .replaceAll("UNIT-ED", "Emergency department")
      .replaceAll("FAC-MAIN", "Hospital");
  if (Array.isArray(value))
    return value.length
      ? value.map(formatComparisonSetting).join("; ")
      : "None";
  if (typeof value === "object")
    return Object.entries(value)
      .map(
        ([key, item]) =>
          `${key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}: ${formatComparisonSetting(item)}`,
      )
      .join(" · ");
  return "Not available";
}
