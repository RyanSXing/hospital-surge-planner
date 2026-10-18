import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("historical results retain frozen dates and assumptions beside an edited draft", async ({
  page,
}, info) => {
  const context = await scenario(page, "immutable result presentation", {
    horizon_calendar_days: 1,
    replications: 1,
    interventions: [
      {
        id: "frozen-reserve",
        name: "Frozen reserve assignment",
        kind: "staff_existing",
        unit_id: "UNIT-WARD-A",
        facility_id: "FAC-MAIN",
        nurses: 1,
        activation_minutes: 0,
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
  const editedName = "Edited three-day draft " + Date.now();
  const changed = await page.request.patch(
    `/api/scenarios/${context.scenario.id}`,
    {
      headers: { "If-Match": String(context.scenario.revision) },
      data: {
        name: editedName,
        horizon_calendar_days: 3,
        timezone: "America/New_York",
        interventions: [],
        conditions: [
          {
            kind: "arrival_multiplier",
            entry_stream_id: "ED_MAIN",
            shape: "step",
            multiplier: 2.4,
            start_at: context.scenario.start_at,
            end_at: run.end_at,
          },
        ],
      },
    },
  );
  expect(changed.ok()).toBe(true);
  await open(page, context.scenario.id, "replay", run.id);
  await expect(page.locator(".stale-banner")).toContainText(
    "current draft has changes",
  );
  await expect(page.locator(".context-actions")).toContainText(
    "Oct 16 – Oct 16",
  );
  await expect(page.locator(".statusbar")).toContainText("America/Chicago");
  await expect(page.locator(".breadcrumb")).toContainText(
    context.scenario.name,
  );
  await page
    .getByRole("button", { name: "Advanced replay tools", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Go to run horizon", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("at"))
    .toBe(run.end_at);
  await page.reload();
  await expect(page.locator(".context-actions")).toContainText(
    "Oct 16 – Oct 16",
  );
  await expect(page.locator(".statusbar")).toContainText("America/Chicago");
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Configuration", exact: true })
    .click();
  await expect(page.getByLabel("Scenario name", { exact: true })).toHaveValue(
    editedName,
  );
  await expect(page.locator(".context-actions")).toContainText(
    "Oct 16 – Oct 18",
  );
  await expect(
    page
      .locator(".context-actions")
      .getByRole("button", { name: "Run simulation", exact: true }),
  ).toHaveCount(0);
  const frozen = await api(page.request, `/run-groups/${run.id}`);
  expect(frozen.input_sha256).toBe(run.input_sha256);
  expect(frozen.scenario_context.horizon_calendar_days).toBe(1);
  expect(frozen.scenario_context.timezone).toBe("America/Chicago");
  await capture(page, "frozen-result-draft-context", info);
  record("frozen-result-context", {
    project: info.project.name,
    run_id: run.id,
    frozen_days: 1,
    draft_days: 3,
    frozen_timezone: "America/Chicago",
    draft_timezone: "America/New_York",
    reloaded_frozen_dates: true,
    immutable_inputs: true,
  });
});

test("completed comparisons and source search preserve distinct frozen and rebased datasets", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Cross-dataset lineage is exercised once; responsive inspectors have separate coverage.",
  );
  const context = await scenario(page, "frozen comparison provenance", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  const created = await api(page.request, "/comparisons", "POST", {
    scenario_id: context.scenario.id,
    replications: 1,
    plans: [
      {
        name: "Physical places",
        interventions: [
          {
            kind: "physical_overflow",
            facility_id: "FAC-MAIN",
            unit_id: "UNIT-WARD-C",
            enabled_slots: 32,
            activation_minutes: 60,
          },
        ],
      },
    ],
  });
  let comparison: any;
  await expect
    .poll(
      async () => {
        comparison = await api(page.request, `/comparisons/${created.id}`);
        return comparison.status;
      },
      { timeout: 60000 },
    )
    .toBe("SUCCEEDED");
  const reference = await api(
    page.request,
    `/run-groups/${comparison.plans[0].run_group_id}`,
  );
  const rebased = await scenario(
    page,
    "rebased source fixture",
    { horizon_calendar_days: 1, replications: 1 },
    "stress_snapshot",
  );
  const changed = await page.request.patch(
    `/api/scenarios/${context.scenario.id}`,
    {
      headers: { "If-Match": String(context.scenario.revision) },
      data: {
        name: "Rebased live draft",
        timezone: "America/New_York",
        dataset_version_id: rebased.dataset.id,
        horizon_calendar_days: 3,
        base_seed: 99,
      },
    },
  );
  expect(changed.ok()).toBe(true);
  const historicalBefore = await api(
    page.request,
    `/comparisons/${comparison.id}`,
  );
  await page.goto(
    `/?scenario=${context.scenario.id}&run=${reference.id}&view=analysis&analysis=comparison&comparison=${comparison.id}&compare_left=${context.scenario.id}&compare_right=${rebased.scenario.id}`,
  );
  await expect(
    page.getByRole("heading", { name: "Compare saved scenarios", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Left saved scenario", { exact: true }),
  ).toHaveValue(context.scenario.id);
  await expect(
    page.getByLabel("Right saved scenario", { exact: true }),
  ).toHaveValue(rebased.scenario.id);
  await expect(page.getByTestId("comparison-left")).toContainText("3 days");
  await expect(
    page.getByTestId("left-average_wait_per_patient_hours"),
  ).toHaveText("—");
  // Historical response-plan runs are preserved, but are not results for the
  // separately edited saved library configuration.
  await expect(
    page.getByRole("button", {
      name: "Open left scenario results",
      exact: true,
    }),
  ).toHaveCount(0);
  const current = await api(
    page.request,
    `/scenario-comparisons?left_scenario_id=${context.scenario.id}&right_scenario_id=${rebased.scenario.id}`,
  );
  expect(current.left.scenario.dataset_version_id).toBe(rebased.dataset.id);
  expect(current.left.scenario.horizon_calendar_days).toBe(3);
  expect(current.left.metrics).toBeNull();
  const frozenReference = await api(
    page.request,
    `/run-groups/${reference.id}`,
  );
  expect(frozenReference.scenario_context.dataset_version_id).toBe(
    context.dataset.id,
  );
  expect(frozenReference.scenario_context.horizon_calendar_days).toBe(1);
  expect(frozenReference.scenario_context.timezone).toBe("America/Chicago");
  expect(frozenReference.input_sha256).toBe(reference.input_sha256);
  expect(await api(page.request, `/comparisons/${comparison.id}`)).toEqual(
    historicalBefore,
  );
  await open(page, context.scenario.id, "analytics-patients", reference.id);
  await page.locator(".patient-table tbody .link-button").first().click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Configuration", exact: true })
    .click();
  await expect(page.getByLabel("Scenario name", { exact: true })).toHaveValue(
    "Rebased live draft",
  );
  await expect(page.locator(".planning-baseline")).toHaveAttribute(
    "data-baseline-dataset",
    rebased.dataset.id,
  );
  await expect
    .poll(() => new URL(page.url()).searchParams.get("dataset"))
    .toBe(rebased.dataset.id);
  const sourcePatients = await api(
    page.request,
    `/datasets/${rebased.dataset.id}/patients?limit=1`,
  );
  const patientId = sourcePatients.items[0].patient_id;
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await search.getByLabel("Search workspace content").fill(patientId);
  await search
    .locator(".search-results button")
    .filter({ hasText: patientId })
    .click();
  await expect(page.locator(".patient-inspector")).toContainText(patientId);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBeNull();
  expect(new URL(page.url()).searchParams.get("dataset")).toBe(
    rebased.dataset.id,
  );
  expect(
    (await api(page.request, `/run-groups/${reference.id}`)).input_sha256,
  ).toBe(reference.input_sha256);
  record("frozen-comparison-rebased-search", {
    comparison_id: comparison.id,
    frozen_dataset_id: context.dataset.id,
    draft_dataset_id: rebased.dataset.id,
    source_patient_id: patientId,
    source_inspection_cleared_old_run: true,
  });
});
