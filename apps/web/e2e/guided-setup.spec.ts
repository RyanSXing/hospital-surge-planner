import { expect, test } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";
import { expandScenarioSection, scenarioSectionNames } from "./scenario-ui";

test("compact setup retains advanced drafts and starts the exact saved simulation", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (info.project.name === "desktop")
    await page.setViewportSize({ width: 1280, height: 800 });
  const context = await scenario(page, "guided setup", {
    horizon_calendar_days: 3,
    replications: 2,
  });
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario");
  for (const title of ["Time period", "Expected arrivals", "Review & run"])
    await expect(editor.getByRole("heading", { name: title })).toBeVisible();
  const runButton = editor.getByRole("button", {
    name: "Run simulation",
    exact: true,
  });
  await expect(runButton).toHaveCount(1);
  await expect(
    editor.getByLabel("Simulation runs", { exact: true }),
  ).toHaveValue("2");
  for (const title of Object.values(scenarioSectionNames))
    await expect(
      editor.getByRole("button", { name: new RegExp(`^${title}`) }),
    ).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Starts on day", { exact: true })).toHaveCount(
    0,
  );
  const baseline = page.locator(".planning-baseline");
  const baselineText = await baseline
    .locator(".planning-baseline-metrics")
    .innerText();
  const baselineBounds = await baseline.boundingBox();
  if (info.project.name === "desktop")
    expect(baselineBounds!.height).toBeLessThanOrEqual(300);
  await capture(page, "guided-setup-start", info);

  // Basic fields are sufficient to create a scenario. Exact edits remain available.
  const name = `Guided editable scenario ${Date.now()}`;
  await editor.getByLabel("Scenario name", { exact: true }).fill(name);
  await editor.getByLabel("Increase in ED arrivals").fill("35");
  const demand = await expandScenarioSection(page, "demand");
  await page.getByLabel("Starts on day", { exact: true }).fill("2");
  await page
    .getByLabel("Care mix", { exact: true })
    .selectOption("percentages");
  await page
    .getByLabel("Discharge after assessment (%)", { exact: true })
    .fill("60");
  await page.getByLabel("Ward admission (%)", { exact: true }).fill("30");
  await page.getByLabel("ICU admission (%)", { exact: true }).fill("10");
  await demand.click();
  await expect(page.getByLabel("Starts on day", { exact: true })).toHaveCount(
    0,
  );
  await expandScenarioSection(page, "demand");
  await expect(page.getByLabel("Starts on day", { exact: true })).toHaveValue(
    "2",
  );
  await expect(
    page.getByLabel("Ward admission (%)", { exact: true }),
  ).toHaveValue("30");

  // A quick staffing preset opens its exact form once. Collapsing its section
  // must not replay a stale form request when the controls mount again.
  await editor.getByLabel("Scenario preset").selectOption("staff_loss");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const resources = await expandScenarioSection(page, "resources");
  await resources.click();
  await expandScenarioSection(page, "resources");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await editor.getByLabel("Scenario preset").selectOption("sustained");
  await editor.getByLabel("Increase in ED arrivals").fill("35");
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    editor.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(saved.name).toBe(name);
  expect(saved.replications).toBe(2);
  const arrival = saved.conditions.find(
    (item: any) => item.kind === "arrival_multiplier",
  );
  expect(arrival.care_mix_override).toEqual({
    discharge: 0.6,
    ward: 0.3,
    icu: 0.1,
  });
  expect(arrival.control_points.map((point: any) => point.multiplier)).toEqual([
    1.35, 1.35,
  ]);
  expect(Date.parse(arrival.control_points[0].at)).toBe(
    Date.parse("2026-10-17T05:00:00Z"),
  );
  expect(await baseline.locator(".planning-baseline-metrics").innerText()).toBe(
    baselineText,
  );
  await assertPageHealthy(page);
  const submission = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  await runButton.click();
  const response = await submission;
  expect(response.ok()).toBeTruthy();
  const run = await waitRun(page, (await response.json()).id);
  expect(run.total).toBe(2);
  expect(run.completed).toBe(2);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("analysis"))
    .toBe("summary");
  expect(run.scenario_context.conditions).toEqual(saved.conditions);
  expect(errors).toEqual([]);
  record(`guided-setup-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    replications: run.completed,
    baseline_height: baselineBounds!.height,
    advanced_draft_preserved: true,
    resource_request_consumed_once: true,
    exact_saved_conditions_frozen: true,
    page_errors: errors,
  });
});
