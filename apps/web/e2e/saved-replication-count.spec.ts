import { expandScenarioSection } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario, waitRun } from "./helpers";

test("saved custom replication counts stay visible and are submitted unchanged", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const context = await scenario(page, "saved custom run count", {
    horizon_calendar_days: 1,
    replications: 2,
  });
  await open(page, context.scenario.id, "overview");
  await expandScenarioSection(page, "calculation");
  const scenarioCount = page.getByRole("combobox", {
    name: "Simulation runs",
    exact: true,
  });
  await expect(scenarioCount).toHaveValue("2");
  await expect(scenarioCount.locator("option:checked")).toHaveText("2 runs");
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

  const savedScenario = await api(
    page.request,
    `/scenarios/${context.scenario.id}`,
  );
  const other = await api(page.request, "/scenarios", "POST", {
    name: `E2E three-run comparison ${Date.now()}`,
    dataset_version_id: savedScenario.dataset_version_id,
    start_at: savedScenario.start_at,
    timezone: savedScenario.timezone,
    horizon_calendar_days: 1,
    base_seed: savedScenario.base_seed,
    replications: 3,
    conditions: [],
  });
  await page.goto(
    `/?scenario=${savedScenario.id}&view=analysis&analysis=comparison&compare_left=${savedScenario.id}&compare_right=${other.id}`,
  );
  await expect(
    page.getByRole("heading", { name: "Compare saved scenarios", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("comparison-left")).toContainText(
    "2 planned runs",
  );
  await expect(page.getByTestId("comparison-right")).toContainText(
    "3 planned runs",
  );
  await expect(page.getByTestId("left-success_score_percent")).toHaveText("—");
  const completed: any[] = [];
  for (const [position, selected, count] of [
    ["left", savedScenario, 2],
    ["right", other, 3],
  ] as const) {
    const queued = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/run-groups") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: `Run ${position} scenario`, exact: true })
      .click();
    const submitted = await queued;
    expect(submitted.ok(), await submitted.text()).toBe(true);
    expect(submitted.request().postDataJSON()).toEqual({
      scenario_id: selected.id,
      expected_scenario_revision: selected.revision,
    });
    const result = await waitRun(page, (await submitted.json()).id);
    expect(result.replications_completed).toBe(count);
    expect(result.scenario_context.replications).toBe(count);
    completed.push(result);
    await expect(
      page.getByRole("button", {
        name: `Open ${position} scenario results`,
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(page.getByTestId("comparison-left")).toContainText(
    "2 simulation runs",
  );
  await expect(page.getByTestId("comparison-right")).toContainText(
    "3 simulation runs",
  );
  const projection = await api(
    page.request,
    `/scenario-comparisons?left_scenario_id=${savedScenario.id}&right_scenario_id=${other.id}`,
  );
  expect(projection.left.metrics.replications_completed).toBe(2);
  expect(projection.right.metrics.replications_completed).toBe(3);
  expect(projection.compatibility.comparable).toBe(true);
  expect(projection.paired_evidence).toBeNull();
  expect(
    (await api(page.request, `/scenarios/${savedScenario.id}`)).replications,
  ).toBe(2);
  expect((await api(page.request, `/scenarios/${other.id}`)).replications).toBe(
    3,
  );
  record(`saved-replication-count-${info.project.name}`, {
    scenario_id: savedScenario.id,
    compared_scenario_id: other.id,
    saved_and_submitted_counts: [2, 3],
    run_ids: completed.map((run) => run.id),
    no_simulation_parameter_overrides: true,
    counts_restored_without_metrics: true,
    reload_retains_custom_counts: true,
    comparison_basis: "independent_ensembles",
  });
});
