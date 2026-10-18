import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
test("stress census exposes initial boarding and actual patient blockers", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Detailed stress-context workflow runs once.",
  );
  const context = await scenario(
    page,
    "stress context",
    { horizon_calendar_days: 1, replications: 1 },
    "stress_snapshot",
  );
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "summary", run.id);
  const metrics = await api(
    page.request,
    `/run-groups/${run.id}/metrics?grain=day`,
  );
  const format = (value: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
  for (const [key, label, percent] of [
    ["average_wait_per_patient_hours", "Average wait per patient", false],
    ["success_score_percent", "Success score", true],
  ] as const) {
    const statistic = metrics.scalar_metrics[key];
    const median = typeof statistic === "number" ? statistic : statistic?.p50;
    expect(Number.isFinite(median), key).toBe(true);
    await expect(
      page.locator(".summary-metrics article").filter({ hasText: label }),
    ).toContainText(`${format(median)}${percent ? "%" : ""}`);
  }
  await expect(
    page
      .locator(".summary-metrics article")
      .filter({ hasText: "Average medical supplies" })
      .locator("strong"),
  ).toHaveText("—");
  await expect(
    page
      .locator(".summary-metrics article")
      .filter({ hasText: "Most constrained department" }),
  ).toBeVisible();
  await expect(page.locator(".summary-metrics")).not.toContainText(
    "Ward occupancy",
  );
  await capture(page, "stress-summary", info);
  await page
    .getByRole("navigation", { name: "Analysis navigation" })
    .getByRole("button", { name: "Analytics", exact: true })
    .click();
  await page
    .getByRole("tab", { name: "Patients & units", exact: true })
    .click();
  await page.getByLabel("Patient state filter").selectOption("waiting");
  await expect(page.locator(".table-footer")).toContainText("14 patients");
  await page.locator(".patient-table tbody .link-button").first().click();
  await expect(page.locator(".patient-inspector")).toContainText(
    "Awaiting suitable inpatient capacity",
  );
  await expect(page.locator(".patient-inspector")).toContainText(
    "Why this patient is waiting",
  );
  await capture(page, "stress-patient-blockers", info);
  record("stress-context", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    initial_ward_occupied: 80,
    initial_icu_occupied: 12,
    initial_boarders: 14,
  });
});
