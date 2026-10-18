/** Cross-language audit: actual engine trajectories → API projections → UI model.
 * The Python oracle reconstructs metrics from patient/event intervals and supply
 * mass balance. No stored scenarios, database, browser, or live service is used.
 * Normal `make setup` installs the Python runtime required by this full-stack test.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Entity, PlanningContext } from "../types";
import {
  buildDecisionSummary,
  comparisonMatchesResult,
  followDecisionAction,
  mainRecordedConstraint,
} from "./decisionSummaryModel";
import {
  formatOutcomeStatistic,
  formatRecordedPercentage,
} from "./OutcomeSummaryCards";
import { finiteStatistic } from "./resultsMetrics";
import { meanConstraintHours } from "./bottleneckEvidence";

let samples: Record<string, Entity>;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

// Test-only dynamic builtins keep Node globals out of the browser app type scope.
const nodeBuiltin = (name: string) => import(/* @vite-ignore */ name);
beforeAll(async () => {
  const [
    { execFileSync },
    { existsSync },
    { delimiter, join },
    { fileURLToPath },
    { env, platform },
  ] = await Promise.all([
    nodeBuiltin("node:child_process"),
    nodeBuiltin("node:fs"),
    nodeBuiltin("node:path"),
    nodeBuiltin("node:url"),
    nodeBuiltin("node:process"),
  ]);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const python = join(
    root,
    ".venv",
    platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if (!existsSync(python))
    throw new Error(
      "Run make setup before the cross-language simulation audit.",
    );
  const payload = execFileSync(
    python,
    [join(root, "tests/test_simulation_metrics_audit.py")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...env,
        PYTHONPATH: [
          join(root, "packages/engine"),
          join(root, "apps/api"),
          env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(delimiter),
      },
    },
  );
  samples = JSON.parse(payload);
}, 100_000);

function context(sample: Entity): PlanningContext {
  return {
    scenario: structuredClone(sample.scenario),
    resultScenario: structuredClone(sample.scenario),
    run: structuredClone(sample.run),
    metrics: structuredClone(sample.metrics),
    dataset: {
      id: sample.run.dataset_version_id,
      units: structuredClone(sample.units),
      timezone: sample.scenario.timezone,
    },
    setPage: vi.fn(),
    setTime: vi.fn(),
    setReplication: vi.fn(),
    openReplayAt: vi.fn().mockResolvedValue(undefined),
    runScenario: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlanningContext;
}

describe("patient-facing metrics from actual varied simulations", () => {
  it.each([
    "quiet",
    "staff_blocked",
    "overlapping_disruptions",
    "equipment_icu",
    "supply_and_disruption",
  ])(
    "%s wait and success use independent patient-level event calculations",
    (name) => {
      const sample = samples[name];
      for (const key of [
        "average_wait_per_patient_hours",
        "success_score_percent",
      ]) {
        const expected = median(
          sample.independent_access.map((row: Entity) => row[key]),
        );
        expect(finiteStatistic(sample.metrics.scalar_metrics[key])).toBeCloseTo(
          expected,
          9,
        );
      }
      expect(
        formatOutcomeStatistic(
          sample.metrics.scalar_metrics.average_wait_per_patient_hours,
        ),
      ).not.toBe("—");
      expect(
        formatRecordedPercentage(
          sample.metrics.scalar_metrics.success_score_percent,
        ),
      ).toMatch(/%$/);
    },
  );
  it("counts unfinished queues while excluding recent untreated arrivals from success failures", () => {
    const sample = samples.staff_blocked;
    expect(sample.independent_access[0]).toMatchObject({
      unfinished_waiting_hours: 109,
      average_wait_per_patient_hours: 27.25,
      success_eligible_patients: 2,
      success_arrivals_with_insufficient_followup: 2,
      success_score_percent: 0,
    });
    const model = buildDecisionSummary({
      ctx: context(sample),
      ensemble: sample.evidence,
    });
    expect(model.impact).toContain("Average waiting per patient: 27.3 hours.");
    expect(
      formatRecordedPercentage(
        sample.metrics.scalar_metrics.success_score_percent,
      ),
    ).toBe("0%");
  });
  it("keeps no-arrival waiting and success unavailable even with an initial hospital census", () => {
    const sample = samples.no_arrivals_initial;
    expect(
      sample.independent_access.every(
        (row: Entity) =>
          row.arrivals === 0 &&
          row.average_wait_per_patient_hours === null &&
          row.success_score_percent === null,
      ),
    ).toBe(true);
    expect(
      formatOutcomeStatistic(
        sample.metrics.scalar_metrics.average_wait_per_patient_hours,
      ),
    ).toBe("—");
    expect(
      formatRecordedPercentage(
        sample.metrics.scalar_metrics.success_score_percent,
      ),
    ).toBe("—");
    expect(sample.metrics.scalar_metrics.initial_patients.p50).toBeGreaterThan(
      0,
    );
  });
  it("shows a real empty constraint record as no shortage, without fabricating a tested response", () => {
    const sample = samples.quiet;
    expect(sample.evidence.categories).toEqual([]);
    const model = buildDecisionSummary({
      ctx: context(sample),
      ensemble: sample.evidence,
    });
    expect(model.problem).toContain("No modeled resource shortage");
    expect(model.action).toEqual({
      kind: "compare",
      label: "Compare responses",
    });
    expect(model.response).not.toContain("Best tested");
    expect(model.replay).toBeNull();
  });
  it("uses the actual ED constraint peak rather than an unrelated zero admission queue", () => {
    const sample = samples.staff_blocked;
    const model = buildDecisionSummary({
      ctx: context(sample),
      ensemble: sample.evidence,
    });
    expect(model.main?.unitKind).toBe("ed");
    const row = sample.evidence.units.find(
      (item: Entity) =>
        item.unit_kind === "ed" && item.reason === model.main?.reason,
    );
    expect(model.main?.peakWaiting).toBe(row.peak_waiting.p50);
    expect(model.impact.join(" ")).toContain("emergency assessment");
    expect(model.impact.join(" ")).not.toContain(
      "patients waiting for admission",
    );
  });
  it.each(["supplies", "supplies_dst", "supply_and_disruption"])(
    "%s stock percentages match independently integrated care and refill mass balance",
    (name) => {
      const sample = samples[name];
      const oracle = sample.independent_supplies[0];
      expect(
        finiteStatistic(
          sample.metrics.scalar_metrics.medical_supply_average_percent,
        ),
      ).toBeCloseTo(oracle.average, 9);
      sample.metrics.daily.forEach((row: Entity, index: number) => {
        expect(finiteStatistic(row.medical_supply_average_percent)).toBeCloseTo(
          oracle.daily[index],
          9,
        );
        expect(
          finiteStatistic(row.medical_supply_average_percent),
        ).toBeGreaterThanOrEqual(0);
        expect(
          finiteStatistic(row.medical_supply_average_percent),
        ).toBeLessThanOrEqual(100);
      });
      if (name === "supplies_dst") {
        expect(oracle.hours_per_day).toEqual([24, 25, 24]);
        expect(oracle.refills[1][0]).toBe(49 * 60);
        const weighted =
          oracle.daily.reduce(
            (sum: number, value: number, index: number) =>
              sum + value * oracle.hours_per_day[index],
            0,
          ) / 73;
        expect(oracle.average).toBeCloseTo(weighted, 9);
      }
    },
  );
});

describe("actual constraint projections and exact shortage navigation", () => {
  it.each([
    "staff_blocked",
    "equipment_icu",
    "overlapping_disruptions",
    "supply_and_disruption",
  ])(
    "%s daily constraint means agree with whole-period API burden without combining overlapping categories",
    (name) => {
      const sample = samples[name];
      const means = meanConstraintHours(sample.metrics.daily);
      for (const row of means) {
        const category = sample.evidence.categories.find(
          (entry: Entity) => entry.reason === row.reason,
        );
        expect(row.patient_hours).toBeCloseTo(category.patient_hours.mean, 8);
      }
      expect(sample.evidence.non_additive).toBe(true);
      const main = mainRecordedConstraint(sample.evidence, sample.units)!;
      expect(main.burden).toBe(
        Math.max(
          ...sample.evidence.categories.map(
            (row: Entity) => row.patient_hours.mean,
          ),
        ),
      );
    },
  );
  it("names ICU equipment using recorded proof without inventing a qualified nurse shortage", () => {
    const sample = samples.equipment_icu;
    expect(
      sample.evidence.resources.some(
        (row: Entity) =>
          row.unit_id === "UNIT-ICU" &&
          row.kind === "equipment" &&
          row.code === "ICU_MONITOR",
      ),
    ).toBe(true);
    expect(
      sample.evidence.resources.some(
        (row: Entity) =>
          row.unit_id === "UNIT-ICU" &&
          row.kind === "staff" &&
          row.code === "rn",
      ),
    ).toBe(false);
    const model = buildDecisionSummary({
      ctx: context(sample),
      ensemble: sample.evidence,
    });
    expect(model.problem).not.toContain("Not enough qualified nurses");
  });
  it.each(["staff_blocked", "equipment_icu", "overlapping_disruptions"])(
    "%s opens the actual recorded source replication and first-shortage time atomically",
    (name) => {
      const sample = samples[name],
        ctx = context(sample);
      const model = buildDecisionSummary({ ctx, ensemble: sample.evidence });
      expect(model.replay).not.toBeNull();
      if (model.replay?.kind !== "replay")
        throw new Error("Expected a recorded shortage action");
      const source = sample.recorded_sources[model.replay.replicationId];
      expect(source).toBeDefined();
      const proof = [
        ...source.units,
        ...source.resources,
        ...source.categories,
      ].some(
        (row: Entity) =>
          row.reason === model.main?.reason &&
          row.first_at === model.replay!.at,
      );
      expect(proof).toBe(true);
      followDecisionAction(model.replay, ctx);
      expect(ctx.openReplayAt).toHaveBeenCalledWith(
        model.replay.replicationId,
        model.replay.at,
      );
      expect(ctx.setTime).not.toHaveBeenCalled();
    },
  );
});

describe("actual matched comparison and result-context protection", () => {
  it("recommends only the actual highest-ranked, feasible improving response and its existing plan-save destination", () => {
    const sample = samples.comparison,
      ctx = context(sample),
      comparison = sample.comparison;
    const reduction = median(sample.independent_reductions);
    expect(comparisonMatchesResult(comparison, ctx)).toBe(true);
    expect(
      comparison.plans.find((plan: Entity) => plan.id === "two-nurses")
        .improvement.absolute_change.p50,
    ).toBeCloseTo(reduction, 9);
    const model = buildDecisionSummary({
      ctx,
      ensemble: sample.evidence,
      comparison,
    });
    expect(model.action).toMatchObject({
      kind: "review",
      comparisonId: comparison.id,
      planId: "two-nurses",
    });
    expect(model.response).toContain("2 additional nurses");
    const review = vi.fn();
    followDecisionAction(model.action, ctx, review);
    expect(review).toHaveBeenCalledWith(comparison.id, "two-nurses");
  });
  it("does not use old numbers as a new-draft recommendation or change saved evidence", () => {
    const sample = samples.comparison;
    const before = JSON.stringify(sample);
    const ctx = context(sample);
    ctx.scenario!.revision = 2;
    const model = buildDecisionSummary({
      ctx,
      ensemble: sample.evidence,
      comparison: sample.comparison,
    });
    expect(model.state).toBe("stale");
    expect(model.action.kind).toBe("simulate");
    expect(model.response).toBeNull();
    expect(JSON.stringify(sample)).toBe(before);
  });
  it("withholds recommendations from a different horizon, failed or absent comparison", () => {
    const sample = samples.comparison;
    const mismatch = structuredClone(sample.comparison);
    mismatch.source_scenario_snapshot.horizon_calendar_days = 30;
    expect(
      buildDecisionSummary({ ctx: context(sample), comparison: mismatch })
        .action.kind,
    ).toBe("compare");
    const failed = { ...sample.comparison, status: "FAILED" };
    expect(
      buildDecisionSummary({ ctx: context(sample), comparison: failed }).action
        .kind,
    ).toBe("compare");
    const missing = buildDecisionSummary({
      ctx: context(sample),
      comparisonUnavailable: true,
    });
    expect(missing.response).toContain("could not be loaded");
    expect(missing.action.kind).toBe("compare");
  });
  it("never converts missing access, supply, success, or constraint evidence into reassuring zeroes", () => {
    const sample = samples.comparison,
      ctx = context(sample);
    ctx.metrics!.scalar_metrics = {};
    const model = buildDecisionSummary({ ctx });
    expect(model.problem).toContain("unavailable");
    expect(model.impact.join(" ")).toContain("unavailable");
    expect(formatOutcomeStatistic(undefined)).toBe("—");
    expect(formatRecordedPercentage(null)).toBe("—");
    expect(formatRecordedPercentage({ p50: null })).toBe("—");
    expect(model.problem).not.toContain("No modeled resource shortage");
  });
});
