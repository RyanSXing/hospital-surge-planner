import { expandScenarioDetails } from "./scenario-ui";
import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("selected alternate replication and patient survive a page reload", async ({
  page,
}, info) => {
  const context = await scenario(page, "restored context", {
    horizon_calendar_days: 2,
    replications: 3,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const replicas = await api(
      page.request,
      `/run-groups/${run.id}/replications`,
    ),
    alternate = replicas.items.find(
      (r: any) => r.id !== run.selected_replication_id,
    );
  expect(alternate).toBeTruthy();
  await open(page, context.scenario.id, "replay", run.id);
  const choice = page.getByLabel("Select replication to replay");
  await choice.selectOption(alternate.id);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("replication"), {
      timeout: 45000,
    })
    .toBe(alternate.id);
  await expect(choice).toBeEnabled();
  await page
    .getByRole("button", { name: "View patient census", exact: true })
    .click();
  const first = page
    .locator(".replay-page .patient-census tbody button")
    .first();
  await expect(first).toBeVisible();
  const patientLabel = (await first.textContent())?.trim();
  await first.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("patient"))
    .toBeTruthy();
  const patient = new URL(page.url()).searchParams.get("patient")!;
  const saved = page.url();
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(choice).toHaveValue(alternate.id);
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await expect(page.locator(".replay-inspector")).toContainText(patient);
  expect(new URL(page.url()).searchParams.get("replication")).toBe(
    alternate.id,
  );
  expect(new URL(page.url()).searchParams.get("patient")).toBe(patient);
  expect(new URL(page.url()).searchParams.get("run")).toBe(run.id);
  await capture(page, "restored-context", info);
  record("restored-context", {
    run_id: run.id,
    replication_id: alternate.id,
    patient_id: patient,
    patient_label: patientLabel,
    scenario_id: context.scenario.id,
    at: new URL(saved).searchParams.get("at"),
  });
});

test("exact arrival dates and care edits preserve completed forecast inputs", async ({
  page,
}, info) => {
  const context = await scenario(page, "condition editing", {
    horizon_calendar_days: 10,
    replications: 1,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "overview", run.id);
  await expandScenarioDetails(page);
  await page.getByLabel("Increase in ED arrivals").fill("70");
  await page.getByLabel("Starts on day").fill("3");
  await page.getByLabel("Ends on day").fill("8");
  await page.getByLabel("Care mix").selectOption("percentages");
  await page
    .getByLabel("Discharge after assessment (%)", { exact: true })
    .fill("60");
  await page.getByLabel("Ward admission (%)", { exact: true }).fill("30");
  await page.getByLabel("ICU admission (%)", { exact: true }).fill("10");
  const graph = page.getByTestId("arrival-preview-chart");
  const originalCurve = await graph.getAttribute("data-planned-arrivals");
  await page.getByLabel("Starts on day", { exact: true }).fill("4");
  await page.getByLabel("Ends on day", { exact: true }).fill("9");
  await page.getByLabel("Starts on day", { exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByLabel("Starts on day", { exact: true })).toHaveValue(
    "5",
  );
  await expect(page.getByLabel("Ends on day", { exact: true })).toHaveValue(
    "9",
  );
  await expect(graph).not.toHaveAttribute(
    "data-planned-arrivals",
    originalCurve!,
  );
  const saving = page.waitForResponse(
    (r) =>
      r.url().endsWith("/scenarios/" + context.scenario.id) &&
      r.request().method() === "PATCH",
  );
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  expect((await saving).ok()).toBeTruthy();
  const saved = await api(page.request, "/scenarios/" + context.scenario.id),
    condition = saved.conditions.find(
      (c: any) => c.kind === "arrival_multiplier",
    );
  expect(condition.care_mix_override).toEqual({
    discharge: 0.6,
    ward: 0.3,
    icu: 0.1,
  });
  expect(condition.control_points.map((point: any) => point.at)).toEqual([
    "2026-10-20T05:00:00.000Z",
    "2026-10-25T05:00:00.000Z",
  ]);
  await capture(page, "exact-arrival-parameters", info);
  const preserved = await api(page.request, "/run-groups/" + run.id);
  expect(preserved.input_sha256).toBe(run.input_sha256);
  record("condition-editor", {
    scenario_id: saved.id,
    original_run_id: run.id,
    original_input_sha256: run.input_sha256,
    care_mix: condition.care_mix_override,
    exact_window_days: [5, 9],
    saved_revision: saved.revision,
  });
});
