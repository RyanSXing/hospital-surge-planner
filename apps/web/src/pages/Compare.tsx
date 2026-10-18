import { useEffect, useState } from "react";
import { NativeSelect } from "@mantine/core";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  GitCompareArrows,
  Info,
  Layers,
  Play,
  Plus,
  Save,
  Users,
} from "lucide-react";
import type { Entity, Metrics, PlanningContext } from "../types";
import { api, atDay, fmt, items, localDayIndex, num, post } from "../api";
import { Badge, Button, Modal } from "../components/ui";
import { ForecastChart, Timeline } from "../components/Charts";
import { comparisonWardInventory } from "./comparisonCapacity";
import {
  comparisonResultPlan,
  finiteStatistic,
  hospitalResponse,
  responseName,
} from "./resultsMetrics";
import ComparisonDetails from "../components/ComparisonDetails";
import {
  PlanningPanelControls,
  PlanningTimelineDock,
  usePlanningPanels,
} from "../components/PlanningPanels";
import "./compare.css";
const choices = [
  {
    kind: "staff_existing",
    name: "Staff more ward beds",
    description: "Bring in reserve nurses to use beds already in the hospital.",
    icon: Users,
  },
  {
    kind: "physical_overflow",
    name: "Open extra hospital beds",
    description: "Open planned ward beds with the current staffing level.",
    icon: Layers,
  },
  {
    kind: "staffed_overflow",
    name: "Open and staff extra beds",
    description:
      "Open planned ward beds with reserve staff and available equipment.",
    icon: Layers,
  },
];
const palette = ["#65758b", "#a87614", "#1976c9", "#168976", "#8060b6"];
export default function Compare({
  ctx,
  comparisonId,
  onComparisonSelect,
}: {
  ctx: PlanningContext;
  comparisonId?: string | null;
  onComparisonSelect?: (id: string | null) => void;
}) {
  const panels = usePlanningPanels(180);
  const [selected, setSelected] = useState([
      "staff_existing",
      "staffed_overflow",
    ]),
    [comparison, setComparison] = useState<Entity | null>(null),
    [replications, setReplications] = useState(100),
    [assumptions, setAssumptions] = useState(false),
    [chosen, setChosen] = useState(""),
    [history, setHistory] = useState<Entity[]>([]),
    [historyOpen, setHistoryOpen] = useState(false),
    [fetchError, setFetchError] = useState(""),
    [exportResult, setExportResult] = useState<Entity | null>(null),
    [exportOpen, setExportOpen] = useState(false),
    [chartMetric, setChartMetric] = useState("inpatient_queue"),
    [bandPlan, setBandPlan] = useState("none"),
    [preflight, setPreflight] = useState<Entity | null>(null),
    [prerequisites, setPrerequisites] = useState<Record<string, Entity>>({}),
    [preflightError, setPreflightError] = useState(""),
    [checking, setChecking] = useState(false),
    [periodMetrics, setPeriodMetrics] = useState<Record<string, Metrics>>({}),
    [periodLoading, setPeriodLoading] = useState(false);
  const availableChoices = choices.filter((choice) =>
    hospitalResponse(ctx.dataset, choice.kind, ctx.scenario?.start_at),
  );
  const selectedChoices = selected.filter((kind) =>
    availableChoices.some((choice) => choice.kind === kind),
  );
  const makeResponse = (kind: string) =>
    hospitalResponse(ctx.dataset, kind, ctx.scenario?.start_at);
  useEffect(() => {
    let ignore = false;
    setPreflight(null);
    setChecking(true);
    setPreflightError("");
    const timer = setTimeout(() => {
      if (!ctx.scenario?.id) {
        setChecking(false);
        return;
      }
      const common = { replications };
      Promise.all([
        post(`/scenarios/${ctx.scenario.id}/feasibility`, common),
        ...selectedChoices.map((kind) =>
          post(`/scenarios/${ctx.scenario!.id}/feasibility`, {
            ...common,
            interventions: [
              ...(ctx.scenario?.interventions || []),
              makeResponse(kind),
            ],
          }),
        ),
      ])
        .then(([base, ...reports]) => {
          if (ignore) return;
          const estimate = base.compute_estimate;
          if (estimate) {
            const total =
              estimate.expected_trajectories_per_run *
              (selectedChoices.length + 1);
            setPreflight({
              ...estimate,
              valid: base.valid,
              plans: selectedChoices.length + 1,
              expected_trajectories_total: total,
              within_budget:
                estimate.within_budget &&
                total <= estimate.limits.max_comparison_trajectories,
            });
          } else
            setPreflightError(
              base.errors?.map((e: Entity) => e.message).join(" · ") ||
                "Execution estimate unavailable",
            );
          setPrerequisites(
            Object.fromEntries(
              selectedChoices.map((kind, index) => [
                kind,
                reports[index].feasibility,
              ]),
            ),
          );
        })
        .catch((e) => {
          if (!ignore) setPreflightError(e.message);
        })
        .finally(() => {
          if (!ignore) setChecking(false);
        });
    }, 400);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [
    ctx.scenario?.id,
    ctx.scenario?.revision,
    replications,
    selectedChoices.join(","),
    ctx.dataset?.id,
  ]);
  function accept(c: Entity) {
    setChosen("");
    if (c.scenario_id && c.scenario_id !== ctx.scenario?.id) {
      setComparison(null);
      return;
    }
    setComparison(c);
    const plan = c.plans?.[0];
    const savedCount = [
      plan?.metrics?.replications_completed,
      plan?.total,
    ].find(
      (count) =>
        typeof count === "number" && Number.isFinite(count) && count > 0,
    );
    if (savedCount !== undefined) setReplications(savedCount);
    const kinds = c.plans
      ?.slice(1)
      .map((p: Entity) => p.interventions?.at(-1)?.kind)
      .filter((kind: string) => choices.some((choice) => choice.kind === kind));
    if (kinds?.length) setSelected(kinds);
  }
  useEffect(() => {
    let ignore = false;
    const stored =
      comparisonId !== undefined
        ? comparisonId
        : new URLSearchParams(location.search).get("comparison") ||
          sessionStorage.getItem(`hospital.comparison.${ctx.scenario?.id}`);
    if (stored === comparison?.id) return;
    setComparison(null);
    setChosen("");
    setFetchError("");
    if (stored)
      api(`/comparisons/${stored}`)
        .then((c) => {
          if (!ignore) accept(c);
        })
        .catch((e) => {
          if (!ignore) setFetchError(e.message);
        });
    return () => {
      ignore = true;
    };
  }, [ctx.scenario?.id, comparisonId]);
  useEffect(() => {
    if (
      !comparison?.id ||
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(comparison.status)
    )
      return;
    const timer = setInterval(
      () =>
        api(`/comparisons/${comparison.id}`)
          .then(setComparison)
          .catch((e) => setFetchError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [comparison?.id, comparison?.status]);
  function persist(c: Entity) {
    accept(c);
    onComparisonSelect?.(c.id);
    sessionStorage.setItem(`hospital.comparison.${ctx.scenario?.id}`, c.id);
    const u = new URL(location.href);
    u.searchParams.set("comparison", c.id);
    historyReplace(u);
  }
  async function compare() {
    setChosen("");
    await ctx.action("Submitting matched comparisons", async () => {
      setFetchError("");
      const result = await post("/comparisons", {
        scenario_id: ctx.scenario?.id,
        replications,
        plans: selectedChoices.map((kind) => ({
          name: choices.find((o) => o.kind === kind)?.name,
          interventions: [
            ...(ctx.scenario?.interventions || []),
            { ...makeResponse(kind), id: crypto.randomUUID() },
          ],
        })),
      });
      persist(result);
    });
  }
  useEffect(() => {
    if (
      !exportResult?.id ||
      ["SUCCEEDED", "FAILED"].includes(exportResult.status)
    )
      return;
    const timer = setInterval(
      () =>
        api(`/exports/${exportResult.id}`)
          .then(setExportResult)
          .catch((e) => setFetchError(e.message)),
      1500,
    );
    return () => clearInterval(timer);
  }, [exportResult?.id, exportResult?.status]);
  useEffect(() => {
    let ignore = false;
    setPeriodMetrics({});
    if (
      !comparison?.id ||
      comparison.status !== "SUCCEEDED" ||
      ctx.grain === "day"
    ) {
      setPeriodLoading(false);
      return;
    }
    setPeriodLoading(true);
    Promise.all(
      (comparison.plans || [])
        .filter((p: Entity) => p.run_group_id && p.status === "SUCCEEDED")
        .map(
          async (p: Entity) =>
            [
              p.id,
              await api<Metrics>(
                `/run-groups/${p.run_group_id}/metrics?grain=${ctx.grain}`,
              ),
            ] as const,
        ),
    )
      .then((values) => {
        if (!ignore) setPeriodMetrics(Object.fromEntries(values));
      })
      .catch((e) => {
        if (!ignore) setFetchError(e.message);
      })
      .finally(() => {
        if (!ignore) setPeriodLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [comparison?.id, comparison?.status, ctx.grain]);
  const rawPlans: Entity[] = comparison?.plans || [
    { id: "reference", name: "Current plan", kind: "reference" },
    ...selectedChoices.map((kind) => ({
      id: kind,
      name: choices.find((o) => o.kind === kind)?.name,
      kind,
    })),
  ];
  const plans: Entity[] = rawPlans.map((plan, index): Entity => ({
    ...plan,
    name:
      plan.reference === true || index === 0
        ? "Current setup"
        : plan.name || responseName(plan),
  }));
  const maxWait = Math.max(
      1,
      ...plans.map(
        (p) =>
          finiteStatistic(
            (p.metrics?.scalar_metrics || p.metrics || {})
              .inpatient_waiting_patient_hours,
          ) ?? 0,
      ),
    ),
    first =
      ctx.grain === "day"
        ? plans.find((p) => p.metrics?.series?.length)?.metrics?.series || []
        : Object.values(periodMetrics).find((p) => p.data?.length)?.data || [];
  const plottedPlans = plans
    .map<Entity>((p, index) => ({
      ...p,
      chartRows:
        ctx.grain === "day" ? p.metrics?.series : periodMetrics[p.id]?.data,
      chartKey: `plan_${index}`,
      chartColor: palette[index],
      chartDash: [undefined, "7 4", "2 3", "9 3 2 3"][index],
    }))
    .filter((p) => p.chartRows?.length);
  const chartRows = first.map((row: Entity, index: number) =>
    Object.fromEntries([
      ["at", row.at || row.start_at],
      ...plottedPlans.map((p) => [
        p.chartKey,
        p.chartRows[index]?.[
          ctx.grain !== "day" && chartMetric === "waiting_patient_hours"
            ? "inpatient_waiting_patient_hours"
            : chartMetric
        ] ?? null,
      ]),
    ]),
  );
  const calendarScenario = comparison?.source_scenario_snapshot || ctx.scenario;
  const calendarPlan = plans.find((p) => p.id === chosen) || plans[0],
    calendarCtx: PlanningContext = {
      ...ctx,
      scenario: calendarScenario,
      resultScenario: calendarScenario,
      selectedDay: calendarScenario
        ? Math.max(
            0,
            localDayIndex(
              calendarScenario.start_at,
              ctx.selectedTime,
              calendarScenario.timezone,
            ),
          )
        : ctx.selectedDay,
      setDay: (day) =>
        calendarScenario
          ? ctx.setTime(
              atDay(
                calendarScenario.start_at,
                day,
                0,
                calendarScenario.timezone,
              ),
            )
          : ctx.setDay(day),
      activeReplicationId: "",
      metrics: periodMetrics[calendarPlan?.id] || calendarPlan?.metrics || null,
      run: calendarPlan?.metrics
        ? {
            ...(ctx.run || {
              id: calendarPlan.run_group_id,
              status: "SUCCEEDED",
              replications_requested: replications,
            }),
            id: calendarPlan.run_group_id,
            selected_replication_id:
              calendarPlan.metrics.selected_replication_id,
            replications_completed: calendarPlan.metrics.replications_completed,
          }
        : null,
    };
  const running =
    !!comparison &&
    !["SUCCEEDED", "FAILED", "CANCELLED"].includes(comparison.status);
  const rankedPlan =
    comparison?.status === "SUCCEEDED"
      ? [...plans].sort(
          (a, b) =>
            (a.rank ?? Number.MAX_SAFE_INTEGER) -
            (b.rank ?? Number.MAX_SAFE_INTEGER),
        )[0]
      : null;
  // The API's rank may use a secondary tie-breaker. If no response improved
  // the paired objective, the result banner must still name the reference.
  const leadingPlan = comparisonResultPlan(
    plans,
    comparison?.no_plan_improves,
    rankedPlan,
  );
  const leadingWait =
    leadingPlan?.metrics?.scalar_metrics?.inpatient_waiting_patient_hours;
  const selectedPlan =
    comparison?.status === "SUCCEEDED"
      ? plans.find(
          (plan) =>
            plan.id === chosen &&
            plan.status === "SUCCEEDED" &&
            plan.reference !== true &&
            plan.feasibility?.feasible !== false,
        )
      : undefined;
  async function exportComparison() {
    await ctx.action("Exporting comparison", async () => {
      const exp = await post("/exports", {
        comparison_id: comparison?.id,
        run_group_id: plans[0].run_group_id,
        format: "zip",
        include_events: false,
      });
      setExportResult(exp);
      setExportOpen(true);
    });
  }
  return (
    <div className="compare-page page-scroll planning-panel-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ANALYSIS / COMPARISON</div>
          <h1>Compare response plans</h1>
          <p>
            Choose practical options and see which one improves patient flow.
          </p>
        </div>
        <div className="heading-actions">
          <NativeSelect
            label="Simulation runs"
            aria-label="Comparison simulation runs"
            value={String(replications)}
            onChange={(e) => setReplications(+e.currentTarget.value)}
            data={[
              ...(![10, 100, 500].includes(replications)
                ? [
                    {
                      value: String(replications),
                      label: `${replications} runs · Saved count`,
                    },
                  ]
                : []),
              { value: "10", label: "10 runs · Preview" },
              { value: "100", label: "100 runs · Standard" },
              { value: "500", label: "500 runs" },
            ]}
          />
          <Button
            primary
            disabled={
              ctx.canWrite === false ||
              !!ctx.busy ||
              running ||
              !selectedChoices.length ||
              checking ||
              preflight?.within_budget === false
            }
            onClick={compare}
          >
            <Play size={14} />
            {running ? "Evaluating plans…" : "Evaluate responses"}
          </Button>
          <details className="comparison-tools">
            <summary>More tools</summary>
            <div className="comparison-tools-menu">
              <Button
                onClick={() =>
                  ctx.action("Loading saved comparisons", async () => {
                    setHistory(
                      items(
                        await api(
                          `/comparisons?scenario_id=${ctx.scenario?.id}`,
                        ),
                      ),
                    );
                    setHistoryOpen(true);
                  })
                }
              >
                <Layers size={14} />
                History
              </Button>
              <Button onClick={() => setAssumptions(true)}>
                <Info size={15} />
                Assumptions
              </Button>
              <PlanningPanelControls panels={panels} name="compare" />
            </div>
          </details>
        </div>
      </div>
      <div className="comparison-context">
        <GitCompareArrows size={16} />
        <strong>{calendarScenario?.name}</strong>
        <span>{calendarScenario?.horizon_calendar_days} days</span>
        <span>One hospital · same patient demand</span>
        <Badge
          tone={comparison?.status === "SUCCEEDED" ? "success" : "neutral"}
        >
          {comparison?.status === "SUCCEEDED"
            ? `${comparison.plans[0]?.metrics?.replications_completed || replications} runs per plan`
            : running
              ? "Computation in progress"
              : "Select responses to evaluate"}
        </Badge>
      </div>
      <div className="response-selector">
        {availableChoices.map((o) => (
          <button
            key={o.kind}
            className={selectedChoices.includes(o.kind) ? "selected" : ""}
            aria-pressed={selectedChoices.includes(o.kind)}
            disabled={
              running ||
              (!selectedChoices.includes(o.kind) && selectedChoices.length >= 3)
            }
            onClick={() => {
              setSelected((v) =>
                v.includes(o.kind)
                  ? v.filter((k) => k !== o.kind)
                  : [...v, o.kind],
              );
              setChosen("");
              setComparison(null);
              onComparisonSelect?.(null);
              sessionStorage.removeItem(
                `hospital.comparison.${ctx.scenario?.id}`,
              );
              const u = new URL(location.href);
              u.searchParams.delete("comparison");
              historyReplace(u);
            }}
          >
            <o.icon size={16} />
            <span className="response-choice-copy">
              <strong>{o.name}</strong>
              <small>{o.description}</small>
            </span>
            {selected.includes(o.kind) ? (
              <Check size={14} />
            ) : (
              <Plus size={14} />
            )}
          </button>
        ))}
      </div>
      {!availableChoices.length ? (
        <p className="comparison-unavailable" role="status">
          The hospital baseline has no additional ward beds or reserve staffing
          to compare. Update the hospital setup to add a response.
        </p>
      ) : null}
      <details className="comparison-preflight">
        <summary>
          {checking
            ? "Checking hospital readiness…"
            : preflight
              ? preflight.within_budget === false
                ? "Reduce the simulation size to continue"
                : "More details · readiness and calculation settings"
              : preflightError || "Readiness check unavailable"}
        </summary>
        <p className="muted small-copy">
          Estimate includes the initial census in every run. Budget:{" "}
          {fmt(preflight?.limits?.max_run_trajectories)} per run group and{" "}
          {fmt(preflight?.limits?.max_comparison_trajectories)} across the
          comparison. No repetitions are omitted.
        </p>
        {preflight?.within_budget === false ? (
          <p className="amber small-copy">
            Reduce the horizon, number of plans, or repetitions to fit the
            execution budget.
          </p>
        ) : null}
        {selectedChoices.map((kind) => (
          <div className="preflight-row" key={kind}>
            <strong>{choices.find((o) => o.kind === kind)?.name}</strong>
            <span
              className={
                prerequisites[kind]?.feasible === false ? "amber" : "muted"
              }
            >
              {prerequisites[kind]?.feasible === false
                ? prerequisites[kind].reasons?.join(" · ")
                : prerequisites[kind]
                  ? "This change can be scheduled"
                  : "Checking availability"}
            </span>
          </div>
        ))}
      </details>
      {comparison?.source_draft_revision &&
      ctx.scenario?.revision !== comparison.source_draft_revision ? (
        <div className="stale-banner">
          The setup has changed since this comparison. Evaluate again to include
          your latest changes.
        </div>
      ) : null}
      {fetchError || comparison?.status === "FAILED" ? (
        <div className="global-error">
          <p className="red">
            {fetchError ||
              comparison?.error?.message ||
              comparison?.error ||
              "Comparison failed. Review the plan diagnostics before retrying."}
          </p>
        </div>
      ) : null}
      {leadingPlan ? (
        <section
          className={`comparison-result-summary${comparison?.no_plan_improves ? " neutral" : ""}`}
          aria-label="Comparison result"
        >
          <div className="comparison-result-icon">
            {comparison?.no_plan_improves ? (
              <Info size={20} aria-hidden="true" />
            ) : (
              <Check size={20} aria-hidden="true" />
            )}
          </div>
          <div>
            <span>Best result in this comparison</span>
            <h2>{leadingPlan.name}</h2>
            <p>
              {comparison?.no_plan_improves
                ? "These changes did not reduce waiting. Keep the current plan or adjust the simulation setup."
                : `${fmt(num(leadingWait), 1)} patient-hours of total bed waiting, using the middle result across all runs.`}
            </p>
          </div>
        </section>
      ) : null}
      <div className="comparison-body">
        <div className="comparison-main">
          <details className="comparison-capacity-details">
            <summary>
              <span>
                <strong>Capacity and staffing assumptions</strong>
                <small>
                  Physical places, staffed places, and activation constraints
                </small>
              </span>
              <span>Show details</span>
            </summary>
            <div
              className="plan-cards capacity-plan-cards"
              style={{
                gridTemplateColumns: `repeat(${plans.length},minmax(0,1fr))`,
              }}
            >
              {plans.map((p, i) => {
                const kind =
                    p.kind || p.interventions?.at(-1)?.kind || selected[i - 1],
                  last = p.metrics?.series?.at(-1),
                  fullHorizonWait =
                    p.metrics?.scalar_metrics?.inpatient_waiting_patient_hours,
                  inventory = comparisonWardInventory(
                    ctx.dataset,
                    comparison?.source_scenario_snapshot?.dataset_version_id,
                    last,
                  ),
                  physical = inventory?.physical ?? 0,
                  staffed = inventory?.staffed ?? 0,
                  tileSize = Math.max(1, Math.ceil(physical / 120));
                return (
                  <div
                    key={p.id}
                    className={`plan-card ${p.rank === 1 ? "best-plan" : ""}`}
                  >
                    <div className="plan-card-header">
                      <span className="eyebrow">
                        {i === 0
                          ? "REFERENCE PLAN"
                          : `RESPONSE ${String(i).padStart(2, "0")}`}
                      </span>
                      {p.rank === 1 && p.feasibility?.feasible !== false ? (
                        <Badge tone="success">Lowest waiting</Badge>
                      ) : null}
                      <h2>{p.name}</h2>
                    </div>
                    <div className="plan-grid">
                      <span className="micro-label">
                        WARD BEDS · {inventory?.basis || "Waiting for baseline"}
                      </span>
                      <div
                        className="capacity-diagram"
                        role="img"
                        aria-label={
                          inventory
                            ? `${physical} physical ward places; ${staffed} staffing-supported; capacity diagram without patient assignments`
                            : "Capacity pending for the saved baseline"
                        }
                      >
                        {Array.from(
                          { length: Math.ceil(physical / tileSize) },
                          (_, j) => {
                            const begin = j * tileSize,
                              count = Math.min(tileSize, physical - begin),
                              supported = Math.max(
                                0,
                                Math.min(count, staffed - begin),
                              );
                            return (
                              <span
                                key={j}
                                className={
                                  supported === count
                                    ? "supported"
                                    : "unsupported"
                                }
                                style={
                                  supported > 0 && supported < count
                                    ? {
                                        background: `linear-gradient(to right,#65b8df ${(supported / count) * 100}%,transparent ${(supported / count) * 100}%)`,
                                        opacity: 1,
                                      }
                                    : undefined
                                }
                                title={`${tileSize === 1 ? "Place" : "Places"} ${begin + 1}${count > 1 ? `–${begin + count}` : ""}: ${supported} staffing-supported, ${count - supported} unsupported`}
                              />
                            );
                          },
                        )}
                      </div>
                      {tileSize > 1 ? (
                        <span className="capacity-scale">
                          Each tile represents up to {tileSize} physical places
                        </span>
                      ) : null}
                      <div className="plan-capacity">
                        <strong>
                          {inventory ? staffed : "—"}
                          <small> / {inventory ? physical : "—"}</small>
                        </strong>
                        <span>
                          staffing-supported
                          <br />
                          physical places
                        </span>
                      </div>
                      {fullHorizonWait !== undefined ? (
                        <div className="plan-inline-outcome">
                          <span>Full-horizon waiting</span>
                          <strong>
                            {fmt(num(fullHorizonWait))}
                            <small>patient-hours</small>
                          </strong>
                        </div>
                      ) : null}
                    </div>
                    <div
                      className={`plan-status ${kind === "physical_overflow" ? "amber" : ""}`}
                    >
                      <span className="status-dot" />
                      {kind === "physical_overflow"
                        ? "Additional spaces need staffing"
                        : kind === "staff_existing"
                          ? "Qualified reserve nursing allocation"
                          : i === 0
                            ? "Current resource allocation"
                            : "Capability and resource checks apply"}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
          <section className="comparison-chart">
            <div className="spread">
              <h3>
                {chartMetric === "inpatient_queue"
                  ? "Patients waiting for a hospital bed"
                  : chartMetric === "ward_occupied"
                    ? "Ward occupancy"
                    : chartMetric === "icu_occupied"
                      ? "ICU occupancy"
                      : ctx.grain === "day"
                        ? "Cumulative inpatient waiting burden"
                        : "Inpatient waiting burden by interval"}
              </h3>
              <span className="muted small-copy">
                {ctx.grain === "day"
                  ? "Hourly points"
                  : ctx.grain === "week"
                    ? "Weekly intervals"
                    : "Monthly intervals"}{" "}
                · Median across matched runs
              </span>
            </div>
            <div className="comparison-chart-controls">
              <NativeSelect
                label="Plot"
                aria-label="Comparison chart metric"
                value={chartMetric}
                onChange={(e) => setChartMetric(e.currentTarget.value)}
                data={[
                  {
                    value: "inpatient_queue",
                    label: "Patients waiting for a bed",
                  },
                  {
                    value: "ward_occupied",
                    label: "Ward occupancy · patients",
                  },
                  { value: "icu_occupied", label: "ICU occupancy · patients" },
                  {
                    value: "waiting_patient_hours",
                    label: `${ctx.grain === "day" ? "Cumulative waiting" : "Waiting per interval"} · patient-hours`,
                  },
                ]}
              />
              <NativeSelect
                label="Uncertainty"
                aria-label="Comparison uncertainty band"
                value={bandPlan}
                onChange={(e) => setBandPlan(e.currentTarget.value)}
                data={[
                  { value: "none", label: "Hide possible range" },
                  ...plottedPlans.map((plan) => ({
                    value: plan.chartKey,
                    label: `${plan.name} · possible range`,
                  })),
                ]}
              />
            </div>
            {chartRows.length ? (
              <ForecastChart
                rows={chartRows}
                timeZone={calendarScenario?.timezone || ctx.dataset?.timezone}
                keys={plottedPlans.map((p) => p.chartKey)}
                labels={plottedPlans.map((p) => p.name)}
                yLabel={
                  chartMetric === "waiting_patient_hours"
                    ? ctx.grain === "day"
                      ? "Cumulative patient-hours"
                      : "Patient-hours per interval"
                    : "Patients"
                }
                colors={plottedPlans.map((p) => p.chartColor)}
                lineDashes={plottedPlans.map((p) => p.chartDash)}
                bandKey={bandPlan}
                height={240}
                showBand={bandPlan !== "none"}
                selected={chartRows.reduce(
                  (best: number, row: Entity, index: number) =>
                    Math.abs(
                      Date.parse(row.at) - Date.parse(ctx.selectedTime),
                    ) <
                    Math.abs(
                      Date.parse(chartRows[best]?.at) -
                        Date.parse(ctx.selectedTime),
                    )
                      ? index
                      : best,
                  0,
                )}
                onSelect={(index) => ctx.setTime(chartRows[index].at)}
              />
            ) : (
              <div className="chart-empty" role="status">
                Evaluate responses to compare forecasts.
              </div>
            )}
            {periodLoading ? (
              <div className="comparison-progress">
                Loading aggregates from the same matched runs…
              </div>
            ) : null}
            {running ? (
              <div className="comparison-progress">
                <span className="spin">◌</span> Comparing how patients move
                through the hospital…
              </div>
            ) : null}
          </section>
          {comparison?.status === "SUCCEEDED" ? (
            <div
              className="comparison-outcomes"
              style={{
                gridTemplateColumns: `repeat(${plans.length},minmax(0,1fr))`,
              }}
            >
              {plans.map((p, i) => {
                const metrics = p.metrics?.scalar_metrics || {},
                  wait = metrics.inpatient_waiting_patient_hours,
                  waitMedian = finiteStatistic(wait),
                  has = waitMedian !== null,
                  peak = finiteStatistic(metrics.peak_inpatient_queue),
                  improvement = p.improvement;
                return (
                  <div
                    key={p.id}
                    className={`outcome-card ${chosen === p.id ? "chosen" : ""}`}
                  >
                    <span className="eyebrow">{p.name} · FULL HORIZON</span>
                    <div className="outcome-number">
                      {has ? fmt(waitMedian) : "—"}
                      <small>patient-hours waiting</small>
                    </div>
                    <div className="outcome-bar">
                      <span
                        style={{
                          width: `${has ? (waitMedian / maxWait) * 100 : 0}%`,
                          background: palette[i],
                        }}
                      />
                    </div>
                    <dl>
                      <div>
                        <dt>Most patients waiting</dt>
                        <dd>{peak !== null ? fmt(peak) : "—"} patients</dd>
                      </div>
                      <div>
                        <dt>Less waiting</dt>
                        <dd
                          className={num(improvement?.p50) > 0 ? "green" : ""}
                        >
                          {i === 0
                            ? "Reference"
                            : improvement
                              ? `${fmt(num(improvement.absolute_change || improvement), 1)} h`
                              : "—"}
                        </dd>
                      </div>
                      {improvement && i > 0 ? (
                        <>
                          <div>
                            <dt>Typical range</dt>
                            <dd>
                              {fmt(
                                num(
                                  improvement.absolute_change || improvement,
                                  "p10",
                                ),
                              )}{" "}
                              –{" "}
                              {fmt(
                                num(
                                  improvement.absolute_change || improvement,
                                  "p90",
                                ),
                              )}{" "}
                              h
                            </dd>
                          </div>
                          <div>
                            <dt>Runs with less waiting</dt>
                            <dd>
                              {fmt(
                                100 *
                                  (improvement.probability_of_improvement ??
                                    improvement.probability_improvement ??
                                    0),
                              )}
                              %
                            </dd>
                          </div>
                        </>
                      ) : null}
                    </dl>
                    {p.feasibility?.feasible === false ? (
                      <p className="amber small-copy">
                        {p.feasibility.reasons?.join(" · ") ||
                          "Resource prerequisites unmet"}
                      </p>
                    ) : null}
                    {comparison?.status === "SUCCEEDED" && i > 0 ? (
                      <Button
                        className="full-width"
                        disabled={
                          ctx.canWrite === false ||
                          p.feasibility?.feasible === false
                        }
                        primary={chosen === p.id}
                        onClick={() => setChosen(p.id)}
                      >
                        {chosen === p.id ? <Check size={13} /> : null}
                        {chosen === p.id
                          ? "Selected response"
                          : "Select response"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {selectedPlan && comparison?.id ? (
            <section className="comparison-selected-action">
              <div>
                <span className="eyebrow">SELECTED RESPONSE</span>
                <strong>{selectedPlan.name}</strong>
                <span>
                  Save this evaluated response as a new scenario when you are
                  ready to continue planning.
                </span>
              </div>
              <Button
                primary
                disabled={ctx.canWrite === false || !!ctx.busy}
                onClick={() =>
                  ctx.action("Saving planning response", async () => {
                    const saved = await post(
                      `/comparisons/${comparison.id}/save-plan`,
                      { plan_id: selectedPlan.id },
                    );
                    await ctx.saveScenario({ __select: saved.id });
                    ctx.notify(
                      "Proposed response saved as a new planning scenario.",
                    );
                  })
                }
              >
                <Save size={15} />
                Save selected plan
              </Button>
            </section>
          ) : null}
          {comparison?.status === "SUCCEEDED" ? (
            <ComparisonDetails plans={plans} ctx={calendarCtx} />
          ) : null}
        </div>
        <details
          className="comparison-explainer"
          id="compare-inspector-dock"
          hidden={panels.inspectorHidden}
        >
          <summary>Decision support and comparison tools</summary>
          <div className="comparison-explainer-content">
            <span className="eyebrow">WHY STAFFING MATTERS</span>
            <h2>Space becomes capacity when resources align.</h2>
            <div className="equation">
              <div>
                <Layers size={24} />
                <strong>Physical places</strong>
                <span>Installed & ready</span>
              </div>
              <span>+</span>
              <div>
                <Users size={24} />
                <strong>Qualified staff</strong>
                <span>Available & assigned</span>
              </div>
              <span>↓</span>
              <div className="result">
                <GitCompareArrows size={23} />
                <strong>Usable capacity</strong>
                <span>Compatible equipment required</span>
              </div>
            </div>
            <p>
              Additional spaces cannot accept patients while required staff or
              equipment are unavailable.
            </p>
            <div className="insight-note">
              <Clock3 size={16} />
              <span>
                Activation lead times count. Waiting before a response becomes
                ready stays in its results.
              </span>
            </div>
            {comparison?.no_plan_improves ? (
              <div className="info-note">
                These plans did not reduce waiting. Review staffing, beds, and
                equipment before trying another change.
              </div>
            ) : null}
            <Button
              className="full-width"
              onClick={() => ctx.setPage("overview")}
            >
              Adjust hospital setup <ArrowRight size={14} />
            </Button>
            {comparison?.status === "SUCCEEDED" ? (
              <Button className="full-width" onClick={exportComparison}>
                <ArrowDownToLine size={14} />
                Export comparison
              </Button>
            ) : null}
            <small className="muted">
              Saving preserves a proposed plan with its assumptions and resource
              requirements.
            </small>
          </div>
        </details>
      </div>
      <PlanningTimelineDock panels={panels} name="compare">
        <Timeline
          ctx={calendarCtx}
          heatmapOnly
          title={`Calendar · ${calendarPlan?.name || "Reference"}`}
        />
      </PlanningTimelineDock>
      {assumptions ? (
        <Modal
          title="Comparison assumptions"
          wide
          onClose={() => setAssumptions(false)}
        >
          <div className="info-note">
            Each option uses the same hospital, time period, and patient
            arrivals. Results are ordered by total time waiting for a bed, then
            by the largest queue and the staff needed.
          </div>
          <dl className="detail-list">
            <div>
              <dt>Scenario</dt>
              <dd>{calendarScenario?.name}</dd>
            </div>
            <div>
              <dt>Dataset</dt>
              <dd>
                {calendarScenario?.dataset_version_id === ctx.dataset?.id
                  ? ctx.dataset?.name || "Hospital baseline"
                  : "Saved hospital baseline"}
              </dd>
            </div>
            <div>
              <dt>Horizon</dt>
              <dd>{calendarScenario?.horizon_calendar_days} local days</dd>
            </div>
            <div>
              <dt>Randomness seed</dt>
              <dd>{calendarScenario?.base_seed}</dd>
            </div>
          </dl>
          {(comparison?.plans || selected.map((kind) => ({ kind }))).map(
            (plan: Entity, index: number) => {
              const kind = plan.kind;
              const option = choices.find((o) => o.kind === kind);
              return (
                <div key={plan.id || kind || index} className="assumption-row">
                  <strong>
                    {plan.name || option?.name || "Hospital response"}
                  </strong>
                  <span>
                    {comparison
                      ? (plan.interventions || [])
                          .map((value: Entity) => responseName(value))
                          .join(" · ") ||
                        "Reference scenario resource assumptions"
                      : option?.description}
                  </span>
                </div>
              );
            },
          )}
          <p className="muted small-copy">
            Financial cost is unavailable unless costs are supplied. Percentile
            changes are calculated from paired runs.
          </p>
        </Modal>
      ) : null}
      {exportOpen ? (
        <Modal
          title="Download comparison package"
          onClose={() => setExportOpen(false)}
        >
          <div className="form-stack">
            <p className="muted small-copy">
              The package includes matched metrics, paired differences, resource
              assumptions, and checksum manifests.
            </p>
            {exportResult?.status === "FAILED" ? (
              <p className="red">{exportResult.error || "Export failed."}</p>
            ) : exportResult?.download_url ? (
              <a
                className="button primary"
                href={
                  exportResult.download_url.startsWith("/api")
                    ? exportResult.download_url
                    : `/api${exportResult.download_url}`
                }
              >
                Download comparison ZIP <ArrowDownToLine size={14} />
              </a>
            ) : (
              <p className="muted">Preparing computed comparison artifacts…</p>
            )}
          </div>
        </Modal>
      ) : null}
      {historyOpen ? (
        <Modal
          title="Saved response comparisons"
          wide
          onClose={() => setHistoryOpen(false)}
        >
          {history.map((c) => (
            <div className="library-row" key={c.id}>
              <div>
                <strong>{c.name || "Response comparison"}</strong>
                <span>{c.plans?.length || "Saved"} plans</span>
              </div>
              <Badge>
                {c.status === "SUCCEEDED"
                  ? "Complete"
                  : c.status === "FAILED"
                    ? "Needs attention"
                    : c.status === "CANCELLED"
                      ? "Stopped"
                      : "In progress"}
              </Badge>
              <Button
                small
                onClick={() =>
                  ctx.action("Opening comparison", async () => {
                    persist(await api(`/comparisons/${c.id}`));
                    setHistoryOpen(false);
                  })
                }
              >
                Open <ArrowRight size={13} />
              </Button>
            </div>
          ))}
        </Modal>
      ) : null}
    </div>
  );
}
function historyReplace(url: URL) {
  window.history.replaceState({}, "", url);
}
