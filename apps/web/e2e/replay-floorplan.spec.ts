import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import {
  expectFloorPlanAt,
  expectHospitalFlowGeometry,
  seekFloorPlan,
} from "./replay-floorplan-helpers";

test("floor plan separates actual wards and every bed, with meaningful bed, area and patient inspection", async ({
  page,
}, info) => {
  const context = await scenario(page, "recorded floor plan", {
    horizon_calendar_days: 2,
    replications: 1,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, context.scenario.id, "replay", run.id);
  const state = await expectFloorPlanAt(
    page,
    run.selected_replication_id,
    run.start_at,
  );
  const geometry = await expectHospitalFlowGeometry(page);
  await capture(page, "replay-hospital-footprint", info);
  for (const id of [
    "UNIT-WARD-A",
    "UNIT-WARD-B",
    "UNIT-WARD-C",
    "UNIT-ED",
    "UNIT-ICU",
  ])
    await expect(
      page.locator(`.floor-plan-unit[data-unit-id="${id}"]`),
    ).toBeVisible();
  const patientBed = state.slots.find(
    (slot: any) => slot.patient_id && slot.status === "occupied",
  );
  expect(patientBed).toBeTruthy();
  await page
    .locator(`.floor-plan-bed[data-slot-id="${patientBed.slot_id}"]`)
    .click();
  const detail = page.getByRole("dialog", { name: "Replay details" });
  await expect(detail).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("patient"))
    .toBe(patientBed.patient_id);
  await expect(detail.locator(".replay-patient-history")).toBeVisible();
  await page.keyboard.press("Escape");
  const readyBed = state.slots.find(
    (slot: any) => slot.status === "ready" && slot.enabled,
  );
  expect(readyBed).toBeTruthy();
  await page
    .locator(`.floor-plan-bed[data-slot-id="${readyBed.slot_id}"]`)
    .click();
  const resource = page.getByRole("dialog").filter({ hasText: "Bed enabled" });
  await expect(resource).toBeVisible();
  await expect(resource).toContainText("StatusReady");
  await page.keyboard.press("Escape");
  await page
    .locator(
      '.floor-plan-unit[data-unit-id="UNIT-ICU"] .floor-plan-unit-heading',
    )
    .click();
  await expect(detail).toBeVisible();
  await expect(detail.getByLabel("Replay resource unit")).toHaveValue(
    "UNIT-ICU",
  );
  const icu = state.units.find((unit: any) => unit.unit_id === "UNIT-ICU");
  await expect(detail).toContainText(
    `${icu.occupied} / ${icu.staffed} / ${icu.physical}`,
  );
  await page.keyboard.press("Escape");
  await page.getByTestId("floor-plan-ed-waiting").click();
  await expect(page.getByLabel("Replay census state filter")).toHaveValue(
    "ed_waiting",
  );
  await page.getByTestId("floor-plan-bed-waiting").click();
  await expect(page.getByLabel("Replay census state filter")).toHaveValue(
    "awaiting_bed",
  );
  await seekFloorPlan(page, run, 24 * 60);
  await page.getByTestId("floor-plan-discharges").click();
  await expect(detail.locator(".replay-discharge-history")).toBeVisible();
  await expect(
    detail
      .locator(".replay-discharge-history .replay-event-list > button")
      .first(),
  ).toBeVisible();
  await detail
    .locator(".replay-discharge-history .replay-event-list > button")
    .first()
    .click();
  await expect(
    detail.getByRole("tab", { name: "Patient", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(detail.locator(".replay-patient-history")).toBeVisible();
  await page.keyboard.press("Escape");
  await capture(page, "replay-floor-plan", info);
  expect(errors).toEqual([]);
  record("replay-floor-plan", {
    run: run.id,
    recorded_slots: state.slots.length,
    actual_wards: ["A", "B", "C"],
    patient_and_empty_bed_inspection: true,
    numeric_queue_and_discharge_areas: true,
    hospital_geometry: geometry,
    errors,
  });
});

test("current shortage pressure follows actual paused care and clears after recovery and backward seeks", async ({
  page,
}, info) => {
  const context = await scenario(page, "floor plan disruption pressure", {
    horizon_calendar_days: 2,
    replications: 1,
    hospital_operations: {
      disruptions: [
        {
          id: "floor-plan-closed",
          start_at: "2026-10-16T11:00:00Z",
          end_at: "2026-10-16T17:00:00Z",
          name: "Treatment pause",
        },
      ],
    },
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "replay", run.id);
  const before = await expectFloorPlanAt(
    page,
    run.selected_replication_id,
    run.start_at,
  );
  await seekFloorPlan(page, run, 8 * 60);
  const paused = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(new Date(Date.parse(run.start_at) + 8 * 3600000).toISOString())}`,
  );
  expect(
    Object.values(paused.blocker_counts_by_unit).some(
      (reasons: any) => reasons.treatment_disruption > 0,
    ),
  ).toBe(true);
  const planNode = await page.getByTestId("replay-floor-plan").elementHandle();
  await seekFloorPlan(page, run, 20 * 60);
  const recovered = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(new Date(Date.parse(run.start_at) + 20 * 3600000).toISOString())}`,
  );
  expect(
    Object.values(recovered.blocker_counts_by_unit).every(
      (reasons: any) => !reasons.treatment_disruption,
    ),
  ).toBe(true);
  await seekFloorPlan(page, run, 0);
  expect(
    await page
      .getByTestId("replay-floor-plan")
      .evaluate((node, old) => node === old, planNode),
  ).toBe(true);
  await expect(page.getByTestId("floor-plan-discharges")).toHaveAttribute(
    "data-count",
    String(before.flow_counts["FAC-MAIN"].discharges),
  );
  await capture(page, "replay-floor-plan-recovery", info);
});

test("editable bed and staffed-bed parameters rebuild replay inventory per frozen run", async ({
  page,
}, info) => {
  const context = await scenario(page, "floor plan editable beds", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  await open(page, context.scenario.id, "overview");
  const controls = page.locator("#hospital-capacity-parameters");
  async function configure(physical: number, staffed: number) {
    await controls.getByRole("radio", { name: "Ward A", exact: true }).check();
    const total = controls.getByLabel("Ward A installed beds", { exact: true });
    await total.fill(String(physical));
    await total.press("Tab");
    const supported = controls.getByLabel("Ward A staffed beds", {
      exact: true,
    });
    await supported.fill(String(staffed));
    await supported.press("Tab");
    const save = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/scenarios/${context.scenario.id}`) &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const saved = await save;
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await expect(
      page.getByText("Unsaved changes", { exact: true }),
    ).toHaveCount(0);
    const submit = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/run-groups") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run simulation", exact: true })
      .click();
    const queued = await submit;
    expect(queued.ok(), await queued.text()).toBeTruthy();
    return waitRun(page, (await queued.json()).id);
  }
  const first = await configure(48, 36);
  await open(page, context.scenario.id, "replay", first.id);
  const firstState = await expectFloorPlanAt(
    page,
    first.selected_replication_id,
    first.start_at,
  );
  const ward = page.locator('.floor-plan-unit[data-unit-id="UNIT-WARD-A"]');
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(48);
  await expect(ward).toHaveAttribute("data-staffed", "36");
  await expectHospitalFlowGeometry(page);
  const firstWard = firstState.units.find(
    (unit: any) => unit.unit_id === "UNIT-WARD-A",
  );
  await expect(ward).toHaveAttribute(
    "data-available",
    String(firstWard.available),
  );
  expect(firstWard.physical).toBe(48);
  await open(page, context.scenario.id, "overview", first.id);
  const second = await configure(44, 32);
  await open(page, context.scenario.id, "replay", second.id);
  const secondState = await expectFloorPlanAt(
    page,
    second.selected_replication_id,
    second.start_at,
  );
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(44);
  await expect(ward).toHaveAttribute("data-staffed", "32");
  await expectHospitalFlowGeometry(page);
  const secondWard = secondState.units.find(
    (unit: any) => unit.unit_id === "UNIT-WARD-A",
  );
  await expect(ward).toHaveAttribute(
    "data-available",
    String(secondWard.available),
  );
  // Reopen the old saved result after the draft and newer result have changed.
  await open(page, context.scenario.id, "replay", first.id);
  await expectFloorPlanAt(page, first.selected_replication_id, first.start_at);
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(48);
  await expect(ward).toHaveAttribute("data-staffed", "36");
  await expectHospitalFlowGeometry(page);
  await expect(ward).toHaveAttribute(
    "data-available",
    String(firstWard.available),
  );
  expect(
    (await api(page.request, `/run-groups/${first.id}`)).input_sha256,
  ).toBe(first.input_sha256);
  await capture(page, "replay-frozen-editable-beds", info);
  record("replay-editable-beds", {
    first: {
      id: first.id,
      physical: firstWard.physical,
      staffed: firstWard.staffed,
      available: firstWard.available,
    },
    second: {
      id: second.id,
      physical: secondWard.physical,
      staffed: secondWard.staffed,
      available: secondWard.available,
    },
    old_result_preserved: true,
  });
});

test("a 100-bed ward reflows inside a compact architectural map without overflowing its walls", async ({
  page,
}, info) => {
  const context = await scenario(page, "100-bed floor plan", {
    horizon_calendar_days: 1,
    replications: 1,
    conditions: [
      {
        id: "large-ward",
        kind: "unit_configuration",
        unit_id: "UNIT-WARD-A",
        physical_capacity: 100,
        enabled_capacity: 100,
        staffed_capacity: 80,
        staff_counts: { rn: 20, provider: 3, support: 4 },
      },
    ],
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  const ward = page.locator('.floor-plan-unit[data-unit-id="UNIT-WARD-A"]');
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(100);
  await expect(ward).toHaveAttribute("data-physical", "100");
  await expect(ward).toHaveAttribute("data-staffed", "80");
  const geometry = await ward.evaluate((room) => {
    const wall = room.getBoundingClientRect(),
      building = room.closest(".floor-plan-building")!.getBoundingClientRect();
    return {
      mapHeight: building.height,
      overflow: [...room.querySelectorAll(".floor-plan-bed")].filter((bed) => {
        const rect = bed.getBoundingClientRect();
        return (
          rect.left < wall.left ||
          rect.right > wall.right ||
          rect.top < wall.top ||
          rect.bottom > wall.bottom
        );
      }).length,
      detail: [...room.querySelectorAll(".floor-plan-bed")].some(
        (bed) => bed.children.length || bed.textContent?.trim(),
      ),
    };
  });
  expect(geometry).toMatchObject({ overflow: 0, detail: false });
  expect(geometry.mapHeight).toBeLessThan(700);
  const hospitalGeometry = await expectHospitalFlowGeometry(page);
  await capture(page, "replay-100-bed-map", info);
  record("replay-100-bed-map", {
    run: run.id,
    ...geometry,
    hospital_geometry: hospitalGeometry,
  });
});
