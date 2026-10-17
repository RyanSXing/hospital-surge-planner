import { expect, test, type Page } from "@playwright/test";
import {
  api,
  open,
  scenario,
  waitRun,
  workspaceViewQuery,
  type WorkspaceView,
} from "./helpers";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function urlValue(page: Page, key: string) {
  return new URL(page.url()).searchParams.get(key);
}

async function openAt(
  page: Page,
  scenarioId: string,
  view: WorkspaceView,
  runId: string,
  at: string,
) {
  await page.goto(
    `/?scenario=${scenarioId}&${workspaceViewQuery(view)}&run=${runId}&at=${encodeURIComponent(at)}`,
  );
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByText("Loading planning workspace")).toHaveCount(0);
}

async function inspectSearchResult(
  page: Page,
  id: string,
  provenance?: string,
) {
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByLabel("Search workspace content").fill(id);
  const result = dialog.locator(".search-results button").filter({
    hasText: id,
  });
  await expect(result).toHaveCount(1);
  if (provenance) await expect(result).toContainText(provenance);
  await result.click();
}

test("workspace search keeps completed-run context and map controls preserve their routes", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "This desktop workflow exercises the map canvas and shared inspectors once.",
  );
  test.setTimeout(240_000);

  const context = await scenario(page, "map and inventory search", {
    horizon_calendar_days: 1,
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
  const dataset = await api(page.request, `/datasets/${context.dataset.id}`);
  const at = context.scenario.start_at;
  const unit =
    dataset.units?.find((value: { kind: string }) => value.kind === "icu") ||
    dataset.units?.[0];
  const equipment = dataset.equipment_pools?.[0];
  const vehicle = dataset.vehicles?.[0];
  const slot = dataset.slots?.[0];
  expect(unit?.unit_id).toBeTruthy();
  expect(equipment?.equipment_pool_id).toBeTruthy();
  expect(vehicle?.vehicle_id).toBeTruthy();
  expect(slot?.slot_id).toBeTruthy();

  await openAt(page, context.scenario.id, "summary", run.id, at);
  await inspectSearchResult(page, unit.unit_id, "Recorded selected time");
  expect(urlValue(page, "view")).toBe("analysis");
  expect(urlValue(page, "analysis")).toBe("analytics");
  expect(urlValue(page, "section")).toBe("patients");
  expect(urlValue(page, "unit")).toBe(unit.unit_id);
  expect(urlValue(page, "run")).toBe(run.id);
  expect(urlValue(page, "at")).toBe(at);
  await expect(page.getByRole("button", { name: /Clear unit/ })).toBeVisible();
  await expect(page.locator(".patient-inspector")).toContainText(unit.name);

  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: /Clear unit/ })).toBeVisible();
  expect(urlValue(page, "unit")).toBe(unit.unit_id);
  expect(urlValue(page, "run")).toBe(run.id);
  expect(urlValue(page, "at")).toBe(at);

  for (const [kind, id, provenance] of [
    ["equipment pool", equipment.equipment_pool_id],
    ["vehicle", vehicle.vehicle_id, "Recorded selected time"],
    ["slot", slot.slot_id, "Recorded selected time"],
  ] as const) {
    await inspectSearchResult(page, id, provenance);
    expect(urlValue(page, "view")).toBe("analysis");
    expect(urlValue(page, "analysis")).toBe("analytics");
    expect(urlValue(page, "section")).toBe("resources");
    expect(urlValue(page, "resource")).toBe(id);
    expect(urlValue(page, "resource_type")).toBe(kind.replace(" ", "_"));
    expect(urlValue(page, "run")).toBe(run.id);
    expect(urlValue(page, "at")).toBe(at);
    const inspector = page.locator("#resources-inspector-dock");
    await expect(inspector).toContainText(id);
    await expect(inspector).toContainText(`SELECTED ${kind}`);
    await inspector
      .getByRole("button", { name: "Clear selected resource" })
      .click();
  }

  await open(page, context.scenario.id, "analytics-resources", run.id);
  const targetSite = dataset.facilities.find(
    (facility: { facility_id: string }) =>
      facility.facility_id !== dataset.facilities[0]?.facility_id,
  );
  expect(targetSite).toBeTruthy();
  await page
    .getByRole("button", {
      name: new RegExp(`^Select ${escapeRegex(targetSite.name)}:`),
    })
    .click();
  expect(urlValue(page, "view")).toBe("analysis");
  expect(urlValue(page, "analysis")).toBe("analytics");
  expect(urlValue(page, "section")).toBe("resources");
  expect(urlValue(page, "facility")).toBe(targetSite.facility_id);

  await page.getByRole("button", { name: "Map layers" }).click();
  const layerPanel = page.getByLabel("Map layer controls");
  await expect(layerPanel).toBeVisible();
  for (const label of [
    "Facilities",
    "Capacity",
    "Patient cohorts",
    "Transfer paths",
    "Candidate sites",
    "Incident reports",
    "Buildings",
  ]) {
    const toggle = layerPanel.getByLabel(`Show ${label}`);
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
  }

  await expect(page.locator(".map-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Fit all sites" }).click();
  await expect(page.locator(".map-canvas canvas")).toBeVisible();
  await page.getByRole("button", { name: "Reset camera" }).click();
  await expect(page.locator(".map-canvas canvas")).toBeVisible();
  await openAt(page, context.scenario.id, "analytics-resources", run.id, at);
  const overflow = dataset.facilities.find(
    (facility: any) => facility.facility_id === "FAC-OVERFLOW-SOUTH",
  );
  await page
    .locator(".site-list .site-item")
    .filter({ hasText: overflow.name })
    .click();
  const graph = page.locator(".candidate-dependency-overlay");
  await expect(graph).toBeVisible();
  await expect(
    graph.getByRole("button", {
      name: `Plan declared places for ${overflow.name}`,
    }),
  ).toContainText("0 installed / 20 planned");
});
