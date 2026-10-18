import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  api,
  capture,
  login,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";
import { expectFloorPlanAt } from "./replay-floorplan-helpers";

test("replay displays actual separate hospital capacity and no offsite inventory", async ({
  page,
}, info) => {
  const context = await scenario(page, "clinical replay capacity", {
    horizon_calendar_days: 1,
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
  await open(page, context.scenario.id, "replay", run.id);
  const state = await expectFloorPlanAt(
    page,
    run.selected_replication_id,
    run.start_at,
  );
  const wards = state.units.filter(
    (unit: any) => unit.kind === "ward" && unit.facility_id === "FAC-MAIN",
  );
  expect(wards).toHaveLength(3);
  for (const unit of wards) {
    const room = page.locator(
      `.floor-plan-unit[data-unit-id="${unit.unit_id}"]`,
    );
    await expect(
      room.locator('.floor-plan-bed[data-status="occupied"]'),
    ).toHaveCount(unit.occupied);
    await expect(room).toHaveAttribute("data-staffed", String(unit.staffed));
  }
  await expect(page.getByTestId("replay-floor-plan")).not.toContainText(
    /shelter|overflow|transport/i,
  );
  await capture(page, "replay-clinical-capacity", info);
  record("replay-clinical-capacity", {
    run: run.id,
    wards: wards.map((unit: any) => ({
      id: unit.unit_id,
      occupied: unit.occupied,
      staffed: unit.staffed,
    })),
    actual_separate_wards: true,
  });
});

test("replay holds a stepdown patient in the recorded ICU bed until actual ward entry", async ({
  page,
}, info) => {
  await login(page);
  const snapshot = JSON.parse(
    execFileSync(
      resolve(process.cwd(), "../../.venv/bin/python"),
      [
        "-c",
        `
import json
from test_stepdown_snapshot import stepdown_source
from surge_engine import run_replication,state_at
data=stepdown_source()
trace=run_replication(data,{'horizon_calendar_days':1})
state=state_at(trace,75)
data['snapshot_at']=state['at']
data['patients']=state['patients']
for patient in data['patients']:
    patient['source_type']='initial_census'
print(json.dumps(data))
`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONPATH: ["packages/engine", "apps/api", "tests"]
            .map((p) => resolve(process.cwd(), "../..", p))
            .join(":"),
        },
      },
    ),
  );
  const imported = await api(page.request, "/imports", "POST", {});
  const upload = await page.request.post(`/api/imports/${imported.id}/files`, {
    multipart: {
      file: {
        name: "dataset.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(snapshot)),
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const validation = await api(
    page.request,
    `/imports/${imported.id}/validate`,
    "POST",
    {},
  );
  expect(validation.valid, JSON.stringify(validation.errors)).toBeTruthy();
  const dataset = await api(
    page.request,
    `/imports/${imported.id}/commit`,
    "POST",
    {},
  );
  const plan = await api(page.request, "/scenarios", "POST", {
    name: "ICU stepdown recorded source location",
    dataset_version_id: dataset.id,
    horizon_calendar_days: 1,
    replications: 1,
    conditions: [],
  });
  const run = await waitRun(
    page,
    (await api(page.request, "/run-groups", "POST", { scenario_id: plan.id }))
      .id,
  );
  const rep = run.selected_replication_id;
  const state = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(run.start_at)}`,
  );
  expect(state.patient_total).toBe(1);
  const patient = state.patients[0];
  expect(patient.care_level).toBe("ward");
  expect(patient.stage_status).toBe("ready_to_exit");
  expect(patient.unit_id).toBe("UNIT-ICU");
  expect(state.patient_groups).toEqual([
    expect.objectContaining({
      unit_id: "UNIT-ICU",
      care_level: "ward",
      count: 1,
    }),
  ]);
  await open(page, plan.id, "replay", run.id);
  await expectFloorPlanAt(page, rep, run.start_at);
  const beforeBed = page.locator(
    `.floor-plan-bed[data-patient-id="${patient.patient_id}"]`,
  );
  await expect(beforeBed).toHaveCount(1);
  await expect(beforeBed).toHaveAttribute("data-unit-id", "UNIT-ICU");
  await expect(beforeBed).toHaveAttribute("data-status", "occupied");
  const detail = await api(
    page.request,
    `/runs/${rep}/patients/${patient.patient_id}?at=${encodeURIComponent(run.start_at)}`,
  );
  const wardEntry = detail.state_intervals.find(
    (interval: any) =>
      interval.state === "inpatient" && interval.unit_id !== "UNIT-ICU",
  );
  expect(wardEntry).toBeTruthy();
  await capture(page, "replay-stepdown-held-icu", info);
  const url = new URL(page.url());
  url.searchParams.set("at", wardEntry.start_at);
  url.searchParams.set("patient", patient.patient_id);
  await page.goto(url.toString());
  await expectFloorPlanAt(page, rep, wardEntry.start_at);
  const afterBed = page.locator(
    `.floor-plan-bed[data-patient-id="${patient.patient_id}"]`,
  );
  await expect(afterBed).toHaveCount(1);
  await expect(afterBed).toHaveAttribute("data-unit-id", wardEntry.unit_id);
  await expect(
    page.locator(
      `.floor-plan-unit[data-unit-id="UNIT-ICU"] .floor-plan-bed[data-patient-id="${patient.patient_id}"]`,
    ),
  ).toHaveCount(0);
  await capture(page, "replay-stepdown-actual-ward-bed", info);
  record("replay-held-unit", {
    run: run.id,
    before: { at: run.start_at, unit: "UNIT-ICU" },
    after: { at: wardEntry.start_at, unit: wardEntry.unit_id },
    actual_slot_identity: true,
  });
});
