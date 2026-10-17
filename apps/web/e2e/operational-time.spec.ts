import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("observed reset preserves an explicit-offset snapshot cutoff finer than one minute", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Exact timestamp lineage is checked once; responsive update forms have separate coverage.",
  );
  const context = await scenario(page, "precise observed snapshot", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  const snapshot = await api(page.request, `/datasets/${context.dataset.id}`);
  snapshot.snapshot_at = "2026-10-16T00:00:17.123-05:00";
  const stage = await api(page.request, "/imports", "POST", {});
  const uploaded = await page.request.post(`/api/imports/${stage.id}/files`, {
    multipart: {
      file: {
        name: "dataset.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(snapshot)),
      },
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const validation = await api(
    page.request,
    `/imports/${stage.id}/validate`,
    "POST",
    {},
  );
  expect(validation.valid, JSON.stringify(validation.errors)).toBeTruthy();
  const observed = await api(
    page.request,
    `/imports/${stage.id}/commit`,
    "POST",
    {},
  );
  await open(page, context.scenario.id, "resources");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Record update", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Starting state").selectOption("observed_reset");
  await dialog
    .getByLabel("Complete replacement snapshot")
    .selectOption(observed.id);
  await expect(
    dialog.getByLabel("Effective time", { exact: false }),
  ).toHaveValue("2026-10-16T00:00");
  await expect(dialog).toContainText("17.123");
  const preview = page.waitForResponse((response) =>
    response.url().endsWith("/reset-reconciliation"),
  );
  await dialog
    .getByRole("button", { name: "Validate & preview reconciliation" })
    .click();
  const checked = await preview;
  expect(checked.ok(), await checked.text()).toBeTruthy();
  expect(checked.request().postDataJSON().effective_at).toBe(
    observed.snapshot_at,
  );
  await dialog
    .getByLabel("Create a new forecast branch after saving")
    .uncheck();
  await dialog.getByLabel(/I reviewed/).check();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/updates") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save input", exact: true }).click();
  const response = await savedResponse;
  expect(response.ok(), await response.text()).toBeTruthy();
  const saved = await response.json();
  expect(saved.effective_at).toBe(observed.snapshot_at);
  expect(saved.payload.effective_at).toBe(observed.snapshot_at);
  record("observed-cutoff-precision", {
    observed_dataset_id: observed.id,
    effective_at: saved.effective_at,
    update_id: saved.id,
  });
});
