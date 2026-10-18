import { describe, expect, it, vi } from "vitest";
import type { Entity, PlanningContext } from "../types";
import {
  buildDecisionSummary,
  comparisonMatchesResult,
  comparisonOperationsVersionsMatch,
  evidenceMatchesRun,
  followDecisionAction,
  mainRecordedConstraint,
  metricsMatchRun,
  responseChanges,
  requestedComparisonPlan,
  mostConstrainedDepartment,
} from "./decisionSummaryModel";

const frozen = {
  id: "scenario-1",
  name: "Hospital plan",
  revision: 3,
  dataset_version_id: "dataset-1",
  start_at: "2026-10-16T05:00:00Z",
  horizon_calendar_days: 14,
  timezone: "America/Chicago",
  base_seed: 17,
  replications: 20,
  conditions: [],
  interventions: [],
};
const context = {
  run_group_id: "run-1",
  scenario_id: "scenario-1",
  scenario_revision_id: "revision-1",
  dataset_version_id: "dataset-1",
};
function setup(patch: Partial<PlanningContext> = {}): PlanningContext {
  return {
    scenario: structuredClone(frozen),
    resultScenario: structuredClone(frozen),
    dataset: {
      id: "dataset-1",
      units: [
        { unit_id: "WARD-A", name: "Ward A" },
        { unit_id: "ICU", name: "Intensive care" },
      ],
    },
    run: {
      id: "run-1",
      status: "SUCCEEDED",
      scenario_id: "scenario-1",
      source_draft_revision: 3,
      scenario_revision_id: "revision-1",
      dataset_version_id: "dataset-1",
      replications_completed: 20,
      replications_requested: 20,
      selected_replication_id: "example-1",
    },
    metrics: {
      context,
      scalar_metrics: {
        peak_inpatient_queue: { p50: 12 },
        completed_wait_median_hours: { p50: 4 },
      },
      series: [],
      daily: [],
    },
    setTime: vi.fn(),
    setReplication: vi.fn(),
    setPage: vi.fn(),
    runScenario: vi.fn().mockResolvedValue(undefined),
    ...patch,
  } as unknown as PlanningContext;
}
const evidence: Entity = {
  context,
  scope: "ensemble",
  evidence_available: true,
  non_additive: true,
  categories: [
    { reason: "nursing_capacity", patient_hours: { mean: 50, p50: 40 } },
    {
      reason: "no_matching_physical_place",
      patient_hours: { mean: 45, p50: 44 },
    },
  ],
  units: [
    {
      reason: "nursing_capacity",
      unit_id: "WARD-A",
      patient_hours: { mean: 40 },
      first_at: "2026-10-17T06:00:00Z",
      first_replication_id: "earliest-17",
    },
    {
      reason: "nursing_capacity",
      unit_id: "ICU",
      patient_hours: { mean: 10 },
      first_at: "2026-10-17T04:00:00Z",
      first_replication_id: "earliest-3",
    },
  ],
};
function comparison(): Entity {
  return {
    id: "comparison-1",
    status: "SUCCEEDED",
    scenario_id: "scenario-1",
    source_draft_revision: 3,
    source_scenario_snapshot: structuredClone(frozen),
    no_plan_improves: false,
    plans: [
      {
        id: "current",
        reference: true,
        status: "SUCCEEDED",
        rank: 2,
        feasibility: { feasible: true },
        metrics: {
          scalar_metrics: { inpatient_waiting_patient_hours: { p50: 100 } },
        },
      },
      {
        id: "response",
        reference: false,
        name: "Extra ward staff",
        status: "SUCCEEDED",
        rank: 1,
        feasibility: { feasible: true },
        interventions: [
          {
            kind: "staff_existing",
            nurses: 2,
            providers: 1,
            unit_id: "WARD-A",
          },
        ],
        improvement: {
          absolute_change: { p50: 40 },
          relative_change_percent: { p50: 40 },
          relative_undefined_replications: 0,
        },
        metrics: {
          scalar_metrics: {
            inpatient_waiting_patient_hours: { p50: 60 },
            peak_inpatient_queue: { p50: 7 },
          },
        },
      },
    ],
  };
}

describe("recorded decision evidence", () => {
  it("ranks mean ensemble burden and selects the named unit without summing overlaps", () => {
    expect(
      mainRecordedConstraint(evidence, setup().dataset!.units),
    ).toMatchObject({
      reason: "nursing_capacity",
      burden: 50,
      unit: "Ward A",
      firstAt: "2026-10-17T06:00:00Z",
      replicationId: "earliest-17",
      scope: "ensemble",
    });
  });
  it("names fully recorded nurse or equipment limits and uses their actual first exposure", () => {
    const resource = {
      unit_id: "WARD-A",
      reason: "nursing_capacity",
      patient_hours: { mean: 40 },
      first_at: "2026-10-18T09:00:00Z",
      first_replication_id: "named-resource-run",
      kind: "staff",
      code: "rn",
    };
    let main = mainRecordedConstraint(
      { ...evidence, resources: [resource] },
      setup().dataset!.units,
    );
    expect(main).toMatchObject({
      label: "Not enough qualified nurses",
      firstAt: resource.first_at,
      replicationId: resource.first_replication_id,
      burden: 50,
    });
    main = mainRecordedConstraint(
      {
        ...evidence,
        resources: [{ ...resource, kind: "equipment", code: "WARD_OXYGEN" }],
      },
      setup().dataset!.units,
    );
    expect(main?.label).toBe("Bed capacity limited by oxygen support");
    expect(main?.firstAt).toBe(resource.first_at);
  });
  it("keeps partial, unknown or untimed named-resource evidence generic", () => {
    const resource = {
      unit_id: "WARD-A",
      reason: "nursing_capacity",
      patient_hours: { mean: 40 },
      first_at: "2026-10-18T09:00:00Z",
      first_replication_id: "named-resource-run",
      kind: "staff",
      code: "rn",
    };
    for (const patch of [
      { patient_hours: { mean: 10 } },
      { patient_hours: { mean: 0 } },
      { patient_hours: { mean: Number.NaN } },
      { first_at: undefined },
      { first_at: "invalid" },
      { first_replication_id: undefined },
      { unit_id: "ICU" },
      { reason: "minimum_operating_team" },
      { code: "unverified_role" },
    ]) {
      expect(
        mainRecordedConstraint({
          ...evidence,
          resources: [{ ...resource, ...patch }],
        })?.label,
      ).toBe("No staffed bed available");
    }
  });
  it("does not add nurse/equipment exposures or imply a combined constraint with conflicting evidence", () => {
    const resource = {
      unit_id: "WARD-A",
      reason: "nursing_capacity",
      patient_hours: { mean: 40 },
      first_at: "2026-10-18T09:00:00Z",
      first_replication_id: "named-resource-run",
    };
    const nursing = { ...resource, kind: "staff", code: "rn" };
    const equipment = { ...resource, kind: "equipment", code: "WARD_OXYGEN" };
    const main = mainRecordedConstraint({
      ...evidence,
      resources: [nursing, equipment],
    });
    expect(main?.label).toBe(
      "Qualified nurse and oxygen support shortages limited bed capacity",
    );
    expect(main?.burden).toBe(50);
    for (const patch of [
      { patient_hours: { mean: 20 } },
      { first_at: "2026-10-19T09:00:00Z" },
      { first_replication_id: "different-run" },
    ]) {
      expect(
        mainRecordedConstraint({
          ...evidence,
          resources: [nursing, { ...equipment, ...patch }],
        })?.label,
      ).toBe("No staffed bed available");
    }
  });
  it("names fully verified medical and support team limits only for their selected unit", () => {
    const category = {
      reason: "minimum_operating_team",
      patient_hours: { mean: 40 },
    };
    const unit = { ...evidence.units[0], reason: "minimum_operating_team" };
    const resource = {
      unit_id: "WARD-A",
      reason: "minimum_operating_team",
      patient_hours: { mean: 40 },
      first_at: "2026-10-18T09:00:00Z",
      first_replication_id: "team-run",
      kind: "staff",
      code: "provider",
    };
    const e = { ...evidence, categories: [category], units: [unit] };
    expect(mainRecordedConstraint({ ...e, resources: [resource] })?.label).toBe(
      "Not enough qualified medical providers",
    );
    expect(
      mainRecordedConstraint({
        ...e,
        resources: [{ ...resource, code: "support" }],
      })?.label,
    ).toBe("Not enough support staff");
    expect(
      mainRecordedConstraint({
        ...e,
        resources: [resource, { ...resource, code: "support" }],
      })?.label,
    ).toBe("Not enough medical providers and support staff");
    expect(
      mainRecordedConstraint({
        ...e,
        resources: [{ ...resource, patient_hours: { mean: 5 } }],
      })?.label,
    ).toBe("Minimum medical or support team missing");
  });
  it("finds the most constrained department from unit records without adding overlapping reasons", () => {
    const ctx = setup();
    const e = {
      ...evidence,
      units: [
        {
          unit_id: "WARD-A",
          reason: "nursing_capacity",
          patient_hours: { mean: 40 },
        },
        {
          unit_id: "WARD-A",
          reason: "minimum_operating_team",
          patient_hours: { mean: 40 },
        },
        {
          unit_id: "ICU",
          reason: "no_matching_physical_place",
          patient_hours: { mean: 45 },
        },
      ],
    };
    expect(mostConstrainedDepartment(e, ctx.dataset!.units)?.name).toBe(
      "Intensive care",
    );
    expect(mostConstrainedDepartment({ ...e, units: [] })).toBeNull();
  });
  it("does not invent a unit from a category or missing bed attribution", () => {
    expect(mainRecordedConstraint({ ...evidence, units: [] })).toMatchObject({
      unit: null,
      firstAt: null,
      replicationId: null,
    });
  });
  it("keeps absent and invalid constraint values unavailable", () => {
    expect(
      mainRecordedConstraint({
        ...evidence,
        categories: [
          { reason: "nursing_capacity", patient_hours: null },
          { reason: "equipment", patient_hours: { mean: Number.NaN } },
        ],
      }),
    ).toBeNull();
  });
  it("rejects wrong run, dataset, revision and selected example", () => {
    for (const field of [
      "run_group_id",
      "dataset_version_id",
      "scenario_revision_id",
      "scenario_id",
    ]) {
      expect(
        evidenceMatchesRun(
          { ...evidence, context: { ...context, [field]: "wrong" } },
          setup(),
        ),
      ).toBe(false);
    }
    expect(
      evidenceMatchesRun(
        { ...evidence, scope: "selected_replication", replication_id: "other" },
        setup(),
      ),
    ).toBe(false);
    expect(
      metricsMatchRun(
        setup({
          metrics: {
            context: { ...context, run_group_id: "wrong" },
            scalar_metrics: {},
            series: [],
            daily: [],
          },
        }),
      ),
    ).toBe(false);
  });
  it("prefers ensemble evidence and clearly labels one-run fallback", () => {
    const example = {
      ...evidence,
      scope: "selected_replication",
      replication_id: "example-1",
      categories: [
        { reason: "required_equipment_unavailable", patient_hours: 100 },
      ],
    };
    expect(
      buildDecisionSummary({ ctx: setup(), ensemble: evidence, example }).main
        ?.scope,
    ).toBe("ensemble");
    const fallback = buildDecisionSummary({
      ctx: setup(),
      ensemble: { ...evidence, evidence_available: false },
      example,
    });
    expect(fallback.main).toMatchObject({
      scope: "example",
      reason: "required_equipment_unavailable",
    });
    expect(fallback.evidence.join(" ")).toContain("selected example run");
  });
});

describe("decision result and comparison matching", () => {
  it("requires the selected saved revision and entire simulation context", () => {
    expect(comparisonMatchesResult(comparison(), setup())).toBe(true);
    for (const [field, value] of [
      ["horizon_calendar_days", 30],
      ["start_at", "2026-10-17T05:00:00Z"],
      ["dataset_version_id", "wrong"],
      ["timezone", "UTC"],
      ["base_seed", 12],
      ["conditions", [{ scale: 2 }]],
      ["hospital_operations", { supplies: { stock: 10 } }],
    ] as const) {
      const c = comparison();
      c.source_scenario_snapshot[field] = value;
      expect(comparisonMatchesResult(c, setup()), field).toBe(false);
    }
    const c = comparison();
    c.source_draft_revision = 2;
    expect(comparisonMatchesResult(c, setup())).toBe(false);
  });
  it("accepts equivalent object key order without weakening input checks", () => {
    const ctx = setup();
    ctx.resultScenario!.conditions = [{ a: 1, b: 2 }];
    const c = comparison();
    c.source_scenario_snapshot.conditions = [{ b: 2, a: 1 }];
    expect(comparisonMatchesResult(c, ctx)).toBe(true);
  });
  it("blocks recommendations for a changed draft or different scenario", () => {
    const ctx = setup();
    ctx.scenario = { ...ctx.scenario!, revision: 4 };
    const model = buildDecisionSummary({
      ctx,
      ensemble: evidence,
      comparison: comparison(),
    });
    expect(model.state).toBe("stale");
    expect(model.action.kind).toBe("simulate");
    expect(model.response).toBeNull();
    expect(
      buildDecisionSummary({
        ctx: setup({ scenario: { ...frozen, id: "another" } }),
        comparison: comparison(),
      }).state,
    ).toBe("unavailable");
  });
  it("does not trust a revision number that was not recorded", () => {
    const ctx = setup();
    delete ctx.run!.source_draft_revision;
    expect(
      buildDecisionSummary({ ctx, comparison: comparison() }).action.kind,
    ).toBe("simulate");
  });
  it("preserves waiting missingness and does not turn unavailable impact into zero", () => {
    const ctx = setup();
    ctx.metrics!.scalar_metrics = {
      peak_inpatient_queue: { p50: null },
      completed_wait_median_hours: { p50: null },
    };
    expect(buildDecisionSummary({ ctx }).impact).toEqual([
      "Waiting impact measures are unavailable in these saved results.",
    ]);
  });
  it("does not use another run's metrics during a context switch", () => {
    const ctx = setup();
    ctx.metrics!.context = { ...context, run_group_id: "previous" };
    const model = buildDecisionSummary({ ctx, ensemble: evidence });
    expect(model.impact.join(" ")).not.toContain("12 patients");
    expect(model.impact.join(" ")).toContain("unavailable");
  });
  it("uses recorded average patient waiting when available", () => {
    const ctx = setup();
    ctx.metrics!.scalar_metrics.average_wait_per_patient_hours = { p50: 0 };
    expect(buildDecisionSummary({ ctx }).impact).toContain(
      "Average waiting per patient: 0 hours.",
    );
  });
  it("does not call malformed or partially missing constraint evidence shortage-free", () => {
    for (const categories of [
      undefined,
      [{ reason: "nursing_capacity", patient_hours: null }],
    ]) {
      const model = buildDecisionSummary({
        ctx: setup(),
        ensemble: { ...evidence, categories },
      });
      expect(model.problem).toContain("unavailable");
    }
  });
  it("does not call absent constraint evidence a shortage-free run", () => {
    expect(buildDecisionSummary({ ctx: setup() }).problem).toContain(
      "unavailable",
    );
    const model = buildDecisionSummary({
      ctx: setup(),
      ensemble: { ...evidence, categories: [], units: [] },
    });
    expect(model.problem).toContain("No modeled resource shortage");
  });
  it.each(["FAILED", "CANCELLED", "RUNNING", "AGGREGATING"])(
    "withholds conclusions for %s results",
    (status) => {
      const ctx = setup();
      ctx.run!.status = status;
      const model = buildDecisionSummary({
        ctx,
        ensemble: evidence,
        comparison: comparison(),
      });
      expect(model.state).toBe("unavailable");
      expect(model.main).toBeNull();
      expect(model.response).toBeNull();
    },
  );
  it("offers compare without inventing a response when none exists", () => {
    const model = buildDecisionSummary({ ctx: setup(), ensemble: evidence });
    expect(model.action).toEqual({
      kind: "compare",
      label: "Compare responses",
    });
    expect(model.response).not.toContain("Best tested");
  });
  it("labels a selected comparison response without treating it as the current baseline", () => {
    const ctx = setup();
    ctx.run!.comparison_id = "comparison-1";
    ctx.run!.comparison_plan_id = "response";
    const c = comparison();
    c.plans[1].run_group_id = "run-1";
    const model = buildDecisionSummary({ ctx, comparison: c });
    expect(model.response).toContain("Viewing tested response");
    expect(model.action).toMatchObject({ kind: "review", planId: "response" });
    expect(model.improvement).toBeNull();
    c.plans[1].run_group_id = "foreign-run";
    expect(buildDecisionSummary({ ctx, comparison: c }).action.kind).not.toBe(
      "review",
    );
  });
  it("uses tested resource counts, matched improvement and remaining limitation", () => {
    const model = buildDecisionSummary({
      ctx: setup(),
      ensemble: evidence,
      comparison: comparison(),
    });
    expect(model.response).toContain(
      "2 additional nurses, 1 additional medical provider in Ward A",
    );
    expect(model.improvement).toContain("40% less");
    expect(model.remaining).toContain("7 patients");
    expect(model.action).toEqual({
      kind: "review",
      label: "Review response",
      comparisonId: "comparison-1",
      planId: "response",
    });
  });
  it("rejects stale, failed and incomplete comparisons", () => {
    for (const status of ["FAILED", "RUNNING", "CANCELLED"]) {
      const c = comparison();
      c.status = status;
      expect(
        buildDecisionSummary({
          ctx: setup(),
          ensemble: evidence,
          comparison: c,
        }).action.kind,
      ).toBe("compare");
    }
    const c = comparison();
    c.source_scenario_snapshot.horizon_calendar_days = 30;
    expect(
      buildDecisionSummary({ ctx: setup(), comparison: c }).response,
    ).toContain("different configuration");
  });
  it("honors no-improvement despite the API secondary ranking tie-breaker", () => {
    const c = comparison();
    c.no_plan_improves = true;
    const model = buildDecisionSummary({
      ctx: setup(),
      ensemble: evidence,
      comparison: c,
    });
    expect(model.response).toContain("No tested response reduced");
    expect(model.action.kind).toBe("replay");
    expect(model.improvement).toBeNull();
  });
  it("does not equate the reference ranking first with no positive paired improvement", () => {
    // Medians: reference [0, 10, 20] = 10; response [100, 9, 19] = 19.
    // Paired reductions [-100, 1, 1] still have a positive median of 1.
    const c = comparison();
    c.plans[0].rank = 1;
    c.plans[0].metrics.scalar_metrics.inpatient_waiting_patient_hours.p50 = 10;
    c.plans[1].rank = 2;
    c.plans[1].metrics.scalar_metrics.inpatient_waiting_patient_hours.p50 = 19;
    c.plans[1].improvement.absolute_change.p50 = 1;
    c.no_plan_improves = false;
    const model = buildDecisionSummary({
      ctx: setup(),
      ensemble: evidence,
      comparison: c,
    });
    expect(model.response).toBe(
      "The current plan ranks first among the tested plans.",
    );
    expect(model.response).not.toContain("No tested response reduced");
    expect(model.evidence.join(" ")).toContain("different calculation");
    expect(model.improvement).toBeNull();
  });
  it.each([undefined, null])(
    "does not infer that no response improved when the API flag is %s",
    (flag) => {
      const c = comparison();
      c.no_plan_improves = flag;
      c.plans[0].rank = 1;
      c.plans[1].rank = 2;
      let model = buildDecisionSummary({ ctx: setup(), comparison: c });
      expect(model.response).toBe(
        "The current plan ranks first among the tested plans.",
      );
      c.plans[0].rank = 2;
      c.plans[1].rank = 1;
      c.plans[1].improvement.absolute_change.p50 = 0;
      model = buildDecisionSummary({ ctx: setup(), comparison: c });
      expect(model.response).toContain("highest-ranked response");
      expect(model.response).not.toContain("No tested response reduced");
      expect(model.action.kind).not.toBe("review");
    },
  );
  it("handles zero reference waiting and undefined percentage reductions honestly", () => {
    const c = comparison();
    c.no_plan_improves = true;
    c.plans[0].metrics.scalar_metrics.inpatient_waiting_patient_hours = {
      p50: 0,
    };
    expect(
      buildDecisionSummary({ ctx: setup(), comparison: c }).response,
    ).toContain("zero median bed waiting");
    const mixed = comparison();
    mixed.plans[1].improvement.relative_undefined_replications = 2;
    const model = buildDecisionSummary({ ctx: setup(), comparison: mixed });
    expect(model.improvement).not.toContain("%");
    expect(model.evidence.join(" ")).toContain("undefined");
  });
  it("requires actual positive paired improvement and completed feasible plans", () => {
    for (const value of [null, Number.NaN, 0, -3]) {
      const c = comparison();
      c.plans[1].improvement.absolute_change.p50 = value;
      expect(
        buildDecisionSummary({ ctx: setup(), comparison: c }).action.kind,
      ).not.toBe("review");
    }
    const c = comparison();
    c.plans[1].feasibility = undefined;
    expect(
      buildDecisionSummary({ ctx: setup(), comparison: c }).action.kind,
    ).not.toBe("review");
  });
});

describe("decision navigation contracts", () => {
  it("opens Replay in the exact run and recorded shortage time", () => {
    const ctx = setup();
    const model = buildDecisionSummary({ ctx, ensemble: evidence });
    followDecisionAction(model.replay!, ctx);
    expect(ctx.setReplication).toHaveBeenCalledWith("earliest-17");
    expect(ctx.setTime).toHaveBeenCalledWith("2026-10-17T06:00:00Z");
    expect(ctx.setPage).toHaveBeenCalledWith("replay");
  });
  it("selects only the eligible requested plan in a completed matching comparison", () => {
    expect(requestedComparisonPlan(comparison(), "response")).toBe("response");
    for (const id of [null, "missing", "current"])
      expect(requestedComparisonPlan(comparison(), id)).toBe("");
    const c = comparison();
    c.plans[1].feasibility.feasible = false;
    expect(requestedComparisonPlan(c, "response")).toBe("");
    c.plans[1].feasibility.feasible = true;
    c.status = "RUNNING";
    expect(requestedComparisonPlan(c, "response")).toBe("");
  });
  it("opens the exact comparison and tested plan for the existing save-plan flow", () => {
    const ctx = setup();
    const review = vi.fn();
    const model = buildDecisionSummary({ ctx, comparison: comparison() });
    followDecisionAction(model.action, ctx, review);
    expect(review).toHaveBeenCalledWith("comparison-1", "response");
    expect(ctx.setPage).not.toHaveBeenCalled();
  });
  it("routes no-comparison and stale results to the appropriate action", () => {
    const ctx = setup();
    followDecisionAction({ kind: "compare", label: "Compare responses" }, ctx);
    expect(ctx.setPage).toHaveBeenCalledWith("compare");
    followDecisionAction(
      { kind: "simulate", label: "Run updated simulation" },
      ctx,
    );
    expect(ctx.runScenario).toHaveBeenCalledOnce();
  });
  it("describes only new intervention changes, preserving the tested base plan", () => {
    const common = { kind: "staff_existing", nurses: 1 };
    expect(
      responseChanges(
        { interventions: [common, { nurses: 2 }] },
        { interventions: [common] },
      ),
    ).toBe("2 additional nurses");
  });
});

const severityMix = {
  low: { percentage: 60, average_stay_hours: 24 },
  medium: { percentage: 30, average_stay_hours: 72 },
  high: { percentage: 10, average_stay_hours: 168 },
};
function operationsFixture(
  version = "1.1",
  operations: Entity = { severity_mix: severityMix },
) {
  const ctx = setup();
  ctx.scenario!.hospital_operations = structuredClone(operations);
  ctx.resultScenario!.hospital_operations = structuredClone(operations);
  ctx.metrics!.hospital_operations_model_version = version;
  const c = comparison();
  c.source_scenario_snapshot.hospital_operations = structuredClone(operations);
  c.hospital_operations_model_version = version;
  for (const plan of c.plans) {
    plan.hospital_operations_model_version = version;
    plan.metrics.hospital_operations_model_version = version;
  }
  return { ctx, c };
}

describe("corrected severity model reporting", () => {
  it("retains actual earlier-model numbers, but requires a corrected independent rerun before recommending", () => {
    const { ctx, c } = operationsFixture("1.0");
    ctx.metrics!.scalar_metrics.average_wait_per_patient_hours = { p50: 99.5 };
    const model = buildDecisionSummary({
      ctx,
      ensemble: evidence,
      comparison: c,
    });
    expect(model.state).toBe("stale");
    expect(model.notice).toBe(
      "These saved results use the earlier severity model. Run again with corrected inpatient stays.",
    );
    expect(model.impact).toContain("Average waiting per patient: 99.5 hours.");
    expect(model.response).toBeNull();
    expect(model.action).toEqual({
      kind: "simulate",
      label: "Run updated simulation",
    });
    expect(model.evidence.join(" ")).toContain(
      "emergency-department assessment as well as inpatient beds",
    );
  });
  it("does not promise that rerunning inherited simulation history will upgrade its model", () => {
    for (const provenance of [
      { parent_run_group_id: "parent-run" },
      { parent_replication_id: "parent-rep" },
      { state_origin: "simulation_branch" },
    ]) {
      const { ctx, c } = operationsFixture("1.0");
      Object.assign(ctx.resultScenario!, provenance);
      const model = buildDecisionSummary({ ctx, comparison: c });
      expect(model.action).toEqual({
        kind: "configure",
        label: "Review configuration",
      });
      expect(model.notice).toContain("corrected independent simulation");
      expect(model.evidence.join(" ")).toContain("does not upgrade");
      followDecisionAction(model.action, ctx);
      expect(ctx.setPage).toHaveBeenCalledWith("overview");
      expect(ctx.runScenario).not.toHaveBeenCalled();
    }
  });
  it("does not flag supplies-only or disruptions-only version1.0 trajectories as affected severity results", () => {
    for (const operations of [
      { supplies: { initial_percent: 80 } },
      { disruptions: [{ id: "pause" }] },
    ]) {
      const { ctx, c } = operationsFixture("1.0", operations);
      const model = buildDecisionSummary({ ctx, comparison: c });
      expect(model.state).toBe("ready");
      expect(model.notice).toBeNull();
      expect(model.action.kind).toBe("review");
    }
    const { ctx, c } = operationsFixture("1.1");
    expect(buildDecisionSummary({ ctx, comparison: c }).state).toBe("ready");
  });
  it("does not misattribute another run's version marker to the selected frozen result", () => {
    const { ctx } = operationsFixture("1.0");
    ctx.metrics!.context = { ...context, run_group_id: "other" };
    const model = buildDecisionSummary({ ctx });
    expect(model.notice).toBeNull();
    expect(model.state).toBe("unavailable");
  });
});

describe("operations comparison algorithm matching", () => {
  it("accepts matching corrected1.2 results without calling them earlier severity results", () => {
    const { ctx, c } = operationsFixture("1.2");
    expect(comparisonOperationsVersionsMatch(c, ctx)).toBe(true);
    expect(comparisonMatchesResult(c, ctx)).toBe(true);
    const model = buildDecisionSummary({ ctx, comparison: c });
    expect(model.state).toBe("ready");
    expect(model.notice).toBeNull();
    expect(model.action.kind).toBe("review");
  });
  it.each([
    ["1.1", "1.2"],
    ["1.2", "1.1"],
  ])(
    "rejects a%s result compared with%s plans",
    (resultVersion, comparisonVersion) => {
      const { ctx, c } = operationsFixture(comparisonVersion);
      ctx.metrics!.hospital_operations_model_version = resultVersion;
      expect(comparisonOperationsVersionsMatch(c, ctx)).toBe(false);
      expect(buildDecisionSummary({ ctx, comparison: c }).action.kind).not.toBe(
        "review",
      );
    },
  );
  it("accepts matching frozen, projected and artifact model versions", () => {
    const { ctx, c } = operationsFixture();
    expect(comparisonOperationsVersionsMatch(c, ctx)).toBe(true);
    expect(comparisonMatchesResult(c, ctx)).toBe(true);
  });
  it("rejects cross-model or missing version evidence without a recommendation", () => {
    for (const mismatch of [
      "selected",
      "comparison",
      "artifact",
      "projected",
      "missing-selected",
      "missing-comparison",
      "missing-artifact",
      "unknown",
    ]) {
      const { ctx, c } = operationsFixture();
      if (mismatch === "selected")
        ctx.metrics!.hospital_operations_model_version = "1.0";
      if (mismatch === "comparison")
        c.hospital_operations_model_version = "1.0";
      if (mismatch === "artifact")
        c.plans[1].metrics.hospital_operations_model_version = "1.0";
      if (mismatch === "projected")
        c.plans[1].hospital_operations_model_version = "1.0";
      if (mismatch === "missing-selected")
        delete ctx.metrics!.hospital_operations_model_version;
      if (mismatch === "missing-comparison")
        delete c.hospital_operations_model_version;
      if (mismatch === "missing-artifact")
        delete c.plans[1].metrics.hospital_operations_model_version;
      if (mismatch === "unknown") {
        ctx.metrics!.hospital_operations_model_version = "9.0";
        c.hospital_operations_model_version = "9.0";
      }
      expect(comparisonOperationsVersionsMatch(c, ctx), mismatch).toBe(false);
      expect(comparisonMatchesResult(c, ctx), mismatch).toBe(false);
      expect(
        buildDecisionSummary({ ctx, comparison: c }).action.kind,
        mismatch,
      ).not.toBe("review");
    }
  });
  it("accepts unversioned legacy no-operations results only when all compared artifacts are also unversioned", () => {
    const ctx = setup();
    const c = comparison();
    expect(comparisonOperationsVersionsMatch(c, ctx)).toBe(true);
    c.plans[1].metrics.hospital_operations_model_version = "1.1";
    expect(comparisonOperationsVersionsMatch(c, ctx)).toBe(false);
  });
});

describe("emergency-assessment constraint impact", () => {
  function edFixture(scope = "ensemble") {
    const ctx = setup();
    ctx.dataset!.units.push({
      unit_id: "ED",
      kind: "ed",
      name: "Emergency department",
    });
    ctx.metrics!.scalar_metrics.peak_inpatient_queue = { p50: 0 };
    ctx.metrics!.scalar_metrics.average_wait_per_patient_hours = { p50: 12.5 };
    const e: Entity = {
      ...evidence,
      scope,
      replication_id: scope === "ensemble" ? undefined : "example-1",
      categories: [
        { reason: "nursing_capacity", patient_hours: { mean: 500 } },
      ],
      units: [
        {
          unit_id: "ED",
          unit_kind: "ed",
          reason: "nursing_capacity",
          patient_hours: { mean: 500 },
          peak_waiting: scope === "ensemble" ? { p50: 1000, mean: 1100 } : 900,
        },
      ],
    };
    return { ctx, e };
  }
  it("shows recorded ED queue impact instead of the unrelated zero admission queue", () => {
    const { ctx, e } = edFixture();
    const model = buildDecisionSummary({ ctx, ensemble: e });
    expect(model.main).toMatchObject({
      unitKind: "ed",
      peakWaiting: 1000,
      peakStatistic: "median",
    });
    expect(model.impact).toContain(
      "Typical recorded peak: 1,000 patients waiting for emergency assessment with this constraint.",
    );
    expect(model.impact.join(" ")).not.toContain(
      "0 patients waiting for admission",
    );
    expect(model.impact).toContain("Average waiting per patient: 12.5 hours.");
  });
  it("labels an exact example-run peak and does not imply an ensemble statistic", () => {
    const { ctx, e } = edFixture("selected_replication");
    const model = buildDecisionSummary({ ctx, example: e });
    expect(model.impact).toContain(
      "Selected example run: up to 900 patients waiting for emergency assessment with this constraint.",
    );
    expect(model.evidence.join(" ")).toContain("selected example run only");
  });
  it("uses a recorded mean only with an explicit average label, and leaves absent peaks unavailable", () => {
    const { ctx, e } = edFixture();
    e.units[0].peak_waiting = { p50: null, mean: 1100 };
    let model = buildDecisionSummary({ ctx, ensemble: e });
    expect(model.impact).toContain(
      "Average recorded peak: 1,100 patients waiting for emergency assessment with this constraint.",
    );
    e.units[0].peak_waiting = undefined;
    model = buildDecisionSummary({ ctx, ensemble: e });
    expect(model.impact.join(" ")).toContain("queue peak is unavailable");
    expect(model.impact.join(" ")).not.toContain("0 patients");
  });
});
