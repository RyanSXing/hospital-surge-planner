import { expect, test } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

test("arrival slider follows every day of the selected duration and survives save and reload", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Desktop configuration regression.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "arrival duration regression", {
    horizon_calendar_days: 7,
    replications: 1,
    conditions: [
      {
        id: "whole-period-arrivals",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        shape: "step",
        surge_percent: 115,
        start_at: "2026-10-16T05:00:00Z",
        end_at: "2026-10-23T05:00:00Z",
        control_points: [
          { at: "2026-10-16T05:00:00Z", multiplier: 2.15 },
          { at: "2026-10-23T05:00:00Z", multiplier: 2.15 },
        ],
      },
    ],
  });
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario");
  const chart = editor.getByTestId("arrival-preview-chart");
  async function expectAllDays(days: number, multiplier: number) {
    await expect(chart.getByTestId("arrival-day-handle")).toHaveCount(days);
    const planned = (await chart.getAttribute("data-planned-arrivals"))!
      .split(",")
      .map(Number);
    const usual = (await chart.getAttribute("data-usual-arrivals"))!
      .split(",")
      .map(Number);
    expect(planned).toHaveLength(days);
    planned.forEach((value, day) =>
      expect(value / usual[day], `Day ${day + 1}`).toBeCloseTo(multiplier, 2),
    );
  }
  for (const [days, label, end, percent] of [
    [14, "2 weeks", "2026-10-30T05:00:00.000Z", 120],
    [30, "30 days", "2026-11-15T06:00:00.000Z", 125],
    [7, "1 week", "2026-10-23T05:00:00.000Z", 130],
  ] as const) {
    await editor
      .locator(".mantine-SegmentedControl-label")
      .filter({ hasText: new RegExp(`^${label}$`) })
      .click();
    // Changing duration alone must extend the existing plan, before touching the slider.
    await expectAllDays(days, 1 + (percent - 5) / 100);
    const slider = editor.getByRole("slider", {
      name: "Adjust arrival surge",
      exact: true,
    });
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", String(percent));
    await expectAllDays(days, 1 + percent / 100);
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByText("Unsaved changes", { exact: true }),
    ).toHaveCount(0);
    const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
    const arrival = saved.conditions.find(
      (item: any) => item.id === "whole-period-arrivals",
    );
    expect(saved.horizon_calendar_days).toBe(days);
    expect(Date.parse(arrival.end_at)).toBe(Date.parse(end));
    expect(Date.parse(arrival.control_points.at(-1).at)).toBe(Date.parse(end));
    await page.reload();
    await expectAllDays(days, 1 + percent / 100);
    if (days === 30) await capture(page, "arrival-duration-30-days", info);
  }
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  record("arrival-duration-regression", {
    scenario_id: context.scenario.id,
    all_days_update: [14, 30, 7],
    saved_endpoints_verified: true,
    reload_verified: true,
    page_errors: errors,
  });
});

test("simple hospital setup keeps its live graph visible and runs the exact optional inputs", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (info.project.name === "desktop")
    await page.setViewportSize({ width: 1280, height: 800 });
  const context = await scenario(
    page,
    "simple hospital setup",
    { horizon_calendar_days: 3, replications: 2 },
    "hospital_baseline",
  );
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario");
  const more = editor.locator(".more-simulation-parameters");
  const chart = editor.getByTestId("arrival-preview-chart");
  await expect(chart).toBeVisible();
  await expect(more).not.toHaveAttribute("open", "");
  await expect(
    editor.getByLabel("Simulation runs", { exact: true }),
  ).not.toBeVisible();
  await expect(
    editor.getByRole("heading", { name: "How long?", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("heading", { name: "Patient arrivals", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("heading", { name: "Arrival pattern", exact: true }),
  ).toBeVisible();
  await expect(
    editor.locator(".empty-track,.condition-palette,.json-editor"),
  ).toHaveCount(0);
  await expect(
    editor.getByText(/Synthetic planning data|ED_MAIN|FAC-MAIN/),
  ).toHaveCount(0);
  await capture(page, "simple-setup", info);

  await editor
    .locator(".mantine-SegmentedControl-label")
    .filter({ hasText: /^1 week$/ })
    .click();
  await expect(chart).toHaveAttribute("aria-label", /over 7 days/);
  const usual = (await chart.getAttribute("data-planned-arrivals"))!;
  const name = `Intuitive hospital scenario ${Date.now()}`;
  await editor.getByLabel("Scenario name", { exact: true }).fill(name);
  await editor
    .getByLabel("Increase in ED arrivals", { exact: true })
    .fill("35");
  await expect(chart).not.toHaveAttribute("data-planned-arrivals", usual);
  const beforeSlider = (await chart.getAttribute("data-planned-arrivals"))!;
  const slider = editor.getByRole("slider", {
    name: "Adjust arrival surge",
    exact: true,
  });
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuenow", "40");
  await expect(chart).not.toHaveAttribute(
    "data-planned-arrivals",
    beforeSlider,
  );
  const steady = (await chart.getAttribute("data-planned-arrivals"))!;
  await editor
    .locator(".mantine-SegmentedControl-label")
    .filter({ hasText: /^Rises & falls$/ })
    .click();
  await expect(chart).not.toHaveAttribute("data-planned-arrivals", steady);
  await editor
    .locator(".mantine-SegmentedControl-label")
    .filter({ hasText: /^Steady$/ })
    .click();

  // All exact settings stay optional. Closing them keeps both the draft and graph.
  await more.locator(":scope > summary").click();
  await expect(
    editor.getByLabel("Simulation runs", { exact: true }),
  ).toHaveValue("2");
  await editor.getByLabel("Planning horizon", { exact: true }).fill("2");
  const demand = editor.getByRole("button", { name: /^Arrival details/ });
  await demand.click();
  await editor.getByLabel("Starts on day", { exact: true }).fill("2");
  await editor
    .getByLabel("Care mix", { exact: true })
    .selectOption("percentages");
  await editor
    .getByLabel("Discharge after assessment (%)", { exact: true })
    .fill("60");
  await editor.getByLabel("Ward admission (%)", { exact: true }).fill("30");
  await editor.getByLabel("ICU admission (%)", { exact: true }).fill("10");
  const withExactWindow = (await chart.getAttribute("data-planned-arrivals"))!
    .split(",")
    .map(Number);
  expect(withExactWindow).toHaveLength(2);
  const usualWindow = (await chart.getAttribute("data-usual-arrivals"))!
    .split(",")
    .map(Number);
  expect(withExactWindow[0]).toBeCloseTo(usualWindow[0]);
  expect(withExactWindow[1] / usualWindow[1]).toBeCloseTo(1.4);
  await demand.click();
  await demand.click();
  await expect(editor.getByLabel("Starts on day", { exact: true })).toHaveValue(
    "2",
  );
  await expect(
    editor.getByLabel("Ward admission (%)", { exact: true }),
  ).toHaveValue("30");
  const resources = editor.getByRole("button", {
    name: /^Staff, beds & equipment/,
  });
  await resources.click();
  await expect(
    editor.getByRole("button", { name: "Add hospital beds", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /sites|shelter|transfers/i }),
  ).toHaveCount(0);
  await editor
    .getByRole("button", { name: "Add hospital beds", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(
    (
      await dialog
        .getByLabel("Target unit", { exact: true })
        .locator("option")
        .allTextContents()
    ).join(" "),
  ).not.toMatch(/SHELTER|PARTNER/);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await resources.click();
  await resources.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await more.locator(":scope > summary").click();
  await expect(chart).toBeVisible();
  await expect(
    editor.getByLabel("Simulation runs", { exact: true }),
  ).not.toBeVisible();
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    editor.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  await expect(
    editor.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toHaveValue("40%");
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(saved.name).toBe(name);
  expect(saved.replications).toBe(2);
  expect(saved.horizon_calendar_days).toBe(2);
  const arrival = saved.conditions.find(
    (item: any) => item.kind === "arrival_multiplier",
  );
  expect(arrival.care_mix_override).toEqual({
    discharge: 0.6,
    ward: 0.3,
    icu: 0.1,
  });
  expect(arrival.control_points.map((point: any) => point.multiplier)).toEqual([
    1.4, 1.4,
  ]);
  expect(Date.parse(arrival.control_points[0].at)).toBe(
    Date.parse("2026-10-17T05:00:00Z"),
  );
  await assertPageHealthy(page);
  const submission = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  const runButton = editor.getByRole("button", {
    name: "Run simulation",
    exact: true,
  });
  await expect(runButton).toBeEnabled();
  await runButton.click();
  const response = await submission;
  expect(response.ok()).toBeTruthy();
  const run = await waitRun(page, (await response.json()).id);
  expect(run.total).toBe(2);
  expect(run.completed).toBe(2);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("analysis"))
    .toBe("summary");
  expect(run.scenario_context.conditions).toEqual(saved.conditions);
  await assertPageHealthy(page);
  await open(page, saved.id, "replay", run.id);
  await expect(page.locator(".replay-canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play replay", exact: true }),
  ).toBeVisible();
  await open(page, saved.id, "overview", run.id);
  await page
    .getByRole("button", { name: "Scenario library", exact: true })
    .click();
  const library = page.getByRole("dialog", {
    name: "Scenario library",
    exact: true,
  });
  await library
    .getByLabel("Search saved scenarios", { exact: true })
    .fill(name);
  const row = library
    .locator(".library-row")
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(row).toContainText("Results available");
  await expect(row).not.toContainText("No results yet");
  await library
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  expect(errors).toEqual([]);
  record(`simple-setup-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    replications: run.completed,
    fixture: "hospital_baseline",
    live_graph_updates: true,
    optional_draft_preserved: true,
    single_hospital: true,
    exact_saved_conditions_frozen: true,
    scenario_library_results_status_correct: true,
    page_errors: errors,
  });
});

test("arrival percentage accepts sequential negative and positive typing without losing the draft", async ({
  page,
}, info) => {
  const context = await scenario(page, "arrival keyboard editing", {
    horizon_calendar_days: 2,
    replications: 1,
  });
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario");
  const input = editor.getByLabel("Increase in ED arrivals", { exact: true });
  const chart = editor.getByTestId("arrival-preview-chart");
  const slider = editor.getByRole("slider", {
    name: "Adjust arrival surge",
    exact: true,
  });
  const undo = editor.getByRole("button", { name: "Undo", exact: true });
  const redo = editor.getByRole("button", { name: "Redo", exact: true });
  const run = editor.getByRole("button", {
    name: "Run simulation",
    exact: true,
  });
  const baseline = (await chart.getAttribute("data-planned-arrivals"))!;
  const usual = (await chart.getAttribute("data-usual-arrivals"))!
    .split(",")
    .map(Number);

  await input.fill("");
  await expect(input).toHaveValue("");
  await expect(chart).toHaveAttribute("data-planned-arrivals", baseline);
  await input.pressSequentially("-");
  await expect(chart).toHaveAttribute("data-planned-arrivals", baseline);
  await input.pressSequentially("20");
  await expect(input).toHaveValue("-20%");
  await expect(slider).toHaveAttribute("aria-valuenow", "-20");
  const reduced = (await chart.getAttribute("data-planned-arrivals"))!
    .split(",")
    .map(Number);
  reduced.forEach((value, index) =>
    expect(value / usual[index]).toBeCloseTo(0.8),
  );
  await input.blur();
  await expect(input).toHaveValue("-20%");
  await expect(run).toBeEnabled();

  // Clearing or leaving a minus unfinished keeps the last valid simulation.
  await input.fill("");
  await input.pressSequentially("-");
  await input.blur();
  await expect(input).toHaveValue("-20%");
  await expect(slider).toHaveAttribute("aria-valuenow", "-20");

  // One completed typing gesture is one Undo step, rather than a partial digit.
  await undo.click();
  await expect(input).toHaveValue("0%");
  await expect(chart).toHaveAttribute("data-planned-arrivals", baseline);
  await redo.click();
  await expect(input).toHaveValue("-20%");
  await input.fill("");
  await input.pressSequentially("20");
  await input.blur();
  await expect(input).toHaveValue("20%");
  await expect(slider).toHaveAttribute("aria-valuenow", "20");
  const increased = (await chart.getAttribute("data-planned-arrivals"))!
    .split(",")
    .map(Number);
  increased.forEach((value, index) =>
    expect(value / usual[index]).toBeCloseTo(1.2),
  );
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(input).toHaveValue("25%");
  await undo.click();
  await expect(input).toHaveValue("20%");
  await expect(slider).toHaveAttribute("aria-valuenow", "20");
  await expect(run).toBeEnabled();
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    editor.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  const arrival = saved.conditions.find(
    (condition: any) => condition.kind === "arrival_multiplier",
  );
  expect(arrival.control_points.map((point: any) => point.multiplier)).toEqual([
    1.2, 1.2,
  ]);
  await expect(input).toHaveValue("20%");
  await assertPageHealthy(page);
  record(`arrival-keyboard-${info.project.name}`, {
    scenario_id: saved.id,
    sequential_negative_input: -20,
    sequential_positive_input: 20,
    incomplete_input_restores_last_valid_value: true,
    live_graph_matches_input: true,
    slider_and_undo_stay_in_sync: true,
    saved_multiplier: arrival.control_points[0].multiplier,
  });
});
