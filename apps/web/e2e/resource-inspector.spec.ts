import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("resource tables use persistent selected-time inspectors and reloadable links", async ({
  page,
}, info) => {
  const context = await scenario(page, "persistent resource inspection", {
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
  const dataset = await api(page.request, `/datasets/${context.dataset.id}`);
  await open(page, context.scenario.id, "analytics-resources", run.id);
  const cases = [
    ["Staff", "staff", dataset.staff[0].staff_id],
    [
      "Equipment",
      "equipment_pool",
      dataset.equipment_pools[0].equipment_pool_id,
    ],
    ["Transport", "vehicle", dataset.vehicles[0].vehicle_id],
  ];
  const seen = [];
  for (const [label, kind, id] of cases) {
    await page
      .locator(".resource-tabs")
      .getByRole("button", { name: new RegExp(`^${label}`) })
      .click();
    const search = page.getByLabel("Search records", { exact: true }).first();
    await search.fill(id);
    const row = page
      .locator(".resource-table-page tbody tr")
      .filter({ hasText: id })
      .first();
    await row.getByRole("button", { name: "Details", exact: true }).click();
    const inspector = page.locator("#resources-inspector-dock");
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(id);
    await expect(inspector).toContainText("selected simulation time");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("resource"))
      .toBe(id);
    expect(new URL(page.url()).searchParams.get("resource_type")).toBe(kind);
    const at = new URL(page.url()).searchParams.get("at");
    await page.getByLabel("Hide resources inspector", { exact: true }).click();
    await expect(inspector).toBeHidden();
    await expect(page.locator("#resources-timeline-dock")).toBeHidden();
    await page.getByLabel("Show resources timeline", { exact: true }).click();
    await expect(page.locator("#resources-timeline-dock")).toBeVisible();
    await page.getByLabel("Hide resources timeline", { exact: true }).click();
    await page.getByLabel("Show resources inspector", { exact: true }).click();
    await page.reload();
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(id);
    expect(new URL(page.url()).searchParams.get("at")).toBe(at);
    expect(new URL(page.url()).searchParams.get("run")).toBe(run.id);
    await expect(page.locator(".resource-tabs .active")).toContainText(label);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    seen.push({ kind, id, selected_time: at, reload_preserved: true });
  }
  await capture(page, "resource-persistent-inspector", info);
  expect((await api(page.request, `/run-groups/${run.id}`)).input_sha256).toBe(
    run.input_sha256,
  );
  record("resource-persistent-inspector", {
    project: info.project.name,
    run_id: run.id,
    selections: seen,
  });
});
