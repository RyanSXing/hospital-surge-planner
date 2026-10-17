import { test, expect } from "@playwright/test";
import { api, open, record, scenario } from "./helpers";

test("cohort edit and stream changes retain compatible visible mix semantics", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
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
  await open(page, context.scenario.id, "scenarios");
  const block = page.getByRole("button", {
    name: "Declared ward cohort Planning assumption",
    exact: true,
  });
  await block.click();
  let d = page.getByRole("dialog");
  await expect(d.getByLabel("Mix basis")).toHaveValue("cohorts");
  await expect(
    d.getByLabel("COHORT-WARD-SHORT (%)", { exact: true }),
  ).toHaveValue("70");
  await d.getByRole("button", { name: "Apply assumption" }).click();
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
  await d
    .getByLabel("Incident or cohort entry stream")
    .selectOption("DIRECT_WARD_MAIN");
  await expect(d.getByLabel("Mix basis")).toHaveValue("care");
  await expect(d.getByLabel("ward (%)", { exact: true })).toHaveValue("100");
  await d.getByLabel("Mix basis").selectOption("profiles");
  await expect(
    d.getByLabel("RP-ICU-VENTILATED (%)", { exact: true }),
  ).toHaveCount(0);
  await expect(
    d.getByLabel("RP-WARD-BASIC (%)", { exact: true }),
  ).toBeVisible();
  await d.getByLabel("Mix basis").selectOption("cohorts");
  await expect(
    d.getByLabel("COHORT-ICU-STANDARD (%)", { exact: true }),
  ).toHaveCount(0);
  await d.getByRole("button", { name: "Apply assumption" }).click();
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

test("custom imported curves, multiple windows and timeline moves retain exact inputs", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
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
  await open(page, context.scenario.id, "scenarios");
  await expect(page.getByLabel("Scenario preset")).toHaveValue("custom");
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
    .getByRole("button", { name: "Add equipment availability", exact: true })
    .click();
  let d = page.getByRole("dialog");
  await d.getByLabel("Assumption name").fill("Drag exact planned change");
  await d
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-17T00:00");
  await d.getByRole("button", { name: "Apply assumption" }).click();
  const block = page.getByRole("button", {
    name: "Drag exact planned change Planning assumption",
    exact: true,
  });
  await block.scrollIntoViewIfNeeded();
  const bounds = await block.boundingBox();
  const row = await block
    .locator("xpath=ancestor::div[contains(@class,'plan-timeline-row')]")
    .boundingBox();
  expect(bounds && row).toBeTruthy();
  expect(
    await block.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      );
    }),
  ).toBe(true);
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2 + row!.width / 72,
    bounds!.y + bounds!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
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
    pointer_move_exact_hour: true,
    undo_restores_exact_time: true,
  });
});
