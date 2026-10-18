import { expect, test, type Locator } from "@playwright/test";
import { plannedArrivals } from "../src/pages/plannedArrivalSeries";
import { atDay } from "../src/api";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

async function chartValues(chart: Locator) {
  const serialized = await chart.getAttribute("data-planned-arrivals");
  expect(serialized).toBeTruthy();
  return serialized!.split(",").map(Number);
}

for (const days of [14, 30]) {
  test(`${days}-day edited curve keeps controls available and drives actual simulated arrivals`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop", "Desktop arrival workflow.");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const context = await scenario(
      page,
      `editable ${days}-day curve actual run`,
      {
        horizon_calendar_days: 7,
        replications: 1,
        conditions: [
          {
            id: "whole-period-ed",
            kind: "arrival_multiplier",
            entry_stream_id: "ED_MAIN",
            shape: "step",
            surge_percent: -80,
            start_at: "2026-10-16T05:00:00Z",
            end_at: "2026-10-23T05:00:00Z",
          },
        ],
      },
    );
    await open(page, context.scenario.id, "overview");
    await expect(
      page.getByText("Patients awaiting a bed", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Awaiting ED assessment", { exact: true }),
    ).toHaveCount(0);
    const editor = page.getByTestId("guided-scenario");
    const chart = editor.getByTestId("arrival-preview-chart");
    await editor
      .locator(".mantine-SegmentedControl-label")
      .filter({ hasText: days === 14 ? /^2 weeks$/ : /^30 days$/ })
      .click();
    const handles = chart.getByTestId("arrival-day-handle");
    await expect(handles).toHaveCount(days);
    const zeroDay = days === 14 ? 9 : 20;
    await handles.nth(zeroDay).focus();
    await handles.nth(zeroDay).press("Home");
    await expect.poll(async () => (await chartValues(chart))[zeroDay]).toBe(0);
    const last = handles.last();
    await last.focus();
    await last.press("ArrowUp");
    await last.press("ArrowUp");
    const main = editor.locator(".simulation-main-controls");
    await expect(
      main.getByLabel("Increase in ED arrivals", { exact: true }),
    ).toBeEnabled();
    await expect(
      main.getByRole("radio", { name: "Steady", exact: true }),
    ).toBeChecked();
    await expect(
      editor.getByText("Custom daily curve", { exact: true }),
    ).toHaveCount(0);
    const beforeScaling = await chartValues(chart);
    const slider = main.getByRole("slider", {
      name: "Adjust arrival surge",
      exact: true,
    });
    await slider.focus();
    await slider.press("ArrowRight");
    const scaled = await chartValues(chart);
    expect(scaled[zeroDay]).toBe(0);
    const scale = scaled[0] / beforeScaling[0];
    expect(scale).toBeGreaterThan(1);
    scaled.forEach((value, index) =>
      expect(value).toBeCloseTo(beforeScaling[index] * scale, 1),
    );
    const serialized = (await chart.getAttribute("data-planned-arrivals"))!;
    await main
      .getByRole("button", { name: "Reset daily edits", exact: true })
      .click();
    expect((await chartValues(chart))[zeroDay]).toBeGreaterThan(0);
    await editor.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(chart).toHaveAttribute("data-planned-arrivals", serialized);
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByText("Unsaved changes", { exact: true }),
    ).toHaveCount(0);
    const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
    await page.reload();
    await expect(chart).toHaveAttribute("data-planned-arrivals", serialized);
    await expect(
      main.getByLabel("Increase in ED arrivals", { exact: true }),
    ).toBeEnabled();
    await expect(
      main.getByRole("slider", { name: "Adjust arrival surge", exact: true }),
    ).toBeEnabled();
    const dataset = await api(
      page.request,
      `/datasets/${saved.dataset_version_id}`,
    );
    const direct = dataset.entry_streams.find(
      (entry: any) => entry.entry_stream_id === "DIRECT_WARD_MAIN",
    );
    const directExpected = plannedArrivals({
      conditions: saved.conditions,
      stream: "DIRECT_WARD_MAIN",
      baselineRate: direct.expected_arrivals_per_local_day,
      start: saved.start_at,
      end: atDay(saved.start_at, days, 0, saved.timezone),
      days,
      timeZone: saved.timezone,
      hourWeights: direct.hour_weights,
      weekdayWeights: direct.weekday_weights,
    }).reduce((sum, day) => sum + day.planned, 0);
    const expectedArrivals =
      scaled.reduce((sum, value) => sum + value, 0) + directExpected;
    await capture(page, `arrival-controls-${days}-days`, info);
    const submission = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/run-groups") &&
        response.request().method() === "POST",
    );
    await editor
      .getByRole("button", { name: "Run simulation", exact: true })
      .click();
    const completed = await waitRun(page, (await (await submission).json()).id);
    expect(completed.scenario_context.conditions).toEqual(saved.conditions);
    const metrics = await api(
      page.request,
      `/run-groups/${completed.id}/metrics?grain=day`,
    );
    expect(metrics.scalar_metrics.expected_arrivals.p50).toBeCloseTo(
      expectedArrivals,
      0,
    );
    const start = atDay(saved.start_at, zeroDay, 0, saved.timezone),
      end = atDay(saved.start_at, zeroDay + 1, 0, saved.timezone);
    const events = await api(
      page.request,
      `/runs/${completed.selected_replication_id}/events?event_type=arrival&start_at=${encodeURIComponent(start)}&end_at=${encodeURIComponent(end)}&limit=200`,
    );
    expect(events.total).toBeLessThan(200);
    expect(
      events.items.filter((event: any) => event.payload.entry_type === "ed"),
    ).toHaveLength(0);
    const finalStart = atDay(saved.start_at, days - 1, 0, saved.timezone),
      finalEnd = atDay(saved.start_at, days, 0, saved.timezone);
    const finalEvents = await api(
      page.request,
      `/runs/${completed.selected_replication_id}/events?event_type=arrival&start_at=${encodeURIComponent(finalStart)}&end_at=${encodeURIComponent(finalEnd)}&limit=200`,
    );
    const actualFinalEd = finalEvents.items.filter(
      (event: any) => event.payload.entry_type === "ed",
    ).length;
    expect(actualFinalEd).toBeGreaterThan(0);
    // A pattern must keep its selection after canonical windows are saved and reloaded.
    await open(page, saved.id, "overview", completed.id);
    await main
      .locator(".mantine-SegmentedControl-label")
      .filter({ hasText: /^Builds up$/ })
      .click();
    await editor
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(
      editor.getByText("Unsaved changes", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      main.getByRole("radio", { name: "Builds up", exact: true }),
    ).toBeChecked();
    await assertPageHealthy(page);
    expect(errors).toEqual([]);
    record(`arrival-controls-${days}-days`, {
      scenario_id: saved.id,
      run_group_id: completed.id,
      planned_ed_arrivals: scaled,
      expected_total_arrivals: expectedArrivals,
      engine_expected_total_arrivals:
        metrics.scalar_metrics.expected_arrivals.p50,
      actual_total_arrivals: metrics.scalar_metrics.arrivals.p50,
      zero_ed_day: zeroDay + 1,
      actual_zero_day_ed_arrivals: 0,
      actual_last_day_ed_arrivals: actualFinalEd,
      controls_remain_available: true,
      slider_preserves_daily_shape: true,
      reset_and_undo_verified: true,
      saved_reloaded_and_frozen_match: true,
      browser_errors: errors,
    });
  });
}

test("dragged daily arrivals keep a stable axis, one undo and exact saved simulation inputs", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Arrival editing is verified on desktop.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const careMix = { discharge: 0.8, ward: 0.16, icu: 0.04 };
  const direct = {
    id: "arrival-curve-direct",
    kind: "arrival_multiplier",
    entry_stream_id: "DIRECT_WARD_MAIN",
    shape: "step",
    start_at: "2026-10-16T05:00:00Z",
    end_at: "2026-10-19T05:00:00Z",
    surge_percent: 20,
  };
  const batch = {
    id: "arrival-curve-batch",
    kind: "arrival_batch",
    entry_stream_id: "ED_MAIN",
    at: "2026-10-17T17:00:00Z",
    count: 25,
    spread_minutes: 60,
    care_mix: careMix,
  };
  const context = await scenario(page, "drag daily arrival curve", {
    horizon_calendar_days: 3,
    replications: 1,
    conditions: [
      {
        id: "arrival-curve-ed",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        shape: "step",
        start_at: "2026-10-16T05:00:00Z",
        end_at: "2026-10-19T05:00:00Z",
        surge_percent: 0,
        care_mix_override: careMix,
        control_points: [
          { at: "2026-10-16T05:00:00Z", multiplier: 1 },
          { at: "2026-10-19T05:00:00Z", multiplier: 1 },
        ],
      },
      direct,
      batch,
    ],
  });
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario"),
    chart = editor.getByTestId("arrival-preview-chart"),
    handles = chart.getByTestId("arrival-day-handle"),
    undo = editor.getByRole("button", { name: "Undo", exact: true }),
    redo = editor.getByRole("button", { name: "Redo", exact: true });
  await expect(chart).toHaveAttribute("role", "group");
  await expect(handles).toHaveCount(3);
  await expect(undo).toBeDisabled();
  await expect(
    editor.locator(".more-simulation-parameters"),
  ).not.toHaveAttribute("open", "");
  const initialSerialized = (await chart.getAttribute(
      "data-planned-arrivals",
    ))!,
    initial = await chartValues(chart),
    usual = (await chart.getAttribute("data-usual-arrivals"))!
      .split(",")
      .map(Number),
    initialScale = (await chart.getAttribute("data-scale-max"))!;
  expect(initial[1] - usual[1]).toBeCloseTo(25, 1);
  const day = handles.nth(1);
  await day.scrollIntoViewIfNeeded();
  const dot = await day.locator(".arrival-curve-dot").boundingBox();
  expect(dot).toBeTruthy();
  const start = { x: dot!.x + dot!.width / 2, y: dot!.y + dot!.height / 2 };
  const graphTop = (await chart.boundingBox())!.y;
  const targetY = Math.max(graphTop + 22, start.y - 35);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(start.x, (start.y + targetY) / 2, { steps: 5 });
    await expect
      .poll(async () => (await chartValues(chart))[1])
      .toBeGreaterThan(initial[1]);
    await expect(chart).toHaveAttribute("data-scale-max", initialScale);
    const firstMove = (await chartValues(chart))[1];
    await page.mouse.move(start.x, targetY, { steps: 5 });
    await expect
      .poll(async () => (await chartValues(chart))[1])
      .toBeGreaterThan(firstMove);
    await expect(chart).toHaveAttribute("data-scale-max", initialScale);
    await expect(
      editor.locator(".more-simulation-parameters"),
    ).not.toHaveAttribute("open", "");
  } finally {
    await page.mouse.up();
  }
  const draggedSerialized = (await chart.getAttribute(
      "data-planned-arrivals",
    ))!,
    dragged = await chartValues(chart);
  expect(dragged[0]).toBe(initial[0]);
  expect(dragged[2]).toBe(initial[2]);
  const mainControls = editor.locator(".simulation-main-controls");
  await expect(mainControls.getByTestId("custom-arrival-state")).toHaveCount(0);
  await expect(
    mainControls.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toBeEnabled();
  await expect(
    mainControls.getByRole("radio", { name: "Steady", exact: true }),
  ).toBeChecked();
  await undo.click();
  await expect(chart).toHaveAttribute(
    "data-planned-arrivals",
    initialSerialized,
  );
  await expect(undo).toBeDisabled();
  await redo.click();
  await expect(chart).toHaveAttribute(
    "data-planned-arrivals",
    draggedSerialized,
  );

  // Holding a key produces several updates but still creates one undo step.
  await day.focus();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowUp");
  await page.keyboard.up("ArrowUp");
  await expect
    .poll(async () => (await chartValues(chart))[1])
    .toBe(dragged[1] + 2);
  const finalSerialized = (await chart.getAttribute("data-planned-arrivals"))!,
    final = await chartValues(chart);
  await undo.click();
  await expect(chart).toHaveAttribute(
    "data-planned-arrivals",
    draggedSerialized,
  );
  await redo.click();
  await expect(chart).toHaveAttribute("data-planned-arrivals", finalSerialized);

  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/scenarios/${context.scenario.id}`) &&
      response.request().method() === "PATCH",
  );
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await savedResponse).ok()).toBeTruthy();
  await expect(
    editor.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(
    saved.conditions.find((condition: any) => condition.id === direct.id),
  ).toEqual(
    context.scenario.conditions.find(
      (condition: any) => condition.id === direct.id,
    ),
  );
  expect(
    saved.conditions.find((condition: any) => condition.id === batch.id),
  ).toEqual(
    context.scenario.conditions.find(
      (condition: any) => condition.id === batch.id,
    ),
  );
  const edWindows = saved.conditions.filter(
    (condition: any) =>
      condition.kind === "arrival_multiplier" &&
      condition.entry_stream_id === "ED_MAIN",
  );
  expect(edWindows).toHaveLength(3);
  const changed = edWindows.find(
    (condition: any) =>
      Date.parse(condition.control_points[0].at) ===
      Date.parse("2026-10-17T05:00:00Z"),
  );
  expect(changed).toBeTruthy();
  expect(Date.parse(changed.control_points.at(-1).at)).toBe(
    Date.parse("2026-10-18T05:00:00Z"),
  );
  for (const point of changed.control_points)
    expect(point.multiplier).toBeCloseTo((final[1] - 25) / usual[1], 3);
  for (const window of edWindows)
    expect(window.care_mix_override).toEqual(careMix);
  await page.reload();
  await expect(chart).toHaveAttribute("data-planned-arrivals", finalSerialized);
  await expect(mainControls.getByTestId("custom-arrival-state")).toHaveCount(0);
  await expect(
    mainControls.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toBeEnabled();
  await expect(day).toHaveAttribute("aria-valuemin", "25");
  await capture(page, "arrival-curve-edited", info);

  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  await editor
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  const queued = await (await submitted).json(),
    completed = await waitRun(page, queued.id),
    frozen = await api(page.request, `/run-groups/${completed.id}`),
    metrics = await api(
      page.request,
      `/run-groups/${completed.id}/metrics?grain=day`,
    );
  expect(frozen.scenario_context.conditions).toEqual(saved.conditions);
  expect(completed.replications_completed).toBe(1);
  expect(metrics.scalar_metrics.arrivals.p50).toBeGreaterThan(25);
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  record("arrival-curve-desktop", {
    scenario_id: saved.id,
    run_group_id: completed.id,
    initial_daily_arrivals: initial,
    edited_daily_arrivals: final,
    unchanged_neighbor_days: true,
    stable_axis_while_dragging: initialScale,
    one_undo_per_drag_and_held_key: true,
    scheduled_batch_preserved: true,
    other_stream_and_care_mix_preserved: true,
    saved_reloaded_and_frozen_conditions_match: true,
    browser_errors: errors,
  });
});

test("daily arrival keyboard controls stop at the fixed scheduled-batch minimum", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Arrival editing is verified on desktop.",
  );
  const batch = {
    id: "arrival-keyboard-minimum-batch",
    kind: "arrival_batch",
    entry_stream_id: "ED_MAIN",
    at: "2026-10-16T17:00:00Z",
    count: 25,
    spread_minutes: 60,
    care_mix: { discharge: 1, ward: 0, icu: 0 },
  };
  const context = await scenario(page, "arrival curve scheduled minimum", {
    horizon_calendar_days: 2,
    replications: 1,
    conditions: [batch],
  });
  await open(page, context.scenario.id, "overview");
  const editor = page.getByTestId("guided-scenario"),
    chart = editor.getByTestId("arrival-preview-chart"),
    point = chart.getByTestId("arrival-day-handle").first(),
    undo = editor.getByRole("button", { name: "Undo", exact: true });
  const before = (await chart.getAttribute("data-planned-arrivals"))!,
    beforeValues = await chartValues(chart);
  await expect(point).toHaveAttribute("aria-valuemin", "25");
  await point.focus();
  await point.press("Home");
  await expect(point).toHaveAttribute("aria-valuenow", "25");
  await expect(point).toHaveAttribute(
    "aria-valuetext",
    "25 patients, including 25 scheduled arrivals",
  );
  await point.press("ArrowDown");
  await expect(point).toHaveAttribute("aria-valuenow", "25");
  expect((await chartValues(chart))[1]).toBe(beforeValues[1]);
  // An attempted decrement below the minimum must not add an empty undo step.
  await undo.click();
  await expect(chart).toHaveAttribute("data-planned-arrivals", before);
  await expect(undo).toBeDisabled();
  await point.focus();
  await point.press("Home");
  const minimum = (await chart.getAttribute("data-planned-arrivals"))!;
  await editor.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    editor.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`),
    window = saved.conditions.find(
      (condition: any) => condition.kind === "arrival_multiplier",
    );
  expect(window.control_points.every((p: any) => p.multiplier === 0)).toBe(
    true,
  );
  expect(
    saved.conditions.find((condition: any) => condition.id === batch.id),
  ).toEqual(context.scenario.conditions[0]);
  await page.reload();
  await expect(chart).toHaveAttribute("data-planned-arrivals", minimum);
  await expect(point).toHaveAttribute("aria-valuenow", "25");
  await assertPageHealthy(page);
  record("arrival-curve-batch-minimum-desktop", {
    scenario_id: saved.id,
    fixed_scheduled_minimum: 25,
    zero_variable_arrivals_saved: true,
    neighbor_day_unchanged: true,
    no_empty_undo_at_minimum: true,
    reload_retains_exact_curve_and_batch: true,
  });
});
