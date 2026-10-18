import { expect, test, type Locator } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

async function setSlider(slider: Locator, count: number) {
  await slider.focus();
  await slider.press("Home");
  for (let i = 0; i < count; i++) await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", String(count));
}

test("desktop configuration saves editable beds and all staff roles into a real immutable simulation", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "This acceptance flow targets the requested desktop interface.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "editable hospital capacity", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  const source = await api(page.request, `/datasets/${context.dataset.id}`);
  const sourceIcu = source.units.find((u: any) => u.unit_id === "UNIT-ICU");
  expect(sourceIcu.baseline_staff.rn).toBe(6);
  expect(sourceIcu.baseline_staff.provider).toBe(1);
  await open(page, context.scenario.id, "overview");
  await expect(
    page.getByRole("heading", { name: "Configuration", exact: true }),
  ).toBeVisible();
  const controls = page.locator("#hospital-capacity-parameters");
  await controls.getByText("ICU", { exact: true }).click();
  await expect(
    controls.getByRole("radio", { name: "ICU", exact: true }),
  ).toBeChecked();
  const totalBeds = controls.getByLabel(`${sourceIcu.name} installed beds`, {
    exact: true,
  });
  const staffedBeds = controls.getByLabel(`${sourceIcu.name} staffed beds`, {
    exact: true,
  });
  const nurses = controls.getByLabel(`${sourceIcu.name} registered nurses`, {
    exact: true,
  });
  await expect(totalBeds).toHaveValue("12");
  await totalBeds.fill("20");
  await totalBeds.press("Tab");
  await staffedBeds.fill("18");
  await staffedBeds.press("Tab");
  await expect(nurses).toHaveValue("9");
  await controls
    .getByRole("status")
    .getByText("16 beds supported", { exact: true })
    .waitFor();
  await expect(controls.getByRole("status")).toContainText("equipment limits");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(totalBeds).toHaveValue("20");
  await expect(staffedBeds).toHaveValue("12");
  await expect(nurses).toHaveValue("6");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(staffedBeds).toHaveValue("18");
  await expect(nurses).toHaveValue("9");

  await setSlider(
    controls.getByRole("slider", {
      name: `${sourceIcu.name} registered nurses per shift`,
      exact: true,
    }),
    10,
  );
  await setSlider(
    controls.getByRole("slider", {
      name: `${sourceIcu.name} doctors & providers per shift`,
      exact: true,
    }),
    3,
  );
  await setSlider(
    controls.getByRole("slider", {
      name: `${sourceIcu.name} support staff per shift`,
      exact: true,
    }),
    4,
  );
  await expect(nurses).toHaveValue("10");
  await expect(staffedBeds).toHaveValue("20");
  await staffedBeds.fill("18");
  await staffedBeds.press("Tab");
  await expect(nurses).toHaveValue("9");
  await expect(
    controls.getByLabel(`${sourceIcu.name} doctors & providers`, {
      exact: true,
    }),
  ).toHaveValue("3");
  await expect(
    controls.getByLabel(`${sourceIcu.name} support staff`, { exact: true }),
  ).toHaveValue("4");
  await expect(controls.getByRole("status")).toContainText("16 beds supported");
  // Patient-type and stay controls were explicitly removed from this change.
  await expect(controls).not.toContainText(
    /terminal|patient types|length of stay|discharge rate/i,
  );
  await assertPageHealthy(page);
  await capture(page, "configuration-capacity", info);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  const config = saved.conditions.find(
    (c: any) => c.kind === "unit_configuration",
  );
  expect(config).toMatchObject({
    unit_id: "UNIT-ICU",
    physical_capacity: 20,
    enabled_capacity: 20,
    staffed_capacity: 18,
    staff_counts: { rn: 9, provider: 3, support: 4 },
  });
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await controls.getByText("ICU", { exact: true }).click();
  await expect(
    controls.getByRole("radio", { name: "ICU", exact: true }),
  ).toBeChecked();
  await expect(totalBeds).toHaveValue("20");
  await expect(staffedBeds).toHaveValue("18");
  await expect(nurses).toHaveValue("9");
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  const queuedResponse = await submitted;
  expect(queuedResponse.ok(), await queuedResponse.text()).toBeTruthy();
  const run = await waitRun(page, (await queuedResponse.json()).id);
  expect(run.replications_completed || run.completed).toBe(1);
  expect(
    run.scenario_context.conditions.find(
      (c: any) => c.kind === "unit_configuration",
    ),
  ).toEqual(config);
  const rep = run.selected_replication_id;
  const snapshots: any[] = [];
  for (const hours of [0, 7, 12, 19, 23]) {
    const at = new Date(
      Date.parse(run.start_at) + hours * 3600000,
    ).toISOString();
    const state = await api(
      page.request,
      `/runs/${rep}/state?at=${encodeURIComponent(at)}`,
    );
    const icu = state.units.find((u: any) => u.unit_id === "UNIT-ICU");
    expect(icu).toMatchObject({
      physical: 20,
      enabled: 20,
      staffed: 16,
      qualified_staff_by_role: { rn: 9, provider: 3, support: 4 },
      admission_gate: true,
    });
    expect(icu.active_staff_ids).toHaveLength(16);
    expect(icu.equipment.ICU_MONITOR.quantity).toBe(16);
    snapshots.push({
      at,
      physical: icu.physical,
      staffed: icu.staffed,
      qualified_staff_by_role: icu.qualified_staff_by_role,
    });
  }
  expect(await api(page.request, `/datasets/${context.dataset.id}`)).toEqual(
    source,
  );
  expect(errors).toEqual([]);
  record(`configuration-controls-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    source_dataset_unchanged: true,
    saved_and_reloaded: true,
    undo_redo: true,
    equipment_cap_displayed: 16,
    frozen_configuration: config,
    verified_shift_snapshots: snapshots,
    page_errors: errors,
  });
});
