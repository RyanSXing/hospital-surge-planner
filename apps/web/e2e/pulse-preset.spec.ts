import { expandScenarioSection } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, open, record, scenario, waitRun } from "./helpers";

test("extra arrival groups are editable, undoable and frozen as one additive batch", async ({
  page,
}, info) => {
  const separate = {
    id: "separate-incident",
    name: "Earlier extra patients",
    kind: "arrival_batch",
    entry_stream_id: "ED_MAIN",
    at: "2026-10-16T11:00:00Z",
    count: 3,
    spread_minutes: 0,
    care_mix: { discharge: 1 },
    source: "user_assumption",
  };
  const context = await scenario(page, "editable short arrival pulse", {
    replications: 2,
    conditions: [
      {
        id: "selected-surge",
        kind: "arrival_multiplier",
        entry_stream_id: "ED_MAIN",
        shape: "step",
        surge_percent: 70,
        control_points: [
          { at: "2026-10-16T05:00:00Z", multiplier: 1.7 },
          { at: "2026-10-19T05:00:00Z", multiplier: 1.7 },
        ],
      },
      separate,
    ],
  });
  await open(page, context.scenario.id, "overview");
  await page.getByLabel("Increase in ED arrivals", { exact: true }).fill("0");
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", { name: "Add extra patient arrivals", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Change name", { exact: true })
    .fill("Short arrival pulse");
  await dialog
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-17T12:00");
  await dialog.getByLabel("Additional patients", { exact: true }).fill("20");
  await dialog
    .getByLabel("Spread arrivals over (minutes)", { exact: true })
    .fill("60");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  const pulse = page.getByRole("button", {
    name: "Short arrival pulse Planning assumption",
    exact: true,
  });
  await expect(pulse).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(pulse).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(pulse).toBeVisible();
  await pulse.click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Additional patients", { exact: true }),
  ).toHaveValue("20");
  await expect(
    dialog.getByLabel("Spread arrivals over (minutes)", { exact: true }),
  ).toHaveValue("60");
  await expect(
    dialog.getByLabel("Where patients arrive", { exact: true }),
  ).toHaveValue("ED_MAIN");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const submission = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  const runButton = page.getByRole("button", {
    name: "Run simulation",
    exact: true,
  });
  await expect(runButton).toBeEnabled();
  await runButton.click();
  const queued = await (await submission).json();
  const saved = await api(page.request, `/scenarios/${context.scenario.id}`);
  const batch = saved.conditions.find(
    (condition: any) => condition.name === "Short arrival pulse",
  );
  expect(batch).toMatchObject({
    kind: "arrival_batch",
    entry_stream_id: "ED_MAIN",
    count: 20,
    spread_minutes: 60,
    at: "2026-10-17T17:00:00.000Z",
    care_mix: { discharge: 0.8, ward: 0.16, icu: 0.04 },
    source: "user_assumption",
  });
  expect(saved.conditions).toHaveLength(2);
  expect(
    saved.conditions.some(
      (condition: any) => condition.kind === "arrival_multiplier",
    ),
  ).toBe(false);
  expect(
    saved.conditions.find((condition: any) => condition.id === separate.id),
  ).toEqual(separate);
  expect(
    saved.revisions.find(
      (revision: any) => revision.id === queued.scenario_revision_id,
    ).conditions,
  ).toEqual(saved.conditions);
  const run = await waitRun(page, queued.id);
  const trace = await api(
    page.request,
    `/runs/${run.selected_replication_id}/events?event_type=arrival&start_at=${encodeURIComponent(batch.at)}&end_at=${encodeURIComponent(new Date(Date.parse(batch.at) + 3600000).toISOString())}&limit=200`,
  );
  const arrivals = trace.items.filter((event: any) =>
    event.patient_id?.startsWith(`PAT-REPORT-${batch.id}-`),
  );
  expect(arrivals).toHaveLength(20);
  expect(
    arrivals.every(
      (event: any) =>
        Date.parse(event.occurred_at) >= Date.parse(batch.at) &&
        Date.parse(event.occurred_at) < Date.parse(batch.at) + 3600000,
    ),
  ).toBe(true);
  record(`hospital-arrival-pulse-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    saved_batch: batch,
    frozen_conditions_equal: true,
    exact_batch_arrivals: arrivals.length,
    undo_redo_verified: true,
    unrelated_incident_preserved: true,
  });
});

test("extra arrivals reject times outside the simulation period", async ({
  page,
}) => {
  const context = await scenario(page, "arrival pulse outside horizon", {
    horizon_calendar_days: 1,
  });
  await open(page, context.scenario.id, "overview");
  await expandScenarioSection(page, "resources");
  await page
    .getByRole("button", { name: "Add extra patient arrivals", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Change name", { exact: true })
    .fill("Out-of-period arrivals");
  await dialog
    .getByLabel("Effective time (America/Chicago)", { exact: true })
    .fill("2026-10-17T12:00");
  await dialog
    .getByRole("button", { name: "Apply change", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "effective time must lie within the scenario horizon",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Out-of-period arrivals Planning assumption",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (await api(page.request, `/scenarios/${context.scenario.id}`)).conditions,
  ).toEqual([]);
});
