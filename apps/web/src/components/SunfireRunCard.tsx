import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  LoaderCircle,
} from "lucide-react";
import { api, localDate } from "../api";
import type { Entity, Metrics, PlanningContext, RunGroup } from "../types";
import {
  evidenceMatchesRun,
  mainRecordedConstraint,
} from "../pages/decisionSummaryModel";
import { pendingSimulation, sunfireRunOutcomes } from "./sunfireModel";
import type { SunfireLink } from "./sunfireTypes";

export default function SunfireRunCard({
  runId,
  ctx,
  onNavigate,
  onRequest,
  disabled,
  active,
}: {
  runId: string;
  ctx: PlanningContext;
  onNavigate: (link: SunfireLink) => void;
  onRequest: (message: string, runId?: string) => void;
  disabled: boolean;
  active: boolean;
}) {
  const query = useQuery({
    queryKey: ["sunfire-simulation", runId],
    queryFn: () => api<RunGroup>(`/run-groups/${encodeURIComponent(runId)}`),
    enabled: active,
    refetchInterval: (result) =>
      pendingSimulation(result.state.data?.status) ? 1500 : false,
    retry: false,
  });
  const run = query.data;
  const metrics = useQuery({
    queryKey: ["sunfire-run-metrics", runId],
    queryFn: () =>
      api<Metrics>(
        `/run-groups/${encodeURIComponent(runId)}/metrics?grain=day&max_points=200`,
      ),
    enabled: active && run?.status === "SUCCEEDED",
    staleTime: Infinity,
    retry: false,
  });
  const evidence = useQuery({
    queryKey: ["ensemble-recorded-bottlenecks", runId],
    queryFn: () =>
      api<Entity>(`/run-groups/${encodeURIComponent(runId)}/bottlenecks`),
    enabled: active && run?.status === "SUCCEEDED",
    staleTime: Infinity,
    retry: false,
  });
  const pending = pendingSimulation(run?.status);
  const complete = run?.status === "SUCCEEDED";
  const completed =
    run && Number.isInteger(run.replications_completed)
      ? run.replications_completed
      : null;
  const requested =
    run &&
    Number.isInteger(run.replications_requested) &&
    run.replications_requested > 0
      ? run.replications_requested
      : null;
  const context = run ? { ...ctx, run, metrics: metrics.data || null } : null;
  const recorded =
    context && evidenceMatchesRun(evidence.data, context)
      ? evidence.data
      : null;
  const constraint = mainRecordedConstraint(
    recorded,
    ctx.dataset && ctx.dataset.id === run?.dataset_version_id
      ? ctx.dataset.units
      : [],
  );
  const title = !run
    ? "Loading simulation"
    : complete
      ? "Simulation complete"
      : pending
        ? run.status === "CANCEL_REQUESTED"
          ? "Cancelling simulation"
          : "Simulation in progress"
        : run.status === "CANCELLED"
          ? "Simulation cancelled"
          : "Simulation needs attention";
  return (
    <section
      className="sunfire-run-card"
      data-testid="sunfire-run-progress"
      data-run-id={runId}
      data-status={run?.status || "LOADING"}
      aria-label="Simulation progress and results"
    >
      <header>
        {complete ? (
          <CheckCircle2 size={15} />
        ) : pending || !run ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <AlertCircle size={15} />
        )}
        <strong>{title}</strong>
      </header>
      {query.error ? (
        <p role="alert">
          Simulation status could not be loaded.{" "}
          <button onClick={() => void query.refetch()}>Retry status</button>
        </p>
      ) : !run ? (
        <p>Retrieving the saved simulation job…</p>
      ) : pending ? (
        <>
          <p>
            {completed !== null && requested !== null
              ? `${completed} of ${requested} runs complete`
              : "Waiting for recorded progress"}
          </p>
          {completed !== null && requested !== null ? (
            <progress
              max={requested}
              value={Math.min(requested, completed)}
              aria-label="Simulation runs completed"
            />
          ) : null}
          {ctx.canWrite !== false ? (
            <button
              className="sunfire-text-action"
              disabled={disabled || run.status === "CANCEL_REQUESTED"}
              onClick={() => onRequest("Cancel this simulation.", runId)}
            >
              Cancel simulation
            </button>
          ) : null}
        </>
      ) : complete ? (
        <>
          <p className="sunfire-evidence-scope">
            Median across {completed === null ? "completed" : completed}{" "}
            simulation runs
          </p>
          <dl className="sunfire-result-measures">
            {sunfireRunOutcomes(run, metrics.data).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value === null
                    ? "Unavailable"
                    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(row.value)}${row.unit === "%" ? "%" : ` ${row.unit}`}`}
                </dd>
              </div>
            ))}
          </dl>
          {constraint ? (
            <p className="sunfire-recorded-constraint">
              <strong>{constraint.label}</strong>
              {constraint.unit ? ` · ${constraint.unit}` : ""}
              {constraint.firstAt
                ? ` · first recorded ${localDate(constraint.firstAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: run.scenario_context?.timezone || ctx.scenario?.timezone || "America/Chicago" })}`
                : ""}
            </p>
          ) : recorded?.categories?.length === 0 ? (
            <p>No resource constraint was recorded.</p>
          ) : evidence.isFetching ? (
            <p>Loading recorded constraints…</p>
          ) : (
            <p>Recorded constraint details unavailable.</p>
          )}
          {metrics.error ? (
            <button
              className="sunfire-text-action"
              onClick={() => void metrics.refetch()}
            >
              Retry measured outcomes
            </button>
          ) : null}
          <div className="sunfire-card-actions">
            <button
              onClick={() =>
                onNavigate({
                  kind: "run",
                  label: "View summary",
                  run_group_id: runId,
                })
              }
            >
              View summary <ArrowUpRight size={12} />
            </button>
            {constraint?.firstAt && constraint.replicationId ? (
              <button
                onClick={() =>
                  onNavigate({
                    kind: "replay",
                    label: "View bottleneck",
                    run_group_id: runId,
                    replication_id: constraint.replicationId!,
                    at: constraint.firstAt!,
                  })
                }
              >
                View bottleneck <ArrowUpRight size={12} />
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p>
            {run.status === "CANCELLED"
              ? "The saved job was cancelled. Previous results are preserved."
              : "This job did not produce complete results."}
          </p>
          {ctx.canWrite !== false ? (
            <button
              className="sunfire-text-action"
              disabled={disabled}
              onClick={() => onRequest("Run the current configuration again.")}
            >
              Run current configuration again
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
