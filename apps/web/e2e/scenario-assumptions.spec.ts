import { expandScenarioDetails } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("advanced assumptions save preserves unsaved visual conditions", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const context = await scenario(page, "visual draft to assumptions");
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  await page.getByLabel("Increase in ED arrivals").fill("70");
  await page
    .getByRole("button", { name: "Add one-time incident batches", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Assumption name").fill("Unsaved visual incident");
  await dialog.getByLabel("Incident patient count").fill("3");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  expect(
    (await api(page.request, "/scenarios/" + context.scenario.id)).conditions,
  ).toEqual([]);
  await page.getByRole("button", { name: "Assumptions", exact: true }).click();
  dialog = page.getByRole("dialog");
  const shown = JSON.parse(
    await dialog.getByLabel("Complete condition list").inputValue(),
  );
  expect(shown).toHaveLength(2);
  expect(
    shown
      .find((c: any) => c.kind === "arrival_multiplier")
      .control_points.map((p: any) => p.multiplier),
  ).toEqual([1.7, 1.7]);
  expect(shown.find((c: any) => c.kind === "arrival_batch")).toMatchObject({
    name: "Unsaved visual incident",
    count: 3,
  });
  await dialog
    .getByRole("button", { name: "Validate and save all conditions" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(saved.conditions).toEqual(shown);
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  record("scenario-assumptions-preservation", {
    scenario_id: context.scenario.id,
    unsaved_visual_conditions_preserved: true,
    saved_conditions_equal_dialog: true,
  });
});
