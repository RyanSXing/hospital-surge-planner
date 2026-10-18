import { expect, test } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
  type WorkspaceView,
} from "./helpers";

test("the two-page workspace and analysis sections render actual run context", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "screen audit", {
    horizon_calendar_days: 2,
    replications: 2,
  });
  const queued = await api(page.request, "/run-groups", "POST", {
    scenario_id: context.scenario.id,
  });
  const run = await waitRun(page, queued.id);
  const views: WorkspaceView[] = [
    "overview",
    "summary",
    "replay",
    "analytics-outcomes",
    "analytics-patients",
    "comparison",
    "data",
  ];
  const audit = [];

  for (const view of views) {
    await open(page, context.scenario.id, view, run.id);
    await expect(page.locator(".statusbar")).toContainText("2 completed runs");
    if (view === "overview")
      await expect(
        page.getByRole("heading", { name: "Configure your simulation" }),
      ).toBeVisible();
    if (view === "summary")
      await expect(
        page.getByRole("heading", { name: "Results summary" }),
      ).toBeVisible();
    if (view === "analytics-patients") {
      await expect(
        page.getByText("Selected simulation trajectory", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".patient-census tbody tr")).not.toHaveCount(0);
    }
    if (view === "replay")
      await expect(page.locator(".replay-summary")).toContainText(
        "84 active patients",
      );
    if (view === "comparison") {
      const caption = page.locator(".comparison-chart .chart-empty");
      await expect(caption).toBeVisible();
      const captionBox = await caption.boundingBox();
      const chartBox = await page.locator(".comparison-chart").boundingBox();
      expect(captionBox).not.toBeNull();
      expect(chartBox).not.toBeNull();
      expect(captionBox!.y + captionBox!.height).toBeLessThanOrEqual(
        chartBox!.y + chartBox!.height,
      );
      const assertComparisonWidth = async () => {
        const pageWidth = (await page.locator(".compare-page").boundingBox())!
          .width;
        for (const selector of [".comparison-main", ".comparison-chart"]) {
          const box = await page.locator(selector).boundingBox();
          expect(box, selector).not.toBeNull();
          expect(
            box!.width,
            `${selector} should use the readable content width`,
          ).toBeGreaterThanOrEqual(pageWidth - 64);
        }
      };
      await assertComparisonWidth();
      if (info.project.name === "mobile") {
        const originalViewport = page.viewportSize()!;
        for (const width of [320, 820]) {
          await page.setViewportSize({ ...originalViewport, width });
          await assertComparisonWidth();
          if (width === 320) {
            const nav = await page
              .getByRole("navigation", { name: "Analysis navigation" })
              .evaluate((element) => ({
                available: element.clientWidth,
                needed: element.scrollWidth,
              }));
            expect(nav.needed).toBeLessThanOrEqual(nav.available + 1);
          }
          await capture(page, `comparison-width-${width}`, info);
        }
        await page.setViewportSize(originalViewport);
      }
    }
    if (view === "data")
      await expect(
        page.getByRole("button", { name: "Export dataset", exact: true }),
      ).toBeEnabled();
    await expect(page.locator(".state-banner")).toHaveCount(0);
    await page.waitForTimeout(500);
    await assertPageHealthy(page);
    await capture(page, view, info);
    audit.push({
      view,
      scenario: context.scenario.id,
      run: run.id,
      title: await page.locator("h1:visible").allTextContents(),
      viewport: page.viewportSize(),
    });
  }

  await open(page, context.scenario.id, "overview", run.id);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to workspace" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(errors).toEqual([]);
  record(`${info.project.name}-screens`, {
    tested_at: new Date().toISOString(),
    screens: audit,
    page_errors: errors,
  });
});
