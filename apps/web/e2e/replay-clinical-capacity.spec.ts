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

test("replay displays only the simulated hospital capacity", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    (window as any).__clinicalCapacityPaints = [];
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof fillText>
    ) {
      if (this.canvas.classList.contains("replay-canvas")) {
        const paints = (window as any).__clinicalCapacityPaints as string[];
        paints.push(String(args[0]));
        if (paints.length > 2000) paints.splice(0, paints.length - 2000);
      }
      return fillText.apply(this, args);
    };
  });
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
  const state = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(run.start_at)}`,
  );
  const ward = state.units.filter(
    (unit: any) => unit.kind === "ward" && unit.facility_id === "FAC-MAIN",
  );
  const totals = ward.reduce(
    (sum: any, unit: any) => ({
      occupied: sum.occupied + unit.occupied,
      staffed: sum.staffed + unit.staffed,
      background: sum.background + unit.background_occupied,
    }),
    { occupied: 0, staffed: 0, background: 0 },
  );
  expect(totals.occupied).toBeGreaterThan(0);
  expect(totals.staffed).toBeGreaterThanOrEqual(totals.occupied);
  await open(page, context.scenario.id, "replay", run.id);
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-recorded-at",
    new Date(run.start_at).toISOString(),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__clinicalCapacityPaints))
    .toContain(`${totals.occupied}/${totals.staffed} occupied / staffed`);
  const paints: string[] = await page.evaluate(
    () => (window as any).__clinicalCapacityPaints,
  );
  expect(paints.some((text) => /shelter|overflow|transport/i.test(text))).toBe(
    false,
  );
  await capture(page, "replay-clinical-capacity", info);
  record("replay-clinical-capacity", {
    run_id: run.id,
    replication_id: run.selected_replication_id,
    at: run.start_at,
    ward: totals,
    only_main_hospital_included: true,
    actual_canvas_label: `${totals.occupied}/${totals.staffed}`,
  });
});

test("replay holds a stepdown patient and care path in ICU until actual ward entry", async ({
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
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    let path: { x: number; y: number }[] = [];
    const fillRect = proto.fillRect,
      beginPath = proto.beginPath,
      moveTo = proto.moveTo,
      lineTo = proto.lineTo,
      arc = proto.arc,
      stroke = proto.stroke;
    (window as any).__heldPaint = { dots: [], path: [] };
    proto.fillRect = function (...args: Parameters<typeof fillRect>) {
      if (
        this.canvas.classList.contains("replay-canvas") &&
        args[0] === 0 &&
        args[1] === 0
      )
        (window as any).__heldPaint = {
          dots: [],
          path: [],
          height: this.canvas.height / devicePixelRatio,
        };
      return fillRect.apply(this, args);
    };
    proto.beginPath = function () {
      path = [];
      return beginPath.call(this);
    };
    proto.moveTo = function (x, y) {
      path.push({ x, y });
      return moveTo.call(this, x, y);
    };
    proto.lineTo = function (x, y) {
      path.push({ x, y });
      return lineTo.call(this, x, y);
    };
    proto.arc = function (...args: Parameters<typeof arc>) {
      if (
        this.canvas.classList.contains("replay-canvas") &&
        (args[2] === 3 || args[2] === 5.5)
      )
        (window as any).__heldPaint.dots.push({ x: args[0], y: args[1] });
      return arc.apply(this, args);
    };
    proto.stroke = function (...args: Parameters<typeof stroke>) {
      if (
        this.canvas.classList.contains("replay-canvas") &&
        this.strokeStyle === "#0e849a"
      )
        (window as any).__heldPaint.path = [...path];
      return stroke.apply(this, args);
    };
  });
  await open(page, plan.id, "replay", run.id);
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-recorded-at",
    new Date(run.start_at).toISOString(),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__heldPaint.dots.length))
    .toBe(1);
  const initial = await page.evaluate(() => (window as any).__heldPaint);
  expect(initial.dots[0].x).toBeGreaterThan(655);
  expect(initial.dots[0].x).toBeLessThan(805);
  expect((initial.dots[0].y / initial.height) * 620).toBeGreaterThan(320);
  expect((initial.dots[0].y / initial.height) * 620).toBeLessThan(490);
  await capture(page, "replay-stepdown-held-icu", info);
  const detail = await api(
    page.request,
    `/runs/${rep}/patients/${patient.patient_id}?at=${encodeURIComponent(run.start_at)}`,
  );
  const wardEntry = detail.state_intervals.find(
    (interval: any) =>
      interval.state === "inpatient" && interval.unit_id !== "UNIT-ICU",
  );
  expect(wardEntry).toBeTruthy();
  const url = new URL(page.url());
  url.searchParams.set("at", wardEntry.start_at);
  url.searchParams.set("patient", patient.patient_id);
  await page.goto(url.toString());
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-recorded-at",
    new Date(wardEntry.start_at).toISOString(),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__heldPaint.path.length))
    .toBeGreaterThanOrEqual(2);
  const entered = await page.evaluate(() => (window as any).__heldPaint);
  expect(entered.dots).toHaveLength(1);
  expect((entered.dots[0].y / entered.height) * 620).toBeLessThan(280);
  expect((entered.path[0].y / entered.height) * 620).toBeGreaterThan(320);
  expect((entered.path.at(-1).y / entered.height) * 620).toBeLessThan(280);
  await capture(page, "replay-stepdown-actual-ward-path", info);
  record("replay-held-unit", {
    run_id: run.id,
    source: {
      at: run.start_at,
      unit_id: patient.unit_id,
      requested_care: patient.care_level,
      canvas: initial,
    },
    destination: {
      at: wardEntry.start_at,
      unit_id: wardEntry.unit_id,
      canvas: entered,
    },
  });
});
