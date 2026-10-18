import type { Entity, PlanningContext, Scenario } from "../types";
import { comparisonResultPlan, finiteStatistic } from "./resultsMetrics";
import { bottleneckLabel } from "./bottleneckEvidence";
import { humanLabel } from "../presentation";

export type DecisionAction =
  | { kind: "compare"; label: string }
  | { kind: "simulate"; label: string }
  | { kind: "configure"; label: string }
  | { kind: "review"; label: string; comparisonId: string; planId: string }
  | { kind: "replay"; label: string; at: string; replicationId: string };
export interface MainConstraint {
  reason: string;
  label: string;
  unit: string | null;
  unitKind: string | null;
  peakWaiting: number | null;
  peakStatistic: "median" | "mean" | "example" | null;
  burden: number;
  firstAt: string | null;
  replicationId: string | null;
  scope: "ensemble" | "example";
  firstAcrossRuns: boolean;
}
export interface DecisionSummaryModel {
  state: "ready" | "stale" | "unavailable" | "loading";
  problem: string;
  notice: string | null;
  impact: string[];
  response: string | null;
  improvement: string | null;
  remaining: string | null;
  evidence: string[];
  main: MainConstraint | null;
  action: DecisionAction;
  replay: Extract<DecisionAction, { kind: "replay" }> | null;
}
const number = (value: number, digits = 1) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
    value,
  );
const positive = (value: unknown) => {
  const mean =
    value && typeof value === "object" ? (value as Entity).mean : null;
  return typeof mean === "number" && Number.isFinite(mean)
    ? mean
    : finiteStatistic(value);
};
function sameTime(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Number.isFinite(Date.parse(a)) &&
    Date.parse(a) === Date.parse(b)
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${key}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const knownOperationsVersions = new Set(["1.0", "1.1", "1.2"]);
function operationsEnabled(scenario: Entity | null | undefined): boolean {
  return Boolean(
    scenario?.hospital_operations &&
    Object.keys(scenario.hospital_operations).length,
  );
}
function operationsVersion(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}
/** Match the algorithm as well as the frozen inputs before comparing outcomes. */
export function comparisonOperationsVersionsMatch(
  comparison: Entity,
  ctx: PlanningContext,
): boolean {
  const enabled =
    operationsEnabled(ctx.resultScenario || ctx.run?.scenario_context) ||
    operationsEnabled(comparison.source_scenario_snapshot);
  const resultVersion = operationsVersion(
    ctx.metrics?.hospital_operations_model_version,
  );
  const comparisonVersion = operationsVersion(
    comparison.hospital_operations_model_version,
  );
  const versioned =
    enabled || resultVersion !== null || comparisonVersion !== null;
  if (
    versioned &&
    (!metricsMatchRun(ctx) ||
      !resultVersion ||
      !knownOperationsVersions.has(resultVersion) ||
      comparisonVersion !== resultVersion)
  )
    return false;
  for (const plan of comparison.plans || []) {
    if (plan.status !== "SUCCEEDED") continue;
    const artifactVersion = operationsVersion(
      plan.metrics?.hospital_operations_model_version,
    );
    const planVersion = operationsVersion(
      plan.hospital_operations_model_version,
    );
    if (
      versioned
        ? artifactVersion !== resultVersion ||
          (planVersion !== null && planVersion !== resultVersion)
        : artifactVersion !== null || planVersion !== null
    )
      return false;
  }
  return true;
}
/** A revision alone is insufficient: a comparison also freezes horizon and inputs. */
export function comparisonMatchesResult(
  comparison: Entity,
  ctx: PlanningContext,
): boolean {
  const frozen = ctx.resultScenario || ctx.run?.scenario_context;
  const source = comparison.source_scenario_snapshot;
  if (!frozen || !source || !ctx.scenario || !ctx.run) return false;
  if (
    comparison.scenario_id !== ctx.scenario.id ||
    ctx.run.scenario_id !== ctx.scenario.id
  )
    return false;
  if (
    typeof ctx.run.source_draft_revision !== "number" ||
    comparison.source_draft_revision !== ctx.run.source_draft_revision ||
    ctx.scenario.revision !== ctx.run.source_draft_revision
  )
    return false;
  if (
    source.dataset_version_id !== frozen.dataset_version_id ||
    !sameTime(source.start_at, frozen.start_at) ||
    source.horizon_calendar_days !== frozen.horizon_calendar_days ||
    source.timezone !== frozen.timezone ||
    source.base_seed !== frozen.base_seed ||
    stable(source.measurement_start_at ?? null) !==
      stable(frozen.measurement_start_at ?? null) ||
    stable(source.branch_at ?? null) !== stable(frozen.branch_at ?? null) ||
    (source.end_at && frozen.end_at && !sameTime(source.end_at, frozen.end_at))
  )
    return false;
  if (!comparisonOperationsVersionsMatch(comparison, ctx)) return false;
  // Comparison plan runs contain their own interventions. Their baseline is still
  // checked against the frozen source revision before a response can be offered.
  if (ctx.run.comparison_id) return ctx.run.comparison_id === comparison.id;
  return [
    "conditions",
    "interventions",
    "updates",
    "hospital_operations",
  ].every(
    (key) =>
      stable(source[key] ?? (key === "hospital_operations" ? null : [])) ===
      stable(frozen[key] ?? (key === "hospital_operations" ? null : [])),
  );
}
export function evidenceMatchesRun(
  evidence: Entity | null | undefined,
  ctx: PlanningContext,
): boolean {
  if (
    !evidence?.evidence_available ||
    !ctx.run ||
    !Array.isArray(evidence.categories) ||
    evidence.categories.some(
      (row: Entity) =>
        typeof row.reason !== "string" || positive(row.patient_hours) === null,
    )
  )
    return false;
  const context = evidence.context;
  if (!context || context.run_group_id !== ctx.run.id) return false;
  if (
    context.scenario_id !== ctx.run.scenario_id ||
    context.dataset_version_id !== ctx.run.dataset_version_id ||
    context.scenario_revision_id !== ctx.run.scenario_revision_id
  )
    return false;
  if (evidence.scope !== "ensemble") {
    const replication =
      ctx.activeReplicationId || ctx.run.selected_replication_id;
    if (!replication || evidence.replication_id !== replication) return false;
  }
  return true;
}
export function metricsMatchRun(ctx: PlanningContext): boolean {
  const context = ctx.metrics?.context;
  return Boolean(
    ctx.run &&
    context &&
    context.run_group_id === ctx.run.id &&
    context.scenario_id === ctx.run.scenario_id &&
    context.scenario_revision_id === ctx.run.scenario_revision_id &&
    context.dataset_version_id === ctx.run.dataset_version_id,
  );
}
/** Only name a resource when its evidence covers the full selected unit constraint. */
function fullyRecordedResourceLimit(
  evidence: Entity,
  attributed: Entity | undefined,
  reason: string,
): { label: string; firstAt: string; replicationId: string } | null {
  if (
    !attributed?.unit_id ||
    !["nursing_capacity", "minimum_operating_team"].includes(reason)
  )
    return null;
  const burden = positive(attributed.patient_hours);
  if (burden === null || burden <= 0) return null;
  const resources: Entity[] = (evidence.resources || []).filter(
    (row: Entity) =>
      row.unit_id === attributed.unit_id &&
      row.reason === reason &&
      (positive(row.patient_hours) ?? 0) > 0,
  );
  if (!resources.length) return null;
  const tolerance = Math.max(1e-8, burden * 1e-8);
  if (
    resources.some(
      (row) =>
        Math.abs(positive(row.patient_hours)! - burden) > tolerance ||
        typeof row.first_at !== "string" ||
        !Number.isFinite(Date.parse(row.first_at)) ||
        typeof row.first_replication_id !== "string" ||
        !row.first_replication_id,
    )
  )
    return null;
  const first = resources[0];
  // Conflicting first-exposure records cannot support a combined resource label.
  if (
    resources.some(
      (row) =>
        !sameTime(row.first_at, first.first_at) ||
        row.first_replication_id !== first.first_replication_id,
    )
  )
    return null;
  let label: string;
  if (reason === "nursing_capacity") {
    if (
      resources.some(
        (row) =>
          !(
            (row.kind === "staff" && row.code === "rn") ||
            (row.kind === "equipment" &&
              typeof row.code === "string" &&
              row.code)
          ),
      )
    )
      return null;
    const nurses = resources.some(
      (row) => row.kind === "staff" && row.code === "rn",
    );
    const equipment = [
      ...new Set(
        resources
          .filter((row) => row.kind === "equipment")
          .map((row) => humanLabel(row.code).toLowerCase()),
      ),
    ]
      .sort()
      .join(" and ");
    label =
      nurses && equipment
        ? `Qualified nurse and ${equipment} shortages limited bed capacity`
        : nurses
          ? "Not enough qualified nurses"
          : `Bed capacity limited by ${equipment}`;
  } else {
    if (
      resources.some(
        (row) =>
          row.kind !== "staff" || !["provider", "support"].includes(row.code),
      )
    )
      return null;
    const providers = resources.some((row) => row.code === "provider");
    const support = resources.some((row) => row.code === "support");
    label =
      providers && support
        ? "Not enough medical providers and support staff"
        : providers
          ? "Not enough qualified medical providers"
          : "Not enough support staff";
  }
  return {
    label,
    firstAt: first.first_at,
    replicationId: first.first_replication_id,
  };
}
export function mainRecordedConstraint(
  evidence: Entity | null | undefined,
  units: Entity[] = [],
): MainConstraint | null {
  if (!evidence?.evidence_available) return null;
  const category = [...(evidence.categories || [])]
    .filter((row: Entity) => (positive(row.patient_hours) ?? 0) > 0)
    .sort(
      (a: Entity, b: Entity) =>
        positive(b.patient_hours)! - positive(a.patient_hours)! ||
        String(a.reason).localeCompare(String(b.reason)),
    )[0];
  if (!category) return null;
  // Never add overlapping resources or categories to manufacture a contribution.
  const attributed = [...(evidence.units || []), ...(evidence.resources || [])]
    .filter(
      (row: Entity) =>
        row.reason === category.reason &&
        row.unit_id &&
        (positive(row.patient_hours) ?? 0) > 0,
    )
    .sort(
      (a: Entity, b: Entity) =>
        positive(b.patient_hours)! - positive(a.patient_hours)!,
    )[0];
  const definition = units.find(
    (unit) => (unit.unit_id || unit.id) === attributed?.unit_id,
  );
  const unit = attributed
    ? definition?.name
      ? humanLabel(definition.name)
      : attributed.unit_kind
        ? humanLabel(attributed.unit_kind)
        : null
    : null;
  const unitKind = definition?.kind || attributed?.unit_kind || null;
  const peakRecord =
    attributed?.peak_waiting ??
    (category.unit_kind === unitKind ? category.peak_waiting : undefined);
  let peakWaiting = finiteStatistic(peakRecord);
  let peakStatistic: MainConstraint["peakStatistic"] =
    peakWaiting !== null
      ? evidence.scope === "ensemble"
        ? "median"
        : "example"
      : null;
  if (
    peakWaiting === null &&
    evidence.scope === "ensemble" &&
    typeof peakRecord?.mean === "number" &&
    Number.isFinite(peakRecord.mean)
  ) {
    peakWaiting = peakRecord.mean;
    peakStatistic = "mean";
  }
  if (peakWaiting !== null && peakWaiting < 0) {
    peakWaiting = null;
    peakStatistic = null;
  }
  const namedLimit = fullyRecordedResourceLimit(
    evidence,
    attributed,
    category.reason,
  );
  const first =
    namedLimit?.firstAt || attributed?.first_at || category.first_at;
  const firstAt =
    typeof first === "string" && Number.isFinite(Date.parse(first))
      ? first
      : null;
  return {
    reason: category.reason,
    label:
      namedLimit?.label ||
      (
        {
          medical_supplies: "Medical supplies exhausted",
          treatment_disruption: "Treatment paused by a disruption",
        } as Record<string, string>
      )[category.reason] ||
      bottleneckLabel(category.reason),
    unit,
    unitKind,
    peakWaiting,
    peakStatistic,
    burden: positive(category.patient_hours)!,
    firstAt,
    replicationId:
      namedLimit?.replicationId ||
      attributed?.first_replication_id ||
      category.first_replication_id ||
      evidence.replication_id ||
      null,
    scope: evidence.scope === "ensemble" ? "ensemble" : "example",
    firstAcrossRuns: evidence.scope === "ensemble",
  };
}
/** Compare individual unit/constraint records; overlapping reasons are not summed. */
export function mostConstrainedDepartment(
  evidence: Entity | null | undefined,
  units: Entity[] = [],
): { name: string; scope: "ensemble" | "example" } | null {
  if (!evidence?.evidence_available) return null;
  const row = [...(evidence.units || []), ...(evidence.resources || [])]
    .filter(
      (item: Entity) => item.unit_id && (positive(item.patient_hours) ?? 0) > 0,
    )
    .sort(
      (a: Entity, b: Entity) =>
        positive(b.patient_hours)! - positive(a.patient_hours)! ||
        String(a.unit_id).localeCompare(String(b.unit_id)),
    )[0];
  if (!row) return null;
  const definition = units.find(
    (unit) => (unit.unit_id || unit.id) === row.unit_id,
  );
  const name = definition?.name
    ? humanLabel(definition.name)
    : row.unit_kind
      ? humanLabel(row.unit_kind)
      : null;
  return name
    ? { name, scope: evidence.scope === "ensemble" ? "ensemble" : "example" }
    : null;
}
/** Resource changes already tested by the saved comparison, with exact counts. */
export function responseChanges(
  plan: Entity,
  source: Scenario | Entity | undefined,
  units: Entity[] = [],
): string | null {
  const original = new Set(
    (source?.interventions || []).map((item: Entity) => stable(item)),
  );
  const changes = (plan.interventions || []).filter(
    (item: Entity) => item.enabled !== false && !original.has(stable(item)),
  );
  if (!changes.length) return null;
  return changes
    .map((item: Entity) => {
      const unit = units.find(
        (row) => (row.unit_id || row.id) === item.unit_id,
      );
      const place = unit?.name ? ` in ${humanLabel(unit.name)}` : "";
      const parts: string[] = [];
      if (typeof item.nurses === "number" && item.nurses > 0)
        parts.push(
          `${number(item.nurses, 0)} additional ${item.nurses === 1 ? "nurse" : "nurses"}`,
        );
      if (typeof item.providers === "number" && item.providers > 0)
        parts.push(
          `${number(item.providers, 0)} additional medical ${item.providers === 1 ? "provider" : "providers"}`,
        );
      if (typeof item.support === "number" && item.support > 0)
        parts.push(`${number(item.support, 0)} additional support staff`);
      if (typeof item.enabled_slots === "number")
        parts.push(`make ${number(item.enabled_slots, 0)} beds available`);
      return parts.length
        ? `${parts.join(", ")}${place}`
        : item.name || "Recorded resource changes";
    })
    .join("; ");
}
export function buildDecisionSummary({
  ctx,
  ensemble,
  example,
  comparison,
  loading = false,
  comparisonUnavailable = false,
}: {
  ctx: PlanningContext;
  ensemble?: Entity | null;
  example?: Entity | null;
  comparison?: Entity | null;
  loading?: boolean;
  comparisonUnavailable?: boolean;
}): DecisionSummaryModel {
  const model: DecisionSummaryModel = {
    state: "ready",
    problem: "Recorded constraint details are unavailable.",
    notice: null,
    impact: [],
    response: null,
    improvement: null,
    remaining: null,
    evidence: [],
    main: null,
    action: { kind: "compare", label: "Compare scenarios" },
    replay: null,
  };
  if (!ctx.run || ctx.run.status !== "SUCCEEDED") {
    model.state = "unavailable";
    model.problem = !ctx.run
      ? "Run a simulation to understand where patients may wait."
      : ["FAILED", "CANCELLED"].includes(ctx.run.status)
        ? "This simulation did not finish. No complete conclusion is available."
        : "The simulation is still running. Complete results are not available yet.";
    model.action = {
      kind: "simulate",
      label:
        ctx.run?.status === "FAILED" ? "Retry simulation" : "Run simulation",
    };
    return model;
  }
  if (
    !ctx.scenario ||
    ctx.run.scenario_id !== ctx.scenario.id ||
    !ctx.resultScenario ||
    ctx.resultScenario.id !== ctx.scenario.id ||
    ctx.run.dataset_version_id !== ctx.resultScenario.dataset_version_id
  ) {
    model.state = "unavailable";
    model.problem =
      "These results do not match the selected scenario. Run the selected configuration before choosing a response.";
    model.action = { kind: "simulate", label: "Run selected configuration" };
    return model;
  }
  const revision = ctx.run.source_draft_revision;
  const legacySeverity =
    metricsMatchRun(ctx) &&
    ctx.metrics?.hospital_operations_model_version === "1.0" &&
    Boolean(ctx.resultScenario.hospital_operations?.severity_mix);
  const staleRevision =
    typeof revision !== "number" || revision !== ctx.scenario.revision;
  const stale = staleRevision || legacySeverity;
  if (stale) {
    model.state = "stale";
    if (staleRevision)
      model.evidence.push(
        typeof revision === "number"
          ? `These results describe saved revision ${revision}; the current configuration is revision ${ctx.scenario.revision ?? "unavailable"}.`
          : "The saved configuration revision is unavailable, so a current-plan recommendation cannot be verified.",
      );
    model.remaining =
      "Run the current configuration before choosing a response.";
    model.action = { kind: "simulate", label: "Run updated simulation" };
    if (legacySeverity) {
      const inheritedHistory = Boolean(
        ctx.resultScenario.parent_run_group_id ||
        ctx.resultScenario.parent_replication_id ||
        ctx.resultScenario.state_origin === "simulation_branch",
      );
      model.notice =
        "These saved results use the earlier severity model. Run again with corrected inpatient stays.";
      model.remaining =
        "Run again with corrected inpatient stays before choosing a response.";
      model.evidence.push(
        "The earlier severity model applied configured inpatient stay durations to emergency-department assessment as well as inpatient beds. These saved waiting times and queues are the actual results of that earlier model; they have not been changed. Updated simulations preserve normal emergency-assessment durations and apply severity stay settings only to inpatient beds.",
      );
      if (inheritedHistory) {
        model.notice =
          "These saved results use the earlier severity model. Review configuration to create a corrected independent simulation.";
        model.remaining =
          "A simulation-history branch retains its earlier model. Create a new independent scenario or complete an observed reset for corrected inpatient stays.";
        model.action = { kind: "configure", label: "Review configuration" };
        model.evidence.push(
          "Rerunning a branch of simulated history preserves its original model for reproducible replay; it does not upgrade the severity calculation. Use an independent scenario or a complete observed reset to use the corrected model. The saved run and its replay remain unchanged.",
        );
      }
    }
  }
  const evidence = evidenceMatchesRun(ensemble, ctx)
    ? ensemble
    : evidenceMatchesRun(example, ctx)
      ? example
      : null;
  const main = mainRecordedConstraint(evidence, ctx.dataset?.units);
  model.main = main;
  const metricsMatch = metricsMatchRun(ctx);
  const scalar = metricsMatch ? ctx.metrics?.scalar_metrics || {} : {};
  const peak = finiteStatistic(scalar.peak_inpatient_queue);
  const wait = finiteStatistic(scalar.completed_wait_median_hours);
  const averageWait = finiteStatistic(scalar.average_wait_per_patient_hours);
  if (main?.unitKind === "ed") {
    model.impact.push(
      main.peakWaiting !== null
        ? main.scope === "example"
          ? `Selected example run: up to ${number(main.peakWaiting)} patients waiting for emergency assessment with this constraint.`
          : `${main.peakStatistic === "mean" ? "Average" : "Typical"} recorded peak: ${number(main.peakWaiting)} patients waiting for emergency assessment with this constraint.`
        : "The recorded emergency-assessment queue peak is unavailable for this constraint.",
    );
  } else if (peak !== null) {
    model.impact.push(
      `Typical peak: ${number(peak)} patients waiting for admission.`,
    );
  }
  if (averageWait !== null)
    model.impact.push(
      `Average waiting per patient: ${number(averageWait)} hours.`,
    );
  else if (wait !== null && main?.unitKind !== "ed")
    model.impact.push(
      `Typical admission wait: ${number(wait)} hours for patients admitted before the simulation ended.`,
    );
  if (main) {
    model.problem = `${main.unit ? `${main.unit}: ` : ""}${main.label}. This is the largest recorded constraint.`;
    model.evidence.push(
      `${main.scope === "ensemble" ? "Across simulations, mean" : "In the selected example run,"} whole-hospital waiting burden for the “${bottleneckLabel(main.reason)}” category: ${number(main.burden)} patient-hours. Other constraint categories can overlap and are never added together.`,
    );
    if (!main.unit)
      model.evidence.push(
        "The affected unit was not recorded; a department cannot be inferred.",
      );
    if (main.firstAt && main.replicationId)
      model.replay = {
        kind: "replay",
        label: "View bottleneck",
        at: main.firstAt,
        replicationId: main.replicationId,
      };
  } else if (evidence) {
    model.problem =
      "No modeled resource shortage was recorded while patients waited.";
    model.evidence.push(
      evidence.scope === "ensemble"
        ? "No recorded constraint in the completed ensemble."
        : "This finding applies to the selected example run only; it does not prove that all simulation runs had no shortages.",
    );
  } else if (loading) {
    model.state = stale ? "stale" : "loading";
    model.problem = "Checking recorded constraints for this simulation…";
  }
  model.evidence.push(
    main?.unitKind === "ed"
      ? `${main.scope === "example" ? "The emergency-assessment constraint peak describes the selected example run only." : `The emergency-assessment constraint peak uses the recorded unit-level ${main.peakStatistic || "unavailable statistic"} across completed simulation runs.`} Hospitalwide average waiting, when available, is the median of per-run average patient waiting.`
      : `Peak queue and admission waiting measures above are medians across ${ctx.run.replications_completed} completed simulation runs. A median peak is not the largest queue seen in every run.`,
  );
  if (!model.impact.length)
    model.impact.push(
      "Waiting impact measures are unavailable in these saved results.",
    );
  if (ctx.metricsError || (ctx.metrics && !metricsMatch)) {
    model.state = "unavailable";
    model.impact = [
      "Waiting impact measures are unavailable for the selected run.",
    ];
  }
  if (stale) return model;
  if (!comparison) {
    model.response = comparisonUnavailable
      ? "The saved comparison could not be loaded. No response recommendation is available."
      : "Compare saved scenarios to see how their configurations affect patient flow.";
    return model;
  }
  if (!comparisonMatchesResult(comparison, ctx)) {
    model.response = comparisonOperationsVersionsMatch(comparison, ctx)
      ? "The saved comparison uses a different configuration or simulation period. Compare responses again."
      : "The saved comparison uses a different or unrecorded simulation model. Compare responses again with matching results.";
    model.evidence.push(
      "A comparison must match scenario, saved revision, dataset, arrival and resource inputs, start time, horizon, and seed before it can support a recommendation.",
    );
    return model;
  }
  if (comparison.status !== "SUCCEEDED") {
    model.response = ["FAILED", "CANCELLED"].includes(comparison.status)
      ? "The comparison did not finish. No response recommendation is available."
      : "The response comparison is still running. No recommendation is available yet.";
    return model;
  }
  const plans: Entity[] = comparison.plans || [];
  if (ctx.run.comparison_id && ctx.run.comparison_plan_id) {
    const displayed = plans.find(
      (plan) =>
        plan.id === ctx.run!.comparison_plan_id &&
        plan.run_group_id === ctx.run!.id,
    );
    if (!displayed) {
      model.response =
        "This run does not match a recorded plan in the selected comparison. No response recommendation is available.";
      return model;
    }
    if (displayed.reference !== true) {
      if (
        displayed.status !== "SUCCEEDED" ||
        displayed.feasibility?.feasible !== true
      ) {
        model.response =
          "The selected response does not have complete feasible results.";
        return model;
      }
      const changes = responseChanges(
        displayed,
        comparison.source_scenario_snapshot,
        ctx.dataset?.units,
      );
      model.response = `Viewing tested response: ${changes || displayed.name || "Recorded response plan"}.`;
      model.remaining =
        "These results describe the selected response. Review its comparison with the saved baseline before saving a plan.";
      model.action = {
        kind: "review",
        label: "Review response",
        comparisonId: comparison.id,
        planId: displayed.id,
      };
      model.evidence.push(
        "This is an evaluated response run, not the comparison baseline. No improvement is described as a reduction from the currently displayed response.",
      );
      return model;
    }
  }
  const complete = plans.filter(
    (plan) =>
      plan.status === "SUCCEEDED" && plan.feasibility?.feasible === true,
  );
  const ranked =
    [...complete]
      .filter((plan) => typeof plan.rank === "number")
      .sort((a, b) => a.rank - b.rank)[0] || null;
  const best = comparisonResultPlan(
    complete,
    comparison.no_plan_improves,
    ranked,
  );
  const improvement = finiteStatistic(
    best?.improvement?.absolute_change || best?.improvement,
  );
  const baseline = plans.find((plan) => plan.reference === true);
  const baselineWait = finiteStatistic(
    baseline?.metrics?.scalar_metrics?.inpatient_waiting_patient_hours,
  );
  if (comparison.no_plan_improves === true) {
    model.response =
      baselineWait === 0
        ? "The current plan has zero median bed waiting. No tested response reduced waiting in the matched comparison."
        : "No tested response reduced bed waiting compared with the current plan.";
    if (model.replay) model.action = model.replay;
    return model;
  }
  if (best?.reference === true) {
    model.response = "The current plan ranks first among the tested plans.";
    model.evidence.push(
      "The ranking compares each plan's median waiting burden. Median improvement in matched repetitions is a different calculation: a response can improve most paired repetitions while having a higher overall median waiting burden. Ranking the current plan first does not establish that no response reduced waiting.",
    );
    if (model.replay) model.action = model.replay;
    return model;
  }
  if (improvement !== null && improvement <= 0) {
    model.response =
      "The highest-ranked response does not show a positive median reduction in matched waiting. No response is recommended from these results.";
    if (model.replay) model.action = model.replay;
    return model;
  }
  if (
    !best ||
    improvement === null ||
    improvement <= 0 ||
    !baseline ||
    baseline.status !== "SUCCEEDED"
  ) {
    model.response =
      "The completed comparison lacks sufficient matched evidence to recommend a response.";
    return model;
  }
  const changes = responseChanges(
    best,
    comparison.source_scenario_snapshot,
    ctx.dataset?.units,
  );
  model.response = `Best tested response: ${changes || best.name || "Recorded response plan"}.`;
  const relative = finiteStatistic(best.improvement?.relative_change_percent);
  const baselineHasZeros =
    typeof best.improvement?.relative_undefined_replications === "number" &&
    best.improvement.relative_undefined_replications > 0;
  model.improvement =
    relative !== null &&
    best.improvement?.relative_undefined_replications === 0 &&
    !baselineHasZeros
      ? `${number(relative)}% less bed waiting than the current plan, using matched simulation runs.`
      : `Less bed waiting than the current plan in matched simulation runs.`;
  model.evidence.push(
    `Median paired reduction: ${number(improvement)} patient-hours. This is the measured reduction in waiting burden, not a change in each patient's admission wait.`,
  );
  if (baselineHasZeros)
    model.evidence.push(
      "Some current-plan repetitions had zero bed waiting; their percentage reduction is undefined and is not shown as zero.",
    );
  const remainingPeak = finiteStatistic(
    best.metrics?.scalar_metrics?.peak_inpatient_queue,
  );
  if (remainingPeak !== null)
    model.remaining =
      remainingPeak > 0
        ? `Remaining limitation: the response still has a typical peak of ${number(remainingPeak)} patients waiting for a bed.`
        : "No inpatient bed queue was recorded at the typical peak under this tested response. Other unmeasured limitations may remain.";
  else
    model.remaining =
      "Remaining limitations could not be determined from the recorded response measures.";
  model.action = {
    kind: "review",
    label: "Review response",
    comparisonId: comparison.id,
    planId: best.id,
  };
  model.evidence.push(
    "Best tested means the saved API ranking among completed, feasible plans. Ranking first minimizes bed-waiting burden, then queue peak and recorded resource tie-breakers; it is not proof of the best possible hospital response.",
  );
  return model;
}

export function followDecisionAction(
  action: DecisionAction,
  ctx: PlanningContext,
  onReview?: (comparisonId: string, planId: string) => void,
): void {
  if (action.kind === "replay") {
    if (ctx.openReplayAt) {
      void ctx.openReplayAt(action.replicationId, action.at);
      return;
    }
    ctx.setReplication(action.replicationId);
    ctx.setTime(action.at);
    ctx.setPage("replay");
  } else if (action.kind === "review") {
    onReview?.(action.comparisonId, action.planId);
  } else if (action.kind === "simulate") {
    void ctx.runScenario();
  } else if (action.kind === "configure") {
    ctx.setPage("overview");
  } else if (ctx.compareScenarios) ctx.compareScenarios();
  else ctx.setPage("compare");
}

/** Only an eligible plan in this exact comparison can enter the existing save flow. */
export function requestedComparisonPlan(
  comparison: Entity | null,
  planId: string | null,
): string {
  return comparison?.status === "SUCCEEDED" &&
    comparison.plans?.some(
      (plan: Entity) =>
        plan.id === planId &&
        plan.status === "SUCCEEDED" &&
        plan.reference !== true &&
        plan.feasibility?.feasible === true,
    )
    ? planId!
    : "";
}
