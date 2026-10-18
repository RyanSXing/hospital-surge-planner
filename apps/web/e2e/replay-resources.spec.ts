import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("replay resource inspection follows exact hospital capacity and equipment without off-site transport controls", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "recorded resource inspection",
    {
      horizon_calendar_days: 1,
      replications: 1,
      interventions: [],
    },
    "stress_snapshot",
  );
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const rep = run.selected_replication_id;
  const at = new Date(Date.parse(run.start_at) + 3600000).toISOString();
  const state = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(at)}`,
  );
  const unit = state.units.find((value: any) => value.unit_id === "UNIT-ICU");
  expect(unit).toBeTruthy();
  await open(page, context.scenario.id, "replay", run.id);
  const url = new URL(page.url());
  url.searchParams.set("at", at);
  await page.goto(url.toString());
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await page.getByRole("tab", { name: "Capacity", exact: true }).click();
  const resources = page.locator(".replay-recorded-capacity");
  await resources.getByLabel("Replay resource unit").selectOption(unit.unit_id);
  const capacity = resources.getByRole("group", {
    name: "Recorded unit capacity",
    exact: true,
  });
  for (const [label, key] of [
    ["Ready physical places", "ready"],
    ["Available suitable places", "available"],
    ["Reserved places", "reserved"],
    ["Turnover / cleaning", "cleaning"],
    ["Capacity deficit", "capacity_deficit"],
  ]) {
    await expect(
      capacity.locator(".spread").filter({ hasText: label }).locator("strong"),
    ).toHaveText(String(unit[key]));
  }
  await expect(
    resources.locator(".spread").filter({ hasText: "Accepting new patients" }),
  ).toContainText(unit.admission_gate ? "Open" : "Closed");
  await expect(resources).toContainText("Minimum care team:");
  for (const [capability, values] of Object.entries(unit.equipment) as [
    string,
    any,
  ][]) {
    await resources
      .getByLabel("Replay equipment capability")
      .selectOption(capability);
    const inventory = resources.getByRole("group", {
      name: "Selected equipment inventory",
      exact: true,
    });
    for (const [label, key] of [
      ["Total quantity", "quantity"],
      ["In use", "in_use"],
      ["Reserved", "reserved"],
      ["Available", "available"],
      ["Deficit", "deficit"],
    ]) {
      await expect(
        inventory
          .locator(".spread")
          .filter({ hasText: new RegExp(`^${label}`) })
          .locator("strong"),
      ).toHaveText(String(values[key]));
    }
  }
  await expect(resources.getByLabel("Replay transport vehicle")).toHaveCount(0);
  const options = await resources
    .getByLabel("Replay resource unit")
    .locator("option")
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLOptionElement).value),
    );
  expect(options).toEqual(
    state.units
      .filter((value: any) => value.facility_id === "FAC-MAIN")
      .map((value: any) => value.unit_id),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "replay-resource-inspection", info);
  record("replay-resource-inspection", {
    project: info.project.name,
    scenario_id: context.scenario.id,
    run_id: run.id,
    at,
    unit_id: unit.unit_id,
    equipment_capabilities: Object.keys(unit.equipment),
    off_site_transport_controls: false,
    hospital_units_only: true,
    actual_api_values_match: true,
  });
});
