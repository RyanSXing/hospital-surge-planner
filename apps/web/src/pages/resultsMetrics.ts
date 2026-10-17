import type { Entity } from "../types";

/** Keeps an omitted result distinct from a real zero. */
export function finiteStatistic(
  value: unknown,
  stat: "p10" | "p50" | "p90" | "min" | "max" = "p50",
): number | null {
  const result =
    typeof value === "number"
      ? value
      : value && typeof value === "object"
        ? (value as Entity)[stat]
        : null;
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}

/** Picks the truthful banner plan when ranking and paired improvement differ. */
export function comparisonResultPlan<
  T extends { kind?: unknown; reference?: boolean },
>(
  plans: T[],
  noPlanImproves: boolean | undefined,
  rankedPlan: T | null,
): T | null {
  if (!noPlanImproves) return rankedPlan;
  return plans.find((plan) => plan.reference === true) || plans[0] || null;
}
