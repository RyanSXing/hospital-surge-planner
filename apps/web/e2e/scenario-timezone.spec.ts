import { expandScenarioDetails } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("scenario fields preserve the second repeated Chicago hour and reject the spring gap", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const context = await scenario(page, "Chicago DST planning times", {
    horizon_calendar_days: 30,
  });
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  await page
    .getByRole("button", { name: "Add equipment availability", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Assumption name")
    .fill("Second repeated hour equipment failure");
  await dialog.getByLabel("Equipment pool").selectOption("EQ-RES-CLINIC-KIT");
  await dialog
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-11-01T01:30");
  await dialog
    .getByRole("combobox", { name: /^Repeated hour/ })
    .selectOption("2026-11-01T07:30");
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await page.getByLabel("Increase in ED arrivals").fill("70");
  const start = page.getByLabel("Arrival starts (America/Chicago)", {
    exact: true,
  });
  await start.fill("2026-11-01T01:30");
  await page
    .getByRole("combobox", { name: /^Repeated hour/ })
    .selectOption("2026-11-01T07:30");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(Date.parse(saved.updates[0].effective_at)).toBe(
    Date.parse("2026-11-01T07:30:00Z"),
  );
  expect(Date.parse(saved.conditions[0].control_points[0].at)).toBe(
    Date.parse("2026-11-01T07:30:00Z"),
  );
  await page.reload();
  await expandScenarioDetails(page);
  await expect(
    page.getByLabel("Arrival starts (America/Chicago)", { exact: true }),
  ).toHaveValue("2026-11-01T01:30");
  await expect(
    page.getByRole("combobox", { name: /^Repeated hour/ }),
  ).toHaveValue("2026-11-01T07:30");
  await page
    .getByRole("button", {
      name: "Second repeated hour equipment failure Planning assumption",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Effective time (America/Chicago)", { exact: true }),
  ).toHaveValue("2026-11-01T01:30");
  await expect(
    dialog.getByRole("combobox", { name: /^Repeated hour/ }),
  ).toHaveValue("2026-11-01T07:30");
  await dialog
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-03-08T02:30");
  await expect(dialog.getByRole("alert")).toContainText(
    "This local time does not exist",
  );
  await dialog.getByRole("button", { name: "Apply assumption" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "The effective time must lie within the scenario horizon",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByLabel("Arrival starts (America/Chicago)", { exact: true })
    .fill("2026-03-08T02:30");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "This local time does not exist" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  const unchanged = await api(
    page.request,
    "/scenarios/" + context.scenario.id,
  );
  expect(unchanged.conditions).toEqual(saved.conditions);
  expect(unchanged.updates).toEqual(saved.updates);
  record("scenario-timezone", {
    scenario_id: context.scenario.id,
    second_occurrence_saved_at: "2026-11-01T07:30:00Z",
    arrival_and_equipment_reopen_preserved: true,
    skipped_local_time_rejected: true,
  });
});
