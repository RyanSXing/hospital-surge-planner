import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

test("configure, compute, inspect, compare, update, replay and export", async ({
  page,
}, info) => {
  test.setTimeout(process.env.E2E_BASE_URL ? 900000 : 180000);
  test.skip(
    info.project.name === "mobile",
    "Full computational workflow runs on desktop; every screen is audited on mobile separately.",
  );
  const errors: string[] = [];
  const workflowDays = Number(process.env.E2E_WORKFLOW_DAYS || 3);
  expect(
    Number.isInteger(workflowDays) && workflowDays >= 1 && workflowDays <= 365,
  ).toBe(true);
  page.on("pageerror", (e) => errors.push(e.message));
  const context = await scenario(page, "complete workflow");
  console.log("workflow: created", context.scenario.id);
  await open(page, context.scenario.id, "overview");
  console.log("workflow: scenario screen loaded");
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill(
      process.env.E2E_SCENARIO_NAME || "E2E 70 percent surge " + Date.now(),
    );
  await page.getByLabel("Increase in ED arrivals").fill("70");
  await page.getByLabel("Planning horizon").fill(String(workflowDays));
  await page.getByLabel("Simulation runs").selectOption("10");
  console.log("workflow: fields configured");
  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/run-groups") && r.request().method() === "POST",
    { timeout: 30000 },
  );
  await page
    .locator(".scenarios-page .heading-actions")
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  console.log("workflow: submit clicked");
  const queued = await (await submitted).json();
  console.log("workflow: queued", queued.id);
  const savedInputs = await api(
    page.request,
    "/scenarios/" + context.scenario.id,
  );
  const savedArrival = savedInputs.conditions.find(
    (c: any) =>
      c.kind === "arrival_multiplier" && c.entry_stream_id === "ED_MAIN",
  );
  expect(savedInputs.horizon_calendar_days).toBe(workflowDays);
  expect(savedArrival).toMatchObject({ surge_percent: 70, shape: "step" });
  expect(savedArrival.control_points.map((p: any) => p.multiplier)).toEqual([
    1.7, 1.7,
  ]);
  const frozenInputs = savedInputs.revisions.find(
    (r: any) => r.id === queued.scenario_revision_id,
  );
  expect(
    frozenInputs,
    "The run must freeze the browser-edited 70% input",
  ).toBeTruthy();
  expect(frozenInputs.conditions).toEqual(savedInputs.conditions);
  expect(frozenInputs.horizon_calendar_days).toBe(workflowDays);
  const run = await waitRun(page, queued.id);
  console.log("workflow: run complete");
  const frozen = await api(page.request, "/run-groups/" + run.id);
  expect(frozen.replications_completed || frozen.completed).toBe(10);
  await open(page, context.scenario.id, "analytics-patients", run.id);
  await page.locator(".patient-table tbody .link-button").first().click();
  await expect(page.locator(".patient-inspector")).toContainText(
    "SELECTED PATIENT",
  );
  await capture(page, "workflow-patient", info);
  await open(page, context.scenario.id, "comparison", run.id);
  await page.getByLabel("Comparison simulation runs").selectOption("10");
  const compared = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/comparisons") && r.request().method() === "POST",
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "Evaluate responses", exact: true })
    .click();
  const comparison = await (await compared).json();
  let result: any;
  await expect
    .poll(
      async () => {
        result = await api(page.request, "/comparisons/" + comparison.id);
        return result.status;
      },
      {
        timeout: process.env.E2E_BASE_URL ? 300000 : 150000,
        intervals: [1000, 2000],
      },
    )
    .toBe("SUCCEEDED");
  for (const [index, plan] of result.plans.entries()) {
    const last = plan.metrics.series.at(-1);
    const card = page.locator(".capacity-plan-cards .plan-card").nth(index);
    await expect(card.locator(".micro-label")).toContainText("HORIZON END");
    await expect(card.locator(".capacity-diagram")).toHaveAttribute(
      "aria-label",
      `${Math.round(last.ward_physical.p50)} physical ward places; ${Math.round(last.ward_staffed.p50)} staffing-supported; capacity diagram without patient assignments`,
    );
  }
  expect(result.plans.length).toBe(3);
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Comparison chart metric")
    .selectOption("ward_occupied");
  await page.getByLabel("Comparison uncertainty band").selectOption("plan_2");
  await expect(page.locator(".comparison-chart")).toContainText(
    "Ward occupancy",
  );
  await page
    .getByLabel("Comparison chart metric")
    .selectOption("inpatient_queue");
  await capture(page, "workflow-comparison", info);
  await page
    .getByText("Full outcome metrics & resource assumptions", { exact: true })
    .click();
  await expect(page.locator(".comparison-metrics")).toContainText(
    "Interfacility transfers",
  );
  await page
    .getByRole("button", { name: "Open in summary", exact: true })
    .last()
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(result.plans.at(-1).run_group_id);
  await expect(page.locator(".evaluated-plan-banner")).toContainText(
    result.plans.at(-1).name,
  );
  await page.getByRole("button", { name: "Return to comparison" }).click();
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select response", exact: true })
    .last()
    .click();
  const saved = page.waitForResponse(
    (r) => r.url().includes("/save-plan") && r.request().method() === "POST",
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "Save selected plan", exact: true })
    .click();
  expect((await saved).ok()).toBeTruthy();
  await open(page, context.scenario.id, "summary", run.id);
  await page.getByRole("button", { name: "Record update" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Additional patients")).toBeVisible();
  await dialog.getByLabel("Additional patients").fill("5");
  await dialog.getByLabel("Future repetitions").selectOption("1");
  await dialog
    .getByLabel("Source and explanation")
    .fill("Synthetic browser acceptance arrival batch.");
  const updated = page.waitForResponse(
    (r) =>
      r.url().includes("/updates/") &&
      r.url().endsWith("/apply") &&
      r.request().method() === "POST",
    { timeout: 30000 },
  );
  await dialog
    .getByRole("button", { name: "Save & reforecast", exact: true })
    .click();
  const updateResponse = await updated;
  expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
  const branch = await updateResponse.json();
  const branchRun = branch.run_group || branch.run;
  expect(branchRun?.id).toBeTruthy();
  await waitRun(page, branchRun.id);
  await open(page, context.scenario.id, "replay", run.id);
  await expect(page.getByLabel("Next recorded event")).toBeEnabled();
  await page.getByLabel("Next recorded event").click();
  await expect(page.locator(".event-feed .info-note")).toContainText("Event");
  await page.getByLabel("Return to run start").click();
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect(page.getByLabel("Pause replay")).toBeVisible();
  await page.getByLabel("Pause replay").click();
  await expect(
    page.getByRole("heading", { name: /Accessible replay census/ }),
  ).toBeVisible();
  await capture(page, "workflow-replay", info);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate export", exact: true })
    .click();
  await expect(page.getByRole("link", { name: "Download export" })).toBeVisible(
    { timeout: 45000 },
  );
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download export" }).click();
  const file = await download;
  const exportPath = info.outputPath("planning-export.zip");
  await file.saveAs(exportPath);
  expect(await file.failure()).toBeNull();
  const exportChecksums = JSON.parse(
    execFileSync(
      resolve(process.cwd(), "../../.venv/bin/python"),
      [
        "-c",
        `import hashlib,json,sys,zipfile
from pathlib import Path
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
path=Path(sys.argv[1])
with zipfile.ZipFile(path) as bundle:
    names=[name for name in bundle.namelist() if not name.endswith('/')]
    assert len(names)==len(set(names)), 'Duplicate ZIP member'
    checksums=json.loads(bundle.read('checksums.json'))
    assert set(checksums)==set(names)-{'checksums.json'}, 'Checksum coverage differs from ZIP contents'
    for name,expected in checksums.items():
        assert hashlib.sha256(bundle.read(name)).hexdigest()==expected, 'Checksum mismatch: '+name
    scenario=json.loads(bundle.read('scenario.json'))
    assert scenario['horizon_calendar_days']==int(sys.argv[2]), 'Export must contain the selected calendar horizon'
    arrival=next((c for c in scenario['conditions'] if c.get('kind')=='arrival_multiplier' and c.get('entry_stream_id')=='ED_MAIN'),None)
    assert arrival and arrival.get('surge_percent')==70, 'Export must contain the browser-created 70% surge'
    assert [p['multiplier'] for p in arrival['control_points']]==[1.7,1.7], 'Export must contain actual modeled multipliers'
    start=datetime.fromisoformat(scenario['start_at'].replace('Z','+00:00'))
    expected_end=start.astimezone(ZoneInfo(scenario['timezone']))+timedelta(days=int(sys.argv[2]))
    assert datetime.fromisoformat(arrival['control_points'][0]['at'].replace('Z','+00:00'))==start
    assert datetime.fromisoformat(arrival['control_points'][-1]['at'].replace('Z','+00:00'))==expected_end, 'Arrival increase must span the full chosen calendar horizon'
    print(json.dumps({'exported_arrival_condition':arrival,'all_checksums_verified':True,'complete_member_coverage':True,'files':names,'archive_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'archive_bytes':path.stat().st_size}))
`,
        exportPath,
        String(workflowDays),
      ],
      { encoding: "utf8" },
    ),
  );
  expect(exportChecksums.all_checksums_verified).toBe(true);
  expect(errors).toEqual([]);
  record("workflow", {
    scenario_id: context.scenario.id,
    horizon_calendar_days: workflowDays,
    run_id: run.id,
    comparison_id: comparison.id,
    saved_arrival_condition: savedArrival,
    frozen_scenario_revision_id: frozenInputs.id,
    saved_and_frozen_conditions_equal: true,
    branch_run_id: branchRun.id,
    export_filename: file.suggestedFilename(),
    export_checksums: exportChecksums,
    page_errors: errors,
  });
});
