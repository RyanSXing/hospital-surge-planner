import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
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
import { api, fmt, items, num, post } from "../api";
import { Badge, Button, Modal } from "../components/ui";
import { ForecastChart, Timeline } from "../components/Charts";
import { statsFor } from "../model";
import ComparisonDetails from "../components/ComparisonDetails";
const choices = [
  {
    kind: "physical_overflow",
    name: "Add physical overflow",
    description:
      "Install planned physical spaces. Staffing remains a separate requirement.",
    icon: Layers,
  },
  {
    kind: "staff_existing",
    name: "Staff existing ward beds",
    description:
      "Allocate available qualified reserve nurses to installed ward beds.",
    icon: Users,
  },
  {
    kind: "clinic",
    name: "Activate outpatient clinic",
    description:
      "Allocate qualified reserve staff and equipment to eligible outpatient services.",
    icon: Plus,
  },
  {
    kind: "staffed_overflow",
    name: "Staffed overflow ward",
    description:
      "Install planned inpatient spaces and assign their required resource bundle.",
    icon: Layers,
  },
  {
    kind: "partner_transfer",
    name: "Partner transfer plan",
    description:
      "Reserve suitable receiving capacity and compatible transport.",
    icon: ArrowUpRight,
  },
];
const palette = ["#ff6c79", "#efbd60", "#57d8eb", "#55d9bf"];
export default function Compare({ ctx }: { ctx: PlanningContext }) {
  const [selected, setSelected] = useState([
      "physical_overflow",
      "staff_existing",
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
        ...selected.map((kind) =>
          post(`/scenarios/${ctx.scenario!.id}/feasibility`, {
            ...common,
            interventions: [
              ...(ctx.scenario?.interventions || []),
              { kind, start_at: ctx.scenario?.start_at },
            ],
          }),
        ),
      ])
        .then(([base, ...reports]) => {
          if (ignore) return;
          const estimate = base.compute_estimate;
          if (estimate) {
            const total =
              estimate.expected_trajectories_per_run * (selected.length + 1);
            setPreflight({
              ...estimate,
              valid: base.valid,
              plans: selected.length + 1,
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
              selected.map((kind, index) => [kind, reports[index].feasibility]),
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
    selected.join(","),
  ]);
  function accept(c: Entity) {
    if (c.scenario_id && c.scenario_id !== ctx.scenario?.id) {
      setComparison(null);
      return;
    }
    setComparison(c);
    if (c.plans?.[0]?.metrics?.replications_completed)
      setReplications(c.plans[0].metrics.replications_completed);
    const kinds = c.plans
      ?.slice(1)
      .map((p: Entity) => p.interventions?.at(-1)?.kind)
      .filter(Boolean);
    if (kinds?.length) setSelected(kinds);
  }
  useEffect(() => {
    let ignore = false;
    const stored =
      sessionStorage.getItem(`hospital.comparison.${ctx.scenario?.id}`) ||
      new URLSearchParams(location.search).get("comparison");
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
  }, [ctx.scenario?.id]);
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
    sessionStorage.setItem(`hospital.comparison.${ctx.scenario?.id}`, c.id);
    const u = new URL(location.href);
    u.searchParams.set("comparison", c.id);
    historyReplace(u);
  }
  async function compare() {
    await ctx.action("Submitting matched comparisons", async () => {
      setFetchError("");
      const result = await post("/comparisons", {
        scenario_id: ctx.scenario?.id,
        replications,
        plans: selected.map((kind) => ({
          name: choices.find((o) => o.kind === kind)?.name,
          interventions: [
            ...(ctx.scenario?.interventions || []),
            { kind, id: crypto.randomUUID(), start_at: ctx.scenario?.start_at },
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
  const baseWard = statsFor(ctx, "ward", "FAC-MAIN"),
    plans: Entity[] = comparison?.plans || [
      { id: "reference", name: "Current plan", kind: "reference" },
      ...selected.map((kind) => ({
        id: kind,
        name: choices.find((o) => o.kind === kind)?.name,
        kind,
      })),
    ];
  const maxWait = Math.max(
      1,
      ...plans.map((p) =>
        num(
          (p.metrics?.scalar_metrics || p.metrics || {})
            .inpatient_waiting_patient_hours,
        ),
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
  const calendarPlan = plans.find((p) => p.id === chosen) || plans[0],
    calendarCtx: PlanningContext = {
      ...ctx,
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
    <div className="compare-page page-scroll">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DECISION WORKSPACE</div>
          <h1>Compare responses</h1>
          <p>
            Same demand assumptions. Feasible resources. Measured differences.
          </p>
        </div>
        <div className="heading-actions">
          <Button
            onClick={() =>
              ctx.action("Loading saved comparisons", async () => {
                setHistory(
                  items(
                    await api(`/comparisons?scenario_id=${ctx.scenario?.id}`),
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
          <select
            aria-label="Comparison simulation runs"
            value={replications}
            onChange={(e) => setReplications(+e.target.value)}
          >
            <option value="10">10 runs · Preview</option>
            <option value="100">100 runs · Standard</option>
            <option value="500">500 runs</option>
          </select>
          <Button
            primary
            disabled={
              ctx.canWrite === false ||
              !!ctx.busy ||
              running ||
              !selected.length ||
              checking ||
              preflight?.within_budget === false
            }
            onClick={compare}
          >
            <Play size={14} />
            {running ? "Evaluating plans…" : "Evaluate responses"}
          </Button>
        </div>
      </div>
      <div className="comparison-context">
        <GitCompareArrows size={16} />
        <strong>{ctx.scenario?.name}</strong>
        <span>{ctx.scenario?.horizon_calendar_days} days</span>
        <span>Paired random inputs</span>
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
        {choices.map((o) => (
          <button
            key={o.kind}
            className={selected.includes(o.kind) ? "selected" : ""}
            disabled={
              running || (!selected.includes(o.kind) && selected.length >= 3)
            }
            onClick={() => {
              setSelected((v) =>
                v.includes(o.kind)
                  ? v.filter((k) => k !== o.kind)
                  : [...v, o.kind],
              );
              setComparison(null);
              sessionStorage.removeItem(
                `hospital.comparison.${ctx.scenario?.id}`,
              );
              const u = new URL(location.href);
              u.searchParams.delete("comparison");
              historyReplace(u);
            }}
          >
            <o.icon size={16} />
            <span>{o.name}</span>
            {selected.includes(o.kind) ? (
              <Check size={14} />
            ) : (
              <Plus size={14} />
            )}
          </button>
        ))}
      </div>
      <details className="comparison-preflight">
        <summary>
          {checking
            ? "Checking compute estimate & prerequisites…"
            : preflight
              ? `${fmt(preflight.plans)} plans × ${fmt(replications)} runs × ${fmt(preflight.expected_trajectories_per_replication)} expected patients = ${fmt(preflight.expected_trajectories_total)} trajectories`
              : preflightError || "Execution estimate unavailable"}
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
        {selected.map((kind) => (
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
                  ? "Inventory and scheduled roster prerequisites satisfied"
                  : "Awaiting validation"}
            </span>
          </div>
        ))}
      </details>
      {comparison?.source_draft_revision &&
      ctx.scenario?.revision !== comparison.source_draft_revision ? (
        <div className="stale-banner">
          This comparison uses saved revision {comparison.source_draft_revision}
          . Evaluate again to include changes in the current draft.
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
      <div className="comparison-body">
        <div className="comparison-main">
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
                physical = last
                  ? Math.round(num(last.ward_physical))
                  : baseWard.physical,
                staffed = last
                  ? Math.round(num(last.ward_staffed))
                  : baseWard.staffed,
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
                      {last
                        ? "WARD INVENTORY · HORIZON END"
                        : "WARD INVENTORY · SOURCE SNAPSHOT"}
                    </span>
                    <div
                      className="capacity-diagram"
                      role="img"
                      aria-label={`${physical} physical ward places; ${staffed} staffing-supported; capacity diagram without patient assignments`}
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
                        {staffed}
                        <small> / {physical}</small>
                      </strong>
                      <span>
                        staffing-supported
                        <br />
                        physical places
                      </span>
                    </div>
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
          <section className="comparison-chart">
            <div className="spread">
              <h3>
                {chartMetric === "inpatient_queue"
                  ? "Patients awaiting inpatient placement"
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
              <label>
                Plot
                <select
                  aria-label="Comparison chart metric"
                  value={chartMetric}
                  onChange={(e) => setChartMetric(e.target.value)}
                >
                  <option value="inpatient_queue">
                    Inpatient queue · patients
                  </option>
                  <option value="ward_occupied">
                    Ward occupancy · patients
                  </option>
                  <option value="icu_occupied">ICU occupancy · patients</option>
                  <option value="waiting_patient_hours">
                    {ctx.grain === "day"
                      ? "Cumulative waiting"
                      : "Waiting per interval"}{" "}
                    · patient-hours
                  </option>
                </select>
              </label>
              <label>
                Uncertainty
                <select
                  aria-label="Comparison uncertainty band"
                  value={bandPlan}
                  onChange={(e) => setBandPlan(e.target.value)}
                >
                  <option value="none">No band</option>
                  {plottedPlans.map((p) => (
                    <option key={p.id} value={p.chartKey}>
                      {p.name} · P10–P90
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ForecastChart
              rows={chartRows}
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
              height={145}
              showBand={bandPlan !== "none"}
              selected={chartRows.reduce(
                (best: number, row: Entity, index: number) =>
                  Math.abs(Date.parse(row.at) - Date.parse(ctx.selectedTime)) <
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
            {periodLoading ? (
              <div className="comparison-progress">
                Loading aggregates from the same matched runs…
              </div>
            ) : null}
            {running ? (
              <div className="comparison-progress">
                <span className="spin">◌</span> Evaluating recorded patient
                trajectories under the same external demand.
              </div>
            ) : null}
          </section>
          <div
            className="comparison-outcomes"
            style={{
              gridTemplateColumns: `repeat(${plans.length},minmax(0,1fr))`,
            }}
          >
            {plans.map((p, i) => {
              const metrics = p.metrics?.scalar_metrics || {},
                wait = metrics.inpatient_waiting_patient_hours,
                has = wait !== undefined,
                improvement = p.improvement;
              return (
                <div
                  key={p.id}
                  className={`outcome-card ${chosen === p.id ? "chosen" : ""}`}
                >
                  <span className="eyebrow">{p.name} · FULL HORIZON</span>
                  <div className="outcome-number">
                    {has ? fmt(num(wait)) : "—"}
                    <small>patient-hours waiting</small>
                  </div>
                  <div className="outcome-bar">
                    <span
                      style={{
                        width: `${has ? (num(wait) / maxWait) * 100 : 0}%`,
                        background: palette[i],
                      }}
                    />
                  </div>
                  <dl>
                    <div>
                      <dt>Peak queue</dt>
                      <dd>
                        {has ? fmt(num(metrics.peak_inpatient_queue)) : "—"}{" "}
                        patients
                      </dd>
                    </div>
                    <div>
                      <dt>Median paired reduction</dt>
                      <dd className={num(improvement?.p50) > 0 ? "green" : ""}>
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
                          <dt>P10–P90 reduction</dt>
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
                          <dt>Runs with improvement</dt>
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
                        ? "Selected planning response"
                        : "Select response"}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <ComparisonDetails plans={plans} ctx={ctx} />
        </div>
        <aside className="comparison-explainer">
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
              None of these plans improves the selected objective. Review the
              remaining constraints.
            </div>
          ) : null}
          <Button
            className="full-width"
            onClick={() => ctx.setPage("resources")}
          >
            Inspect resource dependencies <ChevronRight size={14} />
          </Button>
          {chosen && comparison?.id ? (
            <Button
              primary
              className="full-width"
              onClick={() =>
                ctx.action("Saving planning response", async () => {
                  const saved = await post(
                    `/comparisons/${comparison.id}/save-plan`,
                    { plan_id: chosen },
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
          ) : null}
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
        </aside>
      </div>
      <Timeline
        ctx={calendarCtx}
        heatmapOnly
        title={`Calendar · ${calendarPlan?.name || "Reference"}`}
      />
      {assumptions ? (
        <Modal
          title="Comparison assumptions"
          wide
          onClose={() => setAssumptions(false)}
        >
          <div className="info-note">
            All plans use the same immutable dataset, horizon, model version,
            and paired exogenous demand. Rank by median full-horizon waiting,
            peak queue, additional staff-hours, configured costs, and activation
            time.
          </div>
          <dl className="detail-list">
            <div>
              <dt>Scenario</dt>
              <dd>{ctx.scenario?.name}</dd>
            </div>
            <div>
              <dt>Dataset</dt>
              <dd>{ctx.dataset?.fixture}</dd>
            </div>
            <div>
              <dt>Horizon</dt>
              <dd>{ctx.scenario?.horizon_calendar_days} local days</dd>
            </div>
            <div>
              <dt>Base seed</dt>
              <dd>{ctx.scenario?.base_seed}</dd>
            </div>
          </dl>
          {selected.map((kind) => {
            const option = choices.find((o) => o.kind === kind);
            return (
              <div key={kind} className="assumption-row">
                <strong>{option?.name || kind}</strong>
                <span>{option?.description}</span>
              </div>
            );
          })}
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
                <span>{c.id}</span>
              </div>
              <Badge>{c.status || "Saved"}</Badge>
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
