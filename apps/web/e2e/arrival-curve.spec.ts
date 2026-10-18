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

async function chartValues(chart: Locator) {
  const serialized = await chart.getAttribute("data-planned-arrivals");
  expect(serialized).toBeTruthy();
  return serialized!.split(",").map(Number);
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
  await expect(mainControls.getByTestId("custom-arrival-state")).toContainText(
    "Custom daily curve",
  );
  await expect(
    mainControls.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toHaveCount(0);
  await expect(
    mainControls.getByRole("radio", { name: "Steady", exact: true }),
  ).toHaveCount(0);
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
  await expect(mainControls.getByTestId("custom-arrival-state")).toContainText(
    "Custom daily curve",
  );
  await expect(
    mainControls.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toHaveCount(0);
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
