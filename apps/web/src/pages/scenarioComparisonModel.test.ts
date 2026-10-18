import { describe, expect, it, vi } from "vitest";
import type { Entity } from "../types";
import {
  comparisonCharts,
  comparisonMatchesPair,
  comparisonMetricValue,
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

function side(id: string, value: number | null = 2): Entity {
  return {
    state: "ready",
    can_run: true,
    scenario: {
      id,
      name: id,
      revision: 3,
      dataset_version_id: "dataset",
      archived: false,
      horizon_calendar_days: 14,
    },
    run: {
      id: `run-${id}`,
      scenario_id: id,
      source_draft_revision: 3,
      scenario_revision_id: `revision-${id}`,
      dataset_version_id: "dataset",
      status: "SUCCEEDED",
      replications_completed: 10,
    },
    metrics: {
      context: {
        run_group_id: `run-${id}`,
        scenario_id: id,
        scenario_revision_id: `revision-${id}`,
        dataset_version_id: "dataset",
      },
      scalar_metrics: {
        average_wait_per_patient_hours: { p50: value },
        medical_supply_average_percent: { p50: 40 },
        success_score_percent: { p50: 70 },
      },
      series: [
        { at: "2026-10-16T05:00:00Z", inpatient_queue: { p50: 0 } },
        { at: "2026-10-16T06:00:00Z", inpatient_queue: { p50: 2 } },
      ],
      daily: [],
    },
    latest_run: null,
  };
}
function comparison(): Entity {
  return {
    kind: "saved_scenarios",
    scope: "independent_ensembles",
    left: side("left", 2),
    right: side("right", 5),
    compatibility: { comparable: true },
    deltas: [
      {
        metric: "average_wait_per_patient_hours",
        left: 2,
        right: 5,
        difference: 3,
        percent_change: 150,
        available: true,
      },
    ],
  };
}

describe("saved scenario selection", () => {
  const library = [
    { id: "a", name: "First" },
    { id: "b", name: "Second" },
    { id: "archived", archived: true },
  ];
  it("defaults to the current scenario and another saved scenario", () => {
    expect(resolveScenarioPair(library, "b")).toEqual({
      left: "b",
      right: "a",
      warning: null,
    });
  });
  it("preserves explicit URL choices without mutating the library", () => {
    const before = JSON.stringify(library);
    expect(resolveScenarioPair(library, "b", "a", "b")).toEqual({
      left: "a",
      right: "b",
      warning: null,
    });
    expect(JSON.stringify(library)).toBe(before);
  });
  it("validates duplicate, removed and archived selections", () => {
    const duplicate = resolveScenarioPair(library, "a", "a", "a");
    expect(duplicate.left).not.toBe(duplicate.right);
    expect(duplicate.warning).toContain("different");
    expect(resolveScenarioPair(library, "a", "gone", "b").warning).toContain(
      "no longer",
    );
    expect(resolveScenarioPair(library, "a", "archived", "b").left).toBe("a");
  });
  it("handles an empty or one-scenario library honestly", () => {
    expect(resolveScenarioPair([], "a")).toMatchObject({ left: "", right: "" });
    expect(resolveScenarioPair([library[0]], "a")).toMatchObject({
      left: "a",
      right: "",
    });
  });
  it("refreshes the library without requesting results when only one saved scenario exists", async () => {
    const refreshLibrary = vi.fn(async () => []);
    const requestResults = vi.fn(async () => comparison());
    const pair = resolveScenarioPair([library[0]], "a");
    await refreshScenarioComparison(pair, refreshLibrary, requestResults);
    expect(refreshLibrary).toHaveBeenCalledTimes(1);
    expect(requestResults).not.toHaveBeenCalled();
    await refreshScenarioComparison(
      { left: "a", right: "a" },
      refreshLibrary,
      requestResults,
    );
    expect(requestResults).not.toHaveBeenCalled();
  });
  it("refreshes both the library and results after a valid second scenario is selected", async () => {
    const refreshLibrary = vi.fn(async () => library);
    const requestResults = vi.fn(async () => comparison());
    await refreshScenarioComparison(
      resolveScenarioPair(library, "a"),
      refreshLibrary,
      requestResults,
    );
    expect(refreshLibrary).toHaveBeenCalledTimes(1);
    expect(requestResults).toHaveBeenCalledTimes(1);
  });
  it("removes historical response selection without changing the selected scenario or frozen run", () => {
    const href =
      "https://hospital.test/?view=analysis&analysis=comparison&scenario=current&run=frozen&compare_left=a&compare_right=b&comparison=historical&plan=old";
    const cleaned = savedScenarioComparisonUrl(href);
    expect(cleaned.searchParams.get("scenario")).toBe("current");
    expect(cleaned.searchParams.get("run")).toBe("frozen");
    expect(cleaned.searchParams.get("compare_left")).toBe("a");
    expect(cleaned.searchParams.get("compare_right")).toBe("b");
    expect(cleaned.searchParams.has("comparison")).toBe(false);
    expect(cleaned.searchParams.has("plan")).toBe(false);
    const swapped = savedScenarioComparisonUrl(href, { left: "b", right: "a" });
    expect(swapped.searchParams.get("compare_left")).toBe("b");
    expect(swapped.searchParams.get("compare_right")).toBe("a");
    expect(swapped.searchParams.get("scenario")).toBe("current");
    expect(swapped.searchParams.get("run")).toBe("frozen");
    expect(swapped.searchParams.has("comparison")).toBe(false);
    expect(swapped.searchParams.has("plan")).toBe(false);
  });
  it("rejects cached result revisions after a newer saved library revision is known", () => {
    const current = comparison();
    const library = [
      { id: "left", revision: 3 },
      { id: "right", revision: 3 },
    ];
    expect(comparisonMatchesPair(current, "left", "right", library)).toBe(true);
    expect(
      comparisonMatchesPair(current, "left", "right", [
        { ...library[0], revision: 4 },
        library[1],
      ]),
    ).toBe(false);
    expect(comparisonMatchesPair(current, "left", "right", [library[0]])).toBe(
      false,
    );
    expect(
      comparisonMatchesPair(current, "left", "right", [
        { id: "left" },
        library[1],
      ]),
    ).toBe(false);
  });
  it("waits for library metadata to catch up when the endpoint already has a newer revision", () => {
    const current = comparison();
    current.right.scenario.revision = 4;
    expect(
      comparisonMatchesPair(current, "left", "right", [
        { id: "left", revision: 3 },
        { id: "right", revision: 3 },
      ]),
    ).toBe(false);
    expect(
      comparisonMatchesPair(current, "left", "right", [
        { id: "left", revision: 3 },
        { id: "right", revision: 4 },
      ]),
    ).toBe(true);
  });
  it("does not render a late response for a previous pair", () => {
    expect(comparisonMatchesPair(comparison(), "left", "right")).toBe(true);
    expect(comparisonMatchesPair(comparison(), "right", "left")).toBe(false);
    expect(comparisonMatchesPair(comparison(), "left", "left")).toBe(false);
    expect(
      comparisonMatchesPair(
        { ...comparison(), kind: "automated" },
        "left",
        "right",
      ),
    ).toBe(false);
  });
});

describe("saved revision result matching and explicit simulation", () => {
  it("requires a completed exact-revision result with matching immutable response context", () => {
    expect(scenarioSideReady(side("left"))).toBe(true);
    for (const key of [
      "run_group_id",
      "scenario_id",
      "scenario_revision_id",
      "dataset_version_id",
    ]) {
      const current = side("left");
      current.metrics.context[key] = "old";
      expect(scenarioSideReady(current), key).toBe(false);
    }
    const current = side("left");
    current.run.source_draft_revision = 2;
    expect(scenarioSideReady(current)).toBe(false);
  });
  it.each([
    "missing",
    "running",
    "failed",
    "cancelled",
    "stale",
    "unavailable",
    "archived",
  ])(
    "keeps %s outcomes unavailable even if old metrics were returned",
    (state) => {
      const current = { ...side("left"), state };
      expect(scenarioSideReady(current)).toBe(false);
      expect(
        comparisonMetricValue(current, "average_wait_per_patient_hours"),
      ).toBeNull();
      expect(scenarioSideStatus(current).length).toBeGreaterThan(10);
    },
  );
  it("preserves every saved parameter by submitting only the scenario ID and expected revision", () => {
    const current = side("left");
    current.scenario.hospital_operations = {
      severity_mix: { low: { percentage: 60, average_stay_hours: 24 } },
    };
    const before = JSON.stringify(current);
    expect(savedScenarioRunRequest(current)).toEqual({
      scenario_id: "left",
      expected_scenario_revision: 3,
    });
    expect(JSON.stringify(current)).toBe(before);
    current.can_run = false;
    expect(savedScenarioRunRequest(current)).toBeNull();
    current.can_run = true;
    current.scenario.archived = true;
    expect(savedScenarioRunRequest(current)).toBeNull();
  });
  it("recognizes processing states without treating completed or failed attempts as active", () => {
    for (const status of [
      "QUEUED",
      "RUNNING",
      "AGGREGATING",
      "RETRY_WAIT",
      "CANCEL_REQUESTED",
    ])
      expect(sideIsRunning({ latest_run: { status } })).toBe(true);
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"])
      expect(sideIsRunning({ latest_run: { status } })).toBe(false);
  });
});

describe("independent descriptive outcome differences", () => {
  it("uses the API's measured right-minus-left difference, without ranking or paired improvement", () => {
    expect(
      descriptiveDifference(comparison(), "average_wait_per_patient_hours"),
    ).toBe(3);
    expect(formatComparisonDifference(3, "h")).toBe("+3 h");
    expect(formatComparisonDifference(-3, "h")).toBe("−3 h");
    expect(formatComparisonDifference(10, "%")).toBe("+10 points");
    expect(formatComparisonDifference(0, "patients")).toBe("0");
  });
  it("does not infer a percent change from a zero baseline", () => {
    const current = comparison();
    current.left.metrics.scalar_metrics.average_wait_per_patient_hours.p50 = 0;
    current.deltas[0] = {
      metric: "average_wait_per_patient_hours",
      difference: 5,
      percent_change: null,
      available: true,
    };
    expect(
      descriptiveDifference(current, "average_wait_per_patient_hours"),
    ).toBe(5);
    expect(current.deltas[0].percent_change).toBeNull();
  });
  it("withholds differences for incompatible, unavailable, missing or stale projections", () => {
    for (const change of [
      "incompatible",
      "not-ready",
      "missing-delta",
      "missing-value",
      "wrong-difference",
    ]) {
      const current = comparison();
      if (change === "incompatible") current.compatibility.comparable = false;
      if (change === "not-ready") current.right.state = "stale";
      if (change === "missing-delta") current.deltas = [];
      if (change === "missing-value")
        current.right.metrics.scalar_metrics.average_wait_per_patient_hours = {
          p50: null,
        };
      if (change === "wrong-difference") current.deltas[0].difference = 100;
      expect(
        descriptiveDifference(current, "average_wait_per_patient_hours"),
        change,
      ).toBeNull();
    }
  });
  it("keeps recorded zero distinct from missing, invalid percentages and non-finite data", () => {
    expect(formatComparisonValue(0, "h")).toBe("0 h");
    expect(formatComparisonValue(0, "%")).toBe("0%");
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY])
      expect(formatComparisonValue(value, "%")).toBe("—");
    expect(formatComparisonValue(101, "%")).toBe("—");
    const current = side("left", null);
    expect(
      comparisonMetricValue(current, "average_wait_per_patient_hours"),
    ).toBeNull();
    current.metrics.scalar_metrics.success_score_percent = { p50: 101 };
    expect(comparisonMetricValue(current, "success_score_percent")).toBeNull();
  });
});

describe("overlay charts", () => {
  it("joins original observations by exact timestamps and preserves unavailable points", () => {
    const current = comparison();
    current.right.metrics.series = [
      { at: "2026-10-16T06:00:00Z", inpatient_queue: { p50: 4 } },
      { at: "2026-10-16T07:00:00Z", inpatient_queue: { p50: 8 } },
    ];
    const rows = scenarioComparisonRows(current, comparisonCharts[0]);
    expect(rows).toEqual([
      { at: "2026-10-16T05:00:00Z", left: { p50: 0 }, right: null },
      { at: "2026-10-16T06:00:00Z", left: { p50: 2 }, right: { p50: 4 } },
      { at: "2026-10-16T07:00:00Z", left: null, right: { p50: 8 } },
    ]);
  });
  it("uses daily stock percentages for the medical supplies bookmark", () => {
    const current = comparison();
    current.left.metrics.daily = [
      {
        start_at: "2026-10-16T05:00:00Z",
        medical_supply_average_percent: { p50: 45 },
      },
    ];
    current.right.metrics.daily = [
      {
        start_at: "2026-10-16T05:00:00Z",
        medical_supply_average_percent: { p50: 70 },
      },
    ];
    const chart = comparisonCharts.find(
      (row) => row.key === "medical_supply_average_percent",
    )!;
    expect(scenarioComparisonRows(current, chart)[0]).toEqual({
      at: "2026-10-16T05:00:00Z",
      left: { p50: 45 },
      right: { p50: 70 },
    });
  });
  it("does not overlay incompatible horizons or make missing stock look empty", () => {
    const current = comparison();
    current.compatibility.comparable = false;
    expect(scenarioComparisonRows(current, comparisonCharts[0])).toEqual([]);
    current.compatibility.comparable = true;
    expect(scenarioComparisonRows(current, comparisonCharts[4])).toEqual([]);
  });
  it("formats optional settings as readable text rather than object or variable displays", () => {
    expect(formatComparisonSetting(null)).toBe("Not set");
    expect(formatComparisonSetting([])).toBe("None");
    expect(formatComparisonSetting("UNIT-WARD-A")).toBe("Ward A");
    expect(formatComparisonSetting({ staffed_capacity: 40 })).toBe(
      "Staffed capacity: 40",
    );
  });
});
