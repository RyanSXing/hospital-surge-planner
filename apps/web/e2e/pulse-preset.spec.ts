import { test, expect } from "@playwright/test";
import { api, open, record, scenario, waitRun } from "./helpers";

test("short arrival pulse is editable, undoable and frozen as one additive batch", async ({
  page,
}) => {
  const context = await scenario(page, "short pulse preset", {
    replications: 10,
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
      {
        id: "separate-incident",
        kind: "arrival_batch",
        entry_stream_id: "ED_MAIN",
        at: "2026-10-16T11:00:00Z",
        count: 3,
        spread_minutes: 0,
        care_mix: { discharge: 1 },
        source: "user_assumption",
      },
    ],
  });
  await open(page, context.scenario.id, "scenarios");
  await page.getByLabel("Scenario preset").selectOption("pulse");
  const pulse = page.getByRole("button", {
    name: "Short arrival pulse Planning assumption",
    exact: true,
  });
  await expect(pulse).toBeVisible();
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("0");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(pulse).toHaveCount(0);
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("70");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(pulse).toBeVisible();
  await expect(page.getByLabel("Increase in ED arrivals")).toHaveValue("0");
  await pulse.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Incident patient count")).toHaveValue("20");
  await expect(dialog.getByLabel("Incident spread (minutes)")).toHaveValue(
    "60",
  );
  await expect(
    dialog.getByLabel("Incident or cohort entry stream"),
  ).toHaveValue("ED_MAIN");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/run-groups") &&
      response.request().method() === "POST",
  );
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  const queued = await (await submitted).json();
  const saved = await api(page.request, "/scenarios/" + context.scenario.id);
  const batch = saved.conditions.find(
    (condition: any) => condition.preset_id === "PRESET-PULSE",
  );
  expect(batch).toMatchObject({
    kind: "arrival_batch",
    entry_stream_id: "ED_MAIN",
    count: 20,
    spread_minutes: 60,
    at: "2026-10-17T17:00:00.000Z",
    care_mix: { discharge: 0.8, ward: 0.16, icu: 0.04 },
    source: "synthetic_preset",
  });
  expect(saved.conditions).toHaveLength(2);
  expect(
    saved.conditions.some(
      (condition: any) => condition.kind === "arrival_multiplier",
    ),
  ).toBe(false);
  expect(
    saved.conditions.find(
      (condition: any) => condition.id === "separate-incident",
    ),
  ).toEqual(context.scenario.conditions[1]);
  const frozen = saved.revisions.find(
    (revision: any) => revision.id === queued.scenario_revision_id,
  );
  expect(frozen.conditions).toEqual(saved.conditions);
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
  record("pulse-preset", {
    scenario_id: saved.id,
    run_id: run.id,
    saved_batch: batch,
    frozen_conditions_equal: true,
    exact_batch_arrivals: arrivals.length,
    undo_redo_verified: true,
    unrelated_incident_preserved: true,
  });
});

test("short arrival pulse rejects a horizon ending before day-two noon", async ({
  page,
}) => {
  const context = await scenario(page, "short pulse horizon", {
    horizon_calendar_days: 1,
  });
  await open(page, context.scenario.id, "scenarios");
  await page.getByLabel("Scenario preset").selectOption("pulse");
  await expect(page.getByRole("alert")).toContainText(
    "local day 2 from 12:00 to 13:00",
  );
  await expect(
    page.getByRole("button", {
      name: "Short arrival pulse Planning assumption",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (await api(page.request, "/scenarios/" + context.scenario.id)).conditions,
  ).toEqual([]);
});
