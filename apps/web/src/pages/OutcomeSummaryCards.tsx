import { fmt } from "../api";
import type { PlanningContext } from "../types";
import { finiteStatistic } from "./resultsMetrics";
import {
  evidenceMatchesRun,
  mostConstrainedDepartment,
  metricsMatchRun,
} from "./decisionSummaryModel";
import { useDecisionEvidence } from "./DecisionSummary";

export const outcomeSummaryFields = [
  {
    key: "average_wait_per_patient_hours",
    label: "Average wait per patient",
    unit: "hours · median across runs",
  },
  {
    key: "most_constrained_department",
    label: "Most constrained department",
    unit: "largest unit constraint · recorded waiting",
  },
  {
    key: "medical_supply_average_percent",
    label: "Average medical supplies",
    unit: "average stock · median across runs",
    percent: true,
  },
  {
    key: "success_score_percent",
    label: "Success score",
    unit: "eligible patients treated within 24 h",
    percent: true,
  },
] as const;

export function formatOutcomeStatistic(
  value: unknown,
  statistic: "p10" | "p50" | "p90" = "p50",
  percent = false,
) {
  const result = finiteStatistic(value, statistic);
  return result === null
    ? "—"
    : `${fmt(result * (percent ? 100 : 1), 1)}${percent ? "%" : ""}`;
}
/** These metrics are already percentages, never fractions to multiply by 100. */
export function formatRecordedPercentage(value: unknown): string {
  const percent = finiteStatistic(value);
  return percent === null || percent < 0 || percent > 100
    ? "—"
    : `${fmt(percent, 1)}%`;
}
export function OutcomeSummaryCards({
  scalar,
  className,
  ctx,
}: {
  scalar?: Record<string, unknown> | null;
  className: string;
  ctx?: PlanningContext;
}) {
  const { ensemble, example } = useDecisionEvidence(ctx);
  const availableScalar =
    !ctx || (ctx.run?.status === "SUCCEEDED" && metricsMatchRun(ctx))
      ? scalar
      : null;
  const evidence =
    ctx && evidenceMatchesRun(ensemble.data, ctx)
      ? ensemble.data
      : ctx && evidenceMatchesRun(example.data, ctx)
        ? example.data
        : null;
  const departmentEvidence = mostConstrainedDepartment(
    evidence,
    ctx?.dataset?.units,
  );
  const department =
    departmentEvidence?.name ||
    (evidence?.evidence_available &&
    Array.isArray(evidence.categories) &&
    evidence.categories.length === 0
      ? "None recorded"
      : "—");
  return (
    <section className={className} aria-label="Key outcomes">
      {outcomeSummaryFields.map((field) => (
        <article key={field.key}>
          <span>{field.label}</span>
          <strong
            className={
              field.key === "most_constrained_department"
                ? "outcome-department"
                : undefined
            }
          >
            {field.key === "most_constrained_department"
              ? department
              : "percent" in field && field.percent
                ? formatRecordedPercentage(availableScalar?.[field.key])
                : formatOutcomeStatistic(availableScalar?.[field.key])}
          </strong>
          <small>
            {field.key === "most_constrained_department" &&
            departmentEvidence?.scope === "example"
              ? "selected example run"
              : field.unit}
          </small>
        </article>
      ))}
    </section>
  );
}
