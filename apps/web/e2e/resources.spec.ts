import { test, expect } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";
import { expandScenarioSection } from "./scenario-ui";

test("opening hospital beds preserves staffing limits until nurses are added", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "internal beds and nurses",
    { horizon_calendar_days: 1, replications: 1 },
    "hospital_baseline",
  );
  const original = await api(page.request, `/datasets/${context.dataset.id}`);
  await open(page, context.scenario.id, "overview");
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", { name: "Add hospital beds", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Bed or staffing change", { exact: true })
    .selectOption("physical_overflow");
  await expect(dialog.getByLabel("Target unit", { exact: true })).toHaveValue(
    "UNIT-WARD-C",
  );
  await expect(dialog.getByLabel(/^Total beds after opening/)).toHaveValue(
    "32",
  );
  await dialog
    .getByLabel("Change name", { exact: true })
    .fill("Open the twelve planned Ward C beds");
  await dialog
    .getByLabel("Activation delay (minutes)", { exact: true })
    .fill("0");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(saved.interventions).toHaveLength(1);
  expect(saved.interventions[0]).toMatchObject({
    unit_id: "UNIT-WARD-C",
    facility_id: "FAC-MAIN",
    kind: "physical_overflow",
    enabled_slots: 32,
    activation_minutes: 0,
  });
  const submitRun = async () => {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/run-groups") &&
        response.request().method() === "POST",
    );
    const button = page.getByRole("button", {
      name: "Run simulation",
      exact: true,
    });
    await expect(button).toBeEnabled();
    await button.click();
    const queued = await response;
    expect(queued.ok()).toBeTruthy();
    return waitRun(page, (await queued.json()).id);
  };
  const physicalRun = await submitRun();
  const at = "2026-10-16T06:00:00Z";
  const physicalState = await api(
    page.request,
    `/runs/${physicalRun.selected_replication_id}/state?at=${at}`,
  );
  const physical = physicalState.units.find(
    (unit: any) => unit.unit_id === "UNIT-WARD-C",
  );
  expect(physical).toMatchObject({ physical: 32, enabled: 32, staffed: 16 });
  expect(physical.available).toBeLessThanOrEqual(16);

  await open(page, context.scenario.id, "overview");
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", { name: "Add hospital beds", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Bed or staffing change", { exact: true })
    .selectOption("staff_existing");
  await dialog
    .getByLabel("Target unit", { exact: true })
    .selectOption("UNIT-WARD-C");
  await dialog
    .getByLabel("Change name", { exact: true })
    .fill("Four nurses for the expanded Ward C");
  await dialog.getByLabel("Nurses", { exact: true }).fill("4");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const staffedDraft = await api(
    page.request,
    `/scenarios/${context.scenario.id}`,
  );
  expect(staffedDraft.interventions).toHaveLength(2);
  expect(
    staffedDraft.interventions.find(
      (plan: any) => plan.kind === "staff_existing",
    ),
  ).toMatchObject({
    unit_id: "UNIT-WARD-C",
    facility_id: "FAC-MAIN",
    nurses: 4,
  });
  await capture(page, "hospital-bed-and-staff-plan", info);
  const staffedRun = await submitRun();
  const staffedState = await api(
    page.request,
    `/runs/${staffedRun.selected_replication_id}/state?at=${at}`,
  );
  const staffed = staffedState.units.find(
    (unit: any) => unit.unit_id === "UNIT-WARD-C",
  );
  expect(staffed).toMatchObject({ physical: 32, enabled: 32, staffed: 32 });
  expect(
    staffedState.units.every((unit: any) => unit.facility_id === "FAC-MAIN"),
  ).toBe(true);
  const after = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(
    after.revisions.find(
      (revision: any) => revision.id === physicalRun.scenario_revision_id,
    ).interventions,
  ).toEqual(saved.interventions);
  expect(
    after.revisions.find(
      (revision: any) => revision.id === staffedRun.scenario_revision_id,
    ).interventions,
  ).toEqual(staffedDraft.interventions);
  const unchanged = await api(page.request, `/datasets/${original.id}`);
  expect(unchanged.slots).toEqual(original.slots);
  expect(unchanged.facilities).toEqual(original.facilities);
  await assertPageHealthy(page);
  record(`internal-hospital-resources-${info.project.name}`, {
    scenario_id: after.id,
    physical_run_id: physicalRun.id,
    staffed_run_id: staffedRun.id,
    physical_beds: physical.physical,
    without_added_nurses: physical.staffed,
    with_added_nurses: staffed.staffed,
    source_inventory_unchanged: true,
    only_main_hospital: true,
  });
});

test("a saved combined hospital response stays visible and editable under optional bed settings", async ({
  page,
}, info) => {
  const response = {
    id: `hospital-response-${Date.now()}`,
    kind: "staffed_overflow",
    name: "Open and staff extra beds",
    facility_id: "FAC-MAIN",
    unit_id: "UNIT-WARD-C",
    start_at: "2026-10-16T05:00:00Z",
    activation_minutes: 60,
    enabled_slots: 32,
    nurses: 4,
    providers: 1,
    support: 1,
  };
  const context = await scenario(page, "saved combined hospital response", {
    horizon_calendar_days: 1,
    replications: 1,
    interventions: [response],
  });
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario");
  await expect(
    editor.locator(".more-simulation-parameters"),
  ).not.toHaveAttribute("open", "");
  await expandScenarioSection(page, "resources");
  const beds = editor.getByRole("region", {
    name: "Hospital beds",
    exact: true,
  });
  await beds
    .getByRole("button", {
      name: "Open and staff extra beds Planning assumption",
      exact: true,
    })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Edit hospital beds",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Bed or staffing change", { exact: true }),
  ).toHaveValue("staffed_overflow");
  await expect(dialog.getByLabel("Target unit", { exact: true })).toHaveValue(
    "UNIT-WARD-C",
  );
  await expect(dialog.getByLabel(/^Total beds after opening/)).toHaveValue(
    "32",
  );
  await expect(dialog.getByLabel("Nurses", { exact: true })).toHaveValue("4");
  await expect(dialog.getByLabel("Providers", { exact: true })).toHaveValue(
    "1",
  );
  await expect(dialog.getByLabel("Support staff", { exact: true })).toHaveValue(
    "1",
  );
  await expect(
    dialog.getByLabel("Activation delay (minutes)", { exact: true }),
  ).toHaveValue("60");
  await expect(dialog.getByLabel(/^End time \(exclusive\)/)).toBeVisible();
  await expect(
    dialog.getByRole("group", {
      name: "Explicit portable equipment allocation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("option", { name: /shelter|partner|clinic|transfer/i }),
  ).toHaveCount(0);
  await dialog.getByLabel(/^Total beds after opening/).fill("28");
  await dialog.getByLabel("Nurses", { exact: true }).fill("3");
  await dialog
    .getByLabel("Activation delay (minutes)", { exact: true })
    .fill("30");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    editor.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(saved.interventions).toHaveLength(1);
  expect(saved.interventions[0]).toMatchObject({
    ...response,
    enabled_slots: 28,
    nurses: 3,
    activation_minutes: 30,
  });
  expect(Date.parse(saved.interventions[0].end_at)).toBe(
    Date.parse("2026-10-17T05:00:00Z"),
  );
  await open(page, saved.id, "overview");
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", {
      name: "Open and staff extra beds Planning assumption",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit hospital beds",
    exact: true,
  });
  await expect(dialog.getByLabel(/^Total beds after opening/)).toHaveValue(
    "28",
  );
  await expect(dialog.getByLabel("Nurses", { exact: true })).toHaveValue("3");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertPageHealthy(page);
  record(`saved-combined-hospital-response-${info.project.name}`, {
    scenario_id: saved.id,
    saved_plan_visible_under_hospital_beds: true,
    combined_kind_preserved: saved.interventions[0].kind,
    physical_and_staff_fields_editable: true,
    enabled_slots: saved.interventions[0].enabled_slots,
    nurses: saved.interventions[0].nurses,
    only_hospital_target_options: true,
  });
});
