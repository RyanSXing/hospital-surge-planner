import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("workspace search finds the hospital and preserves exact run context in focused details", async ({
  page,
}, info) => {
  const context = await scenario(page, "hospital search", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const data = await api(page.request, `/datasets/${context.dataset.id}`);
  const at = context.scenario.start_at;
  await open(page, context.scenario.id, "summary", run.id);
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByLabel("Search workspace content").fill("UNIT-ICU");
  const unit = search
    .locator(".search-results button")
    .filter({ hasText: "UNIT-ICU" });
  await expect(unit).toHaveCount(1);
  await unit.click();
  await expect(page.locator(".patient-inspector")).toContainText("Icu");
  expect(new URL(page.url()).searchParams.get("section")).toBe("patients");
  expect(new URL(page.url()).searchParams.get("unit")).toBe("UNIT-ICU");
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  await search
    .getByLabel("Search workspace content")
    .fill(data.equipment_pools[0].equipment_pool_id);
  await search
    .locator(".search-results button")
    .filter({ hasText: data.equipment_pools[0].equipment_pool_id })
    .click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("Intensive care monitor");
  await detail.locator("details > summary").click();
  await expect(detail).toContainText(data.equipment_pools[0].equipment_pool_id);
  expect(new URL(page.url()).searchParams.get("run")).toBe(run.id);
  expect(new URL(page.url()).searchParams.get("at")).toBe(at);
  await detail
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  await search.getByLabel("Search workspace content").fill("registered nurse");
  await expect(
    search
      .locator(".search-results button")
      .filter({ hasText: "Registered nurse" })
      .first(),
  ).toBeVisible();
  await search.getByLabel("Search workspace content").fill("FAC-EAST");
  await expect(
    search.locator(".search-results button").filter({ hasText: "FAC-EAST" }),
  ).toHaveCount(0);
  await search.getByLabel("Search workspace content").fill("Resources");
  await expect(
    search.getByRole("button", { name: "Resources", exact: true }),
  ).toHaveCount(0);
  await search
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await capture(page, "hospital-search", info);
  record("hospital-search", {
    project: info.project.name,
    run_id: run.id,
    at,
    main_hospital_only: true,
    exact_run_preserved: true,
  });
});
