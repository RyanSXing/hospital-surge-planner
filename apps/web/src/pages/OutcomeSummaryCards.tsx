import { fmt } from "../api";
import { finiteStatistic } from "./resultsMetrics";

export const outcomeSummaryFields = [
  { key: "arrivals", label: "New arrivals", unit: "patients" },
  {
    key: "discharges",
    label: "Completed discharges",
    unit: "patients",
  },
  {
    key: "inpatient_waiting_patient_hours",
    label: "Placement waiting",
    unit: "patient-hours",
  },
  {
    key: "ward_utilization",
    label: "Ward utilization",
    unit: "of staffed capacity",
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

export function OutcomeSummaryCards({
  scalar,
  className,
}: {
  scalar?: Record<string, unknown> | null;
  className: string;
}) {
  return (
    <section className={className} aria-label="Key outcomes">
      {outcomeSummaryFields.map((field) => (
        <article key={field.key}>
          <span>{field.label}</span>
          <strong>
            {formatOutcomeStatistic(
              scalar?.[field.key],
              "p50",
              "percent" in field && field.percent === true,
            )}
          </strong>
          <small>{field.unit} · median</small>
        </article>
      ))}
    </section>
  );
}
