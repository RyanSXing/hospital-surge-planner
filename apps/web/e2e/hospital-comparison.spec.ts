import { expect, test, type Page } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  login,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

async function ensureHospitalFixture(page: Page) {
  await login(page);
  const response = await api(page.request, "/datasets?limit=200");
  if (
    !(response.items || response).some(
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

test("one hospital can run, compare internal bed responses, save a plan, and reopen it", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ensureHospitalFixture(page);
  const context = await scenario(
    page,
    "hospital-only comparison",
    {
      horizon_calendar_days: 2,
      replications: 2,
      conditions: [
        {
          kind: "arrival_multiplier",
          entry_stream_id: "ED_MAIN",
          shape: "step",
          surge_percent: 50,
          multiplier: 1.5,
        },
      ],
    },
    "hospital_baseline",
  );
  const dataset = await api(page.request, `/datasets/${context.dataset.id}`);
  expect(
    dataset.facilities.map((facility: any) => facility.facility_id),
  ).toEqual(["FAC-MAIN"]);
  expect(dataset.units).toHaveLength(5);
  expect(dataset.routes).toEqual([]);
  expect(
    dataset.slots.filter(
      (slot: any) =>
        slot.unit_id === "UNIT-WARD-C" &&
        slot.installation_status === "planned",
    ),
  ).toHaveLength(12);
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  expect(run.scenario_context.dataset_version_id).toBe(dataset.id);
  expect(run.replications_completed || run.completed).toBe(2);
  const originalMetrics = await api(
    page.request,
    `/run-groups/${run.id}/metrics?grain=day`,
  );
  expect(median(originalMetrics.series[0].ward_physical)).toBe(100);
  expect(median(originalMetrics.series[0].ward_staffed)).toBe(80);
  await open(page, context.scenario.id, "summary", run.id);
  await expect(
    page.getByRole("heading", { name: "Results summary", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".summary-chart-grid svg[role=img]")).toHaveCount(
    1,
  );
  const summaryCards = page.locator(".summary-metrics article");
  await expect(summaryCards).toHaveCount(4);
  await expect(summaryCards).toContainText([
    "New arrivals",
    "Completed discharges",
    "Placement waiting",
    "Ward utilization",
  ]);
  const format = (value: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
  const wardUtilization = originalMetrics.scalar_metrics.ward_utilization;
  const wardMedian =
    typeof wardUtilization === "number" ? wardUtilization : wardUtilization.p50;
  await expect(
    summaryCards.filter({ hasText: "Ward utilization" }),
  ).toContainText(`${format(wardMedian * 100)}%`);
  await expect(page.locator(".summary-dashboard")).not.toContainText(
    "FAC-MAIN",
  );
  await assertPageHealthy(page);

  await open(page, context.scenario.id, "comparison", run.id);
  const selector = page.locator(".response-selector");
  await expect(selector.getByRole("button")).toHaveCount(3);
  for (const text of ["clinic", "partner", "shelter"])
    await expect(selector).not.toContainText(new RegExp(text, "i"));
  const bedsOnly = selector.getByRole("button", {
    name: /^Open extra hospital beds/,
  });
  await expect(bedsOnly).toHaveAttribute("aria-pressed", "false");
  await bedsOnly.click();
  await expect(selector.getByRole("button", { pressed: true })).toHaveCount(3);
  await page
    .getByLabel("Comparison simulation runs", { exact: true })
    .selectOption("10");
  await expect(page.locator(".comparison-preflight > summary")).toHaveText(
    "More details · readiness and calculation settings",
  );
  await expect(page.locator(".comparison-outcomes")).toHaveCount(0);
  const posted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/comparisons") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Evaluate responses", exact: true })
    .click();
  const submitted = await posted;
  expect(submitted.ok(), await submitted.text()).toBeTruthy();
  const payload = submitted.request().postDataJSON();
  expect(payload.plans).toHaveLength(3);
  const sent = Object.fromEntries(
    payload.plans.map((plan: any) => [
      plan.interventions.at(-1).kind,
      plan.interventions.at(-1),
    ]),
  );
  expect(sent.staff_existing).toMatchObject({
    facility_id: "FAC-MAIN",
    unit_id: "UNIT-WARD-A",
    nurses: 2,
    activation_minutes: 0,
  });
  expect(sent.physical_overflow).toMatchObject({
    facility_id: "FAC-MAIN",
    unit_id: "UNIT-WARD-C",
    enabled_slots: 32,
    activation_minutes: 60,
  });
  expect(sent.staffed_overflow).toMatchObject({
    facility_id: "FAC-MAIN",
    unit_id: "UNIT-WARD-C",
    enabled_slots: 32,
    nurses: 4,
    providers: 1,
    support: 1,
    activation_minutes: 60,
  });
  const comparisonId = (await submitted.json()).id;
  let result: any;
  await expect
    .poll(
      async () => {
        result = await api(page.request, `/comparisons/${comparisonId}`);
        return result.status;
      },
      { timeout: 150000, intervals: [500, 1000, 2000] },
    )
    .toBe("SUCCEEDED");
  expect(result.plans).toHaveLength(4);
  for (const plan of result.plans) {
    expect(plan.status).toBe("SUCCEEDED");
    expect(plan.feasibility.feasible).toBe(true);
    expect(plan.metrics.replications_completed).toBe(10);
  }
  const resultByKind = Object.fromEntries(
    result.plans
      .filter((plan: any) => !plan.reference)
      .map((plan: any) => [plan.interventions.at(-1).kind, plan]),
  );
  expect(
    median(resultByKind.staff_existing.metrics.series.at(-1).ward_staffed),
  ).toBe(88);
  expect(
    median(resultByKind.physical_overflow.metrics.series.at(-1).ward_physical),
  ).toBe(112);
  expect(
    median(resultByKind.physical_overflow.metrics.series.at(-1).ward_staffed),
  ).toBe(80);
  expect(
    median(resultByKind.staffed_overflow.metrics.series.at(-1).ward_physical),
  ).toBe(112);
  expect(
    median(resultByKind.staffed_overflow.metrics.series.at(-1).ward_staffed),
  ).toBe(96);
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".comparison-chart svg[role=img]")).toHaveCount(1);
  await expect(page.locator(".comparison-outcomes .outcome-card")).toHaveCount(
    4,
  );
  await expect(page.locator(".compare-page")).not.toContainText(
    "Inspect resource dependencies",
  );
  await assertPageHealthy(page);
  const selectorBounds = await selector.boundingBox();
  const viewport = page.viewportSize()!;
  expect(selectorBounds!.x).toBeGreaterThanOrEqual(0);
  expect(selectorBounds!.x + selectorBounds!.width).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  const controlsFit = await selector
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.right <= innerWidth + 1 && rect.height >= 44
        );
      }),
    );
  expect(controlsFit).toBe(true);
  await capture(page, "hospital-comparison", info);

  const staffed = resultByKind.staffed_overflow;
  const card = page
    .locator(".comparison-outcomes .outcome-card")
    .filter({ hasText: "Open and staff extra beds" });
  await card
    .getByRole("button", { name: "Select response", exact: true })
    .click();
  const saveRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/comparisons/${comparisonId}/save-plan`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Save selected plan", exact: true })
    .click();
  const savedResponse = await saveRequest;
  expect(savedResponse.ok(), await savedResponse.text()).toBeTruthy();
  const saved = await savedResponse.json();
  expect(saved.parent_scenario_id).toBe(context.scenario.id);
  expect(saved.interventions.at(-1)).toMatchObject(sent.staffed_overflow);
  await open(page, saved.id, "overview");
  await expect(page.getByLabel("Scenario name", { exact: true })).toHaveValue(
    "Open and staff extra beds",
  );
  await expect(page.locator(".planning-baseline")).toHaveAttribute(
    "data-baseline-dataset",
    dataset.id,
  );
  const fetched = await api(page.request, `/scenarios/${saved.id}`);
  expect(fetched.interventions).toEqual(saved.interventions);
  await page.goto(
    `/?scenario=${context.scenario.id}&view=analysis&analysis=comparison&comparison=${comparisonId}`,
  );
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await page.locator(".comparison-metrics > summary").click();
  const planDetails = page.locator(".comparison-plan-resources").filter({
    has: page.getByRole("heading", {
      name: "Open and staff extra beds",
      exact: true,
    }),
  });
  await planDetails.locator(":scope > summary").click();
  await expect(planDetails).toContainText("Ward C");
  await expect(planDetails).not.toContainText("UNIT-WARD-C");
  await planDetails
    .getByRole("button", { name: "Open in summary", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(staffed.run_group_id);
  await expect(
    page.getByRole("heading", { name: "Results summary", exact: true }),
  ).toBeVisible();
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  record(`hospital-comparison-${info.project.name}`, {
    dataset_id: dataset.id,
    scenario_id: context.scenario.id,
    original_run_id: run.id,
    comparison_id: comparisonId,
    saved_scenario_id: saved.id,
    run_count_per_plan: 10,
    hospital_only_targets: true,
    actual_plan_capacity: {
      staff_existing: 88,
      extra_beds: 112,
      staffed_extra_beds: 96,
    },
    saved_plan_reopened: true,
    selected_run_reopened: true,
    controls_within_viewport: true,
    page_errors: errors,
  });
});

test("reevaluating a selected response requires a selection from the new results before saving", async ({
  page,
}, info) => {
  await ensureHospitalFixture(page);
  const context = await scenario(
    page,
    "comparison selection refresh",
    { horizon_calendar_days: 1, replications: 1 },
    "hospital_baseline",
  );
  const first = await api(page.request, "/comparisons", "POST", {
    scenario_id: context.scenario.id,
    replications: 1,
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
  let original: any;
  await expect
    .poll(
      async () => {
        original = await api(page.request, `/comparisons/${first.id}`);
        return original.status;
      },
      { timeout: 60000, intervals: [500, 1000] },
    )
    .toBe("SUCCEEDED");
  await page.goto(
    `/?scenario=${context.scenario.id}&view=analysis&analysis=comparison&comparison=${first.id}`,
  );
  await expect(page.getByText(/^1 runs? per plan$/)).toBeVisible();
  await page
    .locator(".comparison-outcomes")
    .getByRole("button", { name: "Select response", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save selected plan", exact: true }),
  ).toBeVisible();
  const nextResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/comparisons") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Evaluate responses", exact: true })
    .click();
  const response = await nextResponse;
  expect(response.ok(), await response.text()).toBeTruthy();
  const next = await response.json();
  expect(next.id).not.toBe(first.id);
  await expect(page.locator(".comparison-selected-action")).toHaveCount(0);
  let updated: any;
  await expect
    .poll(
      async () => {
        updated = await api(page.request, `/comparisons/${next.id}`);
        return updated.status;
      },
      { timeout: 60000, intervals: [500, 1000] },
    )
    .toBe("SUCCEEDED");
  const newPlan = updated.plans.find((plan: any) => !plan.reference);
  expect(newPlan.id).not.toBe(
    original.plans.find((plan: any) => !plan.reference).id,
  );
  await expect(page.locator(".comparison-selected-action")).toHaveCount(0);
  await page
    .locator(".comparison-outcomes")
    .getByRole("button", { name: "Select response", exact: true })
    .click();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/comparisons/${next.id}/save-plan`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Save selected plan", exact: true })
    .click();
  const saved = await savedResponse;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect(saved.request().postDataJSON().plan_id).toBe(newPlan.id);
  record(`comparison-current-selection-${info.project.name}`, {
    first_comparison_id: first.id,
    next_comparison_id: next.id,
    saved_plan_id: newPlan.id,
    stale_selection_cleared: true,
    current_plan_saved: true,
  });
});
