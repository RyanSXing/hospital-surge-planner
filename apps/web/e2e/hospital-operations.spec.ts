import { expect, test, type Page } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

const severityNames = ["Low", "Medium", "High"];
const valueNumber = (text: string) => Number(text.replace(/[^0-9.-]/g, ""));
const median = (value: any) => (typeof value === "number" ? value : value?.p50);
function dominantRecordedSource(evidence: any) {
  const burden = (row: any) =>
    typeof row.patient_hours === "number"
      ? row.patient_hours
      : row.patient_hours?.mean;
  const dominant = [...evidence.categories]
    .filter((row) => burden(row) > 0)
    .sort(
      (a, b) => burden(b) - burden(a) || a.reason.localeCompare(b.reason),
    )[0];
  const attributed = [...(evidence.units || []), ...(evidence.resources || [])]
    .filter(
      (row: any) =>
        row.reason === dominant.reason && row.unit_id && burden(row) > 0,
    )
    .sort((a, b) => burden(b) - burden(a))[0];
  return {
    at: attributed?.first_at || dominant.first_at,
    replicationId:
      attributed?.first_replication_id ||
      dominant.first_replication_id ||
      evidence.replication_id,
  };
}
async function saveDraft(page: Page, id: string) {
  const response = page.waitForResponse(
    (row) =>
      row.url().endsWith(`/api/scenarios/${id}`) &&
      row.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  return saved.json();
}
async function waitComparison(page: Page, id: string) {
  let comparison: any;
  await expect
    .poll(
      async () => {
        comparison = await api(page.request, `/comparisons/${id}`);
        return comparison.status;
      },
      { timeout: 150000, intervals: [500, 1000, 2000] },
    )
    .toBe("SUCCEEDED");
  return comparison;
}

test("severity pie, disruptions, and supplies survive save/reload and change actual care", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Desktop workflow requested.");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(
    page,
    "patient severity and hospital operations",
    { horizon_calendar_days: 3, replications: 2 },
  );
  await open(page, context.scenario.id, "overview");
  const operations = page.locator(".hospital-operations");
  await expect(
    operations.getByRole("switch", { name: "Apply severity mix" }),
  ).not.toBeChecked();
  await expect(
    operations.getByRole("switch", { name: "Track supplies" }),
  ).not.toBeChecked();

  // An unrelated save leaves both optional models absent in a legacy scenario.
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill(`${context.scenario.name} saved`);
  const legacy = await saveDraft(page, context.scenario.id);
  expect(legacy.hospital_operations ?? null).toBeNull();

  await operations.getByText("Apply severity mix", { exact: true }).click();
  await expect(
    operations.getByRole("switch", { name: "Apply severity mix" }),
  ).toBeChecked();
  await operations
    .getByLabel("Low severity percentage", { exact: true })
    .fill("50");
  await operations
    .getByLabel("High severity percentage", { exact: true })
    .fill("20");
  for (const [severity, hours] of [
    ["Low", 12],
    ["Medium", 36],
    ["High", 72],
  ] as const) {
    await operations
      .getByLabel(`${severity} severity average stay hours`, { exact: true })
      .fill(String(hours));
    await operations
      .getByLabel(`${severity} severity average stay hours`, { exact: true })
      .blur();
  }
  const boundary = operations.getByRole("slider", {
    name: "Low and medium severity boundary",
    exact: true,
  });
  await boundary.scrollIntoViewIfNeeded();
  const beforeKeyboard = valueNumber(
    await operations
      .getByLabel("Low severity percentage", { exact: true })
      .inputValue(),
  );
  await boundary.focus();
  await boundary.press("ArrowRight");
  await expect
    .poll(async () =>
      valueNumber(
        await operations
          .getByLabel("Low severity percentage", { exact: true })
          .inputValue(),
      ),
    )
    .toBeCloseTo(beforeKeyboard + 1, 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () =>
      valueNumber(
        await operations
          .getByLabel("Low severity percentage", { exact: true })
          .inputValue(),
      ),
    )
    .toBeCloseTo(beforeKeyboard, 2);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect
    .poll(async () =>
      valueNumber(
        await operations
          .getByLabel("Low severity percentage", { exact: true })
          .inputValue(),
      ),
    )
    .toBeCloseTo(beforeKeyboard + 1, 2);

  // Drag the real visible pie handle, then verify the saved percentages, rather than only its pixels.
  await boundary.scrollIntoViewIfNeeded();
  const handle = await boundary.boundingBox();
  const pie = await operations
    .getByRole("group", {
      name: "Editable patient severity pie chart",
      exact: true,
    })
    .boundingBox();
  expect(handle && pie).toBeTruthy();
  await page.mouse.move(
    handle!.x + handle!.width / 2,
    handle!.y + handle!.height / 2,
  );
  await page.mouse.down();
  const angle = 0.45 * Math.PI * 2 - Math.PI / 2;
  await page.mouse.move(
    pie!.x + pie!.width / 2 + Math.cos(angle) * pie!.width * 0.4,
    pie!.y + pie!.height / 2 + Math.sin(angle) * pie!.height * 0.4,
    { steps: 12 },
  );
  await page.mouse.up();
  const shares = await Promise.all(
    severityNames.map(async (severity) =>
      valueNumber(
        await operations
          .getByLabel(`${severity} severity percentage`, { exact: true })
          .inputValue(),
      ),
    ),
  );
  expect(shares[0]).toBeCloseTo(45, 0);
  expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);

  await operations.getByText("Track supplies", { exact: true }).click();
  await expect(
    operations.getByRole("switch", { name: "Track supplies" }),
  ).toBeChecked();
  for (const [label, value] of [
    ["Starting medical supply percentage", "100"],
    ["Maximum medical supply capacity", "30"],
    ["Medical supply usage per patient per day", "1"],
    ["Supply refill interval days", "1"],
    ["Supply refill percentage", "100"],
  ]) {
    await operations
      .getByRole("textbox", { name: label, exact: true })
      .fill(value);
    await operations.getByRole("textbox", { name: label, exact: true }).blur();
  }
  await operations
    .getByRole("button", { name: "Add disruption", exact: true })
    .click();
  await operations
    .getByLabel("Disruption 1 date", { exact: true })
    .fill("2026-10-17");
  await expect(operations).toContainText("Patients continue arriving");
  const saved = await saveDraft(page, context.scenario.id);
  expect(saved.hospital_operations.supplies).toEqual({
    initial_percent: 100,
    capacity: 30,
    usage_per_patient_day: 1,
    refill_every_days: 1,
    refill_percent: 100,
  });
  expect(saved.hospital_operations.disruptions[0]).toMatchObject({
    start_at: "2026-10-17T05:00:00.000Z",
    end_at: "2026-10-18T05:00:00.000Z",
  });
  expect(saved.hospital_operations.severity_mix.low.percentage).toBeCloseTo(
    45,
    0,
  );
  await page.reload();
  await expect(
    operations.getByRole("switch", { name: "Apply severity mix" }),
  ).toBeChecked();
  await expect(
    operations.getByRole("switch", { name: "Track supplies" }),
  ).toBeChecked();
  await expect(
    operations.getByLabel("Disruption 1 date", { exact: true }),
  ).toHaveValue("2026-10-17");
  for (const [severity, hours] of [
    ["Low", 12],
    ["Medium", 36],
    ["High", 72],
  ] as const)
    await expect(
      operations.getByLabel(`${severity} severity average stay hours`, {
        exact: true,
      }),
    ).toHaveValue(`${hours} h`);
  await operations.scrollIntoViewIfNeeded();
  await operations
    .getByText("How these settings affect the simulation", { exact: true })
    .click();
  await expect(operations.locator(".operations-definitions")).toContainText(
    "total inpatient and step-down care time",
  );
  await expect(operations.locator(".operations-definitions")).toContainText(
    "Waiting and interruptions add extra time",
  );
  await operations
    .getByText("How these settings affect the simulation", { exact: true })
    .click();
  await capture(page, "operations-configuration", info);

  const queuedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  const submitted = await queuedResponse;
  expect(submitted.ok(), await submitted.text()).toBeTruthy();
  const run = await waitRun(page, (await submitted.json()).id);
  expect(run.scenario_context.hospital_operations).toEqual(
    saved.hospital_operations,
  );
  const metrics = await api(
    page.request,
    `/run-groups/${run.id}/metrics?grain=day`,
  );
  expect(metrics.data).toHaveLength(3);
  for (const day of metrics.data) {
    expect(median(day.arrivals)).toBeGreaterThan(0);
    expect(median(day.medical_supply_average_percent)).toBeGreaterThanOrEqual(
      0,
    );
    expect(median(day.medical_supply_average_percent)).toBeLessThanOrEqual(100);
  }
  const disruptionEvents = await api(
    page.request,
    `/runs/${run.selected_replication_id}/events?start_at=2026-10-17T05%3A00%3A00Z&end_at=2026-10-18T05%3A00%3A00Z&limit=200`,
  );
  expect(disruptionEvents.event_type_counts.arrival).toBeGreaterThan(0);
  for (const kind of [
    "admission",
    "assessment_start",
    "assessment_end",
    "discharge",
  ])
    expect(disruptionEvents.event_type_counts[kind] || 0).toBe(0);
  const midday = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=2026-10-17T17%3A00%3A00Z`,
  );
  expect(midday.patients.some((patient: any) => patient.care_paused)).toBe(
    true,
  );
  const evidence = await api(page.request, `/run-groups/${run.id}/bottlenecks`);
  expect(evidence.scope).toBe("ensemble");
  expect(evidence.evidence_available).toBe(true);
  expect(evidence.categories.map((row: any) => row.reason)).toEqual(
    expect.arrayContaining(["medical_supplies", "treatment_disruption"]),
  );

  await open(page, context.scenario.id, "summary", run.id);
  const cards = page.locator(".summary-metrics article");
  await expect(cards).toHaveCount(4);
  await expect(cards).toContainText([
    "Average wait per patient",
    "Most constrained department",
    "Average medical supplies",
    "Success score",
  ]);
  const decision = page.getByTestId("decision-summary");
  await expect(decision).toContainText("largest recorded constraint");
  await expect(
    decision.getByRole("button", { name: "Compare responses", exact: true }),
  ).toBeVisible();
  await expect(decision).not.toContainText("Best tested response:");
  await decision.getByText("Why this conclusion?", { exact: true }).click();
  await expect(decision).toContainText(
    "Constraint evidence: completed simulations",
  );
  await decision.getByText("Why this conclusion?", { exact: true }).click();
  await capture(page, "decision-summary-operations", info);
  const expectedSource = dominantRecordedSource(evidence);
  const expectedShortageAt = expectedSource.at;
  const expectedShortageReplication = expectedSource.replicationId;
  expect(expectedShortageAt && expectedShortageReplication).toBeTruthy();
  const traceBefore = await api(
    page.request,
    `/runs/${expectedShortageReplication}/trace`,
  );
  const replayStateResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/runs/${expectedShortageReplication}/state` &&
      Date.parse(url.searchParams.get("at") || "") ===
        Date.parse(expectedShortageAt)
    );
  });
  await decision
    .getByRole("button", { name: "View bottleneck", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("analysis"))
    .toBe("replay");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("replication"))
    .toBe(expectedShortageReplication);
  const shortageTime = new URL(page.url()).searchParams.get("at");
  expect(Date.parse(shortageTime || "")).toBe(Date.parse(expectedShortageAt));
  const replayState = await replayStateResponse;
  expect(replayState.ok(), await replayState.text()).toBe(true);
  const stateAtShortage = await replayState.json();
  expect(stateAtShortage.context.replication_id).toBe(
    expectedShortageReplication,
  );
  expect(stateAtShortage.context.run_group_id).toBe(run.id);
  expect(
    (await api(page.request, `/runs/${expectedShortageReplication}/trace`))
      .ready,
  ).toBe(true);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await capture(page, "operations-exact-bottleneck-replay", info);

  await open(page, context.scenario.id, "analytics-outcomes", run.id);
  const outcomes = page.getByTestId("outcome-analytics");
  await outcomes
    .getByRole("tab", { name: "Medical supplies", exact: true })
    .click();
  await expect(outcomes.locator(".outcome-chart svg[role=img]")).toBeVisible();
  await expect(outcomes).toContainText("supplies");
  // A shortage indicator must be visible beside/on the chart, not just in a hidden table.
  await expect(
    outcomes.locator("[data-testid=constraint-markers]"),
  ).toBeVisible();
  await expect(
    outcomes.locator("[data-testid=constraint-markers]"),
  ).toContainText(/suppl|disruption/i);
  await assertPageHealthy(page);
  await capture(page, "operations-supplies-analytics", info);
  expect(errors).toEqual([]);
  record("hospital-operations", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    hospital_operations: saved.hospital_operations,
    actual_disruption_events: disruptionEvents.event_type_counts,
    supplies_daily: metrics.data.map((row: any) => ({
      at: row.at || row.start_at,
      percent: row.medical_supply_average_percent,
    })),
    replay_shortage_time: shortageTime,
    replay_shortage_replication: expectedShortageReplication,
    trace_initially_retained: traceBefore.ready,
    replay_state_context: stateAtShortage.context,
    page_errors: errors,
  });
});

test("Decision summary reviews a matched response, saves that plan, and rejects stale recommendations", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Desktop workflow requested.");
  const context = await scenario(page, "matched decision response", {
    horizon_calendar_days: 3,
    replications: 2,
    conditions: [
      {
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        shape: "step",
        surge_percent: 100,
        multiplier: 2,
      },
    ],
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const queued = await api(page.request, "/comparisons", "POST", {
    scenario_id: context.scenario.id,
    replications: 2,
    plans: [
      {
        name: "Staff more ward beds",
        interventions: [
          {
            kind: "staff_existing",
            unit_id: "UNIT-WARD-A",
            facility_id: "FAC-MAIN",
            nurses: 2,
            activation_minutes: 0,
          },
        ],
      },
    ],
  });
  const comparison = await waitComparison(page, queued.id);
  expect(comparison.no_plan_improves).toBe(false);
  const plan = comparison.plans.find((row: any) => !row.reference);
  expect(median(plan.improvement.absolute_change)).toBeGreaterThan(0);
  await page.goto(
    `/?scenario=${context.scenario.id}&view=analysis&analysis=summary&run=${run.id}&comparison=${comparison.id}`,
  );
  const decision = page.getByTestId("decision-summary");
  await expect(decision).toContainText("Best tested response:");
  await expect(decision).toContainText("2 additional nurses");
  await capture(page, "decision-summary-matched-response", info);
  await decision
    .getByRole("button", { name: "Review response", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("analysis"))
    .toBe("comparison");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("comparison"))
    .toBe(comparison.id);
  const selected = page.locator(".comparison-selected-action");
  await expect(selected).toContainText("Staff more ward beds");
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/comparisons/${comparison.id}/save-plan`) &&
      response.request().method() === "POST",
  );
  await selected
    .getByRole("button", { name: "Save selected plan", exact: true })
    .click();
  const savedResponse = await saveResponse;
  expect(savedResponse.ok(), await savedResponse.text()).toBeTruthy();
  const saved = await savedResponse.json();
  expect(savedResponse.request().postDataJSON().plan_id).toBe(plan.id);
  expect(saved.parent_scenario_id).toBe(context.scenario.id);
  expect(saved.interventions).toEqual(plan.interventions);

  const latest = await api(page.request, `/scenarios/${context.scenario.id}`);
  const revised = await page.request.patch(
    `/api/scenarios/${context.scenario.id}`,
    {
      headers: { "If-Match": String(latest.revision) },
      data: {
        hospital_operations: {
          supplies: {
            initial_percent: 50,
            capacity: 10000,
            usage_per_patient_day: 1,
            refill_every_days: 7,
            refill_percent: 100,
          },
        },
      },
    },
  );
  expect(revised.ok(), await revised.text()).toBeTruthy();
  await page.goto(
    `/?scenario=${context.scenario.id}&view=analysis&analysis=summary&run=${run.id}&comparison=${comparison.id}`,
  );
  await expect(decision).toHaveClass(/decision-summary--stale/);
  await expect(decision).not.toContainText("Best tested response:");
  await expect(
    decision.getByRole("button", { name: "Review response", exact: true }),
  ).toHaveCount(0);
  await expect(decision).toContainText("Run the current configuration");
  await capture(page, "decision-summary-stale-protection", info);
  record("decision-summary-navigation", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    comparison_id: comparison.id,
    selected_plan_id: plan.id,
    saved_scenario_id: saved.id,
    matched_response_reviewed: true,
    existing_save_plan_used: true,
    stale_recommendation_hidden: true,
    stale_configuration_field: "hospital_operations.supplies.initial_percent",
  });
});

test("View bottleneck reconstructs a real unretained source and opens its exact recorded state", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Desktop workflow requested.");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "unretained bottleneck replay", {
    base_seed: 1,
    horizon_calendar_days: 2,
    replications: 3,
    conditions: [
      {
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        multiplier: 2,
        start_at: "2026-10-16T05:00:00Z",
        end_at: "2026-10-18T05:00:00Z",
      },
    ],
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const evidence = await api(page.request, `/run-groups/${run.id}/bottlenecks`);
  const source = dominantRecordedSource(evidence);
  expect(run.selected_replication_id).toMatch(/_rep_0000$/);
  expect(source.replicationId).toMatch(/_rep_0001$/);
  expect(Date.parse(source.at)).toBe(Date.parse("2026-10-16T17:21:19.718833Z"));
  const before = await api(page.request, `/runs/${source.replicationId}/trace`);
  expect(before.ready).toBe(false);
  await open(page, context.scenario.id, "summary", run.id);
  const decision = page.getByTestId("decision-summary");
  await expect(decision).toContainText("largest recorded constraint");
  const requestedTrace = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/runs/${source.replicationId}/trace` &&
      response.request().method() === "POST",
  );
  const stateResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/runs/${source.replicationId}/state` &&
      Date.parse(url.searchParams.get("at") || "") === Date.parse(source.at)
    );
  });
  await decision
    .getByRole("button", { name: "View bottleneck", exact: true })
    .click();
  const requested = await requestedTrace;
  expect(requested.ok(), await requested.text()).toBe(true);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("analysis"))
    .toBe("replay");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("replication"))
    .toBe(source.replicationId);
  expect(Date.parse(new URL(page.url()).searchParams.get("at") || "")).toBe(
    Date.parse(source.at),
  );
  const selected = await stateResponse;
  expect(selected.ok(), await selected.text()).toBe(true);
  const state = await selected.json();
  expect(state.context.replication_id).toBe(source.replicationId);
  expect(state.context.run_group_id).toBe(run.id);
  const after = await api(page.request, `/runs/${source.replicationId}/trace`);
  expect(after.ready).toBe(true);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".replay-canvas")).toBeVisible();
  await assertPageHealthy(page);
  await capture(page, "decision-summary-unretained-source-replay", info);
  expect(errors).toEqual([]);
  record("decision-summary-unretained-replay", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    selected_replication_id: run.selected_replication_id,
    source_replication_id: source.replicationId,
    first_shortage_at: source.at,
    trace_before: before,
    trace_after: after,
    actual_state_context: state.context,
    page_errors: errors,
  });
});
