import { expandScenarioSection } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("optional settings retain unsaved changes when collapsed and save the complete draft", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "main and optional settings preserve draft",
  );
  await open(page, context.scenario.id, "overview");
  await page.getByLabel("Increase in ED arrivals", { exact: true }).fill("70");
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", { name: "Add extra patient arrivals", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Change name", { exact: true })
    .fill("Unsaved extra patient group");
  await dialog.getByLabel("Additional patients", { exact: true }).fill("3");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  expect(
    (await api(page.request, `/scenarios/${context.scenario.id}`)).conditions,
  ).toEqual([]);
  const more = page.locator(".more-simulation-parameters");
  await more.locator(":scope > summary").click();
  await expect(page.getByTestId("arrival-preview-chart")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Unsaved extra patient group Planning assumption",
      exact: true,
    }),
  ).not.toBeVisible();
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", {
      name: "Unsaved extra patient group Planning assumption",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Additional patients", { exact: true }),
  ).toHaveValue("3");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expandScenarioSection(page, "calculation");
  await page.getByLabel("Random seed", { exact: true }).fill("1776");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(saved.conditions).toHaveLength(2);
  expect(saved.base_seed).toBe(1776);
  expect(
    saved.conditions
      .find((condition: any) => condition.kind === "arrival_multiplier")
      .control_points.map((point: any) => point.multiplier),
  ).toEqual([1.7, 1.7]);
  expect(
    saved.conditions.find(
      (condition: any) => condition.kind === "arrival_batch",
    ),
  ).toMatchObject({ name: "Unsaved extra patient group", count: 3 });
  record(`hospital-optional-preservation-${info.project.name}`, {
    scenario_id: saved.id,
    main_and_optional_inputs_preserved: true,
    collapsed_draft_preserved: true,
    saved_random_seed: saved.base_seed,
  });
});
