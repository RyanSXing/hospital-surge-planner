import { expect, test } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  record,
  scenario,
  waitRun,
} from "./helpers";

test("Summary names the recorded nursing, medical and support constraints for the full simulation", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Constraint evidence is verified on desktop.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "exact ED staffing bottlenecks", {
    horizon_calendar_days: 1,
    replications: 1,
    conditions: [
      {
        id: "summary-no-ed-team",
        kind: "unit_configuration",
        unit_id: "UNIT-ED",
        staff_counts: { rn: 0, provider: 0, support: 0 },
        source: "user_assumption",
      },
    ],
  });
  const datasetBefore = await api(
    page.request,
    `/datasets/${context.dataset.id}`,
  );
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const scenarioBeforeInspection = await api(
      page.request,
      `/scenarios/${context.scenario.id}`,
    ),
    rep = run.selected_replication_id,
    diagnostic = await api(page.request, `/runs/${rep}/bottlenecks`),
    metrics = await api(
      page.request,
      `/run-groups/${run.id}/metrics?grain=day`,
    );
  expect(run.replications_completed).toBe(1);
  expect(run.scenario_context.conditions).toEqual(context.scenario.conditions);
  expect(diagnostic.scope).toBe("selected_replication");
  expect(diagnostic.replication_id).toBe(rep);
  expect(diagnostic.evidence_available).toBe(true);
  expect(diagnostic.non_additive).toBe(true);
  expect(Date.parse(diagnostic.start_at)).toBe(Date.parse(run.start_at));
  expect(Date.parse(diagnostic.end_at)).toBe(Date.parse(run.end_at));
  const nursing = diagnostic.categories.find(
      (row: any) => row.reason === "nursing_capacity",
    ),
    team = diagnostic.categories.find(
      (row: any) => row.reason === "minimum_operating_team",
    );
  expect(nursing?.patient_hours).toBeGreaterThan(0);
  expect(team?.patient_hours).toBeGreaterThan(0);
  const roles = diagnostic.resources.filter(
    (row: any) => row.unit_id === "UNIT-ED" && row.kind === "staff",
  );
  expect(new Set(roles.map((row: any) => row.code))).toEqual(
    new Set(["rn", "provider", "support"]),
  );
  for (const row of roles) {
    expect(row.patient_hours).toBeGreaterThan(0);
    expect(row.reason).toBe(
      row.code === "rn" ? "nursing_capacity" : "minimum_operating_team",
    );
  }
  // With one replication, independent integrated daily means must equal each
  // whole-run category. Overlapping reasons are deliberately never added up.
  for (const row of diagnostic.categories) {
    const wholeRunHours = metrics.daily.reduce((total: number, day: any) => {
      const value = day.blocker_patient_hours?.[row.reason];
      return total + (typeof value === "number" ? value : value?.mean || 0);
    }, 0);
    expect(row.patient_hours).toBeCloseTo(wholeRunHours, 8);
  }
  const late = new Date(Date.parse(run.end_at) - 60_000).toISOString();
  expect(Date.parse(nursing.first_at)).toBeLessThan(Date.parse(late));
  await page.goto(
    `/?view=analysis&analysis=summary&scenario=${context.scenario.id}&run=${run.id}&at=${encodeURIComponent(late)}`,
  );
  const panel = page.getByTestId("simulation-bottlenecks");
  await expect(
    panel.getByRole("heading", {
      name: "What limited patient flow",
      exact: true,
    }),
  ).toBeVisible();
  await expect(panel).toContainText("whole measured period");
  await expect(page.locator(".summary-insight")).toContainText(
    "waiting for care",
  );
  const nursingRow = panel
      .locator(".summary-bottleneck-list > article")
      .filter({
        has: page.getByRole("heading", {
          name: "No staffed bed available",
          exact: true,
        }),
      }),
    teamRow = panel.locator(".summary-bottleneck-list > article").filter({
      has: page.getByRole("heading", {
        name: "Minimum medical or support team missing",
        exact: true,
      }),
    });
  await expect(nursingRow).toContainText(
    "Emergency department · Registered nurse",
  );
  await expect(teamRow).toContainText(
    "Emergency department · Medical provider",
  );
  await expect(teamRow).toContainText("Emergency department · Support staff");
  const format = (value: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
  for (const [row, expected] of [
    [nursingRow, nursing],
    [teamRow, team],
  ] as const) {
    await expect(row.locator(".summary-bottleneck-value strong")).toHaveText(
      `${format(expected.patient_hours)} patient-hours`,
    );
    await expect(row).toContainText(
      `Up to ${format(expected.peak_waiting)} patients waiting`,
    );
  }
  await nursingRow
    .getByRole("button", {
      name: "Show first no staffed bed available constraint",
      exact: true,
    })
    .click();
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBe(Date.parse(nursing.first_at));
  const state = await api(
      page.request,
      `/runs/${rep}/state?at=${encodeURIComponent(nursing.first_at)}`,
    ),
    ed = state.units.find((unit: any) => unit.unit_id === "UNIT-ED"),
    originalEd = datasetBefore.units.find(
      (unit: any) => unit.unit_id === "UNIT-ED",
    );
  expect(ed.qualified_staff_by_role).toEqual({
    rn: 0,
    provider: 0,
    support: 0,
  });
  expect(ed.physical).toBe(originalEd.physical_capacity);
  expect(ed.enabled).toBe(originalEd.enabled_capacity);
  expect(ed.staffed).toBe(0);
  // Moving to a first-occurrence timestamp must not turn the whole-run report
  // into selected-time counts or mutate its immutable source inputs.
  await expect(
    nursingRow.locator(".summary-bottleneck-value strong"),
  ).toHaveText(`${format(nursing.patient_hours)} patient-hours`);
  expect(await api(page.request, `/runs/${rep}/bottlenecks`)).toEqual(
    diagnostic,
  );
  expect(await api(page.request, `/scenarios/${context.scenario.id}`)).toEqual(
    scenarioBeforeInspection,
  );
  expect(await api(page.request, `/datasets/${context.dataset.id}`)).toEqual(
    datasetBefore,
  );
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  await capture(page, "summary-exact-staffing-bottlenecks", info);
  record("summary-exact-bottlenecks-desktop", {
    scenario_id: context.scenario.id,
    run_group_id: run.id,
    replication_id: rep,
    whole_measured_period: {
      start_at: diagnostic.start_at,
      end_at: diagnostic.end_at,
    },
    categories: diagnostic.categories,
    named_roles: roles,
    integrated_daily_means_match_full_run_categories: true,
    first_occurrence_link_selected_at: nursing.first_at,
    full_run_report_retained_after_time_selection: true,
    source_and_saved_scenario_unchanged_by_inspection: true,
    browser_errors: errors,
  });
});
