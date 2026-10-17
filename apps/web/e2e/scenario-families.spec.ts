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

test("all visual scenario families save canonical inputs and compute actual effects", async ({
  page,
}, info) => {
  test.setTimeout(240000);
  test.skip(
    info.project.name === "mobile",
    "Desktop computes the complete scenario; mobile form access is checked separately.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const context = await scenario(page, "all editable assumption families");
  await open(page, context.scenario.id, "overview");
  await page.getByLabel("Increase in ED arrivals").fill("70");
  await expect(page.getByLabel("Scenario preset")).toHaveValue("sustained");
  const openFamily = async (name: string) => {
    await page
      .locator(".condition-palette .condition-tile")
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    return page.getByRole("dialog");
  };
  let d = await openFamily("One-time incident batches");
  await d.getByLabel("Assumption name").fill("Planned seven-patient incident");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T06:00");
  await d.getByLabel("Incident patient count").fill("7");
  await d.getByLabel("discharge (%)", { exact: true }).fill("0");
  await d.getByLabel("ward (%)", { exact: true }).fill("100");
  await d.getByLabel("icu (%)", { exact: true }).fill("0");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  d = await openFamily("Equipment availability");
  await d.getByLabel("Assumption name").fill("Ventilator unavailable");
  await d.getByLabel("Equipment pool").selectOption("EQ-ICU-VENT");
  await d.getByLabel("Equipment quantity").fill("1");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T06:00");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  const equipment = page.getByRole("button", {
    name: "Ventilator unavailable Planning assumption",
    exact: true,
  });
  await equipment.focus();
  await equipment.press("ArrowRight");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await equipment.click();
  await expect(
    page
      .getByRole("dialog")
      .getByLabel("Effective time (America/Chicago)", { exact: true }),
  ).toHaveValue("2026-10-16T07:00");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  d = await openFamily("Physical, ready & usable capacity");
  await expect(d).toContainText("Staff-supported ceiling");
  await d.getByLabel("Assumption name").fill("ICU capacity driver");
  await d.getByLabel("Target unit").selectOption("UNIT-ICU");
  await d.getByLabel("Enabled physical places").fill("14");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-16T06:00");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await expect(page.locator(".compute-estimate")).toContainText(
    "Use an integer from 0 to 12",
  );
  await expect(
    page
      .locator(".scenarios-page .heading-actions")
      .getByRole("button", { name: "Run scenario", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "ICU capacity driver Planning assumption",
      exact: true,
    })
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("Enabled physical places").fill("10");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await page.getByLabel("Scenario preset").selectOption("combined");
  d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  await expect(page.getByLabel("Ward A nursing absence")).toHaveCount(0);
  await d.getByLabel("Assumption name").fill("Ward A provider shift absence");
  await d.getByLabel("Target unit").selectOption("UNIT-WARD-A");
  await d.getByLabel("Staff role").selectOption("provider");
  await d.getByLabel("Availability input").selectOption("percentage");
  await expect(d.getByText("Loading the declared shift roster…")).toHaveCount(
    0,
  );
  await expect(
    d
      .getByRole("combobox", { name: "Declared shift", exact: true })
      .locator("option"),
  ).not.toHaveCount(0);
  await expect(
    d
      .getByRole("combobox", { name: "Declared shift", exact: true })
      .locator("option")
      .first(),
  ).toContainText("GMT-5");
  await d.getByLabel("Absent percentage", { exact: true }).fill("100");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  d = await openFamily("Sites & transfers");
  await d
    .getByLabel("Assumption name")
    .fill("Clinic with explicit reserve resources");
  await d
    .getByLabel("EQ-RES-CLINIC-KIT (CLINIC_KIT, 12 total)", { exact: true })
    .fill("8");
  await d.getByLabel("Activation delay (minutes)").fill("4320");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await expect(d).toContainText("Readiness must occur before the plan ends");
  await d.getByLabel("Activation delay (minutes)").fill("360");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  d = await openFamily("Sites & transfers");
  await d.getByLabel("Intervention template").selectOption("route_change");
  await expect(
    d.getByLabel("Directed route").locator("option").first(),
  ).toContainText("FAC-");
  await expect(
    d.getByLabel("Directed route").locator("option").first(),
  ).toContainText("→ FAC-");
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  d = await openFamily("Sites & transfers");
  await d.getByLabel("Intervention template").selectOption("partner_transfer");
  await d.getByLabel("Assumption name").fill("Two eligible ward transfers");
  await d.getByLabel("Maximum transferred patients").fill("2");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  d = await openFamily("Physical, ready & usable capacity");
  await d.getByLabel("Capacity driver").selectOption("physical_overflow");
  await d
    .getByLabel("Assumption name")
    .fill("Physical overflow without staffing");
  await d.getByLabel("Physical places to install and enable").fill("20");
  await d.getByLabel("Activation delay (minutes)").fill("0");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  d = await openFamily("Physical, ready & usable capacity");
  await d.getByLabel("Capacity driver").selectOption("staff_existing");
  await d
    .getByLabel("Assumption name")
    .fill("Three reserve nurses for existing beds");
  await d.getByLabel("Nurses", { exact: true }).fill("3");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  d = await openFamily("Arrival cohorts");
  await d.getByLabel("Assumption name").fill("Exogenous discharge-only cohort");
  await d.getByLabel("discharge (%)", { exact: true }).fill("100");
  await d.getByLabel("ward (%)", { exact: true }).fill("0");
  await d.getByLabel("icu (%)", { exact: true }).fill("0");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  // Removal and undo must preserve all unrelated collections and exact values.
  d = await openFamily("Equipment availability");
  await d.getByLabel("Assumption name").fill("Temporary draft to remove");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await page
    .getByRole("button", {
      name: "Temporary draft to remove Planning assumption",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove assumption" })
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
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(
    saved.conditions
      .find((c: any) => c.kind === "arrival_multiplier")
      .control_points.map((p: any) => p.multiplier),
  ).toEqual([1.7, 1.7]);
  const incident = saved.conditions.find(
    (c: any) => c.kind === "arrival_batch",
  );
  expect(incident.count).toBe(7);
  expect(incident.source).toBe("user_assumption");
  const staff = saved.conditions.find(
    (c: any) => c.kind === "staff_unavailability",
  );
  expect(staff.staff_ids.length).toBeGreaterThan(0);
  expect(staff.staff_ids.every((id: string) => id.includes("PROVIDER"))).toBe(
    true,
  );
  expect(staff.count).toBeUndefined();
  expect(saved.updates).toHaveLength(2);
  expect(
    saved.updates.every(
      (u: any) => u.input_kind === "planned_assumption" && !u.state_origin,
    ),
  ).toBe(true);
  expect(
    saved.interventions.find((p: any) => p.kind === "partner_transfer"),
  ).toMatchObject({
    max_patients: 2,
    patient_eligibility_filter: { care_levels: ["ward"] },
  });
  expect(saved.interventions[0].equipment_allocations).toEqual([
    { equipment_pool_id: "EQ-RES-CLINIC-KIT", quantity: 8 },
  ]);
  if (await page.getByRole("button", { name: "Dismiss notification" }).count())
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.locator("main").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator(".plan-family-track").last().scrollIntoViewIfNeeded();
  const railBounds = await page
    .locator(".plan-family-track")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        name: element.getAttribute("aria-label"),
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
      })),
    );
  const mainBounds = await page.locator("main").boundingBox();
  expect(railBounds).toHaveLength(6);
  expect(
    railBounds.every(
      (rail) =>
        rail.top >= mainBounds!.y &&
        rail.bottom <= mainBounds!.y + mainBounds!.height,
    ),
  ).toBe(true);
  await capture(page, "scenario-all-families", info);
  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/run-groups") && r.request().method() === "POST",
  );
  await page
    .locator(".scenarios-page .heading-actions")
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  const queued = await (await submitted).json();
  const run = await waitRun(page, queued.id);
  const after = await api(page.request, "/scenarios/" + context.scenario.id);
  const frozen = after.revisions.find(
    (r: any) => r.id === run.scenario_revision_id,
  );
  for (const collection of ["conditions", "interventions", "updates"])
    expect(frozen[collection]).toEqual(saved[collection]);
  const patients = await api(
    page.request,
    `/runs/${run.selected_replication_id}/patients?at=2026-10-16T11:01:00Z&limit=500&search=PAT-REPORT-${incident.id}`,
  );
  const planned = patients.items.filter(
    (p: any) => p.arrival_origin === "synthetic_incident",
  );
  expect(planned).toHaveLength(7);
  expect(
    planned.every(
      (p: any) =>
        p.source_type === "surge_arrival" &&
        p.input_kind === "planned_assumption",
    ),
  ).toBe(true);
  const details = await Promise.all(
    planned.map((p: any) =>
      api(
        page.request,
        `/runs/${run.selected_replication_id}/patients/${p.patient_id}`,
      ),
    ),
  );
  expect(details.every((p: any) => p.care_level === "ward")).toBe(true);
  const state = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=2026-10-16T12:01:00Z`,
  );
  expect(state.units.find((u: any) => u.unit_id === "UNIT-ICU").enabled).toBe(
    10,
  );
  expect(
    state.units.find((u: any) => u.unit_id === "UNIT-CLINIC-NORTH").active,
  ).toBe(true);
  expect(
    state.units.find((u: any) => u.unit_id === "UNIT-OVERFLOW-SOUTH"),
  ).toMatchObject({ physical: 20, enabled: 20, staffed: 0, available: 0 });
  expect(
    state.units.find((u: any) => u.unit_id === "UNIT-WARD-A").staffed,
  ).toBe(40);
  const immutable = JSON.stringify(frozen);
  await open(page, context.scenario.id, "overview");
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill("Later draft edits preserve completed forecast");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const newest = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(
    JSON.stringify(
      newest.revisions.find((r: any) => r.id === run.scenario_revision_id),
    ),
  ).toBe(immutable);
  expect(errors).toEqual([]);
  await assertPageHealthy(page);
  record("scenario-families", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    frozen_revision: run.scenario_revision_id,
    all_collections_frozen: true,
    all_six_resource_rails_visible_together: railBounds,
    synthetic_incident_count: planned.length,
    explicit_incident_mix_preserved: true,
    completed_inputs_immutable: true,
    page_errors: errors,
  });
});

test("scenario resource forms and independent inspector remain keyboard accessible on mobile", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile");
  const context = await scenario(page, "mobile exact scenario controls");
  await open(page, context.scenario.id, "overview");
  await page.getByRole("button", { name: "Hide scenario inspector" }).click();
  await expect(page.locator("#scenario-inspector-dock")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Planning timeline" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show scenario inspector" }).click();
  await page
    .getByRole("button", { name: "Add equipment availability", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Equipment quantity").fill("2");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  await expect(
    page.getByRole("button", {
      name: "Equipment availability Planning assumption",
      exact: true,
    }),
  ).toBeVisible();
  await assertPageHealthy(page);
  await capture(page, "scenario-mobile-resource-form", info);
});
