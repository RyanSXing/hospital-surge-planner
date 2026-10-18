import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { api, localDate } from "../api";
import { Button } from "../components/ui";
import type { PlanningContext } from "../types";
import {
  buildDecisionSummary,
  followDecisionAction,
} from "./decisionSummaryModel";
import "./decisionSummary.css";

/** Both summary components share immutable evidence through the query cache. */
export function useDecisionEvidence(ctx?: PlanningContext) {
  const replication =
    ctx?.activeReplicationId || ctx?.run?.selected_replication_id;
  const ensemble = useQuery({
    queryKey: ["ensemble-recorded-bottlenecks", ctx?.run?.id],
    queryFn: ({ signal }) =>
      api(`/run-groups/${encodeURIComponent(ctx!.run!.id)}/bottlenecks`, {
        signal,
      }),
    enabled: ctx?.run?.status === "SUCCEEDED",
    staleTime: Infinity,
    retry: false,
  });
  const example = useQuery({
    queryKey: ["recorded-bottlenecks", replication],
    queryFn: ({ signal }) =>
      api(`/runs/${encodeURIComponent(replication!)}/bottlenecks`, { signal }),
    enabled: Boolean(
      replication &&
      ctx?.run?.status === "SUCCEEDED" &&
      (ensemble.isError ||
        (ensemble.isSuccess &&
          (!ensemble.data?.evidence_available ||
            ensemble.data?.scope !== "ensemble"))),
    ),
    staleTime: Infinity,
    retry: false,
  });
  return { ensemble, example };
}

export default function DecisionSummary({ ctx }: { ctx: PlanningContext }) {
  const { ensemble, example } = useDecisionEvidence(ctx);
  const model = buildDecisionSummary({
    ctx,
    ensemble: ensemble.data,
    example: example.data,
    loading: ensemble.isFetching || example.isFetching,
  });
  const date = model.main?.firstAt
    ? localDate(model.main.firstAt, {
        timeZone:
          (ctx.resultScenario || ctx.scenario)?.timezone ||
          ctx.dataset?.timezone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const runnable =
    !ctx.run || ["SUCCEEDED", "FAILED", "CANCELLED"].includes(ctx.run.status);
  return (
    <section
      className={`decision-summary decision-summary--${model.state}`}
      aria-labelledby="decision-summary-title"
      data-testid="decision-summary"
    >
      <header>
        <h2 id="decision-summary-title">Decision summary</h2>
        <Button
          primary
          disabled={
            (model.action.kind === "simulate" &&
              (!runnable || ctx.canWrite === false)) ||
            Boolean(ctx.busy)
          }
          onClick={() => followDecisionAction(model.action, ctx)}
        >
          {model.action.label} <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </header>
      {model.notice || model.state === "stale" ? (
        <p className="decision-summary-revision">
          {model.notice ||
            `Showing saved revision ${ctx.run?.source_draft_revision ?? "unavailable"}. Run the current configuration for updated results.`}
        </p>
      ) : null}
      <div className="decision-summary-content">
        <div className="decision-summary-line">
          <span>Main problem</span>
          <div>
            <strong>{model.problem}</strong>
            {date ? (
              <p>
                {model.main?.firstAcrossRuns
                  ? "First recorded across simulations"
                  : "First recorded in the example run"}
                : {date}.
              </p>
            ) : model.main ? (
              <p>The first shortage time is unavailable.</p>
            ) : null}
          </div>
        </div>
        <div className="decision-summary-line">
          <span>Patient impact</span>
          <div>
            {model.impact.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
        {model.remaining ? (
          <div className="decision-summary-line">
            <span>Still to address</span>
            <p>{model.remaining}</p>
          </div>
        ) : null}
      </div>
      <footer>
        <details>
          <summary>Why this conclusion?</summary>
          <div className="decision-summary-evidence">
            <p>
              {model.main?.scope === "example"
                ? "Constraint evidence: one selected example run. Impact measures: the completed ensemble."
                : model.main?.scope === "ensemble"
                  ? "Constraint evidence: completed simulations, ranked by mean recorded waiting burden. The first time is the earliest recorded shortage, with Replay opening that exact run."
                  : "Only measures available in the saved results are shown. Missing evidence is unavailable, never zero."}
            </p>
            {model.evidence.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>
              The most constrained department has the largest recorded
              unit/constraint waiting burden; overlapping constraints are not
              added together. Average patient waiting covers measured arrivals;
              patients still waiting contribute time up to the end. Average
              supplies is the time-weighted stock percentage. Success is the
              percentage of eligible measured arrivals who started treatment
              within 24 hours; patients with less than 24 hours of follow-up who
              have not started treatment are excluded. These planning measures
              are not clinical outcome scores.
            </p>
          </div>
        </details>
        {model.replay && model.action.kind !== "replay" ? (
          <button
            className="text-button decision-summary-replay"
            onClick={() => followDecisionAction(model.replay!, ctx)}
          >
            {model.main?.scope === "example"
              ? "View example bottleneck"
              : "View bottleneck"}{" "}
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        ) : null}
      </footer>
    </section>
  );
}
