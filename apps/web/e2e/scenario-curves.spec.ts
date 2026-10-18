import { expandScenarioDetails } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("cohort edit and stream changes retain compatible visible mix semantics", async ({
  page,
}, info) => {
  const original = {
    id: "cohort-edit",
    name: "Declared ward cohort",
    kind: "care_mix_override",
    entry_stream_id: "ED_MAIN",
    start_at: "2026-10-16T05:00:00Z",
    end_at: "2026-10-19T05:00:00Z",
    care_mix_override: {
      "COHORT-WARD-SHORT": 0.7,
      "COHORT-WARD-STANDARD": 0.3,
    },
  };
  const context = await scenario(page, "cohort mix edit semantics", {
    conditions: [original],
  });
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  const block = page.getByRole("button", {
    name: "Declared ward cohort Planning assumption",
    exact: true,
  });
  await block.click();
  let d = page.getByRole("dialog");
  await expect(d.getByLabel("Mix basis")).toHaveValue("cohorts");
  await expect(
    d.getByLabel("Ward · short stay (%)", { exact: true }),
  ).toHaveValue("70");
  await d.getByRole("button", { name: "Apply change" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  expect(
    (await api(page.request, "/scenarios/" + context.scenario.id)).conditions[0]
      .care_mix_override,
  ).toEqual(original.care_mix_override);
  await block.click();
  d = page.getByRole("dialog");
  await d.getByLabel("Mix basis").selectOption("profiles");
  await d.getByLabel("Where patients arrive").selectOption("DIRECT_WARD_MAIN");
  await expect(d.getByLabel("Mix basis")).toHaveValue("care");
  await expect(d.getByLabel("Ward admission (%)", { exact: true })).toHaveValue(
    "100",
  );
  await d.getByLabel("Mix basis").selectOption("profiles");
  await expect(
    d.getByLabel("Intensive care · ventilation (%)", { exact: true }),
  ).toHaveCount(0);
  await expect(
    d.getByLabel("Ward care · usual needs (%)", { exact: true }),
  ).toBeVisible();
  await d.getByLabel("Mix basis").selectOption("cohorts");
  await expect(
    d.getByLabel("Intensive care · usual stay (%)", { exact: true }),
  ).toHaveCount(0);
  await d.getByRole("button", { name: "Apply change" }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(saved.conditions[0].entry_stream_id).toBe("DIRECT_WARD_MAIN");
  expect(
    Object.keys(saved.conditions[0].care_mix_override).every((k) =>
      k.startsWith("COHORT-WARD-"),
    ),
  ).toBe(true);
  record("scenario-cohort-semantics", {
    reopened_cohort_keys_preserved: true,
    stream_change_resets_basis: true,
    direct_ward_choices_filtered: true,
    scenario_id: context.scenario.id,
  });
});

test("custom imported curves, multiple windows and exact time edits retain canonical inputs", async ({
  page,
}, info) => {
  const curve = {
    id: "custom-import",
    kind: "arrival_multiplier",
    entry_stream_id: "ED_MAIN",
    shape: "piecewise_linear",
    source: "imported",
    control_points: [
      { at: "2026-10-16T05:00:00Z", multiplier: 1.2 },
      { at: "2026-10-16T09:12:00Z", multiplier: 2.1 },
      { at: "2026-10-17T13:30:00Z", multiplier: 1.4 },
      { at: "2026-10-18T05:00:00Z", multiplier: 1.1 },
    ],
  };
  const context = await scenario(page, "exact imported curves", {
    conditions: [curve],
  });
  await open(page, context.scenario.id, "overview");
  await expandScenarioDetails(page);
  await expect(
    page.getByRole("radio", { name: "Custom", exact: true }),
  ).toBeChecked();
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill("Unrelated edit preserves exact imported points");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  expect(
    (await api(page.request, "/scenarios/" + context.scenario.id)).conditions,
  ).toEqual([curve]);
  await page.getByLabel("Point 2 multiplier", { exact: true }).fill("2.4");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  let saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(saved.conditions[0].control_points[1]).toEqual({
    ...curve.control_points[1],
    multiplier: 2.4,
  });
  expect(saved.conditions[0].control_points[2]).toEqual(
    curve.control_points[2],
  );
  expect(saved.conditions[0].source).toBe("imported");
  await page
    .getByRole("button", { name: "Add another arrival interval", exact: true })
    .click();
  await page.getByLabel("Increase in ED arrivals").fill("25");
  await page.getByLabel("Starts on day", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  saved = await api(page.request, "/scenarios/" + context.scenario.id);
  expect(
    saved.conditions.filter((c: any) => c.kind === "arrival_multiplier"),
  ).toHaveLength(2);
  expect(new Set(saved.conditions.map((c: any) => c.id)).size).toBe(2);
  expect(
    saved.conditions
      .find((c: any) => c.id !== curve.id)
      .control_points.map((p: any) => p.multiplier),
  ).toEqual([1.25, 1.25]);
  await page
    .getByRole("button", { name: "Add equipment", exact: true })
    .click();
  let d = page.getByRole("dialog");
  await d.getByLabel("Change name").fill("Exact scheduled equipment change");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-17T00:00");
  await d.getByRole("button", { name: "Apply change" }).click();
  const block = page.getByRole("button", {
    name: "Exact scheduled equipment change Planning assumption",
    exact: true,
  });
  await block.click();
  d = page.getByRole("dialog");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-17T01:00");
  await d.getByRole("button", { name: "Apply change", exact: true }).click();
  await block.click();
  d = page.getByRole("dialog");
  await expect(
    d.getByLabel("Effective time (America/Chicago)", { exact: true }),
  ).toHaveValue("2026-10-17T01:00");
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await block.click();
  await expect(
    page
      .getByRole("dialog")
      .getByLabel("Effective time (America/Chicago)", { exact: true }),
  ).toHaveValue("2026-10-17T00:00");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  record("scenario-exact-curves", {
    scenario_id: context.scenario.id,
    unrelated_save_preserves_custom_curve: true,
    custom_point_edit_preserves_other_points: true,
    multiple_intervals_unique: true,
    exact_time_edit_retains_hour: true,
    undo_restores_exact_time: true,
  });
});

test("legacy arrival inputs show the engine default and survive unrelated saves", async ({
  page,
}, info) => {
  const context = await scenario(page, "legacy arrival default", {
    conditions: [
      {
        id: "legacy-default-demand",
        kind: "arrival_multiplier",
        multiplier: 2,
      },
    ],
    replications: 1,
  });
  await open(page, context.scenario.id, "overview");
  await expect(
    page.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toHaveValue("70%");
  const graph = page.getByTestId("arrival-preview-chart");
  const planned = (await graph.getAttribute("data-planned-arrivals"))!
    .split(",")
    .map(Number);
  const usual = (await graph.getAttribute("data-usual-arrivals"))!
    .split(",")
    .map(Number);
  planned.forEach((value, index) =>
    expect(value / usual[index]).toBeCloseTo(1.7),
  );
  await page
    .getByLabel("Scenario name", { exact: true })
    .fill("Unrelated save keeps legacy engine defaults");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const unchanged = await api(
    page.request,
    `/scenarios/${context.scenario.id}`,
  );
  expect(unchanged.conditions).toEqual(context.scenario.conditions);
  await page.getByLabel("Increase in ED arrivals", { exact: true }).fill("35");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const edited = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(
    edited.conditions[0].control_points.map((point: any) => point.multiplier),
  ).toEqual([1.35, 1.35]);
  record(`legacy-demand-controls-${info.project.name}`, {
    scenario_id: edited.id,
    displayed_engine_default_percent: 70,
    unchanged_canonical_input_preserved: true,
    explicit_edit_applied_percent: 35,
  });
});

test("editing exact stepped arrivals preserves their step behavior", async ({
  page,
}, info) => {
  const curve = {
    id: "exact-stepped-arrivals",
    kind: "arrival_multiplier",
    shape: "step",
    source: "imported",
    control_points: [
      { at: "2026-10-16T05:00:00Z", multiplier: 1.2 },
      { at: "2026-10-17T05:00:00Z", multiplier: 2 },
      { at: "2026-10-19T05:00:00Z", multiplier: 1 },
    ],
  };
  const context = await scenario(page, "exact stepped arrivals", {
    conditions: [curve],
    replications: 1,
  });
  await open(page, context.scenario.id, "overview");
  await expect(
    page.getByRole("radio", { name: "Custom", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByLabel("Increase in ED arrivals", { exact: true }),
  ).toBeDisabled();
  await expandScenarioDetails(page);
  await page.getByLabel("Point 2 multiplier", { exact: true }).fill("2.3");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  expect(saved.conditions[0]).toMatchObject({
    shape: "step",
    source: "imported",
  });
  expect(saved.conditions[0].control_points).toEqual([
    curve.control_points[0],
    { ...curve.control_points[1], multiplier: 2.3 },
    curve.control_points[2],
  ]);
  const graph = page.getByTestId("arrival-preview-chart");
  const planned = (await graph.getAttribute("data-planned-arrivals"))!
      .split(",")
      .map(Number),
    usual = (await graph.getAttribute("data-usual-arrivals"))!
      .split(",")
      .map(Number);
  expect(planned[0] / usual[0]).toBeCloseTo(1.2);
  expect(planned[1] / usual[1]).toBeCloseTo(2.3);
  expect(planned[2] / usual[2]).toBeCloseTo(2.3);
  record(`exact-stepped-arrivals-${info.project.name}`, {
    scenario_id: saved.id,
    step_interpolation_preserved: true,
    unrelated_points_preserved: true,
  });
});
