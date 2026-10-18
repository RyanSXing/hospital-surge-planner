import { ArrowUpRight, Play } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { fmt, localDate } from "../api";
import { Badge, Button } from "./ui";
import { responseName } from "../pages/resultsMetrics";

const fields: [string, string, string][] = [
  [
    "inpatient_waiting_patient_hours",
    "Total time waiting for a hospital bed",
    "patient-hours",
  ],
  [
    "ed_waiting_patient_hours",
    "Total time waiting for emergency assessment",
    "patient-hours",
  ],
  ["peak_inpatient_queue", "Most patients waiting for a bed", "patients"],
  ["time_to_first_shortage_hours", "First bed queue", "hours after start"],
  ["hours_with_unmet_placement_demand", "Time with a bed queue", "hours"],
  ["discharges", "Completed discharges", "patients"],
  ["completed_admissions", "Completed inpatient admissions", "patients"],
  ["unserved_at_horizon", "Still waiting for a bed at the end", "patients"],
  ["staff_deficit_hours", "Staffing coverage deficit", "place-hours"],
  ["equipment_deficit_hours", "Equipment coverage deficit", "equipment-hours"],
  ["additional_staff_hours", "Additional staff assignments", "staff-hours"],
];
function scalar(value: unknown, stat = "p50"): number | null {
  const raw =
    typeof value === "number"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[stat]
        : null;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}
function valueText(value: unknown, missing = "Unavailable") {
  const median = scalar(value),
    low = scalar(value, "p10"),
    high = scalar(value, "p90");
  return (
    <>
      {median === null ? missing : fmt(median, 1)}
      {low !== null && high !== null ? (
        <small>
          Typical range: {fmt(low, 1)}–{fmt(high, 1)}
        </small>
      ) : null}
    </>
  );
}
export default function ComparisonDetails({
  plans,
  ctx,
}: {
  plans: Entity[];
  ctx: PlanningContext;
}) {
  const hasCost = plans.some(
    (p) => p.metrics?.scalar_metrics?.configured_cost !== undefined,
  );
  return (
    <details className="comparison-metrics">
      <summary>Full outcome metrics & resource assumptions</summary>
      <p className="muted small-copy">
        Middle results across the full simulation. The typical range covers the
        middle 80% of runs. Waiting reductions compare runs with the same
        arrivals.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="sr-only">
            Full-horizon comparison metrics with units and uncertainty
          </caption>
          <thead>
            <tr>
              <th>Metric · unit</th>
              {plans.map((p) => (
                <th key={p.id}>{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map(([key, label, unit]) => (
              <tr key={key}>
                <th scope="row">
                  {label}
                  <small className="muted"> · {unit}</small>
                </th>
                {plans.map((p) => (
                  <td key={p.id}>
                    {valueText(
                      p.metrics?.scalar_metrics?.[key],
                      key === "time_to_first_shortage_hours" &&
                        p.status === "SUCCEEDED"
                        ? "Not observed within horizon"
                        : "Unavailable",
                    )}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">
                Less waiting than the current plan · patient-hours
              </th>
              {plans.map((p, i) => (
                <td key={p.id}>
                  {i === 0
                    ? "Reference"
                    : valueText(
                        p.improvement?.absolute_change || p.improvement,
                      )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Less waiting than the current plan · percent</th>
              {plans.map((p, i) => {
                const baseline = scalar(
                    plans[0]?.metrics?.scalar_metrics
                      ?.inpatient_waiting_patient_hours,
                  ),
                  value = p.improvement?.percent_reduction;
                return (
                  <td key={p.id}>
                    {i === 0 ? (
                      "Reference"
                    ) : value === null || value === undefined ? (
                      baseline === 0 ? (
                        "Not applicable — zero baseline"
                      ) : (
                        "Unavailable"
                      )
                    ) : (
                      <>
                        {`${fmt(value, 1)}%`}
                        {p.improvement?.relative_change_percent ? (
                          <small>
                            Typical range:{" "}
                            {fmt(p.improvement.relative_change_percent.p10, 1)}–
                            {fmt(p.improvement.relative_change_percent.p90, 1)}%
                          </small>
                        ) : null}
                        {p.improvement?.relative_replications !== undefined ? (
                          <small>
                            {p.improvement.relative_replications} matched pairs
                            with positive reference waiting
                            {p.improvement.relative_undefined_replications
                              ? `; ${p.improvement.relative_undefined_replications} zero-reference pairs are not applicable`
                              : ""}
                          </small>
                        ) : null}
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
            {hasCost ? (
              <tr>
                <th scope="row">Configured intervention cost</th>
                {plans.map((p) => (
                  <td key={p.id}>
                    {valueText(p.metrics?.scalar_metrics?.configured_cost)}
                  </td>
                ))}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {!hasCost ? (
        <p className="muted small-copy">
          Financial cost has not been supplied for this dataset.
        </p>
      ) : null}
      {plans.map((p) => (
        <details key={p.id} className="comparison-plan-resources">
          <summary>
            <h3>{p.name}</h3>
            <Badge
              tone={
                p.feasibility?.feasible === false
                  ? "warning"
                  : p.status === "SUCCEEDED"
                    ? "success"
                    : "neutral"
              }
            >
              {p.feasibility?.feasible === false
                ? "Unavailable"
                : p.status === "SUCCEEDED"
                  ? "Ready to use"
                  : "Not yet compared"}
            </Badge>
          </summary>
          <div className="comparison-plan-resource-body">
            {p.interventions?.length ? (
              p.interventions.map((v: Entity, index: number) => (
                <dl key={v.id || index}>
                  <div>
                    <dt>Proposed action</dt>
                    <dd>{responseName(v)}</dd>
                  </div>
                  <div>
                    <dt>Scheduled start</dt>
                    <dd>
                      {localDate(v.start_at || ctx.scenario?.start_at || "", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZoneName: "short",
                        timeZone:
                          (ctx.resultScenario || ctx.scenario)?.timezone ||
                          ctx.dataset?.timezone ||
                          "America/Chicago",
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>Activation lead time</dt>
                    <dd>
                      {v.activation_minutes === undefined
                        ? "Default preparation time"
                        : `${v.activation_minutes} minutes`}
                    </dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {ctx.dataset?.units?.find(
                        (unit) =>
                          unit.unit_id === (v.unit_id || v.destination_unit_id),
                      )?.name ||
                        ctx.dataset?.facilities?.find(
                          (facility) => facility.facility_id === v.facility_id,
                        )?.name ||
                        "Hospital ward"}
                    </dd>
                  </div>
                  <div>
                    <dt>Staff allocation</dt>
                    <dd>
                      {(v.assigned_staff_ids?.length
                        ? `${v.assigned_staff_ids.length} qualified staff`
                        : null) ||
                        [
                          v.nurses === undefined ? null : `${v.nurses} nurses`,
                          v.providers === undefined
                            ? null
                            : `${v.providers} providers`,
                          v.support === undefined
                            ? null
                            : `${v.support} support`,
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        "Available reserve staff"}
                    </dd>
                  </div>
                  <div>
                    <dt>Physical places</dt>
                    <dd>
                      {v.enabled_slots ??
                        v.beds ??
                        v.quantity ??
                        "Planned hospital beds"}
                    </dd>
                  </div>
                </dl>
              ))
            ) : (
              <p className="muted small-copy">
                Current scenario resource allocations, without an additional
                response.
              </p>
            )}
            {p.feasibility?.reasons?.length ? (
              <p className="amber small-copy">
                {p.feasibility.reasons.join(" · ")}
              </p>
            ) : null}
            {p.status === "SUCCEEDED" && p.run_group_id ? (
              <div className="plan-actions">
                <Button
                  small
                  onClick={() => ctx.openRun(p.run_group_id, "summary")}
                >
                  Open in summary <ArrowUpRight size={13} />
                </Button>
                <Button
                  small
                  onClick={() => ctx.openRun(p.run_group_id, "replay")}
                >
                  <Play size={13} />
                  Replay example run
                </Button>
              </div>
            ) : null}
          </div>
        </details>
      ))}
    </details>
  );
}
