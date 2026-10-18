import { expect, test } from "@playwright/test";
import {
  api,
  assertPageHealthy,
  capture,
  open,
  record,
  scenario,
  waitRun,
} from "./helpers";

test("desktop chart bookmarks share one graph and sparse Summary periods remain visible without shifting on seek", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Desktop workflow requested.");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const context = await scenario(page, "chart bookmarks", {
    horizon_calendar_days: 2,
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
  await open(page, context.scenario.id, "analytics-outcomes", run.id);
  const outcomes = page.getByTestId("outcome-analytics");
  await outcomes
    .getByRole("button", { name: /^Choose an exact outcome interval/ })
    .click();
  await outcomes
    .getByRole("combobox", { name: "Selected outcome day", exact: true })
    .selectOption("1");
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBeGreaterThan(Date.parse(run.start_at));
  const selectedAt = new URL(page.url()).searchParams.get("at");
  const labels = [
    "Arrivals and discharges",
    "Ward beds",
    "Intensive care beds",
    "Emergency department",
    "Patients waiting",
    "Time spent waiting",
    "Busiest hospital unit",
    "Staffing coverage deficit",
    "Equipment coverage deficit",
    "Daily peak bed queue",
    "Daily ward capacity",
    "Medical supplies",
  ];
  const bookmarks = outcomes.getByRole("tablist", {
    name: "Choose a forecast chart",
  });
  expect(await bookmarks.getByRole("tab").allTextContents()).toEqual(
    expect.arrayContaining(labels),
  );
  await expect(
    outcomes.getByRole("combobox", { name: "Outcome metric", exact: true }),
  ).toHaveCount(0);
  for (const label of labels) {
    const tab = bookmarks.getByRole("tab", { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    if (label === "Medical supplies") {
      await expect(
        outcomes.locator(".outcome-chart svg[role=img]"),
      ).toHaveCount(0);
      await expect(outcomes.locator(".outcome-empty-metric")).toContainText(
        "Supply tracking was not enabled in these saved results",
      );
    } else {
      await expect(
        outcomes.locator(".outcome-chart svg[role=img]"),
      ).toHaveCount(1);
      await expect(
        outcomes.locator(".outcome-chart svg[role=img]"),
      ).toBeVisible();
    }
    expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);
  }
  await bookmarks.getByRole("tab", { name: "Ward beds", exact: true }).click();
  await capture(page, "analytics-bookmarks", info);

  await page
    .getByRole("navigation", { name: "Analysis navigation" })
    .getByRole("button", { name: "Summary", exact: true })
    .click();
  const summary = page.locator(".summary-dashboard:visible");
  const timeline = summary.locator(".summary-timeline-card");
  await timeline.getByRole("button", { name: "Month", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("grain"))
    .toBe("month");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);
  const recorded = await api(
    page.request,
    `/run-groups/${run.id}/metrics?grain=month`,
  );
  expect(recorded.data).toHaveLength(1);
  await expect(
    summary.locator(".summary-chart-grid .summary-chart-card"),
  ).toHaveCount(1);
  await expect(
    summary.locator(".summary-chart-grid svg[role=img]"),
  ).toHaveCount(1);
  const points = timeline.locator(".chart-isolated-observation circle");
  await expect(points).toHaveCount(4);
  const pointGeometry = await points.evaluateAll((elements) =>
    elements.map((element) => ({
      x: Number(element.getAttribute("cx")),
      y: Number(element.getAttribute("cy")),
    })),
  );
  const chartSize = await timeline
    .locator("svg[role=img]")
    .evaluate((element) => {
      const box = (element as SVGSVGElement).viewBox.baseVal;
      return { width: box.width, height: box.height };
    });
  for (const point of pointGeometry) {
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(point.x).toBeGreaterThan(42);
    expect(point.x).toBeLessThan(chartSize.width - 32);
    expect(point.y).toBeGreaterThanOrEqual(18);
    expect(point.y).toBeLessThanOrEqual(chartSize.height - 28);
  }
  const gridBox = await summary.locator(".summary-chart-grid").boundingBox();
  const timelineBox = await timeline.boundingBox();
  expect(timelineBox!.width).toBeGreaterThan(gridBox!.width * 0.95);
  await expect(timeline.locator(".chart-single-period-note")).toContainText(
    "One recorded interval",
  );
  await capture(page, "summary-month-observation", info);

  // A real delayed state read makes the intermediate seek state observable.
  // Sample main's position throughout it to catch a transient in-flow banner.
  let delayedReads = 0;
  const statePattern = `**/api/runs/${run.selected_replication_id}/state?**`;
  await page.route(statePattern, async (route) => {
    delayedReads += 1;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  const hour = timeline.getByRole("combobox", {
    name: "Select hour within day",
    exact: true,
  });
  const nextAt = await hour.locator("option").nth(6).getAttribute("value");
  expect(nextAt).toBeTruthy();
  expect(nextAt).not.toBe(selectedAt);
  await page.evaluate(() => {
    const proof = { tops: [] as number[], banners: 0, stop: false };
    (window as any).__seekLayoutProof = proof;
    const sample = () => {
      proof.tops.push(
        document.querySelector("main")!.getBoundingClientRect().top,
      );
      proof.banners += document.querySelectorAll(".state-banner").length;
      if (!proof.stop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  try {
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/runs/${run.selected_replication_id}/state` &&
        Date.parse(url.searchParams.get("at") || "") === Date.parse(nextAt!)
      );
    });
    await hour.selectOption(nextAt!);
    expect((await response).ok()).toBe(true);
    await expect.poll(() => delayedReads).toBeGreaterThan(0);
    await expect(page.locator(".statusbar")).not.toContainText(
      "Updating selected time",
    );
    await expect(page.getByText(/^Reconstructing selected run/)).toHaveCount(0);
    await expect
      .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
      .toBe(Date.parse(nextAt!));
  } finally {
    await page.evaluate(() => {
      (window as any).__seekLayoutProof.stop = true;
    });
    await page.unroute(statePattern);
  }
  const geometry = await page.evaluate(() => {
    const proof = (window as any).__seekLayoutProof;
    return {
      frames: proof.tops.length,
      delta: Math.max(...proof.tops) - Math.min(...proof.tops),
      banners: proof.banners,
    };
  });
  expect(geometry.frames).toBeGreaterThan(2);
  expect(geometry.delta).toBeLessThanOrEqual(0.5);
  expect(geometry.banners).toBe(0);
  await assertPageHealthy(page);
  expect(errors).toEqual([]);
  record("analytics-bookmarks-desktop", {
    run_id: run.id,
    charts: labels,
    one_chart_at_a_time: true,
    selected_time_retained: selectedAt,
    month_interval_count: recorded.data.length,
    visible_sparse_points: pointGeometry,
    summary_chart_full_width: true,
    seek_layout: geometry,
    page_errors: errors,
  });
});
