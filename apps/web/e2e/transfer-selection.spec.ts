import { expect, test } from "@playwright/test";
import { open, record, scenario } from "./helpers";

test("a slower destination check cannot overwrite the current transfer choice", async ({
  page,
}, info) => {
  const context = await scenario(page, "transfer response ordering", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  await open(page, context.scenario.id, "analytics-resources");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  const pattern = "**/api/sites/FAC-EAST/eligibility?*";
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    held++;
    await barrier;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "Plan transfer", exact: true })
      .click();
    await expect.poll(() => held).toBeGreaterThan(0);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Patient group").selectOption("icu");
    await dialog
      .getByLabel("Receiving facility")
      .selectOption("FAC-CLINIC-NORTH");
    await expect(dialog.locator(".transfer-preview h3")).toHaveText(
      "Demo Clinic North",
    );
    await expect(dialog).toContainText("Constraints require attention");
    release();
    await page.waitForTimeout(250);
    await expect(dialog.locator(".transfer-preview h3")).toHaveText(
      "Demo Clinic North",
    );
    await expect(dialog).toContainText("Constraints require attention");
    await expect(
      dialog.getByRole("button", { name: "Save proposed transfer plan" }),
    ).toBeDisabled();
    record("transfer-response-ordering", {
      project: info.project.name,
      delayed_prior_responses: held,
      selected_destination: "FAC-CLINIC-NORTH",
      incompatible_icu_rejected: true,
    });
  } finally {
    release();
    await page.unroute(pattern);
  }
});
