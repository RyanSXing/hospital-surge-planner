import { test, expect } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

test("configure, compute, inspect, compare, update, replay and export", async ({
  page,
}, info) => {
  test.setTimeout(process.env.E2E_BASE_URL ? 900000 : 180000);
  test.skip(
    info.project.name === "mobile",
    "Full computational workflow runs on desktop; every screen is audited on mobile separately.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const context = await scenario(page, "complete workflow");
  console.log("workflow: created", context.scenario.id);
  await open(page, context.scenario.id, "scenarios");
  console.log("workflow: scenario screen loaded");
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill("E2E 70 percent surge " + Date.now());
  await page.getByLabel("Increase in ED arrivals").fill("70");
  await page.getByLabel("Planning horizon").fill("3");
  await page.getByLabel("Simulation runs").selectOption("10");
  console.log("workflow: fields configured");
  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/run-groups") && r.request().method() === "POST",
    { timeout: 30000 },
  );
  await page
    .locator(".scenarios-page .heading-actions")
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  console.log("workflow: submit clicked");
  const queued = await (await submitted).json();
  console.log("workflow: queued", queued.id);
  const run = await waitRun(page, queued.id);
  console.log("workflow: run complete");
  const frozen = await api(page.request, "/run-groups/" + run.id);
  expect(frozen.replications_completed || frozen.completed).toBe(10);
  await open(page, context.scenario.id, "patients", run.id);
  await page.locator(".patient-table tbody .link-button").first().click();
  await expect(page.locator(".patient-inspector")).toContainText(
    "SELECTED PATIENT",
  );
  await capture(page, "workflow-patient", info);
  await open(page, context.scenario.id, "compare", run.id);
  await page.getByLabel("Comparison simulation runs").selectOption("10");
  const compared = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/comparisons") && r.request().method() === "POST",
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "Evaluate responses", exact: true })
    .click();
  const comparison = await (await compared).json();
  let result: any;
  await expect
    .poll(
      async () => {
        result = await api(page.request, "/comparisons/" + comparison.id);
        return result.status;
      },
      { timeout: 150000, intervals: [1000, 2000] },
    )
    .toBe("SUCCEEDED");
  expect(result.plans.length).toBe(3);
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Comparison chart metric")
    .selectOption("ward_occupied");
  await page.getByLabel("Comparison uncertainty band").selectOption("plan_2");
  await expect(page.locator(".comparison-chart")).toContainText(
    "Ward occupancy",
  );
  await page
    .getByLabel("Comparison chart metric")
    .selectOption("inpatient_queue");
  await capture(page, "workflow-comparison", info);
  await page
    .getByText("Full outcome metrics & resource assumptions", { exact: true })
    .click();
  await expect(page.locator(".comparison-metrics")).toContainText(
    "Interfacility transfers",
  );
  await page
    .getByRole("button", { name: "Open in overview", exact: true })
    .last()
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(result.plans.at(-1).run_group_id);
  await expect(page.locator(".evaluated-plan-banner")).toContainText(
    result.plans.at(-1).name,
  );
  await page.getByRole("button", { name: "Return to comparison" }).click();
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select response", exact: true })
    .last()
    .click();
  const saved = page.waitForResponse(
    (r) => r.url().includes("/save-plan") && r.request().method() === "POST",
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "Save selected plan", exact: true })
    .click();
  expect((await saved).ok()).toBeTruthy();
  await open(page, context.scenario.id, "overview", run.id);
  await page.getByRole("button", { name: "Record update" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Additional patients")).toBeVisible();
  await dialog.getByLabel("Additional patients").fill("5");
  await dialog.getByLabel("Future repetitions").selectOption("1");
  await dialog
    .getByLabel("Source and explanation")
    .fill("Synthetic browser acceptance arrival batch.");
  const updated = page.waitForResponse(
    (r) =>
      r.url().includes("/updates/") &&
      r.url().endsWith("/apply") &&
      r.request().method() === "POST",
    { timeout: 30000 },
  );
  await dialog
    .getByRole("button", { name: "Save & reforecast", exact: true })
    .click();
  const updateResponse = await updated;
  expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
  const branch = await updateResponse.json();
  const branchRun = branch.run_group || branch.run;
  expect(branchRun?.id).toBeTruthy();
  await waitRun(page, branchRun.id);
  await open(page, context.scenario.id, "replay", run.id);
  await expect(page.getByLabel("Next recorded event")).toBeEnabled();
  await page.getByLabel("Next recorded event").click();
  await expect(page.locator(".event-feed .info-note")).toContainText("Event");
  await page.getByLabel("Return to run start").click();
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect(page.getByLabel("Pause replay")).toBeVisible();
  await page.getByLabel("Pause replay").click();
  await expect(
    page.getByRole("heading", { name: /Accessible replay census/ }),
  ).toBeVisible();
  await capture(page, "workflow-replay", info);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate export", exact: true })
    .click();
  await expect(page.getByRole("link", { name: "Download export" })).toBeVisible(
    { timeout: 45000 },
  );
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download export" }).click();
  const file = await download;
  await file.saveAs(info.outputPath("planning-export.zip"));
  expect(await file.failure()).toBeNull();
  expect(errors).toEqual([]);
  record("workflow", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    comparison_id: comparison.id,
    branch_run_id: branchRun.id,
    export_filename: file.suggestedFilename(),
    page_errors: errors,
  });
});
