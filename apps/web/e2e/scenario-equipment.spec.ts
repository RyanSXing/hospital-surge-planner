import { expandScenarioDetails } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("planned equipment quantities use prior exact inventory and reject saturation", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const context = await scenario(page, "exact equipment quantities");
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  const add = async () => {
    await page
      .getByRole("button", { name: "Add equipment availability", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Equipment pool").selectOption("EQ-RES-CLINIC-KIT");
    return dialog;
  };
  let dialog = await add();
  await dialog.getByLabel("Equipment operation").selectOption("repair");
  await expect(dialog.getByLabel("Equipment quantity")).toHaveAttribute(
    "max",
    "0",
  );
  await dialog.getByLabel("Equipment quantity").fill("1");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(dialog).toContainText(
    "Planned repair must be a whole quantity from 0 to 0",
  );
  await dialog.getByLabel("Equipment operation").selectOption("fail");
  await dialog.getByLabel("Equipment quantity").fill("13");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(dialog).toContainText(
    "Planned fail must be a whole quantity from 0 to 12",
  );
  await dialog.getByLabel("Assumption name").fill("Four planned failures");
  await dialog.getByLabel("Equipment quantity").fill("4");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  dialog = await add();
  await dialog.getByLabel("Equipment operation").selectOption("repair");
  await expect(dialog.getByLabel("Equipment quantity")).toHaveAttribute(
    "max",
    "4",
  );
  await expect(dialog).toContainText(
    "12 total, 8 serviceable, 4 unserviceable",
  );
  await dialog.getByLabel("Equipment quantity").fill("5");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(dialog).toContainText(
    "Planned repair must be a whole quantity from 0 to 4",
  );
  await dialog.getByLabel("Assumption name").fill("Three planned repairs");
  await dialog.getByLabel("Equipment quantity").fill("3");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  dialog = await add();
  await dialog.getByLabel("Equipment operation").selectOption("decommission");
  await dialog.getByLabel("Equipment quantity").fill("13");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(dialog).toContainText(
    "Planned decommission must be a whole quantity from 0 to 12",
  );
  await dialog.getByLabel("Equipment operation").selectOption("add");
  await expect(dialog.getByLabel("Equipment quantity")).not.toHaveAttribute(
    "max",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(
    saved.updates.map((u: any) => [u.payload.operation, u.payload.quantity]),
  ).toEqual([
    ["fail", 4],
    ["repair", 3],
  ]);
  record("scenario-equipment-exact", {
    scenario_id: context.scenario.id,
    over_failure_rejected: true,
    over_repair_rejected: true,
    over_retirement_rejected: true,
    same_time_prior_failure_enables_exact_repair: true,
  });
});

test("inherited observed equipment failures bound future planned repairs and failures", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const context = await scenario(page, "inherited equipment report");
  const report = await api(page.request, "/updates", "POST", {
    scenario_id: context.scenario.id,
    type: "equipment_change",
    effective_at: context.scenario.start_at,
    state_origin: "simulation_branch",
    source: "Browser regression known equipment failure",
    payload: {
      equipment_pool_id: "EQ-RES-CLINIC-KIT",
      operation: "fail",
      quantity: 100,
    },
  });
  const branch = await api(
    page.request,
    `/updates/${report.id}/apply`,
    "POST",
    { run: false },
  );
  await open(page, branch.scenario.id, "overview");
  await expandScenarioDetails(page);
  await page
    .getByRole("button", { name: "Add equipment availability", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Equipment pool").selectOption("EQ-RES-CLINIC-KIT");
  await dialog
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T00:01");
  await expect(dialog.getByLabel("Equipment quantity")).toHaveAttribute(
    "max",
    "0",
  );
  await expect(dialog).toContainText(
    "12 total, 0 serviceable, 12 unserviceable",
  );
  await dialog.getByLabel("Equipment quantity").fill("1");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(dialog).toContainText(
    "Planned fail must be a whole quantity from 0 to 0",
  );
  await dialog.getByLabel("Equipment operation").selectOption("repair");
  await expect(dialog.getByLabel("Equipment quantity")).toHaveAttribute(
    "max",
    "12",
  );
  await dialog.getByLabel("Equipment quantity").fill("3");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, "/scenarios/" + branch.scenario.id);
  expect(saved.updates).toHaveLength(2);
  expect(saved.updates[0].update_id).toBe(report.id);
  expect(saved.updates[1]).toMatchObject({
    input_kind: "planned_assumption",
    payload: { operation: "repair", quantity: 3 },
  });
  record("scenario-equipment-observed-projection", {
    scenario_id: branch.scenario.id,
    report_id: report.id,
    observed_saturated_failure_blocks_future_fail: true,
    exact_future_repair_saved: true,
  });
});
