import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("saved custom replication counts stay visible and are submitted unchanged", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const context = await scenario(page, "saved custom run count", {
    horizon_calendar_days: 1,
    replications: 2,
  });
  await open(page, context.scenario.id, "overview");
  const scenarioCount = page.getByRole("combobox", {
    name: "Simulation runs",
    exact: true,
  });
  await expect(scenarioCount).toHaveValue("2");
  await expect(scenarioCount.locator("option:checked")).toHaveText(
    "2 · Saved count",
  );
  await expect(scenarioCount.locator("option")).toHaveCount(4);
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill(context.scenario.name + " retained");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/scenarios/${context.scenario.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const saved = await savedResponse;
  expect(saved.ok(), await saved.text()).toBe(true);
  expect(saved.request().postDataJSON().replications).toBe(2);
  expect(
    (await api(page.request, `/scenarios/${context.scenario.id}`)).replications,
  ).toBe(2);

  const comparison = await api(page.request, "/comparisons", "POST", {
    scenario_id: context.scenario.id,
    replications: 2,
    plans: [
      {
        name: "Existing ward staffing",
        interventions: [
          { kind: "staff_existing", start_at: context.scenario.start_at },
        ],
      },
    ],
  });
  const projected = await api(page.request, `/comparisons/${comparison.id}`);
  expect(projected.plans.every((plan: any) => plan.total === 2)).toBe(true);
  // Deterministic pending UI fixture derived from the real GET projection.
  // Status and completion are deliberately reset; requested totals stay real.
  // This tests pre-result rendering without racing the live worker's completion.
  const pendingProjection = {
    ...projected,
    status: "RUNNING",
    completed: 0,
    plans: projected.plans.map((plan: any) => ({
      ...plan,
      status: "RUNNING",
      completed: 0,
      metrics: undefined,
    })),
  };
  const comparisonCount = page.getByRole("combobox", {
    name: "Comparison simulation runs",
    exact: true,
  });
  // Only initial saved-view reads use the fixture. Computation and subsequent
  // completion, reevaluation, and reload remain actual API operations.
  const queuedRoute = `**/api/comparisons/${comparison.id}`;
  await page.route(queuedRoute, (route) =>
    route.fulfill({ json: pendingProjection }),
  );
  try {
    await page.goto(
      `/?scenario=${context.scenario.id}&view=analysis&analysis=comparison&comparison=${comparison.id}`,
    );
    await expect(
      page.getByText("Computation in progress", { exact: true }),
    ).toBeVisible();
    await expect(comparisonCount).toHaveValue("2");
    await expect(comparisonCount.locator("option:checked")).toHaveText(
      "2 runs · Saved count",
    );
    await expect(comparisonCount.locator("option")).toHaveCount(4);
  } finally {
    await page.unroute(queuedRoute);
  }
  await expect
    .poll(
      async () =>
        (await api(page.request, `/comparisons/${comparison.id}`)).status,
      { timeout: 120000 },
    )
    .toBe("SUCCEEDED");
  await expect(comparisonCount).toHaveValue("2");
  await expect(
    page.getByText("2 runs per plan", { exact: true }),
  ).toBeVisible();
  const evaluated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/comparisons") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Evaluate responses", exact: true })
    .click();
  const response = await evaluated;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON().replications).toBe(2);
  const repeated = await response.json();
  let result: any;
  await expect
    .poll(
      async () => {
        result = await api(page.request, `/comparisons/${repeated.id}`);
        return result.status;
      },
      { timeout: 120000 },
    )
    .toBe("SUCCEEDED");
  expect(
    result.plans.every(
      (plan: any) => plan.metrics.replications_completed === 2,
    ),
  ).toBe(true);
  await page.reload();
  await expect(comparisonCount).toHaveValue("2");
  await expect(comparisonCount.locator("option:checked")).toHaveText(
    "2 runs · Saved count",
  );
  record(`saved-replication-count-${info.project.name}`, {
    scenario_id: context.scenario.id,
    source_comparison_id: comparison.id,
    submitted_comparison_id: repeated.id,
    saved_and_submitted_replications: 2,
    metadata_projection_source_status: projected.status,
    pending_ui_fixture: {
      derived_from_actual_get: true,
      overridden_status: "RUNNING",
      completed_reset_to_zero: true,
      metrics_removed: true,
      actual_requested_count: 2,
    },
    count_restored_without_metrics: true,
    custom_option_visible_in_both_selectors: true,
    reload_retains_custom_count: true,
  });
});
