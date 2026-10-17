import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("calendar horizons, complete library search, pagination, clone and archive lifecycle", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Full lifecycle runs once; responsive screens have separate coverage.",
  );
  test.setTimeout(240000);
  const prefix = "E2E Library " + Date.now();
  const context = await scenario(page, prefix, {
    name: prefix + " 00",
    horizon_calendar_days: 3,
    replications: 1,
  });
  for (let i = 1; i <= 50; i++)
    await api(page.request, "/scenarios", "POST", {
      name: `${prefix} ${String(i).padStart(2, "0")}`,
      dataset_version_id: context.dataset.id,
      horizon_calendar_days: 3,
      replications: 1,
    });
  await open(page, context.scenario.id, "overview");
  await page.getByLabel("Horizon unit").selectOption("weeks");
  await page.getByLabel("Planning horizon").fill("2");
  const saveWeeks = page.waitForResponse(
    (r) =>
      r.url().endsWith("/scenarios/" + context.scenario.id) &&
      r.request().method() === "PATCH",
  );
  await page
    .locator(".scenarios-page .heading-actions")
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  expect((await saveWeeks).ok()).toBeTruthy();
  expect(
    (await api(page.request, "/scenarios/" + context.scenario.id))
      .horizon_calendar_days,
  ).toBe(14);
  await page.getByLabel("Horizon unit").selectOption("months");
  await page.getByLabel("Planning horizon").fill("1");
  await expect(page.locator(".scenarios-page")).toContainText(
    "31 local calendar days",
  );
  const saveMonth = page.waitForResponse(
    (r) =>
      r.url().endsWith("/scenarios/" + context.scenario.id) &&
      r.request().method() === "PATCH",
  );
  await page
    .locator(".scenarios-page .heading-actions")
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  expect((await saveMonth).ok()).toBeTruthy();
  const original = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(original.horizon_calendar_days).toBe(31);
  await page
    .getByRole("button", { name: "Scenario library", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Search saved scenarios").fill(prefix);
  await expect(dialog.locator(".library-row")).toHaveCount(50);
  await expect(dialog).toContainText("50 of 51 saved scenarios");
  await dialog
    .getByRole("button", { name: "Load more saved scenarios" })
    .click();
  await expect(dialog.locator(".library-row")).toHaveCount(51);
  const row = dialog
    .locator(".library-row")
    .filter({ has: page.getByText(prefix + " 00", { exact: true }) });
  await expect(row).toContainText("Owner:");
  await expect(row).toContainText("Dataset " + context.dataset.id);
  await expect(row).toContainText("Created");
  await expect(row).toContainText("Modified");
  const cloned = page.waitForResponse(
    (r) => r.url().endsWith("/clone") && r.request().method() === "POST",
  );
  await row.getByRole("button", { name: "Clone", exact: true }).click();
  const copy = await (await cloned).json();
  expect(copy.parent_scenario_id).toBe(context.scenario.id);
  expect(copy.horizon_calendar_days).toBe(31);
  const copyRow = dialog
    .locator(".library-row")
    .filter({ has: page.getByText(copy.name, { exact: true }) });
  await expect(copyRow).toBeVisible();
  const archived = page.waitForResponse(
    (r) => r.url().endsWith("/archive") && r.request().method() === "POST",
  );
  await copyRow
    .getByRole("button", { name: "Archive " + copy.name, exact: true })
    .click();
  expect((await archived).ok()).toBeTruthy();
  await expect(copyRow).toHaveCount(0);
  await dialog.getByLabel("Show archived scenarios").check();
  await expect(dialog.locator(".library-row")).toHaveCount(1);
  await expect(dialog).toContainText(copy.name);
  await expect(
    dialog.getByRole("button", { name: "Archive " + copy.name, exact: true }),
  ).toBeDisabled();
  await capture(page, "scenario-library-lifecycle", info);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const search = page.getByRole("dialog");
  await search.getByLabel("Search workspace content").fill(prefix);
  await expect(search).toContainText("Scenarios · 10 of 51");
  await search
    .getByRole("button", { name: "Load more scenario matches" })
    .click();
  await expect(search).toContainText("Scenarios · 20 of 51");
  await search.getByLabel("Search workspace content").fill("PAT-PLAN-");
  await expect(search).toContainText("Patients · 10 of 84");
  await search
    .getByRole("button", { name: "Load more patient matches" })
    .click();
  await expect(search).toContainText("Patients · 20 of 84");
  await search.getByLabel("Search workspace content").fill(context.scenario.id);
  await expect(
    search.getByRole("button", { name: new RegExp(prefix + " 00") }),
  ).toBeVisible();
  await search
    .getByRole("button", { name: new RegExp(prefix + " 00") })
    .click();
  await expect(page.getByLabel("Scenario name")).toHaveValue(prefix + " 00");
  expect(
    (await api(page.request, "/scenarios/" + context.scenario.id)).revision,
  ).toBe(original.revision);
  record("scenario-library-lifecycle", {
    scenario_id: context.scenario.id,
    clone_id: copy.id,
    searched_scenarios: 51,
    library_page_size: 50,
    global_search_pages: [10, 20],
    weeks_calendar_days: 14,
    month_calendar_days: 31,
    source_revision: original.revision,
  });
});

test("ICU transfer to a clinic is rejected and ward transfer reserves and travels", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Detailed transfer semantics run once.",
  );
  const context = await scenario(
    page,
    "transfer acceptance",
    { horizon_calendar_days: 1, replications: 1 },
    "stress_snapshot",
  );
  const initial = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "analytics-resources", initial.id);
  await page
    .getByRole("button", { name: "Plan transfer", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Patient group").selectOption("icu");
  await dialog
    .getByLabel("Receiving facility")
    .selectOption("FAC-CLINIC-NORTH");
  await expect(dialog).toContainText("Constraints require attention");
  await expect(dialog).toContainText("Incompatible");
  await expect(
    dialog.getByRole("button", { name: "Save proposed transfer plan" }),
  ).toBeDisabled();
  await capture(page, "icu-clinic-rejected", info);
  await dialog.getByLabel("Patient group").selectOption("ward");
  await dialog.getByLabel("Receiving facility").selectOption("FAC-EAST");
  await dialog.getByLabel("Maximum patients").fill("2");
  await expect(dialog).toContainText("Prerequisites declared");
  const saving = page.waitForResponse(
    (r) =>
      r.url().endsWith("/scenarios/" + context.scenario.id) &&
      r.request().method() === "PATCH",
  );
  await dialog
    .getByRole("button", { name: "Save proposed transfer plan" })
    .click();
  expect((await saving).ok()).toBeTruthy();
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(saved.interventions.at(-1).destination_unit_id).toBe("UNIT-EAST-WARD");
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const events = (
    await api(
      page.request,
      `/runs/${run.selected_replication_id}/events?limit=200`,
    )
  ).items;
  const accepted = events.find(
      (e: any) => e.event_type === "transfer_accepted",
    ),
    departed = events.find((e: any) => e.event_type === "transfer_departed"),
    arrived = events.find((e: any) => e.event_type === "transfer_arrived");
  expect(accepted).toBeTruthy();
  expect(departed).toBeTruthy();
  expect(arrived).toBeTruthy();
  expect(Date.parse(accepted.occurred_at)).toBeLessThanOrEqual(
    Date.parse(departed.occurred_at),
  );
  expect(Date.parse(departed.occurred_at)).toBeLessThan(
    Date.parse(arrived.occurred_at),
  );
  const at = await api(
      page.request,
      `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(accepted.occurred_at)}`,
    ),
    patient = await api(
      page.request,
      `/runs/${run.selected_replication_id}/patients/${accepted.patient_id}?at=${encodeURIComponent(accepted.occurred_at)}`,
    );
  expect(patient.state).toBe("transfer_reserved");
  expect(
    at.units.find((u: any) => u.unit_id === "UNIT-EAST-WARD").reserved,
  ).toBeGreaterThan(0);
  expect(patient.unit_id).toBe("UNIT-ED");
  expect(
    (await api(page.request, "/run-groups/" + initial.id)).input_sha256,
  ).toBe(initial.input_sha256);
  await open(page, context.scenario.id, "replay", run.id);
  await capture(page, "bounded-transfer-replay", info);
  record("bounded-transfer", {
    scenario_id: saved.id,
    original_run_id: initial.id,
    run_id: run.id,
    patient_id: accepted.patient_id,
    accepted_at: accepted.occurred_at,
    departed_at: departed.occurred_at,
    arrived_at: arrived.occurred_at,
    clinic_icu_rejected: true,
    source_retained_until_pickup: true,
  });
});

test("patient filters and unit evidence expose exact selected-run details", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "Detailed model filters run once.");
  const context = await scenario(
    page,
    "patient detail acceptance",
    { horizon_calendar_days: 1, replications: 1 },
    "stress_snapshot",
  );
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "analytics-patients", run.id);
  await page.getByLabel("Patient state filter").selectOption("waiting");
  await page
    .getByText("Care, waiting, arrival and remaining-stay filters", {
      exact: true,
    })
    .click();
  await page.getByLabel("Required care").selectOption("icu");
  await expect(page.locator(".table-footer")).toContainText("4 patients");
  await page.getByLabel("Transfer eligibility").selectOption("true");
  await expect(page.locator(".table-footer")).toContainText("4 patients");
  await page
    .getByLabel("Waiting reason")
    .selectOption("no_matching_physical_place");
  await expect(page.locator(".table-footer")).toContainText("4 patients");
  await expect(page.locator(".patient-table thead")).toContainText(
    "Remaining modeled stage",
  );
  await expect(page.locator(".patient-table thead")).toContainText(
    "Time waiting",
  );
  await expect(page.locator(".patient-table tbody")).toContainText(
    "ICU MONITOR",
  );
  await capture(page, "patient-full-filters", info);
  await page.getByLabel("Maximum remaining hours").fill("1");
  await expect(page.locator(".table-footer")).toContainText("0 patients");
  await page
    .getByRole("button", { name: "Clear census filters", exact: true })
    .click();
  await page.getByLabel("Current unit").selectOption("UNIT-WARD-A");
  await expect(page.locator(".unit-evidence")).toContainText(
    "actual assigned staff at selected time",
  );
  await expect(page.locator(".unit-evidence")).toContainText(
    "Declared shift roster",
  );
  await expect(page.locator(".unit-evidence")).toContainText(
    "Actual selected-run occupancy and staffing",
  );
  await expect(page.locator(".unit-evidence")).toContainText(
    "Future simulated capacity changes",
  );
  const inspector = page.locator(".patient-inspector"),
    mainTop = await page.locator("main").evaluate((e) => e.scrollTop);
  await inspector.evaluate(async (e) => {
    e.scrollTop = e.scrollHeight;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect(await page.locator("main").evaluate((e) => e.scrollTop)).toBe(mainTop);
  expect(
    await inspector.evaluate(
      (e) => e.scrollHeight > e.clientHeight && e.scrollTop > 0,
    ),
  ).toBeTruthy();
  await capture(page, "unit-evidence", info);
  record("patient-unit-details", {
    run_id: run.id,
    filtered_icu_boarders: 4,
    not_started_stages_excluded_from_remaining_range: true,
    active_staff_ids: true,
    shift_roster: true,
    occupancy_queue_chart: true,
    future_capacity: true,
  });
});
