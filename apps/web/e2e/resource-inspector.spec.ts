import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("hospital inventory opens focused reloadable details and optional changes without a Resources page", async ({
  page,
}, info) => {
  const context = await scenario(page, "hospital inventory details", {
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
  const at = new Date(Date.parse(run.start_at) + 3600000).toISOString();
  const recorded = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(at)}`,
  );
  const occupied = recorded.slots.find(
    (slot: any) => slot.status === "occupied" && slot.enabled,
  );
  expect(occupied).toBeTruthy();
  for (const [kind, id, type] of [
    ["staff", dataset.staff[0].staff_id, "staff_unavailable"],
    [
      "equipment_pool",
      dataset.equipment_pools[0].equipment_pool_id,
      "equipment_change",
    ],
    ["slot", occupied.slot_id, "capacity_change"],
  ]) {
    await page.goto(
      `/?scenario=${context.scenario.id}&run=${run.id}&view=analysis&analysis=summary&at=${encodeURIComponent(at)}&resource_type=${kind}&resource=${id}`,
    );
    const detail = page.getByRole("dialog");
    await expect(detail).toBeVisible();
    await detail.locator("details > summary").click();
    await expect(detail).toContainText(id);
    if (kind === "slot") {
      await expect(detail).toContainText("Occupied");
      await expect(detail).toContainText("Bed enabledYes");
      await expect(detail).not.toContainText("Ready for use");
    }
    await expect(page.locator(".resources-page")).toHaveCount(0);
    await page.reload();
    await expect(detail).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Record change", exact: true }),
    ).toBeEnabled();
    await detail
      .getByRole("button", { name: "Record change", exact: true })
      .click();
    await expect(
      detail.getByLabel("Change to record", { exact: true }),
    ).toHaveValue(type);
    await expect(detail.getByTestId("update-source-context")).toContainText(id);
    await detail
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    expect(new URL(page.url()).searchParams.get("run")).toBe(run.id);
    expect(new URL(page.url()).searchParams.get("at")).toBe(at);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await open(page, context.scenario.id, "analytics-patients", run.id);
  await expect(
    page.getByRole("tab", { name: "Resources", exact: true }),
  ).toHaveCount(0);
  await capture(page, "hospital-inventory-details", info);
  expect((await api(page.request, `/run-groups/${run.id}`)).input_sha256).toBe(
    run.input_sha256,
  );
  record("hospital-inventory-details", {
    project: info.project.name,
    run_id: run.id,
    resource_types: ["staff", "equipment_pool", "slot"],
    parent_preserved: true,
    separate_resource_page: false,
  });
});
