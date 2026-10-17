import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("simple local-campus replay animates recorded transitions and keeps evidence optional", async ({
  page,
}, info) => {
  const context = await scenario(page, "local campus replay", {
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    (window as any).__replayCanvasPaints = [];
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      if (
        this.canvas.classList.contains("replay-canvas") &&
        this.canvas.dataset.animating === "true"
      )
        (window as any).__replayCanvasPaints.push({
          at: this.canvas.dataset.recordedAt,
          now: performance.now(),
        });
      return Reflect.apply(original, this, args);
    };
  });
  await open(page, context.scenario.id, "replay", run.id);
  const canvas = page.locator(".replay-canvas");
  await expect(canvas).toHaveAttribute(
    "data-recorded-at",
    new Date(run.start_at).toISOString(),
  );
  await expect(
    page.getByRole("link", { name: "Location reference" }),
  ).toHaveAttribute(
    "href",
    "https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center",
  );
  await expect(page.locator(".replay-location")).toContainText(
    "1211 Medical Center Drive",
  );
  await expect(page.locator(".replay-location")).toContainText("synthetic");
  await expect(
    page.getByRole("dialog", { name: "Replay details" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Advanced replay tools", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".patient-census")).toHaveCount(0);
  await expect(
    page.getByLabel("Play replay", { exact: true }),
  ).toBeInViewport();
  await page.locator(".replay-campus-reference summary").click();
  await expect(
    page.getByRole("img", { name: "Vanderbilt hospital campus in Nashville" }),
  ).toBeVisible();
  await expect(page.locator(".replay-campus-caption")).toContainText(
    "36.14229° N",
  );
  await expect(
    page.getByRole("link", { name: "Official campus map" }),
  ).toHaveAttribute("href", /vumc.org\/med-center-parking/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "replay-campus-context", info);
  await page.locator(".replay-campus-reference summary").click();
  await page.locator("main").evaluate((node) => {
    node.scrollTop = 0;
  });
  await capture(page, "replay-simple", info);

  await page.evaluate(() => {
    const samples: { at: string; points: number; frame: number }[] = [];
    (window as any).__replayMotionSamples = samples;
    const tick = (now: number) => {
      const node = document.querySelector<HTMLCanvasElement>(".replay-canvas");
      if (node?.dataset.animating === "true")
        samples.push({
          at: node.dataset.recordedAt || "",
          points: Number(node.dataset.movedMarkers || 0),
          frame: now,
        });
      (window as any).__replayMotionFrame = requestAnimationFrame(tick);
    };
    (window as any).__replayMotionFrame = requestAnimationFrame(tick);
  });
  await page.getByLabel("Replay speed", { exact: true }).selectOption("4");
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__replayMotionSamples.length),
    )
    .toBeGreaterThan(5);
  await page.getByLabel("Pause replay", { exact: true }).click();
  const paused = new URL(page.url()).searchParams.get("at");
  await expect(canvas).toHaveAttribute("data-animating", "false");
  await page.waitForTimeout(1200);
  expect(new URL(page.url()).searchParams.get("at")).toBe(paused);
  const samples = await page.evaluate(() => {
    cancelAnimationFrame((window as any).__replayMotionFrame);
    return (window as any).__replayMotionSamples;
  });
  expect(samples.some((value: any) => value.points > 0)).toBe(true);
  const paints: { at: string; now: number }[] = await page.evaluate(
    () => (window as any).__replayCanvasPaints,
  );
  expect(paints.length).toBeGreaterThan(5);

  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Replay details" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("tab", { name: "Capacity", exact: true }).click();
  await expect(drawer.getByLabel("Replay resource unit")).toBeVisible();
  await drawer.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(drawer.getByLabel("Replay event type filter")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await page
    .getByRole("button", { name: "Advanced replay tools", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Recorded replay timeline annotations" }),
  ).toBeVisible();
  await page.getByLabel("Reduced motion", { exact: true }).check();
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("at"))
    .not.toBe(paused);
  await expect(canvas).toHaveAttribute("data-animating", "false");
  await page.getByLabel("Pause replay", { exact: true }).click();
  await page
    .getByRole("button", { name: "View patient census", exact: true })
    .click();
  await expect(page.locator(".patient-census")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  record("replay-simple-" + info.project.name, {
    run_id: run.id,
    viewport: info.project.name,
    animation_samples: samples.length,
    actual_canvas_animation_paints: paints.length,
    active_paint_interval_ms: paints.at(-1)!.now - paints[0].now,
    moved_markers: Math.max(...samples.map((value: any) => value.points)),
    paused_at: paused,
    source_is_synthetic: true,
    console_errors: errors,
  });
});
