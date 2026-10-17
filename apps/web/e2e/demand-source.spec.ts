import { expect, test } from "@playwright/test";
import { api, capture, login, open, record } from "./helpers";

test("entry stream edit derives read-only demand summaries and commits one immutable version", async ({
  page,
}, info) => {
  await login(page);
  const original = await api(page.request, "/demo-datasets", "POST", {
    fixture: "planning_baseline",
    days: 3,
  });
  const scenario = await api(page.request, "/scenarios", "POST", {
    name: `Single demand source ${Date.now()}`,
    dataset_version_id: original.id,
    horizon_calendar_days: 1,
    replications: 1,
  });
  await open(page, scenario.id, "data");
  await page
    .getByRole("button", { name: "Create editable draft", exact: true })
    .click();
  await expect(page.getByText("Editable draft", { exact: true })).toBeVisible();
  const collections = page.locator(".collection-list");
  await collections.getByRole("button", { name: /^entry streams/ }).click();
  await page
    .locator(".entity-panel tbody tr")
    .filter({ hasText: "ED_MAIN" })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("expected arrivals per local day", { exact: true })
    .fill("120");
  const updating = page.waitForResponse(
    (r) =>
      r.url().includes("/dataset-drafts/") &&
      r.url().endsWith("/entities") &&
      r.request().method() === "PATCH",
  );
  await dialog
    .getByRole("button", { name: "Save record", exact: true })
    .click();
  const response = await updating;
  expect(response.ok()).toBeTruthy();
  const draftPath = new URL(response.url()).pathname
    .replace(/^\/api/, "")
    .replace(/\/entities$/, "");
  const draft = await api(page.request, draftPath);
  expect(
    draft.validation.valid,
    JSON.stringify(draft.validation.errors),
  ).toBeTruthy();
  expect(draft.dataset.arrival_profiles.ed_arrivals_per_local_day).toBe(120);
  await expect(dialog).toHaveCount(0);
  await collections.getByRole("button", { name: /^arrival profiles/ }).click();
  await expect(page.locator(".entity-panel")).toContainText(
    "Derived · read-only",
  );
  await expect(
    page.locator(".entity-panel").getByRole("button", { name: "Add record" }),
  ).toHaveCount(0);
  await page.locator(".entity-panel tbody tr").first().click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("ed arrivals per local day", { exact: true }),
  ).toHaveValue("120");
  await expect(
    dialog.getByLabel("ed arrivals per local day", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(dialog.getByRole("button", { name: "Save record" })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: "Advanced JSON", exact: true })
    .click();
  await expect(dialog.getByLabel("Entity JSON")).toHaveAttribute(
    "readonly",
    "",
  );
  await capture(page, "derived-demand-summary", info);
  await dialog
    .getByRole("button", { name: "View entry streams", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Validate data", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dataset checks passed" }),
  ).toBeVisible();
  const committing = page.waitForResponse(
    (r) =>
      r.url().includes("/dataset-drafts/") &&
      r.url().endsWith("/commit") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Commit new version", exact: true })
    .click();
  const committedResponse = await committing;
  expect(committedResponse.ok()).toBeTruthy();
  await expect
    .poll(() => {
      const id = new URL(page.url()).searchParams.get("dataset");
      return !!id && id !== original.id;
    })
    .toBeTruthy();
  const committedId = new URL(page.url()).searchParams.get("dataset");
  expect(committedId).toBeTruthy();
  const committed = await api(page.request, `/datasets/${committedId}`);
  expect(committed.id).not.toBe(original.id);
  expect(committed.arrival_profiles.ed_arrivals_per_local_day).toBe(120);
  expect(
    committed.entry_streams.find((s: any) => s.entry_stream_id === "ED_MAIN")
      .expected_arrivals_per_local_day,
  ).toBe(120);
  expect(
    (await api(page.request, `/datasets/${original.id}`)).entry_streams,
  ).toEqual(original.entry_streams);
  record("demand-source", {
    project: info.project.name,
    original_dataset_id: original.id,
    draft_id: draft.id,
    committed_dataset_id: committed.id,
    ed_arrivals_per_local_day: 120,
    single_authoritative_edit: true,
    baseline_read_only: true,
    original_unchanged: true,
  });
});
