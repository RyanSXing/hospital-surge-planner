import { expect, test } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("cancelled runs explain their state and retry the same frozen input snapshot", async ({
  page,
}, info) => {
  const context = await scenario(page, "cancelled immutable retry", {
    horizon_calendar_days: 30,
    replications: 100,
  });
  const run = await api(page.request, "/run-groups", "POST", {
    scenario_id: context.scenario.id,
  });
  await api(page.request, `/run-groups/${run.id}/cancel`, "POST");
  await expect
    .poll(async () => (await api(page.request, `/run-groups/${run.id}`)).status)
    .toBe("CANCELLED");
  const changed = await page.request.patch(
    `/api/scenarios/${context.scenario.id}`,
    {
      headers: { "If-Match": String(context.scenario.revision) },
      data: { replications: 1, horizon_calendar_days: 1 },
    },
  );
  expect(changed.ok()).toBe(true);
  await open(page, context.scenario.id, "overview", run.id);
  await expect(
    page.getByText("Simulation cancelled.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/No completed forecast is available/),
  ).toBeVisible();
  await expect(
    page
      .locator(".context-actions")
      .getByRole("button", { name: "Export", exact: true }),
  ).toBeDisabled();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/run-groups/${run.id}/retry`) &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Retry same inputs", exact: true })
    .click();
  const retried = await (await response).json();
  expect(retried.id).toBe(run.id);
  expect(retried.input_sha256).toBe(run.input_sha256);
  expect(retried.total).toBe(100);
  await api(page.request, `/run-groups/${run.id}/cancel`, "POST");
  await expect
    .poll(async () => (await api(page.request, `/run-groups/${run.id}`)).status)
    .toBe("CANCELLED");
  await page.reload();
  await expect(
    page.getByText("Simulation cancelled.", { exact: true }),
  ).toBeVisible();
  await capture(page, "cancelled-run-retry", info);
  record("cancelled-run-retry", {
    project: info.project.name,
    run_id: run.id,
    immutable_inputs: true,
    frozen_replications: retried.total,
    completed_forecast_unavailable: true,
  });
});

test("inspector updates retain selected entities, exact time and frozen parent provenance", async ({
  page,
}, info) => {
  const context = await scenario(page, "prefilled inspector updates", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  const dataset = await api(page.request, `/datasets/${context.dataset.id}`);
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const at = new Date(Date.parse(run.start_at) + 3661250).toISOString();
  const unit = dataset.units.find(
    (u: any) =>
      u.kind === "ward" &&
      u.capacity_mode !== "advertised_aggregate" &&
      u.unit_id !== "UNIT-WARD-A",
  );
  expect(unit).toBeTruthy();
  const url = `/?scenario=${context.scenario.id}&run=${run.id}&view=patients&unit=${unit.unit_id}&at=${encodeURIComponent(at)}`;
  await page.goto(url);
  const inspector = page.locator("#patients-inspector-dock");
  const change = inspector.getByRole("button", {
    name: "Record change",
    exact: true,
  });
  await expect(change).toBeEnabled();
  await change.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Change to record", exact: true }),
  ).toHaveValue("capacity_change");
  await expect(
    dialog.getByRole("combobox", { name: "Unit", exact: true }),
  ).toHaveValue(unit.unit_id);
  await expect(dialog.getByTestId("update-source-context")).toContainText(
    run.scenario_revision_id,
  );
  await expect(
    dialog.getByRole("combobox", { name: /^Parent simulation/ }),
  ).toHaveValue(run.selected_replication_id);
  await dialog
    .getByLabel("Total enabled physical places", { exact: true })
    .fill(String(unit.enabled_capacity - 1));
  const savedResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/updates") && r.request().method() === "POST",
  );
  const branchResponse = page.waitForResponse(
    (r) =>
      /\/updates\/[^/]+\/apply$/.test(r.url()) &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Save & reforecast", exact: true })
    .click();
  const saved = await (await savedResponse).json();
  const branched = await (await branchResponse).json();
  expect(saved.type).toBe("capacity_change");
  expect(saved.payload.unit_id).toBe(unit.unit_id);
  expect(Date.parse(saved.effective_at)).toBe(Date.parse(at));
  expect(saved.source).toBe(`inspector:unit:${unit.unit_id}`);
  expect(branched.scenario.id).not.toBe(context.scenario.id);
  if (branched.run_group?.id) await waitRun(page, branched.run_group.id);
  const cases = [
    {
      kind: "equipment_pool",
      id: dataset.equipment_pools[1].equipment_pool_id,
      type: "equipment_change",
      label: "Equipment pool",
    },
    {
      kind: "staff",
      id: dataset.staff[1].staff_id,
      type: "staff_unavailable",
      label: "Specific staff (optional; otherwise use unit/count)",
    },
    {
      kind: "route",
      id: dataset.routes[1].route_id,
      type: "route_change",
      label: "Directed route",
    },
  ];
  for (const item of cases) {
    await page.goto(
      `/?scenario=${context.scenario.id}&run=${run.id}&view=resources&resource_type=${item.kind}&resource=${item.id}&at=${encodeURIComponent(at)}`,
    );
    const button = page
      .locator("#resources-inspector-dock")
      .getByRole("button", { name: "Record change", exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(
      dialog.getByRole("combobox", { name: "Change to record", exact: true }),
    ).toHaveValue(item.type);
    if (item.kind === "staff")
      await expect(
        dialog.getByRole("listbox", { name: item.label, exact: true }),
      ).toHaveValues([item.id]);
    else
      await expect(
        dialog.getByRole("combobox", { name: item.label, exact: true }),
      ).toHaveValue(item.id);
    await expect(dialog.getByTestId("update-source-context")).toContainText(
      item.id,
    );
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
  expect((await api(page.request, `/run-groups/${run.id}`)).input_sha256).toBe(
    run.input_sha256,
  );
  await page.goto(url);
  await expect(change).toBeEnabled();
  await capture(page, "inspector-update-context", info);
  const viewer = await page.request.post("/api/auth/login", {
    data: { demo_role: "viewer" },
  });
  expect(viewer.ok()).toBe(true);
  await page.reload();
  await expect(change).toBeDisabled();
  const denied = await page.request.post("/api/updates", {
    data: {
      scenario_id: context.scenario.id,
      type: "capacity_change",
      effective_at: at,
      state_origin: "simulation_branch",
      payload: { unit_id: unit.unit_id, enabled_capacity: 1 },
    },
  });
  expect(denied.status()).toBe(403);
  record("inspector-update-context", {
    project: info.project.name,
    parent_run_id: run.id,
    update_id: saved.id,
    branch_scenario_id: branched.scenario.id,
    selected_unit: unit.unit_id,
    exact_effective_at: saved.effective_at,
    resource_types: cases.map((c) => c.kind),
    parent_preserved: true,
    viewer_disabled_and_api_403: true,
  });
});
