import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NativeSelect } from "@mantine/core";
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  Info,
  Play,
  RefreshCw,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, localDate, post } from "../api";
import { Button } from "../components/ui";
import { ForecastChart } from "../components/Charts";
import {
  comparisonCharts,
  comparisonMatchesPair,
  comparisonMetricValue,
  comparisonMetrics,
  descriptiveDifference,
  formatComparisonDifference,
  formatComparisonSetting,
  formatComparisonValue,
  refreshScenarioComparison,
  resolveScenarioPair,
  savedScenarioComparisonUrl,
  savedScenarioRunRequest,
  scenarioComparisonRows,
  scenarioSideReady,
  scenarioSideStatus,
  sideIsRunning,
} from "./scenarioComparisonModel";
import "./compare.css";

const activeStatus = (status?: string) =>
  Boolean(status && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(status));
const readSelection = () => ({
  left: new URLSearchParams(location.search).get("compare_left"),
  right: new URLSearchParams(location.search).get("compare_right"),
});
async function loadLibrary(signal: AbortSignal) {
  const scenarios: Entity[] = [];
  let cursor: string | null = null;
  do {
    const page: Entity = await api(
      `/scenarios?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal },
    );
    scenarios.push(...(page.items || []));
    cursor = page.next_cursor || null;
  } while (cursor);
  return scenarios;
}

/** Compare only saved scenarios. Historical automated comparisons remain untouched. */
export default function Compare({
  ctx,
  comparisonId,
  onComparisonSelect,
}: {
  ctx: PlanningContext;
  comparisonId?: string | null;
  onComparisonSelect?: (id: string | null) => void;
}) {
  const active = ctx.page === "comparison" || ctx.page === "compare";
  const activeRef = useRef(active);
  activeRef.current = active;
  const [requested, setRequested] = useState(readSelection);
  const visibleRequested = active ? readSelection() : requested;
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [chartKey, setChartKey] = useState<string>(comparisonCharts[0].key);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<Record<string, string>>({});
  const submitLocks = useRef(new Set<string>());
  const library = useQuery({
    queryKey: ["saved-scenario-comparison-library", ctx.scenario?.id],
    queryFn: ({ signal }) => loadLibrary(signal),
    enabled: active,
    staleTime: 10_000,
    refetchOnMount: "always",
    retry: false,
  });
  const pair = useMemo(
    () =>
      resolveScenarioPair(
        library.data || [],
        ctx.scenario?.id,
        visibleRequested.left,
        visibleRequested.right,
      ),
    [
      library.data,
      ctx.scenario?.id,
      visibleRequested.left,
      visibleRequested.right,
    ],
  );
  useEffect(() => {
    if (active) {
      setRequested(readSelection());
      setSelectionMessage(null);
      setError(null);
    }
  }, [ctx.page, active]);
  useEffect(() => {
    if (!active) return;
    const url = savedScenarioComparisonUrl(location.href);
    const hadLegacySelection = url.href !== location.href;
    if (hadLegacySelection) history.replaceState({}, "", url);
    if (hadLegacySelection || comparisonId) onComparisonSelect?.(null);
  }, [active, ctx.page, comparisonId, onComparisonSelect]);
  useEffect(() => {
    const restore = () => {
      setRequested(readSelection());
      setSelectionMessage(null);
      setError(null);
    };
    addEventListener("popstate", restore);
    return () => removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!active || !library.isSuccess || library.isFetching || !pair.left)
      return;
    if (pair.warning) setSelectionMessage(pair.warning);
    const url = savedScenarioComparisonUrl(location.href, pair);
    if (url.href === location.href) return;
    history.replaceState({}, "", url);
    setRequested({ left: pair.left, right: pair.right || null });
  }, [
    pair.left,
    pair.right,
    pair.warning,
    library.isSuccess,
    library.isFetching,
    visibleRequested.left,
    visibleRequested.right,
    active,
  ]);
  const result = useQuery({
    queryKey: ["saved-scenario-comparison", pair.left, pair.right],
    queryFn: ({ signal }) =>
      api(
        `/scenario-comparisons?left_scenario_id=${encodeURIComponent(pair.left)}&right_scenario_id=${encodeURIComponent(pair.right)}&max_points=1000`,
        { signal },
      ),
    enabled: Boolean(
      active && pair.left && pair.right && pair.left !== pair.right,
    ),
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
    refetchInterval: (query) =>
      active &&
      (sideIsRunning(query.state.data?.left) ||
        sideIsRunning(query.state.data?.right) ||
        Object.keys(submitted).some((id) =>
          [pair.left, pair.right].includes(id),
        ))
        ? 2000
        : false,
  });
  const trackedRuns = useQuery({
    queryKey: [
      "saved-comparison-submitted-runs",
      ...Object.values(submitted).sort(),
    ],
    queryFn: ({ signal }) =>
      Promise.all(
        Object.values(submitted).map((id) =>
          api(`/run-groups/${encodeURIComponent(id)}`, { signal }),
        ),
      ),
    enabled: active && Object.keys(submitted).length > 0,
    refetchInterval: active ? 2000 : false,
    retry: false,
  });
  useEffect(() => {
    if (!active) return;
    const terminal = new Set(
      (trackedRuns.data || [])
        .filter((run) => !activeStatus(run.status))
        .map((run) => run.id),
    );
    if (!terminal.size) return;
    setSubmitted((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, id]) => !terminal.has(id)),
      ),
    );
    void result.refetch();
  }, [trackedRuns.data, active]);
  const libraryLeftRevision = library.data?.find(
    (item) => item.id === pair.left,
  )?.revision;
  const libraryRightRevision = library.data?.find(
    (item) => item.id === pair.right,
  )?.revision;
  const responseLeftRevision = result.data?.left?.scenario?.revision;
  const responseRightRevision = result.data?.right?.scenario?.revision;
  useEffect(() => {
    if (
      !active ||
      !library.isSuccess ||
      !result.data ||
      !pair.left ||
      !pair.right
    )
      return;
    if (
      typeof libraryLeftRevision === "number" &&
      typeof responseLeftRevision === "number" &&
      typeof libraryRightRevision === "number" &&
      typeof responseRightRevision === "number"
    ) {
      if (
        libraryLeftRevision > responseLeftRevision ||
        libraryRightRevision > responseRightRevision
      )
        void result.refetch();
      else if (
        libraryLeftRevision < responseLeftRevision ||
        libraryRightRevision < responseRightRevision
      )
        void library.refetch();
    }
  }, [
    active,
    pair.left,
    pair.right,
    libraryLeftRevision,
    libraryRightRevision,
    responseLeftRevision,
    responseRightRevision,
  ]);
  const comparison = comparisonMatchesPair(
    result.data,
    pair.left,
    pair.right,
    library.data,
  )
    ? result.data
    : null;
  useEffect(() => {
    if (!comparison) return;
    setSubmitted((current) => {
      const next = { ...current };
      let changed = false;
      for (const side of [comparison.left, comparison.right]) {
        if (
          next[side.scenario.id] &&
          side.latest_run?.id === next[side.scenario.id] &&
          !activeStatus(side.latest_run.status)
        ) {
          delete next[side.scenario.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [comparison]);
  const chart =
    comparisonCharts.find((entry) => entry.key === chartKey) ||
    comparisonCharts[0];
  const rows = useMemo(
    () => scenarioComparisonRows(comparison, chart),
    [comparison, chart],
  );
  const available = library.data || [];
  const labels = {
    left:
      comparison?.left.scenario.name ||
      available.find((item) => item.id === pair.left)?.name ||
      "Left scenario",
    right:
      comparison?.right.scenario.name ||
      available.find((item) => item.id === pair.right)?.name ||
      "Right scenario",
  };
  const ready = Boolean(
    comparison &&
    scenarioSideReady(comparison.left) &&
    scenarioSideReady(comparison.right),
  );
  const comparable = ready && comparison?.compatibility?.comparable === true;
  function choose(left: string, right: string) {
    const url = savedScenarioComparisonUrl(location.href, { left, right });
    if (url.href !== location.href) history.pushState({}, "", url);
    if (comparisonId) onComparisonSelect?.(null);
    setRequested({ left, right });
    setSelectionMessage(null);
    setError(null);
  }
  async function runSaved(side: Entity) {
    const payload = savedScenarioRunRequest(side);
    if (!payload || submitLocks.current.has(payload.scenario_id)) return;
    submitLocks.current.add(payload.scenario_id);
    setSubmitting((ids) => [...ids, payload.scenario_id]);
    setError(null);
    try {
      const run = await post("/run-groups", payload);
      setSubmitted((current) => ({
        ...current,
        [payload.scenario_id]: run.id,
      }));
      if (activeRef.current) await result.refetch();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The simulation could not be started.",
      );
      if (activeRef.current)
        await Promise.all([library.refetch(), result.refetch()]);
    } finally {
      submitLocks.current.delete(payload.scenario_id);
      setSubmitting((ids) => ids.filter((id) => id !== payload.scenario_id));
    }
  }
  async function configure(side: Entity) {
    const selected = await ctx.saveScenario({ __select: side.scenario.id });
    if (selected) ctx.setPage("overview");
  }
  function sidePanel(position: "left" | "right") {
    const side = comparison?.[position];
    const id = position === "left" ? pair.left : pair.right;
    const other = position === "left" ? pair.right : pair.left;
    const running = Boolean(
      submitting.includes(id) || submitted[id] || sideIsRunning(side),
    );
    const valid = scenarioSideReady(side);
    const options = available
      .filter((entry) => entry.id !== other)
      .map((entry) => ({
        value: entry.id,
        label: entry.name || "Saved scenario",
      }));
    return (
      <article
        className={`scenario-comparison-side ${position}`}
        data-testid={`comparison-${position}`}
      >
        <div className="scenario-comparison-side-title">
          <i aria-hidden="true" />
          <strong>
            {position === "left" ? "Left scenario" : "Right scenario"}
          </strong>
        </div>
        <NativeSelect
          label={
            position === "left" ? "Left saved scenario" : "Right saved scenario"
          }
          aria-label={
            position === "left" ? "Left saved scenario" : "Right saved scenario"
          }
          value={id}
          disabled={
            !available.length || (position === "right" && available.length < 2)
          }
          data={[
            {
              value: "",
              label:
                available.length < 2 && position === "right"
                  ? "Save another scenario to compare"
                  : "Choose a scenario",
              disabled: true,
            },
            ...options,
          ]}
          onChange={(event) =>
            position === "left"
              ? choose(event.currentTarget.value, pair.right)
              : choose(pair.left, event.currentTarget.value)
          }
        />
        <div className="scenario-comparison-state" aria-live="polite">
          <span>
            {comparison
              ? scenarioSideStatus(side)
              : pair.right
                ? "Loading saved results…"
                : position === "right"
                  ? "Two saved scenarios are needed for comparison."
                  : "Only saved configurations are compared."}
          </span>
          {side?.scenario ? (
            <small>
              {side.scenario.horizon_calendar_days}{" "}
              {side.scenario.horizon_calendar_days === 1 ? "day" : "days"} ·{" "}
              {localDate(side.scenario.start_at, {
                timeZone: side.scenario.timezone,
                month: "short",
                day: "numeric",
              })}{" "}
              · {side.scenario.replications} planned runs
            </small>
          ) : null}
          {valid && side?.latest_run && side.latest_run.id !== side.run.id ? (
            <small>
              {sideIsRunning(side)
                ? "A newer run is processing; these completed results match the saved revision."
                : ["FAILED", "CANCELLED"].includes(side.latest_run.status)
                  ? "The latest attempt did not finish; the completed results shown still match this revision."
                  : null}
            </small>
          ) : null}
          {running ? (
            <small>
              Simulation in progress
              {side?.latest_run?.total
                ? ` · ${side.latest_run.completed || 0} of ${side.latest_run.total} runs complete`
                : ""}
              .
            </small>
          ) : null}
          {side?.can_run === false && side.can_run_reason ? (
            <small>{side.can_run_reason}</small>
          ) : null}
        </div>
        <div className="scenario-comparison-actions">
          <Button
            primary={!valid}
            disabled={
              !side ||
              side.can_run !== true ||
              running ||
              ctx.canWrite === false
            }
            onClick={() => void runSaved(side)}
            aria-label={`Run ${position} scenario`}
          >
            <Play size={13} aria-hidden="true" />
            {running
              ? "Simulating…"
              : valid
                ? "Run again"
                : side?.state === "stale"
                  ? "Run updated simulation"
                  : "Run simulation"}
          </Button>
          {valid ? (
            <Button
              disabled={Boolean(ctx.busy)}
              onClick={() => void ctx.openRun(side.run.id, "summary")}
              aria-label={`Open ${position} scenario results`}
            >
              Open results <ArrowRight size={13} aria-hidden="true" />
            </Button>
          ) : side?.scenario && side.can_run === false ? (
            <Button onClick={() => void configure(side)}>
              Review configuration
            </Button>
          ) : null}
        </div>
      </article>
    );
  }
  return (
    <div
      className="compare-page saved-scenario-comparison"
      data-testid="saved-scenario-comparison"
    >
      <header className="page-heading">
        <div>
          <h1>Compare saved scenarios</h1>
          <p>
            Choose two scenarios from your library and compare their saved
            results.
          </p>
        </div>
        <div className="heading-actions">
          <Button
            disabled={!pair.left || !pair.right}
            onClick={() => choose(pair.right, pair.left)}
          >
            <ArrowLeftRight size={14} aria-hidden="true" />
            Swap scenarios
          </Button>
          <Button
            disabled={library.isFetching || result.isFetching}
            onClick={() =>
              void refreshScenarioComparison(
                pair,
                () => library.refetch(),
                () => result.refetch(),
              )
            }
          >
            <RefreshCw size={14} aria-hidden="true" />
            Refresh results
          </Button>
        </div>
      </header>
      {library.isError ? (
        <div className="scenario-comparison-message" role="status">
          The scenario library could not be loaded.{" "}
          <Button onClick={() => void library.refetch()}>Try again</Button>
        </div>
      ) : null}
      <section
        className="scenario-comparison-selectors"
        aria-label="Choose scenarios to compare"
      >
        {sidePanel("left")}
        {sidePanel("right")}
      </section>
      <p className="scenario-comparison-saved-note">
        Only saved configurations are compared. Unsaved edits are not included.
      </p>
      {selectionMessage || error || result.isError ? (
        <div className="scenario-comparison-message" role="status">
          <Info size={15} aria-hidden="true" />
          <span>
            {error ||
              selectionMessage ||
              "Saved comparison results could not be loaded. Try refreshing results."}
          </span>
        </div>
      ) : null}
      {ready && !comparable ? (
        <section
          className="scenario-comparison-caution"
          aria-label="Comparison limitations"
        >
          <Info size={16} aria-hidden="true" />
          <div>
            <strong>These results use different planning assumptions.</strong>
            {(comparison?.compatibility?.reasons || []).map(
              (reason: Entity) => (
                <p key={reason.code}>{reason.message}</p>
              ),
            )}
            <p>
              Each result remains visible. Differences and overlay charts are
              unavailable until the planning periods and models match.
            </p>
          </div>
        </section>
      ) : null}
      <section
        className="scenario-comparison-outcomes"
        aria-labelledby="scenario-outcomes-title"
      >
        <header>
          <h2 id="scenario-outcomes-title">Key outcomes</h2>
          <span>Middle result across each scenario’s simulations</span>
        </header>
        <table>
          <thead>
            <tr>
              <th scope="col">Outcome</th>
              <th scope="col">
                <i className="comparison-left-key" />
                {labels.left}
              </th>
              <th scope="col">
                <i className="comparison-right-key" />
                {labels.right}
              </th>
              <th scope="col">Right minus left</th>
            </tr>
          </thead>
          <tbody>
            {comparisonMetrics.map((metric) => (
              <tr key={metric.key}>
                <th scope="row">{metric.label}</th>
                <td data-testid={`left-${metric.key}`}>
                  {formatComparisonValue(
                    comparisonMetricValue(comparison?.left, metric.key),
                    metric.unit,
                  )}
                </td>
                <td data-testid={`right-${metric.key}`}>
                  {formatComparisonValue(
                    comparisonMetricValue(comparison?.right, metric.key),
                    metric.unit,
                  )}
                </td>
                <td>
                  {formatComparisonDifference(
                    descriptiveDifference(comparison, metric.key),
                    metric.unit,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          These are separate simulations. Differences describe the saved results
          and do not establish that one change caused an outcome.
        </p>
      </section>
      <section
        className="scenario-comparison-chart"
        aria-labelledby="scenario-chart-title"
      >
        <nav
          className="scenario-chart-bookmarks"
          aria-label="Comparison charts"
        >
          {comparisonCharts.map((bookmark) => (
            <button
              key={bookmark.key}
              type="button"
              aria-pressed={chart.key === bookmark.key}
              onClick={() => setChartKey(bookmark.key)}
            >
              {bookmark.label}
            </button>
          ))}
        </nav>
        <div className="scenario-comparison-chart-heading">
          <h2 id="scenario-chart-title">{chart.title}</h2>
          <span>Median across simulation runs</span>
        </div>
        {rows.some((row) => row.left !== null || row.right !== null) ? (
          <ForecastChart
            rows={rows}
            keys={["left", "right"]}
            labels={[`Left · ${labels.left}`, `Right · ${labels.right}`]}
            colors={["#2b7fbd", "#1a927c"]}
            lineDashes={[undefined, "6 3"]}
            height={270}
            showBand={false}
            yLabel={chart.unit}
            timeZone={comparison?.left.scenario.timezone}
            dateLabelMode={chart.source === "daily" ? "date" : "auto"}
            {...(chart.unit === "Supply stock (%)" ? { yMax: 100 } : {})}
          />
        ) : (
          <div className="scenario-comparison-chart-empty">
            {!ready
              ? "Run both saved scenarios to view their results here."
              : !comparable
                ? "Choose matching planning periods and models to overlay the results."
                : "This measure was not recorded for these saved simulations."}
          </div>
        )}
      </section>
      <details className="scenario-comparison-details">
        <summary>
          Configuration differences <ChevronDown size={15} aria-hidden="true" />
        </summary>
        {comparison?.configuration_differences?.length ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">{labels.left}</th>
                <th scope="col">{labels.right}</th>
              </tr>
            </thead>
            <tbody>
              {comparison.configuration_differences.map(
                (difference: Entity) => (
                  <tr key={difference.field}>
                    <th scope="row">{difference.label}</th>
                    <td>
                      {formatComparisonSetting(difference.left)}
                      {typeof difference.left === "number" && difference.unit
                        ? ` ${difference.unit === "percent" ? "%" : difference.unit}`
                        : ""}
                    </td>
                    <td>
                      {formatComparisonSetting(difference.right)}
                      {typeof difference.right === "number" && difference.unit
                        ? ` ${difference.unit === "percent" ? "%" : difference.unit}`
                        : ""}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : (
          <p>
            {comparison
              ? "No configuration differences were recorded."
              : "Choose two saved scenarios to review their settings."}
          </p>
        )}
      </details>
      <details className="scenario-comparison-details">
        <summary>
          How to read this comparison{" "}
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div>
          <p>
            Each side uses a completed simulation that matches that scenario’s
            current saved revision, baseline, horizon, and model. Missing and
            outdated results are unavailable; they never become zero. Running a
            scenario uses its saved settings without changing them.
          </p>
          <p>
            The values and chart lines are medians across the runs in each
            scenario. These are independent ensembles, not matched pairs. No
            winning plan, paired probability, or causal recommendation is
            inferred. “Right minus left” is a descriptive difference;
            percentages use percentage points.
          </p>
          <p>
            Average waiting includes the observed waiting of patients still
            queued at the end. Success is the percentage of eligible arrivals
            who started their first treatment within 24 hours; it is an access
            target, not a clinical recovery score. Supply stock is time-weighted
            and remains unavailable when not modeled.
          </p>
        </div>
      </details>
    </div>
  );
}
