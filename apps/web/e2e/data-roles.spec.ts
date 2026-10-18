import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, signInAs } from "./helpers";
function csv(
  rows: Record<string, any>[],
  rename: Record<string, string> = {},
  extra = false,
) {
  const fields = [...new Set(rows.flatMap(Object.keys))],
    cell = (v: any) =>
      `"${String(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v).replaceAll('"', '""')}"`;
  return [
    fields
      .map((k) => cell(rename[k] || k))
      .concat(extra ? ["operator_note"] : [])
      .join(","),
    ...rows.map((r) =>
      fields
        .map((k) => cell(r[k]))
        .concat(extra ? ["ignored sample note"] : [])
        .join(","),
    ),
  ].join("\r\n");
}

test("typed data editor and multi-file mapped import create immutable versions", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Data mutation workflow runs once; mobile data view is covered by the screen matrix.",
  );
  const context = await scenario(page, "data workflow");
  const original = await api(page.request, "/datasets/" + context.dataset.id);
  await open(page, context.scenario.id, "data");
  await expect(
    page.getByRole("button", { name: "Create editable draft" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Create editable draft" }).click();
  await expect(page.getByText("Editable draft", { exact: true })).toBeVisible();
  await page.locator(".entity-panel tbody tr").first().click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Turnover minutes", { exact: true }).fill("25");
  await expect(
    editor.getByLabel("Installed beds", { exact: true }),
  ).toBeVisible();
  await capture(page, "typed-editor", info);
  await editor
    .getByRole("button", { name: "Save record", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("button", { name: "Validate data", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dataset checks passed" }),
  ).toBeVisible();
  const committing = page.waitForResponse(
    (r) => r.url().includes("/dataset-drafts/") && r.url().endsWith("/commit"),
  );
  await page
    .getByRole("button", { name: "Commit new version", exact: true })
    .click();
  expect((await committing).ok()).toBeTruthy();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("dataset"))
    .not.toBe(context.dataset.id);
  const committed = await api(
    page.request,
    "/datasets/" + new URL(page.url()).searchParams.get("dataset"),
  );
  expect(committed.id).not.toBe(context.dataset.id);
  expect(
    committed.units.some((u: any) => u.turnover_minutes === 25),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Import dataset", exact: true })
    .click();
  const wizard = page.getByRole("dialog");
  const facilities = committed.facilities.map((f: any) => ({
    ...f,
    name: "Imported " + f.name,
  }));
  await wizard.locator("input[type=file]").setInputFiles([
    {
      name: "sites.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv(facilities, { facility_id: "site_key" }, true)),
    },
    {
      name: "care-units.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv(committed.units, { unit_id: "unit_key" })),
    },
  ]);
  await wizard.getByRole("button", { name: "Preview and map fields" }).click();
  await wizard.getByLabel("Target collection").selectOption("facilities");
  await wizard
    .getByLabel("Map site_key", { exact: true })
    .selectOption("facility_id");
  await wizard
    .getByLabel("Map operator_note", { exact: true })
    .selectOption("__ignore");
  await wizard
    .getByRole("button", { name: "care-units.csv", exact: true })
    .click();
  await wizard.getByLabel("Target collection").selectOption("units");
  await wizard
    .getByLabel("Map unit_key", { exact: true })
    .selectOption("unit_id");
  await capture(page, "csv-field-mapping", info);
  await wizard.getByRole("button", { name: "Validate all files" }).click();
  await expect(
    wizard.getByText("Ready to commit", { exact: true }),
  ).toBeVisible();
  const importing = page.waitForResponse(
    (r) => r.url().includes("/imports/") && r.url().endsWith("/commit"),
  );
  await wizard
    .getByRole("button", { name: "Commit dataset", exact: true })
    .click();
  expect((await importing).ok()).toBeTruthy();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("dataset"))
    .not.toBe(committed.id);
  const imported = await api(
    page.request,
    "/datasets/" + new URL(page.url()).searchParams.get("dataset"),
  );
  expect(imported.facilities[0].name).toContain("Imported ");
  expect(imported.patients).toEqual(committed.patients);
  expect((await api(page.request, "/datasets/" + original.id)).units).toEqual(
    original.units,
  );
  record("data-workflow", {
    original_dataset_id: original.id,
    edited_dataset_id: committed.id,
    imported_dataset_id: imported.id,
    field_mapping: {
      site_key: "facility_id",
      unit_key: "unit_id",
      operator_note: "explicitly ignored",
    },
  });
});

test("viewer sees disabled mutation controls and the API rejects writes", async ({
  page,
}, info) => {
  const context = await scenario(page, "viewer verification");
  const username = "e2e-reader-" + Date.now(),
    password = "Synthetic-browser-password-" + Date.now();
  await api(page.request, "/workspaces/workspace-main/members", "POST", {
    username,
    password,
    name: "Browser test viewer",
    role: "viewer",
  });
  await api(page.request, "/auth/logout", "POST", {});
  await signInAs(page, { username, password });
  await open(page, context.scenario.id, "overview");
  await expect(
    page
      .locator(".scenarios-page .heading-actions")
      .getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Run simulation", exact: true }),
  ).toBeDisabled();
  const denied = await page.request.post("/api/run-groups", {
    data: { scenario_id: context.scenario.id },
  });
  expect(denied.status()).toBe(403);
  await open(page, context.scenario.id, "data");
  await expect(
    page.getByRole("button", { name: "Import dataset", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create editable draft", exact: true }),
  ).toBeDisabled();
  await capture(page, "viewer-permissions", info);
});
