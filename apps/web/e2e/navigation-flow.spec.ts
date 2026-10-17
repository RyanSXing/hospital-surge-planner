import { test, expect, type Page, type Route } from "@playwright/test";
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

const contextKeys = [
  "scenario",
  "dataset",
  "run",
  "replication",
  "at",
  "facility",
  "grain",
  "patient",
  "unit",
  "resource",
  "resource_type",
  "comparison",
] as const;
function selection(page: Page) {
  const params = new URL(page.url()).searchParams;
  return Object.fromEntries(contextKeys.map((key) => [key, params.get(key)]));
}
async function expectRoute(
  page: Page,
  view: string,
  analysis?: string,
  section?: string,
) {
  await expect
    .poll(() => {
      const p = new URL(page.url()).searchParams;
      return [p.get("view"), p.get("analysis"), p.get("section")];
    })
    .toEqual([view, analysis || null, section || null]);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
}
async function primary(
  page: Page,
  name: "Overview" | "Analysis",
  touch = false,
) {
  const button = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true });
  const menu = page.getByRole("button", { name: "Toggle navigation" });
  if (
    (await menu.isVisible()) &&
    !(await page
      .locator(".sidebar")
      .evaluate((element) => element.classList.contains("open")))
  ) {
    if (touch) await menu.tap();
    else await menu.click();
  }
  if (touch) await button.tap();
  else await button.click();
}
async function analysis(page: Page, name: string, touch = false) {
  const button = page
    .getByRole("navigation", { name: "Analysis navigation" })
    .getByRole("button", { name, exact: true });
  if (touch) await button.tap();
  else await button.click();
  await expect(button).toHaveAttribute("aria-current", "page");
}
async function baseline(page: Page) {
  const region = page.locator(".planning-baseline");
  return {
    dataset: await region.getAttribute("data-baseline-dataset"),
    at: await region.getAttribute("data-baseline-at"),
    metrics: await region.locator(".planning-baseline-metrics").innerText(),
    census: await region.locator(".planning-baseline-identity").innerText(),
  };
}

test("Overview setup to complete Analysis workflow preserves baseline and browser context", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Complete 3-day/10-run compute is covered on desktop; touch navigation is separate.",
  );
  test.setTimeout(process.env.E2E_BASE_URL ? 900000 : 300000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "navigation full flow");
  await open(page, context.scenario.id, "overview");
  await expect(
    page.getByRole("heading", { name: "Hospital overview", exact: true }),
  ).toBeVisible();
  const source = await baseline(page),
    name = "E2E navigation surge " + Date.now();
  await page.getByLabel("Scenario name", { exact: true }).fill(name);
  await page.getByLabel("Increase in ED arrivals").fill("70");
  await page.getByLabel("Planning horizon").fill("3");
  await page
    .getByRole("combobox", { name: "Simulation runs", exact: true })
    .selectOption("10");
  const original = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(original.revision).toBe(context.scenario.revision);
  expect(original.name).toBe(context.scenario.name);
  await primary(page, "Analysis");
  await expectRoute(page, "analysis", "summary");
  await expect(
    page
      .getByRole("navigation", { name: "Analysis navigation" })
      .getByRole("button"),
  ).toHaveText(["Summary", "Replay", "Analytics", "Comparison"]);
  await primary(page, "Overview");
  await expectRoute(page, "overview");
  await expect(page.getByLabel("Scenario name", { exact: true })).toHaveValue(
    name,
  );
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("70");
  await expect(page.getByLabel("Planning horizon")).toHaveValue("3");
  expect(await baseline(page)).toEqual(source);
  // A dialog retained inside hidden Overview must not capture keyboard input.
  await page
    .getByRole("button", { name: "Scenario library", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expectRoute(page, "analysis", "summary");
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await mainNav.getByRole("button", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    mainNav.getByRole("button", { name: "Analysis", exact: true }),
  ).toBeFocused();
  await page.goForward();
  await expectRoute(page, "overview");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("70");

  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/run-groups") && r.request().method() === "POST",
  );
  await page
    .locator(".scenarios-page .heading-actions")
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  const response = await submitted;
  expect(response.ok(), await response.text()).toBeTruthy();
  const queued = await response.json();
  await expectRoute(page, "analysis", "summary");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(queued.id);
  const run = await waitRun(page, queued.id);
  expect(run.completed || run.replications_completed).toBe(10);
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(saved.horizon_calendar_days).toBe(3);
  expect(
    saved.conditions.find(
      (c: any) =>
        c.kind === "arrival_multiplier" && c.entry_stream_id === "ED_MAIN",
    ),
  ).toMatchObject({ surge_percent: 70 });
  await expect(page.locator(".overview-page:visible .kpi-strip")).toBeVisible();
  await page
    .locator(".overview-page:visible")
    .getByLabel("Next day", { exact: true })
    .click();
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBeGreaterThan(Date.parse(run.start_at));
  const selectedAt = new URL(page.url()).searchParams.get("at")!;
  await primary(page, "Overview");
  expect(await baseline(page)).toEqual(source);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Generate export", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const alertsLoaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/alerts",
  );
  await page
    .getByRole("button", { name: "Planning alerts", exact: true })
    .click();
  const alertsResponse = await alertsLoaded;
  expect(alertsResponse.ok()).toBeTruthy();
  const alertParams = new URL(alertsResponse.url()).searchParams;
  expect(alertParams.get("run_group_id")).toBe(run.id);
  expect(alertParams.get("replication_id")).toBe(run.selected_replication_id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await primary(page, "Analysis");
  await expectRoute(page, "analysis", "summary");
  expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);

  // Context keys refer to real entities from the selected frozen trajectory.
  const state = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(selectedAt)}`,
  );
  const patient = state.patients.find(
    (p: any) => p.facility_id === "FAC-MAIN" && p.unit_id,
  );
  expect(patient).toBeTruthy();
  const summary = await api(
    page.request,
    `/workspaces/workspace-main/summary?run_group_id=${run.id}`,
  );
  const pool =
    summary.dataset.equipment_pools.find(
      (p: any) => p.unit_id === patient.unit_id,
    ) || summary.dataset.equipment_pools[0];
  expect(pool).toBeTruthy();
  const deep = new URL(page.url());
  Object.entries({
    view: "analysis",
    analysis: "analytics",
    section: "patients",
    replication: run.selected_replication_id,
    patient: patient.patient_id,
    unit: patient.unit_id,
    resource: pool.equipment_pool_id || pool.id,
    resource_type: "equipment_pool",
  }).forEach(([k, v]) => deep.searchParams.set(k, String(v)));
  await page.goto(deep.href);
  await expectRoute(page, "analysis", "analytics", "patients");
  await expect(page.locator(".patient-inspector")).toContainText(
    patient.patient_id,
  );
  const held = selection(page);
  for (const key of contextKeys.filter((k) => k !== "comparison"))
    expect(held[key], key).toBeTruthy();
  await page
    .getByRole("navigation", { name: "Analytics sections" })
    .getByRole("button", { name: "Resources", exact: true })
    .click();
  await expectRoute(page, "analysis", "analytics", "resources");
  expect(selection(page)).toEqual(held);
  await page.reload();
  await expectRoute(page, "analysis", "analytics", "resources");
  await expect(page.locator(".resources-page:visible")).toBeVisible();
  expect(selection(page)).toEqual(held);
  await page.goBack();
  await expectRoute(page, "analysis", "analytics", "patients");
  expect(selection(page)).toEqual(held);
  await page.goForward();
  await expectRoute(page, "analysis", "analytics", "resources");
  expect(selection(page)).toEqual(held);
  await analysis(page, "Replay");
  await expectRoute(page, "analysis", "replay");
  expect(selection(page)).toEqual(held);
  await analysis(page, "Summary");
  await expectRoute(page, "analysis", "summary");
  expect(selection(page)).toEqual(held);
  await primary(page, "Overview");
  expect(await baseline(page)).toEqual(source);
  await page.goBack();
  await expectRoute(page, "analysis", "summary");
  expect(selection(page)).toEqual(held);
  await page.goForward();
  await expectRoute(page, "overview");
  expect(await baseline(page)).toEqual(source);
  await primary(page, "Analysis");

  await analysis(page, "Comparison");
  await expectRoute(page, "analysis", "comparison");
  await page.getByLabel("Comparison simulation runs").selectOption("10");
  const compared = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/comparisons") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Evaluate responses", exact: true })
    .click();
  const comparisonResponse = await compared;
  expect(comparisonResponse.ok(), await comparisonResponse.text()).toBeTruthy();
  const comparison = await comparisonResponse.json();
  let evaluated: any;
  await expect
    .poll(
      async () => {
        evaluated = await api(page.request, "/comparisons/" + comparison.id);
        return evaluated.status;
      },
      {
        timeout: process.env.E2E_BASE_URL ? 300000 : 150000,
        intervals: [500, 1000, 2000],
      },
    )
    .toBe("SUCCEEDED");
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => selection(page).comparison).toBe(comparison.id);
  const comparisonContext = selection(page);
  expect(comparisonContext.comparison).toBe(comparison.id);
  const plan = evaluated.plans.at(-1);
  await page.locator(".comparison-metrics > summary").click();
  await page
    .getByRole("button", { name: "Open in summary", exact: true })
    .last()
    .click();
  await expectRoute(page, "analysis", "summary");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(plan.run_group_id);
  await expect(page.locator(".evaluated-plan-banner")).toContainText(plan.name);
  await page.reload();
  await expectRoute(page, "analysis", "summary");
  await expect(page.locator(".evaluated-plan-banner")).toContainText(plan.name);
  const planContext = selection(page);
  await page.goBack();
  await expectRoute(page, "analysis", "comparison");
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  expect(selection(page)).toEqual(comparisonContext);
  await page.goForward();
  await expectRoute(page, "analysis", "summary");
  await expect.poll(() => selection(page)).toEqual(planContext);

  // A slower Back response must not overwrite a later Forward navigation.
  let delayed = false;
  let release!: () => void;
  let delivered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const summaryPattern = "**/api/workspaces/workspace-main/summary?**";
  const delayBack = async (route: Route) => {
    if (
      new URL(route.request().url()).searchParams.get("run_group_id") !==
        run.id ||
      delayed
    ) {
      await route.continue();
      return;
    }
    delayed = true;
    try {
      const response = await route.fetch();
      await hold;
      await route.fulfill({ response });
    } finally {
      delivered();
    }
  };
  await page.route(summaryPattern, delayBack);
  try {
    await page.goBack();
    await expect.poll(() => delayed).toBe(true);
    await page.goForward();
    await expectRoute(page, "analysis", "summary");
    await expect.poll(() => selection(page)).toEqual(planContext);
    release();
    await delivery;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expectRoute(page, "analysis", "summary");
    expect(selection(page)).toEqual(planContext);
    await expect(page.locator(".evaluated-plan-banner")).toContainText(
      plan.name,
    );
  } finally {
    release();
    await page.unroute(summaryPattern, delayBack);
  }

  // An unfinished response selection survives navigation; the plan's saved
  // comparison can still be reopened after the selection has cleared results.
  await page
    .getByRole("button", { name: "Return to comparison", exact: true })
    .click();
  await expectRoute(page, "analysis", "comparison");
  await expect.poll(() => selection(page).comparison).toBe(comparison.id);
  await page.locator(".response-selector button.selected").first().click();
  await expect.poll(() => selection(page).comparison).toBeNull();
  const unsavedResponses = await page
    .locator(".response-selector button.selected")
    .allTextContents();
  await expect(
    page.getByText("Select responses to evaluate", { exact: true }),
  ).toBeVisible();
  await analysis(page, "Summary");
  await page.goBack();
  await expectRoute(page, "analysis", "comparison");
  expect(
    await page.locator(".response-selector button.selected").allTextContents(),
  ).toEqual(unsavedResponses);
  expect(selection(page).comparison).toBeNull();
  await expect(
    page.getByText("Select responses to evaluate", { exact: true }),
  ).toBeVisible();
  await analysis(page, "Summary");
  await page
    .getByRole("button", { name: "Return to comparison", exact: true })
    .click();
  await expectRoute(page, "analysis", "comparison");
  await expect.poll(() => selection(page).comparison).toBe(comparison.id);
  await expect(
    page.getByText("10 runs per plan", { exact: true }),
  ).toBeVisible();
  await analysis(page, "Summary");

  await page
    .locator(".overview-page:visible")
    .getByRole("button", { name: /Record update$/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Additional patients").fill("5");
  await dialog.getByLabel("Future repetitions").selectOption("1");
  await dialog
    .getByLabel("Source and explanation")
    .fill("Synthetic navigation-flow acceptance update.");
  const applied = page.waitForResponse(
    (r) =>
      r.url().includes("/updates/") &&
      r.url().endsWith("/apply") &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Save & reforecast", exact: true })
    .click();
  const appliedResponse = await applied;
  expect(appliedResponse.ok(), await appliedResponse.text()).toBeTruthy();
  const update = await appliedResponse.json(),
    branch = update.run_group || update.run;
  const finishedBranch = await waitRun(page, branch.id);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBe(branch.id);
  await analysis(page, "Replay");
  await expectRoute(page, "analysis", "replay");
  await expect(
    page.getByLabel("Next recorded event", { exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Next recorded event", { exact: true }).click();
  await expect(page.locator(".event-feed .info-note")).toContainText("Event");
  const branchContext = selection(page);
  await page.reload();
  await expectRoute(page, "analysis", "replay");
  await expect(page.locator(".replay-canvas")).toBeVisible();
  expect(selection(page)).toEqual(branchContext);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate export", exact: true })
    .click();
  const link = page.getByRole("link", { name: "Download export", exact: true });
  await expect(link).toBeVisible({ timeout: 45000 });
  const downloaded = page.waitForEvent("download");
  await link.click();
  const download = await downloaded,
    file = info.outputPath("navigation-export.zip");
  await download.saveAs(file);
  expect(await download.failure()).toBeNull();
  const checksums = JSON.parse(
    execFileSync(
      resolve(process.cwd(), "../../.venv/bin/python"),
      [
        "-c",
        `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 names=[n for n in z.namelist() if not n.endswith('/')]
 assert len(names)==len(set(names))
 sums=json.loads(z.read('checksums.json'))
 assert set(sums)==set(names)-{'checksums.json'}
 for n,s in sums.items(): assert hashlib.sha256(z.read(n)).hexdigest()==s,n
 m=json.loads(z.read('model-manifest.json'))
 assert m['run_group_id']==sys.argv[2]
 print(json.dumps({'run_group_id':m['run_group_id'],'input_sha256':m['input_sha256'],'files':len(names),'all_checksums_verified':True}))`,
        file,
        branch.id,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(checksums.input_sha256).toBe(finishedBranch.input_sha256);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  await capture(page, "navigation-flow-replay", info);
  record("navigation-flow", {
    scenario_id: context.scenario.id,
    run_id: run.id,
    horizon_days: 3,
    replications: 10,
    comparison_id: comparison.id,
    evaluated_plan_run_id: plan.run_group_id,
    branch_run_id: branch.id,
    baseline_unchanged_after_seek: true,
    unsaved_setup_retained: true,
    hidden_overview_dialog_does_not_trap_focus: true,
    context_keys: contextKeys,
    reload_back_forward_context_preserved: true,
    delayed_popstate_response_ignored: true,
    unsaved_responses_survive_history: true,
    cleared_comparison_reopened_from_plan: true,
    overview_export_and_alerts_use_selected_run: true,
    export: checksums,
    page_errors: errors,
  });
});

test("mobile touch navigation retains the Overview draft and source baseline", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "mobile",
    "Dedicated touch and narrow-screen coverage.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const context = await scenario(page, "mobile navigation");
  await open(page, context.scenario.id, "overview");
  const source = await baseline(page);
  await page.getByLabel("Increase in ED arrivals").fill("42");
  await primary(page, "Analysis", true);
  await expectRoute(page, "analysis", "summary");
  const retained = selection(page);
  await analysis(page, "Analytics", true);
  const sections = page.getByRole("navigation", { name: "Analytics sections" });
  await sections.getByRole("button", { name: "Resources", exact: true }).tap();
  await expectRoute(page, "analysis", "analytics", "resources");
  await expect(page.locator(".resources-page:visible")).toBeVisible();
  expect(selection(page)).toEqual(retained);
  await sections
    .getByRole("button", { name: "Patients & units", exact: true })
    .tap();
  await expectRoute(page, "analysis", "analytics", "patients");
  await expect(page.locator(".patients-page:visible")).toBeVisible();
  for (const button of await sections.getByRole("button").all())
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await analysis(page, "Replay", true);
  await expectRoute(page, "analysis", "replay");
  expect(selection(page)).toEqual(retained);
  await primary(page, "Overview", true);
  await expectRoute(page, "overview");
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("42");
  expect(await baseline(page)).toEqual(source);
  await page.goBack();
  await expectRoute(page, "analysis", "replay");
  await page.goForward();
  await expectRoute(page, "overview");
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("42");
  await page.setViewportSize({ width: 320, height: 844 });
  const expectNarrowWidth = async () => {
    await expect
      .poll(() =>
        page.evaluate(() => [
          document.documentElement.clientWidth,
          document.documentElement.scrollWidth,
        ]),
      )
      .toEqual([320, 320]);
  };
  await primary(page, "Analysis", true);
  for (const tab of ["Summary", "Replay", "Analytics", "Comparison"]) {
    await analysis(page, tab, true);
    await expectRoute(
      page,
      "analysis",
      tab.toLowerCase(),
      tab === "Analytics" ? "patients" : undefined,
    );
    await expectNarrowWidth();
    expect(selection(page)).toEqual(retained);
    if (tab === "Analytics") {
      for (const [label, section] of [
        ["Outcomes", "outcomes"],
        ["Patients & units", "patients"],
        ["Resources", "resources"],
      ]) {
        await sections.getByRole("button", { name: label, exact: true }).tap();
        await expectRoute(page, "analysis", "analytics", section);
        await expectNarrowWidth();
      }
    }
  }
  await primary(page, "Overview", true);
  await expectRoute(page, "overview");
  await expectNarrowWidth();
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("42");
  expect(await baseline(page)).toEqual(source);
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  await capture(page, "navigation-touch-overview", info);
  record("navigation-touch", {
    scenario_id: context.scenario.id,
    source_baseline_unchanged: true,
    unsaved_inputs_retained: true,
    touch_targets_min_height: 44,
    viewport_widths: [390, 320],
    all_analysis_and_analytics_tabs_accessible_at_320: true,
    document_width_at_320: 320,
    history_preserved: true,
    page_errors: errors,
  });
});

test("root, legacy aliases and invalid navigation canonicalize without losing context", async ({
  page,
}, info) => {
  const context = await scenario(page, "navigation links");
  const cases = [
    ["", "overview", null, null],
    ["view=scenarios", "overview", null, null],
    ["view=patients", "analysis", "analytics", "patients"],
    ["view=resources", "analysis", "analytics", "resources"],
    ["view=compare", "analysis", "comparison", null],
    ["view=replay", "analysis", "replay", null],
    ["view=summary", "analysis", "summary", null],
    ["view=not-a-view", "overview", null, null],
    ["view=analysis&analysis=not-a-page", "analysis", "summary", null],
    [
      "view=analysis&analysis=analytics&section=not-a-section",
      "analysis",
      "analytics",
      "outcomes",
    ],
  ];
  for (const [query, view, child, section] of cases)
    await test.step(query || "root route", async () => {
      const params = new URLSearchParams(query || "");
      params.set("scenario", context.scenario.id);
      params.set("dataset", context.dataset.id);
      params.set("at", context.dataset.snapshot_at);
      params.set("facility", "FAC-MAIN");
      params.set("grain", "week");
      await page.goto("/?" + params);
      await expectRoute(page, view!, child || undefined, section || undefined);
      const actual = new URL(page.url()).searchParams;
      for (const key of ["scenario", "dataset", "facility", "grain"])
        expect(actual.get(key), query + " context " + key).toBe(
          params.get(key),
        );
      expect(Date.parse(actual.get("at")!)).toBe(
        Date.parse(context.dataset.snapshot_at),
      );
      await assertPageHealthy(page);
    });
  record(`navigation-aliases-${info.project.name}`, {
    cases: cases.length,
    all_canonical: true,
    context_preserved: true,
  });
});

test("Analytics outcomes match recorded metrics and preserve trajectory context", async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "outcome analytics", {
    replications: 2,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const metrics = await api(
    page.request,
    `/run-groups/${run.id}/metrics?grain=day`,
  );
  await open(page, context.scenario.id, "analytics-outcomes", run.id);
  const outcomes = page.getByTestId("outcome-analytics");
  await expect(
    outcomes.getByRole("heading", { name: "Simulation outcomes", exact: true }),
  ).toBeVisible();
  await expect(outcomes.locator(".outcome-scalars")).toBeVisible();
  const format = (value: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
  const row = (label: string) =>
    outcomes.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: label, exact: true }),
    });
  const values: Record<string, number> = {};
  for (const [key, label] of [
    ["arrivals", "New arrivals"],
    ["inpatient_waiting_patient_hours", "Inpatient placement waiting"],
    ["ed_waiting_patient_hours", "ED assessment waiting"],
  ]) {
    const value = metrics.scalar_metrics[key];
    const median = typeof value === "number" ? value : value.p50;
    expect(Number.isFinite(median), key).toBe(true);
    await expect(row(label).getByRole("cell").nth(2)).toHaveText(
      format(median),
    );
    values[key] = median;
  }
  await outcomes
    .getByRole("combobox", { name: "Selected outcome day", exact: true })
    .selectOption("1");
  const selectedAt = new URL(page.url()).searchParams.get("at");
  const metric = outcomes.getByRole("combobox", {
    name: "Outcome metric",
    exact: true,
  });
  const plotOptions = await metric
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  expect(plotOptions).toHaveLength(9);
  for (const plot of plotOptions) {
    await metric.selectOption(plot);
    await expect(metric).toHaveValue(plot);
    await expect(outcomes.locator(".outcome-chart svg").first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);
  }
  await outcomes.getByRole("checkbox").uncheck();
  await expect(outcomes.getByRole("checkbox")).not.toBeChecked();
  await outcomes.getByRole("checkbox").check();
  for (const grain of ["Week", "Month", "Day"]) {
    await outcomes.getByRole("button", { name: grain, exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("grain"))
      .toBe(grain.toLowerCase());
    await expect(
      outcomes.getByRole("button", { name: grain, exact: true }),
    ).toHaveClass(/active/);
    expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);
    await expect(row("New arrivals").getByRole("cell").nth(2)).toHaveText(
      format(values.arrivals),
    );
  }
  await page
    .getByRole("navigation", { name: "Analytics sections" })
    .getByRole("button", { name: "Patients & units", exact: true })
    .click();
  await expectRoute(page, "analysis", "analytics", "patients");
  expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);
  const patientRow = page.locator(".patient-table tbody tr").first();
  await patientRow.locator(".link-button").first().click();
  await expect(page.locator(".patient-inspector")).toBeVisible();
  await expect.poll(() => selection(page).patient).toBeTruthy();
  const patientContext = selection(page);
  await page
    .getByRole("navigation", { name: "Analytics sections" })
    .getByRole("button", { name: "Outcomes", exact: true })
    .click();
  await expectRoute(page, "analysis", "analytics", "outcomes");
  expect(selection(page)).toEqual(patientContext);
  await assertPageHealthy(page);
  await capture(page, "outcome-analytics", info);

  // A real no-new-arrivals trajectory distinguishes an unobserved shortage
  // from numeric zero; no metrics or network responses are substituted.
  const quiet = await api(page.request, "/scenarios", "POST", {
    name: `E2E null versus zero outcomes ${info.project.name} ${Date.now()}`,
    dataset_version_id: context.dataset.id,
    horizon_calendar_days: 1,
    replications: 1,
    conditions: ["ED_MAIN", "DIRECT_WARD_MAIN"].map((stream, index) => ({
      id: `quiet-${index}`,
      kind: "arrival_multiplier",
      entry_stream_id: stream,
      shape: "step",
      multiplier: 0,
      start_at: context.scenario.start_at,
      end_at: new Date(
        Date.parse(context.scenario.start_at) + 86400000,
      ).toISOString(),
    })),
  });
  const quietRun = await waitRun(
    page,
    (await api(page.request, "/run-groups", "POST", { scenario_id: quiet.id }))
      .id,
  );
  const quietMetrics = await api(
    page.request,
    `/run-groups/${quietRun.id}/metrics?grain=day`,
  );
  expect(quietMetrics.scalar_metrics.arrivals.p50).toBe(0);
  expect(
    quietMetrics.scalar_metrics.time_to_first_shortage_hours.p50,
  ).toBeNull();
  await open(page, quiet.id, "analytics-outcomes", quietRun.id);
  await expect(row("New arrivals").getByRole("cell").nth(2)).toHaveText("0");
  await expect(
    row("First unmet placement demand").getByRole("cell").nth(2),
  ).toHaveText("—");
  await expect(outcomes).toContainText(
    "— means unavailable or undefined; zero remains 0.",
  );
  // Build a genuine selected-replication update branch. Its first partial
  // calendar bucket must use occupied/staffed hours divided by measured hours.
  const cutoff = new Date(
    Date.parse(run.start_at) + 32 * 3600000 + 15250,
  ).toISOString();
  const event = await api(page.request, "/updates", "POST", {
    scenario_id: context.scenario.id,
    type: "arrival_batch",
    state_origin: "simulation_branch",
    effective_at: cutoff,
    parent_run_group_id: run.id,
    replication_id: run.selected_replication_id,
    source: "Synthetic outcome cutoff browser verification",
    payload: {
      facility_id: "FAC-MAIN",
      entry_stream_id: "ED_MAIN",
      count: 1,
      spread_minutes: 0,
      care_mix: { discharge: 1 },
    },
  });
  const applied = await api(
    page.request,
    `/updates/${event.id}/apply`,
    "POST",
    {
      parent_scenario_revision_id: run.scenario_revision_id,
      effective_at: cutoff,
      state_origin: "simulation_branch",
      update_ids: [event.id],
      source: {
        parent_run_group_id: run.id,
        branch_strategy: "selected_replication",
        source_replication_id: run.selected_replication_id,
      },
      replications: 1,
      enqueue: true,
    },
  );
  const branch = await waitRun(page, (applied.run_group || applied.run).id);
  await open(page, applied.scenario.id, "analytics-outcomes", branch.id);
  await expect(outcomes.locator(".outcome-scalars")).toBeVisible();
  await expect(outcomes).toContainText("Measured from update cutoff");
  await expect(row("Expected exogenous arrivals")).toHaveCount(0);
  const daySelect = outcomes.getByRole("combobox", {
    name: "Selected outcome day",
    exact: true,
  });
  await expect(daySelect.locator("option")).toHaveCount(2);
  await expect(daySelect.locator("option").first()).toContainText("Day 2");
  await daySelect.selectOption("0");
  const hourSelect = outcomes.getByRole("combobox", {
    name: "Selected outcome time",
    exact: true,
  });
  const availableTimes = await hourSelect
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  expect(availableTimes.length).toBeGreaterThan(0);
  expect(
    availableTimes.every((value) => Date.parse(value) >= Date.parse(cutoff)),
  ).toBe(true);
  expect(Date.parse(availableTimes[0])).toBe(Date.parse(cutoff));
  await metric.selectOption("ward");
  await outcomes
    .getByRole("button", { name: "View chart data table", exact: true })
    .click();
  const cutoffProjections: Record<string, number> = {};
  for (const grain of ["day", "week", "month"]) {
    const recorded = await api(
      page.request,
      `/run-groups/${branch.id}/metrics?grain=${grain}`,
    );
    const rows = (grain === "day" ? recorded.daily : recorded.data).filter(
      (bucket: any) =>
        Date.parse(bucket.end_at) > Date.parse(cutoff) &&
        Date.parse(bucket.start_at || bucket.at) < Date.parse(branch.end_at),
    );
    const first = rows[0];
    const hours =
      (Math.min(Date.parse(first.end_at), Date.parse(branch.end_at)) -
        Math.max(Date.parse(first.start_at || first.at), Date.parse(cutoff))) /
      3600000;
    const expected = first.ward_occupied_hours.p50 / hours;
    cutoffProjections[grain] = expected;
    await outcomes
      .getByRole("button", {
        name: grain[0].toUpperCase() + grain.slice(1),
        exact: true,
      })
      .click();
    const plotted = outcomes.locator(".chart-data-table tbody tr");
    await expect(plotted).toHaveCount(rows.length);
    await expect(plotted.first().getByRole("cell").nth(1)).toHaveText(
      new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        expected,
      ),
    );
  }
  expect(errors).toEqual([]);
  record(`outcome-analytics-${info.project.name}`, {
    run_id: run.id,
    medians_match_actual_api: values,
    charts_checked: plotOptions,
    grains_checked: ["day", "week", "month"],
    selected_time_preserved: true,
    patient_inspector_context_preserved: true,
    null_zero_run_id: quietRun.id,
    null_and_zero_distinguished: true,
    cutoff_branch_run_id: branch.id,
    cutoff,
    cutoff_projection_matches_recorded_integrals: cutoffProjections,
    pre_cutoff_controls_excluded: true,
    page_errors: errors,
  });
});
