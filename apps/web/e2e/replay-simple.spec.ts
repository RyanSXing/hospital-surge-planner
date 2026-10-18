import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import { expectFloorPlanAt, seekFloorPlan } from "./replay-floorplan-helpers";
import { fetchReplayJourneyEvents } from "../src/pages/replayJourney";

test("recorded floor plan stays stable through buffered playback, delayed seek and backwards seek", async ({
  page,
}, info) => {
  const context = await scenario(page, "stable hospital floor plan", {
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
  let requests = 0;
  await page.route("**/runs/*/state?**", async (route) => {
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await open(page, context.scenario.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  const floor = page.getByTestId("replay-floor-plan");
  await expect(
    page.getByRole("dialog", { name: "Replay details" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Advanced replay tools", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".patient-census")).toHaveCount(0);
  await page.evaluate(() => {
    const floor = document.querySelector('[data-testid="replay-floor-plan"]')!;
    const beds = [...floor.querySelectorAll(".floor-plan-bed")];
    const seen: string[] = [];
    const monitor = {
      original: floor,
      beds,
      seen,
      blanks: 0,
      banners: 0,
      moved: false,
      motion: [] as any[],
    };
    (window as any).__floorMonitor = monitor;
    const observer = new MutationObserver(() => {
      const current = document.querySelector<HTMLElement>(
        '[data-testid="replay-floor-plan"]',
      );
      if (!current || !current.querySelector(".floor-plan-bed"))
        monitor.blanks++;
      if (document.querySelector(".state-banner")) monitor.banners++;
      if (current && current !== floor) monitor.moved = true;
      const at = current?.dataset.recordedAt;
      if (at && seen.at(-1) !== at) seen.push(at);
    });
    observer.observe(document.querySelector("main")!, {
      subtree: true,
      attributes: true,
      childList: true,
    });
    (window as any).__floorObserver = observer;
    const sampleMotion = (now: number) => {
      const overlay = document.querySelector<HTMLElement>(
        '[data-testid="floor-plan-transit"]',
      );
      const map = document
        .querySelector<HTMLElement>(".floor-plan-building")
        ?.getBoundingClientRect();
      overlay
        ?.querySelectorAll<HTMLElement>(".floor-transit-marker")
        .forEach((marker) => {
          if (Number(getComputedStyle(marker).opacity) < 0.2 || !map) return;
          const box = marker.getBoundingClientRect();
          monitor.motion.push({
            at: now,
            x: box.x,
            y: box.y,
            patient: marker.dataset.patientId,
            from: marker.dataset.from,
            to: marker.dataset.to,
            events: marker.dataset.events,
            path: marker.dataset.path,
            windowFrom: overlay.dataset.windowFrom,
            windowTo: overlay.dataset.windowTo,
            inside:
              box.left >= map.left - 8 &&
              box.right <= map.right + 8 &&
              box.top >= map.top - 8 &&
              box.bottom <= map.bottom + 8,
          });
        });
      if (monitor.motion.length > 3000)
        monitor.motion.splice(0, monitor.motion.length - 3000);
      (window as any).__floorMotionFrame = requestAnimationFrame(sampleMotion);
    };
    (window as any).__floorMotionFrame = requestAnimationFrame(sampleMotion);
  });
  await page.getByLabel("Replay speed", { exact: true }).selectOption("4");
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__floorMonitor.motion.length),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    document
      .querySelectorAll(".floor-transit-marker")
      .forEach((marker) =>
        marker.getAnimations().forEach((animation) => animation.pause()),
      ),
  );
  const motionScreenshot = await page.screenshot({
    fullPage: true,
    animations: "allow",
  });
  const motionDirectory = resolve(
    process.cwd(),
    "../..",
    process.env.E2E_EVIDENCE_DIR ||
      "output/playwright/floorplan-library-comparison/replay-final-browser",
  );
  mkdirSync(motionDirectory, { recursive: true });
  writeFileSync(
    resolve(motionDirectory, "browser-desktop-replay-corridor-motion.png"),
    motionScreenshot,
  );
  await info.attach("replay-corridor-motion", {
    body: motionScreenshot,
    contentType: "image/png",
  });
  await page.evaluate(() =>
    document
      .querySelectorAll(".floor-transit-marker")
      .forEach((marker) =>
        marker.getAnimations().forEach((animation) => animation.play()),
      ),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__floorMonitor.seen.length))
    .toBeGreaterThanOrEqual(4);
  await page.getByLabel("Pause replay", { exact: true }).click();
  const paused = new URL(page.url()).searchParams.get("at")!;
  await expectFloorPlanAt(page, run.selected_replication_id, paused);
  await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
  await page.waitForTimeout(1100);
  expect(new URL(page.url()).searchParams.get("at")).toBe(paused);
  const heldAt = await floor.getAttribute("data-recorded-at");
  const target = new Date(
    Date.parse(run.start_at) + 31 * 3600000,
  ).toISOString();
  await page
    .getByLabel("Replay timestamp across actual elapsed horizon")
    .evaluate((node) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(node, String(31 * 60));
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await expect(floor).toHaveAttribute("data-retaining", "true");
  await expect(floor).toHaveAttribute("data-recorded-at", heldAt!);
  await expectFloorPlanAt(page, run.selected_replication_id, target);
  await seekFloorPlan(page, run, 0);
  const continuity = await page.evaluate(() => {
    (window as any).__floorObserver.disconnect();
    cancelAnimationFrame((window as any).__floorMotionFrame);
    const monitor = (window as any).__floorMonitor;
    const current = document.querySelector('[data-testid="replay-floor-plan"]');
    return {
      blanks: monitor.blanks,
      banners: monitor.banners,
      moved: monitor.moved,
      sameRoot: monitor.original === current,
      sameBeds: monitor.beds.every(
        (bed: Element, index: number) =>
          current?.querySelectorAll(".floor-plan-bed")[index] === bed,
      ),
      moments: monitor.seen,
      motion: monitor.motion,
    };
  });
  expect(continuity).toMatchObject({
    blanks: 0,
    banners: 0,
    moved: false,
    sameRoot: true,
    sameBeds: true,
  });
  expect(requests).toBeGreaterThanOrEqual(5);
  expect(continuity.motion.length).toBeGreaterThan(10);
  expect(continuity.motion.every((sample: any) => sample.inside)).toBe(true);
  expect(
    continuity.motion.some((sample: any) => sample.to === "discharge"),
  ).toBe(true);
  const motionPaths = new Map<string, any[]>();
  for (const sample of continuity.motion) {
    const key = `${sample.patient}|${sample.windowTo}`;
    motionPaths.set(key, [...(motionPaths.get(key) || []), sample]);
  }
  expect(
    [...motionPaths.values()].some(
      (samples) =>
        new Set(
          samples.map(
            (sample) => `${Math.round(sample.x)},${Math.round(sample.y)}`,
          ),
        ).size > 3,
    ),
  ).toBe(true);
  const firstMove = continuity.motion[0];
  const evidence = await fetchReplayJourneyEvents(
    (path) => api(page.request, path),
    run.selected_replication_id,
    firstMove.windowFrom,
    firstMove.windowTo,
  );
  const eventIds = new Set(
    evidence.map((event: any) =>
      String(event.event_id || event.sequence_number),
    ),
  );
  expect(
    firstMove.events.split(",").every((id: string) => eventIds.has(id)),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Advanced replay tools", exact: true })
    .click();
  await page.getByLabel("Reduced motion", { exact: true }).check();
  await expect(floor).toHaveClass(/hospital-floor-plan--still/);
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBeGreaterThan(Date.parse(run.start_at));
  await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
  await page.getByLabel("Reduced motion", { exact: true }).uncheck();
  await expect(floor).not.toHaveClass(/hospital-floor-plan--still/);
  await expect(page.getByLabel("Play replay", { exact: true })).toBeVisible();
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".floor-transit-marker")
        .evaluateAll(
          (markers) =>
            markers.filter(
              (marker) => Number(getComputedStyle(marker).opacity) > 0.2,
            ).length,
        ),
    )
    .toBeGreaterThan(0);
  await page.getByLabel("Reduced motion", { exact: true }).check();
  await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
  await expect(page.getByLabel("Play replay", { exact: true })).toBeVisible();
  const reducedPlayingAt = new URL(page.url()).searchParams.get("at");
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("at"))
    .not.toBe(reducedPlayingAt);
  await page.getByLabel("Pause replay", { exact: true }).click();
  await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
  await capture(page, "replay-stable-floor-plan", info);
  expect(errors).toEqual([]);
  record("replay-stable-floor-plan", {
    run: run.id,
    continuity,
    requests,
    delayed_state_ms: 400,
    errors,
  });
});
