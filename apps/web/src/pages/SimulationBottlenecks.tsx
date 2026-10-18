import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt, localDate } from "../api";
import { Button } from "../components/ui";
import { selectedRunNumber } from "../model";
import {
  bottleneckLabel,
  meanConstraintHours,
  namedConstraintResources,
} from "./bottleneckEvidence";

export default function SimulationBottlenecks({
  ctx,
}: {
  ctx: PlanningContext;
}) {
  const replication =
    ctx.activeReplicationId || ctx.run?.selected_replication_id;
  const result = useQuery({
    queryKey: ["recorded-bottlenecks", replication],
    queryFn: ({ signal }) =>
      api(`/runs/${encodeURIComponent(replication!)}/bottlenecks`, { signal }),
    enabled: Boolean(replication && ctx.run?.status === "SUCCEEDED"),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
  if (ctx.run?.status !== "SUCCEEDED") return null;
  const evidence = result.data;
  const categories: Entity[] = evidence?.categories || [];
  const resources: Entity[] = evidence?.resources || [];
  const averages = meanConstraintHours(ctx.metrics?.daily || []);
  const timeZone =
    (ctx.resultScenario || ctx.scenario)?.timezone || ctx.dataset?.timezone;
  const maximum = Math.max(1, ...categories.map((row) => row.patient_hours));
  return (
    <section
      className="summary-bottlenecks"
      aria-labelledby="summary-bottlenecks-title"
      data-testid="simulation-bottlenecks"
    >
      <header>
        <div>
          <span className="eyebrow">RECORDED CONSTRAINTS</span>
          <h2 id="summary-bottlenecks-title">What limited patient flow</h2>
          <p>
            Example run {selectedRunNumber(ctx) || "—"} · whole measured period
          </p>
        </div>
        {evidence?.evidence_available && !categories.length ? (
          <ShieldCheck size={21} aria-hidden="true" />
        ) : (
          <AlertTriangle size={21} aria-hidden="true" />
        )}
      </header>
      {result.isPending ? (
        <p role="status">
          Checking recorded bed, staffing, and equipment constraints…
        </p>
      ) : result.isError ? (
        <div className="summary-bottlenecks-error" role="status">
          <span>Recorded constraint details could not be loaded.</span>
          <Button onClick={() => void result.refetch()}>Retry details</Button>
        </div>
      ) : !evidence?.evidence_available ? (
        <p>This saved run does not contain constraint evidence.</p>
      ) : categories.length ? (
        <>
          <div className="summary-bottleneck-list">
            {categories.map((row) => {
              const named = namedConstraintResources(
                resources,
                row.reason,
                ctx.dataset?.units,
              );
              return (
                <article key={row.reason}>
                  <div className="summary-bottleneck-description">
                    <h3>{bottleneckLabel(row.reason)}</h3>
                    {named.length ? <p>{named.join("; ")}</p> : null}
                    <div
                      className="summary-bottleneck-meter"
                      aria-hidden="true"
                    >
                      <i
                        style={{
                          width: `${(100 * row.patient_hours) / maximum}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="summary-bottleneck-value">
                    <strong>
                      {fmt(row.patient_hours, 1)} <small>patient-hours</small>
                    </strong>
                    <span>Up to {fmt(row.peak_waiting)} patients waiting</span>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => ctx.setTime(row.first_at)}
                    aria-label={`Show first ${bottleneckLabel(row.reason).toLowerCase()} constraint`}
                  >
                    {localDate(row.first_at, {
                      timeZone,
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}{" "}
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                </article>
              );
            })}
          </div>
          <p className="summary-bottleneck-note">
            Patient-hours combine how many people waited with how long they
            waited. Constraints can occur together, so these rows overlap.
            Select a time to inspect its recorded state.
          </p>
        </>
      ) : (
        <p>
          No bed, staffing, equipment, or care-capability constraint was
          recorded while patients waited in this example run.
        </p>
      )}
      {averages.length ? (
        <details className="summary-bottleneck-ensemble">
          <summary>
            Average constraints across all{" "}
            {ctx.run?.replications_completed || 0} simulation runs
          </summary>
          <p>
            Average patient-hours over the whole measured period. These are
            separate from the example-run evidence above and may overlap.
          </p>
          <dl>
            {averages.map((row) => (
              <div key={row.reason}>
                <dt>{bottleneckLabel(row.reason)}</dt>
                <dd>{fmt(row.patient_hours, 1)} patient-hours</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
