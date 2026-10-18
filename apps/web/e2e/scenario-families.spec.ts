import { expandScenarioDetails, expandScenarioSection } from "./scenario-ui";
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

test("all hospital setup changes save canonical inputs and produce real simulation effects", async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(
    page,
    "all hospital assumption families",
    { horizon_calendar_days: 2, replications: 2 },
    "hospital_baseline",
  );
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  await page.getByLabel("Increase in ED arrivals", { exact: true }).fill("70");
  const openFamily = async (name: string) => {
    await page
      .getByRole("button", { name: `Add ${name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    return dialog;
  };
  let d = await openFamily("extra patient arrivals");
  await d.getByLabel("Change name").fill("Seven extra ward patients");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T06:00");
  await d.getByLabel("Additional patients").fill("7");
  await d.getByLabel("Go home after assessment (%)", { exact: true }).fill("0");
  await d.getByLabel("Ward admission (%)", { exact: true }).fill("100");
  await d.getByLabel("Intensive care (%)", { exact: true }).fill("0");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(d).toHaveCount(0);
  d = await openFamily("equipment");
  await d.getByLabel("Change name").fill("Ventilator unavailable");
  await d.getByLabel("Equipment", { exact: true }).selectOption("EQ-ICU-VENT");
  await d.getByLabel("Equipment quantity", { exact: true }).fill("1");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T06:00");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  // Edit exact time, undo, redo, and reopen without relying on an unlabeled drag rail.
  const equipment = page.getByRole("button", {
    name: "Ventilator unavailable Planning assumption",
    exact: true,
  });
  await equipment.click();
  d = page.getByRole("dialog");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T07:00");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await equipment.click();
  d = page.getByRole("dialog");
  await expect(
    d.getByLabel("Effective time (America/Chicago)", { exact: true }),
  ).toHaveValue("2026-10-16T07:00");
  await d.getByRole("button", { name: "Cancel", exact: true }).click();

  d = await openFamily("hospital beds");
  await expect(d).toContainText("Beds supported by staff");
  await d.getByLabel("Change name").fill("ICU bed count");
  await d.getByLabel("Target unit", { exact: true }).selectOption("UNIT-ICU");
  await d.getByLabel(/^Available beds/).fill("14");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T06:00");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(page.locator(".compute-estimate")).toContainText(
    "Use an integer from 0 to 12",
  );
  await expect(
    page.getByRole("button", { name: "Run simulation", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "ICU bed count Planning assumption",
      exact: true,
    })
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel(/^Available beds/).fill("10");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();

  d = await openFamily("staff availability");
  await d.getByLabel("Change name").fill("Ward A provider shift absence");
  await d
    .getByLabel("Target unit", { exact: true })
    .selectOption("UNIT-WARD-A");
  await d.getByLabel("Staff role", { exact: true }).selectOption("provider");
  await d
    .getByLabel("Choose staff using", { exact: true })
    .selectOption("percentage");
  await expect(d.getByText("Loading the declared shift roster…")).toHaveCount(
    0,
  );
  await expect(
    d.getByLabel("Scheduled shift", { exact: true }).locator("option"),
  ).not.toHaveCount(0);
  await d.getByLabel("Absent percentage", { exact: true }).fill("100");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  await expect(d).toHaveCount(0);

  d = await openFamily("hospital beds");
  await d
    .getByLabel("Bed or staffing change", { exact: true })
    .selectOption("physical_overflow");
  await expect(d.getByLabel("Target unit", { exact: true })).toHaveValue(
    "UNIT-WARD-C",
  );
  await expect(d.getByLabel(/^Total beds after opening/)).toHaveValue("32");
  await d.getByLabel("Change name").fill("Open twelve planned Ward C beds");
  await d.getByLabel("Activation delay (minutes)", { exact: true }).fill("0");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();

  d = await openFamily("hospital beds");
  await d
    .getByLabel("Bed or staffing change", { exact: true })
    .selectOption("staff_existing");
  await d.getByLabel("Change name").fill("Three extra nurses for Ward A");
  await d.getByLabel("Nurses", { exact: true }).fill("3");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();

  d = await openFamily("patient care needs");
  await d
    .getByLabel("Change name")
    .fill("New arrivals go home after assessment");
  await d
    .getByLabel("Go home after assessment (%)", { exact: true })
    .fill("100");
  await d.getByLabel("Ward admission (%)", { exact: true }).fill("0");
  await d.getByLabel("Intensive care (%)", { exact: true }).fill("0");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  d = await openFamily("equipment");
  await d.getByLabel("Change name").fill("Temporary draft to remove");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Temporary draft to remove Planning assumption",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove change", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Temporary draft to remove Planning assumption",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(
    saved.conditions
      .find((item: any) => item.kind === "arrival_multiplier")
      .control_points.map((point: any) => point.multiplier),
  ).toEqual([1.7, 1.7]);
  const incident = saved.conditions.find(
    (item: any) => item.kind === "arrival_batch",
  );
  expect(incident).toMatchObject({
    count: 7,
    source: "user_assumption",
    care_mix: { discharge: 0, ward: 1, icu: 0 },
  });
  const staff = saved.conditions.find(
    (item: any) => item.kind === "staff_unavailability",
  );
  expect(staff.staff_ids.length).toBeGreaterThan(0);
  expect(staff.staff_ids.every((id: string) => id.includes("PROVIDER"))).toBe(
    true,
  );
  expect(staff.count).toBeUndefined();
  expect(saved.updates).toHaveLength(2);
  expect(
    saved.updates.every(
      (item: any) =>
        item.input_kind === "planned_assumption" && !item.state_origin,
    ),
  ).toBe(true);
  expect(saved.interventions).toHaveLength(2);
  expect(
    saved.interventions.find((item: any) => item.kind === "physical_overflow"),
  ).toMatchObject({
    unit_id: "UNIT-WARD-C",
    facility_id: "FAC-MAIN",
    enabled_slots: 32,
  });
  expect(
    saved.interventions.find((item: any) => item.kind === "staff_existing"),
  ).toMatchObject({ unit_id: "UNIT-WARD-A", nurses: 3 });
  await expect(page.locator(".optional-change-group")).toHaveCount(5);
  await expect(page.locator(".empty-track,.condition-palette")).toHaveCount(0);
  await capture(page, "hospital-optional-changes", info);
  const submission = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  const response = await submission;
  expect(response.ok()).toBeTruthy();
  const run = await waitRun(page, (await response.json()).id);
  const after = await api(page.request, `/scenarios/${context.scenario.id}`);
  const frozen = after.revisions.find(
    (revision: any) => revision.id === run.scenario_revision_id,
  );
  for (const collection of ["conditions", "interventions", "updates"])
    expect(frozen[collection]).toEqual(saved[collection]);
  const patients = await api(
    page.request,
    `/runs/${run.selected_replication_id}/patients?at=2026-10-16T11:01:00Z&limit=500&search=PAT-REPORT-${incident.id}`,
  );
  const planned = patients.items.filter(
    (patient: any) => patient.arrival_origin === "synthetic_incident",
  );
  expect(planned).toHaveLength(7);
  expect(
    planned.every(
      (patient: any) =>
        patient.source_type === "surge_arrival" &&
        patient.input_kind === "planned_assumption",
    ),
  ).toBe(true);
  const details = await Promise.all(
    planned.map((patient: any) =>
      api(
        page.request,
        `/runs/${run.selected_replication_id}/patients/${patient.patient_id}`,
      ),
    ),
  );
  expect(details.every((patient: any) => patient.care_level === "ward")).toBe(
    true,
  );
  const state = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=2026-10-16T12:01:00Z`,
  );
  expect(
    state.units.find((unit: any) => unit.unit_id === "UNIT-ICU").enabled,
  ).toBe(10);
  expect(
    state.units.find((unit: any) => unit.unit_id === "UNIT-WARD-C"),
  ).toMatchObject({ physical: 32, enabled: 32, staffed: 16 });
  expect(
    state.units.every((unit: any) => unit.facility_id === "FAC-MAIN"),
  ).toBe(true);
  const immutable = JSON.stringify(frozen);
  await open(page, context.scenario.id, "overview");
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill("Later edits preserve completed hospital forecast");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const newest = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(
    JSON.stringify(
      newest.revisions.find(
        (revision: any) => revision.id === run.scenario_revision_id,
      ),
    ),
  ).toBe(immutable);
  expect(errors).toEqual([]);
  await assertPageHealthy(page);
  record(`hospital-scenario-families-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    frozen_revision: run.scenario_revision_id,
    all_collections_frozen: true,
    all_five_hospital_change_groups: true,
    extra_arrivals: planned.length,
    completed_inputs_immutable: true,
    page_errors: errors,
  });
});

test("optional hospital forms and details are keyboard accessible", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "keyboard hospital controls",
    { replications: 1 },
    "hospital_baseline",
  );
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  const demand = await expandScenarioSection(page, "demand");
  await demand.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#scenario-inspector-dock")).toBeHidden();
  await expect(page.getByTestId("arrival-preview-chart")).toBeVisible();
  await demand.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#scenario-inspector-dock")).toBeVisible();
  await page
    .getByRole("button", { name: "Add equipment", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Equipment quantity", { exact: true }).fill("2");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Equipment Planning assumption",
      exact: true,
    }),
  ).toBeVisible();
  await assertPageHealthy(page);
  await capture(page, "hospital-keyboard-parameters", info);
});
