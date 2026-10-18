import { expect, test, type Page } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  login,
  record,
  scenario,
  waitRun,
} from "./helpers";

test.describe.configure({ mode: "serial" });
async function ensureHospitalFixture(page: Page) {
  await login(page);
  const response = await api(page.request, "/datasets?limit=200");
  if (
    !(response.items || []).some(
      (item: any) => item.fixture === "hospital_baseline",
    )
  )
    await api(page.request, "/demo-datasets", "POST", {
      fixture: "hospital_baseline",
      seed: 41021,
      days: 365,
    });
}
function median(value: any) {
  return typeof value === "number" ? value : value?.p50;
}
const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
async function openComparison(page: Page, left: any, right: any, extra = "") {
  await page.goto(
    `/?scenario=${left.id}&view=analysis&analysis=comparison&compare_left=${left.id}&compare_right=${right.id}${extra}`,
  );
  await expect(
    page.getByRole("heading", { name: "Compare saved scenarios", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Left saved scenario", { exact: true }),
  ).toHaveValue(left.id);
}
async function runSide(page: Page, position: "left" | "right", expected: any) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/run-groups" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: `Run ${position} scenario`, exact: true })
    .click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({
    scenario_id: expected.id,
    expected_scenario_revision: expected.revision,
  });
  const completed = await waitRun(page, (await response.json()).id);
  await expect(
    page.getByRole("button", {
      name: `Open ${position} scenario results`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Run ${position} scenario`, exact: true }),
  ).toBeEnabled();
  return completed;
}
async function editSaved(page: Page, saved: any, changes: any) {
  const response = await page.request.patch(`/api/scenarios/${saved.id}`, {
    headers: { "If-Match": String(saved.revision) },
    data: changes,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("two library scenarios run explicitly, compare actual saved results, preserve settings, and navigate without automated presets", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [],
    runRequests: any[] = [],
    automatedRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ensureHospitalFixture(page);
  const context = await scenario(
    page,
    "library comparison left",
    { horizon_calendar_days: 2, replications: 2, conditions: [] },
    "hospital_baseline",
  );
  const left = context.scenario;
  const right = await api(page.request, "/scenarios", "POST", {
    name: `E2E library comparison right ${Date.now()}`,
    dataset_version_id: context.dataset.id,
    start_at: left.start_at,
    timezone: left.timezone,
    horizon_calendar_days: 2,
    base_seed: left.base_seed,
    replications: 2,
    conditions: [
      {
        id: "higher-demand",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        shape: "step",
        multiplier: 1.4,
        surge_percent: 40,
      },
    ],
  });
  const beforeLeft = await api(page.request, `/scenarios/${left.id}`),
    beforeRight = await api(page.request, `/scenarios/${right.id}`);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/run-groups" && request.method() === "POST")
      runRequests.push(request.postDataJSON());
    if (/^\/api\/comparisons(?:\/|$)/.test(path)) automatedRequests.push(path);
  });
  await openComparison(page, left, right);
  await expect(
    page.getByLabel("Right saved scenario", { exact: true }),
  ).toHaveValue(right.id);
  await expect(page.getByTestId("comparison-left")).toContainText(
    "not been simulated",
  );
  await expect(page.getByTestId("comparison-right")).toContainText(
    "not been simulated",
  );
  await expect(
    page.getByTestId("left-average_wait_per_patient_hours"),
  ).toHaveText("—");
  await expect(page.getByTestId("right-success_score_percent")).toHaveText("—");
  expect(runRequests).toEqual([]);
  await expect(
    page.locator(
      ".response-selector,.comparison-preflight,.comparison-selected-action",
    ),
  ).toHaveCount(0);
  const leftRun = await runSide(page, "left", left),
    rightRun = await runSide(page, "right", right);
  expect(runRequests).toHaveLength(2);
  const leftMetrics = await api(
      page.request,
      `/run-groups/${leftRun.id}/metrics`,
    ),
    rightMetrics = await api(
      page.request,
      `/run-groups/${rightRun.id}/metrics`,
    );
  for (const [position, metrics] of [
    ["left", leftMetrics],
    ["right", rightMetrics],
  ] as const) {
    await expect(
      page.getByTestId(`${position}-average_wait_per_patient_hours`),
    ).toHaveText(
      `${number(median(metrics.scalar_metrics.average_wait_per_patient_hours))} h`,
    );
    await expect(
      page.getByTestId(`${position}-success_score_percent`),
    ).toHaveText(
      `${number(median(metrics.scalar_metrics.success_score_percent))}%`,
    );
    await expect(
      page.getByTestId(`${position}-medical_supply_average_percent`),
    ).toHaveText("—");
  }
  const difference =
    median(rightMetrics.scalar_metrics.average_wait_per_patient_hours) -
    median(leftMetrics.scalar_metrics.average_wait_per_patient_hours);
  const expectedDifference = `${difference > 0 ? "+" : difference < 0 ? "−" : ""}${number(Math.abs(difference))} h`;
  const waitRow = page
    .locator(".scenario-comparison-outcomes tbody tr")
    .filter({ hasText: "Average wait per patient" });
  await expect(waitRow.locator("td").nth(2)).toHaveText(expectedDifference);
  await expect(
    page.locator(".scenario-comparison-chart svg[role=img]"),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole("navigation", { name: "Comparison charts" })
      .getByRole("button"),
  ).toHaveCount(6);
  await page
    .getByRole("button", { name: "Medical supplies", exact: true })
    .click();
  await expect(page.locator(".scenario-comparison-chart-empty")).toContainText(
    "not recorded",
  );
  await page
    .getByRole("button", { name: "Daily arrivals", exact: true })
    .click();
  await expect(
    page.locator(".scenario-comparison-chart svg[role=img]"),
  ).toHaveCount(1);
  await expect(
    page.locator(".scenario-comparison-chart svg > text").first(),
  ).toContainText(
    new Intl.DateTimeFormat("en-US", {
      timeZone: left.timezone,
      month: "short",
      day: "numeric",
    }).format(new Date(left.start_at)),
  );
  const configuration = page
    .locator("details.scenario-comparison-details")
    .filter({
      has: page.getByText("Configuration differences", { exact: true }),
    });
  await expect(configuration).not.toHaveAttribute("open");
  await configuration.locator("summary").click();
  await expect(configuration).toContainText(
    "Arrival, bed and staffing settings",
  );
  await capture(page, "saved-scenario-comparison", info);
  const globalScenario = new URL(page.url()).searchParams.get("scenario"),
    globalRun = new URL(page.url()).searchParams.get("run");
  await page
    .getByRole("button", { name: "Swap scenarios", exact: true })
    .click();
  await expect(
    page.getByLabel("Left saved scenario", { exact: true }),
  ).toHaveValue(right.id);
  expect(new URL(page.url()).searchParams.get("scenario")).toBe(globalScenario);
  expect(new URL(page.url()).searchParams.get("run")).toBe(globalRun);
  await page.goBack();
  await expect(
    page.getByLabel("Left saved scenario", { exact: true }),
  ).toHaveValue(left.id);
  await expect(
    page.getByLabel("Right saved scenario", { exact: true }),
  ).toHaveValue(right.id);
  await page
    .getByRole("navigation", { name: "Analysis navigation" })
    .getByRole("button", { name: "Replay", exact: true })
    .click();
  const hiddenPair = {
    left: new URL(page.url()).searchParams.get("compare_left"),
    right: new URL(page.url()).searchParams.get("compare_right"),
  };
  const hiddenFetch = await page
    .waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/scenario-comparisons",
      { timeout: 2500 },
    )
    .then(
      () => true,
      () => false,
    );
  expect(hiddenFetch).toBe(false);
  expect(new URL(page.url()).searchParams.get("compare_left")).toBe(
    hiddenPair.left,
  );
  expect(new URL(page.url()).searchParams.get("compare_right")).toBe(
    hiddenPair.right,
  );
  await page
    .getByRole("navigation", { name: "Analysis navigation" })
    .getByRole("button", { name: "Comparison", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Compare saved scenarios", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open right scenario results",
      exact: true,
    }),
  ).toBeVisible();
  expect(runRequests).toHaveLength(2);
  expect(automatedRequests).toEqual([]);
  const afterLeft = await api(page.request, `/scenarios/${left.id}`),
    afterRight = await api(page.request, `/scenarios/${right.id}`);
  for (const key of [
    "revision",
    "conditions",
    "interventions",
    "hospital_operations",
    "base_seed",
    "replications",
    "horizon_calendar_days",
  ]) {
    expect(afterLeft[key]).toEqual(beforeLeft[key]);
    expect(afterRight[key]).toEqual(beforeRight[key]);
  }
  await page
    .getByRole("button", { name: "Open right scenario results", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Results summary", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(rightRun.id);
  expect(new URL(page.url()).searchParams.get("scenario")).toBe(right.id);
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  record(`saved-library-comparison-${info.project.name}`, {
    left_scenario_id: left.id,
    right_scenario_id: right.id,
    left_run_id: leftRun.id,
    right_run_id: rightRun.id,
    explicit_simulations_only: runRequests.length,
    automated_comparison_requests: automatedRequests,
    saved_settings_preserved: true,
    correct_descriptive_difference: difference,
    hidden_query_paused: true,
    original_result_opened: rightRun.id,
    page_errors: errors,
  });
});

test("a changed saved revision is never silently run, and different horizons never receive a ranking or overlay", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await ensureHospitalFixture(page);
  const context = await scenario(
    page,
    "revision-safe comparison left",
    { horizon_calendar_days: 1, replications: 1 },
    "hospital_baseline",
  );
  const left = context.scenario;
  let right = await api(page.request, "/scenarios", "POST", {
    name: `E2E revision-safe right ${Date.now()}`,
    dataset_version_id: context.dataset.id,
    start_at: left.start_at,
    timezone: left.timezone,
    horizon_calendar_days: 1,
    base_seed: left.base_seed,
    replications: 1,
    conditions: [],
  });
  await waitRun(
    page,
    (await api(page.request, "/run-groups", "POST", { scenario_id: left.id }))
      .id,
  );
  const originalRight = await waitRun(
    page,
    (await api(page.request, "/run-groups", "POST", { scenario_id: right.id }))
      .id,
  );
  await openComparison(page, left, right);
  await expect(
    page.getByRole("button", {
      name: "Open right scenario results",
      exact: true,
    }),
  ).toBeVisible();
  right = await editSaved(page, right, {
    name: `${right.name} changed elsewhere`,
  });
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/run-groups" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Run right scenario", exact: true })
    .click();
  const conflict = await rejected;
  expect(conflict.status()).toBe(409);
  expect(conflict.request().postDataJSON().expected_scenario_revision).toBe(
    right.revision - 1,
  );
  await expect(page.getByTestId("comparison-right")).toContainText(
    "Run this saved configuration",
  );
  await expect(
    page.getByTestId("right-average_wait_per_patient_hours"),
  ).toHaveText("—");
  expect(
    (await api(page.request, `/scenarios/${right.id}`)).latest_run,
  ).toBeUndefined();
  const listing = await api(page.request, "/scenarios?limit=200");
  expect(
    listing.items.find((entry: any) => entry.id === right.id).latest_run.id,
  ).toBe(originalRight.id);
  const updated = await runSide(page, "right", right);
  expect(updated.source_draft_revision).toBe(right.revision);
  right = await editSaved(page, right, { horizon_calendar_days: 2 });
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await expect(page.getByTestId("right-success_score_percent")).toHaveText("—");
  const longer = await runSide(page, "right", right);
  expect(longer.scenario_context.horizon_calendar_days).toBe(2);
  await expect(
    page.getByRole("region", { name: "Comparison limitations" }),
  ).toContainText("different simulation lengths");
  await expect(
    page.locator(".scenario-comparison-chart svg[role=img]"),
  ).toHaveCount(0);
  await expect(page.locator(".scenario-comparison-chart-empty")).toContainText(
    "matching planning periods",
  );
  await expect(
    page
      .locator(".scenario-comparison-outcomes tbody tr")
      .first()
      .locator("td")
      .nth(2),
  ).toHaveText("—");
  await expect(
    page.getByTestId("right-average_wait_per_patient_hours"),
  ).not.toHaveText("—");
  await capture(page, "saved-comparison-incompatible-periods", info);
  await assertPageHealthy(page);
  record(`saved-comparison-revision-guard-${info.project.name}`, {
    left_scenario_id: left.id,
    right_scenario_id: right.id,
    rejected_obsolete_revision_status: 409,
    previous_right_run_preserved: originalRight.id,
    current_right_run: longer.id,
    current_revision: right.revision,
    independent_results_preserved: true,
    invalid_delta_and_overlay_suppressed: true,
  });
});

test("duplicate or historical comparison links fall back to two distinct library scenarios without legacy preset requests", async ({
  page,
}) => {
  await ensureHospitalFixture(page);
  const context = await scenario(
    page,
    "comparison old link",
    { horizon_calendar_days: 1, replications: 1 },
    "hospital_baseline",
  );
  const preservedRun = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    if (/^\/api\/comparisons(?:\/|$)/.test(new URL(request.url()).pathname))
      legacyRequests.push(request.url());
  });
  await openComparison(
    page,
    context.scenario,
    context.scenario,
    `&run=${preservedRun.id}&comparison=historical-unselected&plan=unused-plan`,
  );
  await expect(
    page.getByText(
      "Choose two different saved scenarios. Another available scenario has been selected.",
      { exact: true },
    ),
  ).toBeVisible();
  const left = await page
      .getByLabel("Left saved scenario", { exact: true })
      .inputValue(),
    right = await page
      .getByLabel("Right saved scenario", { exact: true })
      .inputValue();
  expect(left).toBe(context.scenario.id);
  expect(right).not.toBe(left);
  expect(right.length).toBeGreaterThan(0);
  expect(new URL(page.url()).searchParams.get("comparison")).toBeNull();
  expect(new URL(page.url()).searchParams.get("plan")).toBeNull();
  expect(new URL(page.url()).searchParams.get("scenario")).toBe(
    context.scenario.id,
  );
  expect(new URL(page.url()).searchParams.get("run")).toBe(preservedRun.id);
  expect(legacyRequests).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Evaluate responses", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Export results", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Include the completed response comparison",
      exact: true,
    }),
  ).toHaveCount(0);
  await assertPageHealthy(page);
});
