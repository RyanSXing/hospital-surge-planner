import { test, expect } from "@playwright/test";
import {
  api,
  open,
  scenario,
  waitRun,
  capture,
  record,
  type WorkspaceView,
} from "./helpers";

test("linked workspaces keep time docks visible and collapse panels without changing the run", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Docked desktop layout; mobile inspection has separate coverage.",
  );
  const context = await scenario(page, "shared planning panels", {
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
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
      if (!new URL(request.url()).pathname.endsWith("/feasibility"))
        mutations.push(new URL(request.url()).pathname);
  });
  const evidence: Record<string, unknown> = {};
  const views: [
    WorkspaceView,
    "patients" | "resources" | "compare" | "replay",
  ][] = [
    ["analytics-patients", "patients"],
    ["analytics-resources", "resources"],
    ["comparison", "compare"],
    ["replay", "replay"],
  ];
  for (const [view, panel] of views) {
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(page, context.scenario.id, view, run.id);
    await expect(page.locator(".state-banner")).toHaveCount(0);
    const dock = page.locator(`#${panel}-timeline-dock`),
      inspector = page.locator(`#${panel}-inspector-dock`);
    await expect(dock).toBeVisible();
    await expect(inspector).toBeVisible();
    const bounds = await dock.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(877);
    expect(bounds!.height).toBeGreaterThanOrEqual(180);
    const selected = new URL(page.url());
    await page.getByLabel(`Hide ${panel} inspector`, { exact: true }).click();
    await expect(inspector).toBeHidden();
    await expect(dock).toBeVisible();
    await page.getByLabel(`Show ${panel} inspector`, { exact: true }).click();
    await expect(inspector).toBeVisible();
    await page.getByLabel(`Hide ${panel} timeline`, { exact: true }).click();
    await expect(dock).toBeHidden();
    await expect(inspector).toBeVisible();
    await page.getByLabel(`Show ${panel} timeline`, { exact: true }).click();
    const handle = page.getByRole("separator", {
      name: `Resize ${panel} timeline`,
    });
    await handle.focus();
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "180");
    await page.keyboard.press("ArrowUp");
    await expect(handle).toHaveAttribute("aria-valuenow", "190");
    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "260");
    await page.keyboard.press("Home");
    for (const key of [
      "scenario",
      "dataset",
      "run",
      "at",
      "replication",
      "patient",
      "unit",
    ])
      expect(new URL(page.url()).searchParams.get(key)).toBe(
        selected.searchParams.get(key),
      );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await capture(page, `shared-panels-${panel}`, info);
    evidence[panel] = {
      dock: bounds,
      independent_collapse: true,
      keyboard_resize: true,
      context_preserved: true,
    };
  }
  expect(mutations).toEqual([]);
  const final = await api(page.request, `/run-groups/${run.id}`);
  expect(final.input_sha256).toBe(run.input_sha256);
  record("shared-panels", {
    run_id: run.id,
    input_sha256: run.input_sha256,
    views: evidence,
  });
});
