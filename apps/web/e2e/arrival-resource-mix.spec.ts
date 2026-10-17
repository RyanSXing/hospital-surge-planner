import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario } from "./helpers";

test("reported arrival resource mixtures are editable, validated and retained after reload", async ({
  page,
}, info) => {
  const context = await scenario(page, "reported oxygen-requiring arrivals", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  await open(page, context.scenario.id, "analytics-resources");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: /Record update/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Create a new forecast branch after saving")
    .uncheck();
  const save = dialog.getByRole("button", { name: "Save input", exact: true });
  await dialog
    .getByRole("combobox", { name: "Facility", exact: true })
    .selectOption("FAC-EAST");
  await expect(
    dialog.getByRole("combobox", { name: "Entry pathway", exact: true }),
  ).toHaveValue("");
  await expect(dialog.getByRole("alert")).toContainText(
    "no selected matching arrival stream",
  );
  await expect(save).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "Facility", exact: true })
    .selectOption("FAC-MAIN");
  await dialog.getByLabel("ICU disposition (%)", { exact: true }).fill("0");
  await dialog.getByLabel("Ward disposition (%)", { exact: true }).fill("100");
  await dialog.getByLabel("Additional patients", { exact: true }).fill("9");
  await dialog.getByLabel("Spread over minutes", { exact: true }).fill("0");
  await dialog
    .getByRole("spinbutton", {
      name: "Ward admission — WARD-BASIC (%)",
      exact: true,
    })
    .fill("0");
  const oxygen = dialog.getByRole("spinbutton", {
    name: "Ward admission — WARD-OXYGEN (%)",
    exact: true,
  });
  await oxygen.fill("85");
  await expect(dialog.getByRole("alert")).toContainText(
    "percentages must total 100%",
  );
  await expect(save).toBeDisabled();
  await oxygen.fill("100");
  await expect(save).toBeEnabled();
  await oxygen.scrollIntoViewIfNeeded();
  await capture(page, "arrival-resource-mix", info);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/updates") && r.request().method() === "POST",
  );
  await save.click();
  const storedResponse = await response;
  expect(storedResponse.status()).toBe(201);
  const stored = await storedResponse.json();
  expect(stored.payload).toMatchObject({
    count: 9,
    facility_id: "FAC-MAIN",
    entry_stream_id: "ED_MAIN",
    care_mix: { discharge: 0, ward: 1, icu: 0 },
    resource_profile_mix: { ward: { "RP-WARD-BASIC": 0, "RP-WARD-OXYGEN": 1 } },
  });
  expect(stored.payload.resource_profile_mix.discharge).toBeUndefined();
  expect(stored.payload.resource_profile_mix.icu).toBeUndefined();
  await page.reload();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: /Record update/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Recorded history", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText(stored.id, { exact: true }),
  ).toBeVisible();
  const reports = await api(
    page.request,
    `/updates?scenario_id=${context.scenario.id}`,
  );
  expect(
    reports.items.find((item: any) => item.id === stored.id).payload,
  ).toEqual(stored.payload);
  record("arrival-resource-mix", {
    project: info.project.name,
    scenario_id: context.scenario.id,
    update_id: stored.id,
    payload: stored.payload,
    invalid_total_blocked: true,
    mismatched_facility_blocked: true,
    reload_preserved: true,
  });
});
