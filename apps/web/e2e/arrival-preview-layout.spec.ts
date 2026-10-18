import { test, expect } from "@playwright/test";
import { assertPageHealthy, capture, open, record, scenario } from "./helpers";

test("arrival chart preserves readable labels and alignment at narrow and wide widths", async ({
  page,
}, info) => {
  const context = await scenario(page, "readable arrival preview", {
    horizon_calendar_days: 7,
    replications: 1,
  });
  await open(page, context.scenario.id, "overview");
  const measurements = [];
  for (const width of [320, 390, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const graph = page.getByTestId("arrival-preview-chart");
    await graph.scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        graph.evaluate((element) => {
          const text = element.querySelector("text")!;
          const transform = text.getScreenCTM()!;
          return (
            parseFloat(getComputedStyle(text).fontSize) *
            Math.hypot(transform.a, transform.b)
          );
        }),
      )
      .toBeGreaterThanOrEqual(12);
    const measurement = await graph.evaluate((element) => {
      const text = element.querySelector("text")!;
      const transform = text.getScreenCTM()!;
      const box = element.getBoundingClientRect();
      const main = document.querySelector("main")!;
      return {
        viewport: window.innerWidth,
        label_pixels:
          parseFloat(getComputedStyle(text).fontSize) *
          Math.hypot(transform.a, transform.b),
        chart_width: box.width,
        chart_left: box.left,
        chart_right: box.right,
        main_overflow: main.scrollWidth - main.clientWidth,
      };
    });
    expect(measurement.label_pixels).toBeLessThanOrEqual(14);
    expect(measurement.chart_left).toBeGreaterThanOrEqual(0);
    expect(measurement.chart_right).toBeLessThanOrEqual(width);
    expect(measurement.main_overflow).toBeLessThanOrEqual(1);
    measurements.push(measurement);
    await capture(page, `arrival-preview-${width}`, info);
  }
  await assertPageHealthy(page);
  record(`arrival-preview-responsive-${info.project.name}`, {
    scenario_id: context.scenario.id,
    measurements,
  });
});
