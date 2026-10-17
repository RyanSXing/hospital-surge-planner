import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("replay resource inspection follows exact reservations, inventory and transport mission", async ({
  page,
}, info) => {
  const context = await scenario(
    page,
    "recorded resource inspection",
    {
      horizon_calendar_days: 1,
      replications: 1,
      interventions: [{ kind: "partner_transfer" }],
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
  const transfers = await api(
    page.request,
    `/runs/${rep}/events?event_type=transfer_departed&limit=100`,
  );
  expect(transfers.items.length).toBeGreaterThan(0);
  const at = new Date(
    Date.parse(transfers.items[0].occurred_at) + 1000,
  ).toISOString();
  const state = await api(
    page.request,
    `/runs/${rep}/state?at=${encodeURIComponent(at)}`,
  );
  const vehicle = state.vehicles.find(
    (value: any) => value.mission === transfers.items[0].patient_id,
  );
  expect(vehicle).toBeTruthy();
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
    resources
      .locator(".spread")
      .filter({ hasText: "Admission prerequisite gate" }),
  ).toContainText(unit.admission_gate ? "Open" : "Closed");
  await expect(resources).toContainText("Minimum team:");
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
  await resources
    .getByLabel("Replay transport vehicle")
    .selectOption(vehicle.vehicle_id);
  const transport = resources.getByRole("group", {
    name: "Selected transport resource",
    exact: true,
  });
  await expect(transport).toContainText("Assigned");
  await transport
    .getByRole("button", {
      name: "Inspect assigned patient " + vehicle.mission,
    })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("patient"))
    .toBe(vehicle.mission);
  await page.getByRole("tab", { name: "Patient", exact: true }).click();
  await expect(page.locator(".replay-patient-history")).toContainText(
    "Recorded patient path",
  );
  await page.getByRole("tab", { name: "Capacity", exact: true }).click();
  const otherVehicle = state.vehicles.find((value: any) => !value.mission);
  if (otherVehicle) {
    await resources
      .getByLabel("Replay transport vehicle")
      .selectOption(otherVehicle.vehicle_id);
    await expect(transport).toContainText(
      "No patient mission at this timestamp.",
    );
  }
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
    selected_mission: vehicle.mission,
    actual_api_values_match: true,
  });
});
