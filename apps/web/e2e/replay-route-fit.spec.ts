import { expect, test, type Page } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import {
  expectFloorPlanAt,
  expectHospitalFlowGeometry,
  seekFloorPlan,
} from "./replay-floorplan-helpers";
import { fetchReplayJourneyEvents } from "../src/pages/replayJourney";

async function makeRun(page: Page, name: string, options: any = {}) {
  const context = await scenario(page, name, {
    horizon_calendar_days: 3,
    replications: 1,
    ...options,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  await open(page, context.scenario.id, "replay", run.id);
  const initial = await expectFloorPlanAt(
    page,
    run.selected_replication_id,
    run.start_at,
  );
  return { ...context, run, initial };
}

async function fitGeometry(page: Page) {
  return page.evaluate(() => {
    const floor = document.querySelector<HTMLElement>(
      '[data-testid="replay-floor-plan"]',
    )!;
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="floor-plan-fit-viewport"]',
    )!;
    const canvasRect = canvas.getBoundingClientRect();
    const building = floor.querySelector<HTMLElement>(".floor-plan-building")!;
    const buildingRect = building.getBoundingClientRect();
    const renderedScale = buildingRect.width / building.offsetWidth;
    const labels = [
      ...floor.querySelectorAll<HTMLElement>(".floor-plan-unit-heading strong"),
    ];
    const nodes = [
      ...floor.querySelectorAll<HTMLElement>(
        ".floor-plan-unit,.floor-plan-entrance,.floor-plan-exit,.floor-plan-count-area",
      ),
    ];
    const outside: string[] = [];
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      const name = node.dataset.unitId || node.className;
      if (
        r.width <= 0 ||
        r.height <= 0 ||
        r.left < Math.max(0, canvasRect.left) - 1 ||
        r.right > Math.min(innerWidth, canvasRect.right) + 1 ||
        r.top < Math.max(0, canvasRect.top) - 1 ||
        r.bottom > Math.min(innerHeight, canvasRect.bottom) + 1
      )
        outside.push(name);
    }
    const timeline = document.querySelector<HTMLInputElement>(
      'input[aria-label="Replay timestamp across actual elapsed horizon"]',
    )!;
    const t = timeline.getBoundingClientRect();
    if (
      t.left < -1 ||
      t.right > innerWidth + 1 ||
      t.top < -1 ||
      t.bottom > innerHeight + 1 ||
      !t.width ||
      !t.height
    )
      outside.push("replay timeline");
    if (
      document.fullscreenElement &&
      !document.fullscreenElement.contains(timeline)
    )
      outside.push("timeline outside fullscreen surface");
    return {
      outside,
      fitMode: floor.dataset.fitMode,
      fitScale: Number(floor.dataset.fitScale),
      mapScale: Number(floor.dataset.mapScale),
      rooms: floor.querySelectorAll(".floor-plan-unit").length,
      beds: floor.querySelectorAll(".floor-plan-bed").length,
      mapHeight: buildingRect.height,
      smallestRoomLabelPx: Math.min(
        ...labels.map(
          (label) =>
            Number.parseFloat(getComputedStyle(label).fontSize) * renderedScale,
        ),
      ),
      canvas: {
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height,
      },
      viewport: { width: innerWidth, height: innerHeight },
      scroll: {
        page: scrollY,
        main: document.querySelector("main")?.scrollTop || 0,
        canvasTop: canvas.scrollTop,
        canvasLeft: canvas.scrollLeft,
      },
      fullscreen: Boolean(document.fullscreenElement),
    };
  });
}

async function expectCompleteFit(page: Page) {
  await expect(page.getByTestId("replay-floor-plan")).toHaveAttribute(
    "data-fit-mode",
    "fit",
  );
  await expect.poll(async () => (await fitGeometry(page)).outside).toEqual([]);
  const geometry = await fitGeometry(page);
  expect(geometry.fitScale).toBeGreaterThan(0);
  expect(geometry.mapScale).toBeGreaterThan(0);
  expect(geometry.rooms).toBeGreaterThanOrEqual(5);
  expect(Number.isFinite(geometry.smallestRoomLabelPx)).toBe(true);
  expect(geometry.smallestRoomLabelPx).toBeGreaterThanOrEqual(8);
  expect(geometry.scroll).toEqual({
    page: 0,
    main: 0,
    canvasTop: 0,
    canvasLeft: 0,
  });
  return geometry;
}

/** Sidebar CSS animates the available width; wait for the actual measured map. */
async function expectSettledHospitalGeometry(page: Page) {
  const settling = await page.locator(".floor-plan-building").evaluate(
    (building) =>
      new Promise<{ elapsed: number; frames: number; width: number }>(
        (resolve, reject) => {
          const started = performance.now();
          let previous = Number.NaN,
            stable = 0,
            frames = 0;
          const sample = () => {
            const width = building.getBoundingClientRect().width;
            frames++;
            stable = Math.abs(width - previous) < 0.02 ? stable + 1 : 0;
            previous = width;
            if (stable >= 4)
              resolve({ elapsed: performance.now() - started, frames, width });
            else if (performance.now() - started > 2000)
              reject(new Error("Hospital width did not settle after resize"));
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
      ),
  );
  await expect(async () => {
    await expectHospitalFlowGeometry(page);
  }).toPass({ timeout: 2000, intervals: [50, 100] });
  return settling;
}

async function expectMotionPathsOnCurrentGraph(page: Page) {
  await expect(page.locator(".floor-transit-marker").first()).toBeAttached();
  const aligned = await page
    .locator(".floor-transit-marker")
    .evaluateAll((markers) => {
      const svg = document.querySelector<SVGElement>(
        '[data-testid="hospital-footprint"]',
      )!;
      const nodes = Object.values(
        JSON.parse(svg.dataset.corridorNodes || "{}"),
      ) as { x: number; y: number }[];
      return (
        markers.length > 0 &&
        markers.every((marker) => {
          const points = [
            ...((marker as HTMLElement).dataset.path || "").matchAll(
              /[ML]([\d.]+),([\d.]+)/g,
            ),
          ];
          const trail = marker.previousElementSibling?.querySelector(
            ".floor-transit-trail",
          );
          return (
            trail?.getAttribute("d") === (marker as HTMLElement).dataset.path &&
            points.length >= 2 &&
            points.every((point) =>
              nodes.some(
                (node) =>
                  Math.abs(node.x - Number(point[1])) < 0.03 &&
                  Math.abs(node.y - Number(point[2])) < 0.03,
              ),
            )
          );
        })
      );
    });
  expect(aligned).toBe(true);
  return aligned;
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1600, height: 1000 },
]) {
  test(`the complete hospital and timeline fit ${viewport.width}×${viewport.height} in the page and fullscreen without scrolling`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    const { scenario: saved, run } = await makeRun(
      page,
      `complete map fit ${viewport.width}x${viewport.height}`,
      { horizon_calendar_days: 1 },
    );
    const normal = await expectCompleteFit(page);
    await expectHospitalFlowGeometry(page);
    await capture(page, `replay-fit-${viewport.width}-page`, info);
    await page
      .getByRole("button", { name: /^(Expand|Full screen)( replay)?$/ })
      .click();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    const fullscreen = await expectCompleteFit(page);
    await expectHospitalFlowGeometry(page);
    await capture(page, `replay-fit-${viewport.width}-fullscreen`, info);
    await page
      .getByRole("button", { name: "Exit full screen", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(false);
    await expectCompleteFit(page);
    expect(
      (await api(page.request, `/run-groups/${run.id}`)).input_sha256,
    ).toBe(run.input_sha256);
    record(`replay-fit-${viewport.width}`, {
      scenario: saved.id,
      run: run.id,
      normal,
      fullscreen,
    });
  });
}

test("Fit preserves all 100 frozen ward beds and real corridor alignment after zoom and sidebar changes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { run, initial } = await makeRun(page, "100 bed fitted map", {
    horizon_calendar_days: 1,
    conditions: [
      {
        id: "fit-large-ward",
        kind: "unit_configuration",
        unit_id: "UNIT-WARD-A",
        physical_capacity: 100,
        enabled_capacity: 100,
        staffed_capacity: 80,
        staff_counts: { rn: 20, provider: 3, support: 4 },
      },
    ],
  });
  const ward = page.locator('.floor-plan-unit[data-unit-id="UNIT-WARD-A"]');
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(100);
  await expect(ward).toHaveAttribute("data-staffed", "80");
  const rootNode = await page.getByTestId("replay-floor-plan").elementHandle();
  const first = await expectCompleteFit(page);
  expect(first.mapHeight).toBeGreaterThanOrEqual(300);
  await expectHospitalFlowGeometry(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByTestId("replay-floor-plan")).toHaveAttribute(
    "data-fit-mode",
    "manual",
  );
  expect((await fitGeometry(page)).mapScale).toBeGreaterThan(first.mapScale);
  await page
    .getByRole("button", { name: "Fit hospital map", exact: true })
    .click();
  await expectCompleteFit(page);
  await expectSettledHospitalGeometry(page);
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expectMotionPathsOnCurrentGraph(page);
  // Start in the native click event so the evidence includes the whole CSS
  // transition, rather than observing only after the browser action settles.
  await page
    .getByRole("button", { name: /^Collapse navigation$/ })
    .evaluate((button) => {
      button.addEventListener(
        "click",
        () => {
          const building = document.querySelector<HTMLElement>(
            ".floor-plan-building",
          )!;
          const floor = document.querySelector<HTMLElement>(
            '[data-testid="replay-floor-plan"]',
          )!;
          const overlay = document.querySelector<HTMLElement>(
            '[data-testid="floor-plan-transit"]',
          )!;
          const oldNodes = [
            ...overlay.querySelectorAll<HTMLElement>(
              ".floor-transit-marker,.floor-transit-trail",
            ),
          ];
          const width = building.getBoundingClientRect().width;
          const mapScale = floor.dataset.mapScale;
          const started = performance.now();
          (window as any).__fitResizeObservation = new Promise((resolve) => {
            const samples: any[] = [];
            const sample = () => {
              const elapsed = performance.now() - started;
              samples.push({
                elapsed,
                width: building.getBoundingClientRect().width,
                mapScale: floor.dataset.mapScale,
                oldHeads: oldNodes.filter(
                  (node) =>
                    node.isConnected &&
                    node.classList.contains("floor-transit-marker"),
                ).length,
                oldTrails: oldNodes.filter(
                  (node) =>
                    node.isConnected &&
                    node.classList.contains("floor-transit-trail"),
                ).length,
                windowTo: overlay.dataset.windowTo,
              });
              if (elapsed >= 350)
                resolve({
                  original: {
                    width,
                    mapScale,
                    nodes: oldNodes.length,
                    windowTo: samples[0].windowTo,
                  },
                  samples,
                });
              else requestAnimationFrame(sample);
            };
            sample();
          });
        },
        { once: true },
      );
    });
  await page.getByRole("button", { name: /^Collapse navigation$/ }).click();
  const resizeMotion: any = await page.evaluate(
    () => (window as any).__fitResizeObservation,
  );
  expect(resizeMotion.original.nodes).toBeGreaterThan(0);
  const firstChanged = resizeMotion.samples.find(
    (sample: any) =>
      Math.abs(sample.width - resizeMotion.original.width) > 0.02 ||
      sample.mapScale !== resizeMotion.original.mapScale,
  );
  const cleared = resizeMotion.samples.find(
    (sample: any) => sample.oldHeads === 0 && sample.oldTrails === 0,
  );
  expect(firstChanged).toBeTruthy();
  expect(cleared).toBeTruthy();
  // This is shorter than the 1 s playback window: natural marker expiry cannot
  // satisfy the resize contract. Both heads and trails must be invalidated.
  expect(cleared.elapsed - firstChanged.elapsed).toBeLessThanOrEqual(100);
  expect(
    resizeMotion.samples.filter(
      (sample: any) =>
        sample.elapsed > firstChanged.elapsed + 100 &&
        (sample.oldHeads || sample.oldTrails),
    ),
  ).toEqual([]);
  const collapsed = await expectCompleteFit(page);
  const settled = await expectSettledHospitalGeometry(page);
  const sameWindow =
    (await page
      .getByTestId("floor-plan-transit")
      .getAttribute("data-window-to")) === resizeMotion.original.windowTo;
  if (sameWindow) {
    await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
    await expect(page.locator(".floor-transit-trail")).toHaveCount(0);
  }
  await expect
    .poll(() =>
      page.getByTestId("floor-plan-transit").getAttribute("data-window-to"),
    )
    .not.toBe(resizeMotion.original.windowTo);
  const resizedPathsAligned = await expectMotionPathsOnCurrentGraph(page);
  await expectHospitalFlowGeometry(page);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(100);
  await page.getByRole("button", { name: /^Expand navigation$/ }).click();
  await expectCompleteFit(page);
  await expectSettledHospitalGeometry(page);
  await seekFloorPlan(page, run, 0);
  expect(
    initial.slots.filter((slot: any) => slot.unit_id === "UNIT-WARD-A"),
  ).toHaveLength(100);
  expect(
    await page
      .getByTestId("replay-floor-plan")
      .evaluate((node, original) => node === original, rootNode),
  ).toBe(true);
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  const aligned = await expectMotionPathsOnCurrentGraph(page);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await expect(ward.locator(".floor-plan-bed")).toHaveCount(100);
  expect((await api(page.request, `/run-groups/${run.id}`)).input_sha256).toBe(
    run.input_sha256,
  );
  record("replay-fit100-and-zoom", {
    run: run.id,
    first,
    collapsed,
    settled,
    sidebar_motion_invalidation: resizeMotion,
    resized_paths_match_current_corridor_graph: resizedPathsAligned,
    frozen_ward_beds: 100,
    new_paths_match_current_corridor_graph: aligned,
  });
  await capture(page, "replay-fitted100-beds", info);
});

function touchedUnits(event: any, units: Set<string>): string[] {
  if (
    ![
      "assessment_start",
      "clinic_start",
      "admission",
      "transfer_arrived",
      "discharge",
    ].includes(event.event_type)
  )
    return [];
  if (
    event.event_type !== "discharge" &&
    event.from_unit_id === event.to_unit_id
  )
    return [];
  return [
    event.from_unit_id || event.payload?.source_unit_id,
    event.to_unit_id,
    ...(event.event_type === "discharge" ? ["discharge"] : []),
  ].filter((id) => units.has(id) || id === "discharge");
}

test("the movement sample represents recorded activity across every ward, ICU, emergency care and discharge without inventing equal admissions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { run, initial } = await makeRun(page, "recorded route coverage");
  const units = new Set<string>(initial.units.map((unit: any) => unit.unit_id));
  const evidence = await fetchReplayJourneyEvents(
    (path) => api(page.request, path),
    run.selected_replication_id,
    run.start_at,
    run.end_at,
  );
  await expectCompleteFit(page);
  await page.evaluate(() => {
    const audit: any = { running: true, windows: {} };
    (window as any).__routeCoverage = audit;
    const sample = () => {
      if (!audit.running) return;
      const overlay = document.querySelector<HTMLElement>(
        '[data-testid="floor-plan-transit"]',
      );
      if (overlay?.dataset.windowFrom && overlay.dataset.windowTo) {
        const key = `${overlay.dataset.windowFrom}|${overlay.dataset.windowTo}`;
        const window = (audit.windows[key] ||= {
          from: overlay.dataset.windowFrom,
          to: overlay.dataset.windowTo,
          markers: {},
        });
        overlay
          .querySelectorAll<HTMLElement>(".floor-transit-marker")
          .forEach((marker) => {
            window.markers[marker.dataset.patientId!] = {
              patient: marker.dataset.patientId,
              from: marker.dataset.from,
              to: marker.dataset.to,
              events: marker.dataset.events?.split(",") || [],
              path: marker.dataset.path,
            };
          });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByLabel("Replay speed", { exact: true }).selectOption("16");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBe(Date.parse(run.end_at));
  await expect(
    page.getByRole("button", { name: "Play replay", exact: true }),
  ).toBeDisabled();
  const windows: any[] = await page.evaluate(() => {
    (window as any).__routeCoverage.running = false;
    return Object.values((window as any).__routeCoverage.windows);
  });
  const nonempty = windows.filter(
    (window) => Object.keys(window.markers).length,
  );
  expect(nonempty.length).toBeGreaterThanOrEqual(3);
  const checked: any[] = [];
  const allExpected = new Set<string>();
  for (const window of nonempty) {
    const real = evidence.filter(
      (event: any) =>
        Date.parse(event.occurred_at) > Date.parse(window.from) &&
        Date.parse(event.occurred_at) <= Date.parse(window.to),
    );
    const byId = new Map(
      real.map((event: any) => [
        String(event.event_id || event.sequence_number),
        event,
      ]),
    );
    const expected = new Set(
      real.flatMap((event: any) => touchedUnits(event, units)),
    );
    const represented = new Set<string>();
    const markers: any[] = Object.values(window.markers);
    expect(markers.length).toBeLessThanOrEqual(12);
    for (const marker of markers) {
      expect(marker.events.length).toBeGreaterThan(0);
      for (const id of marker.events) {
        expect(
          byId.has(id),
          `Marker event ${id} must exist in its recorded window`,
        ).toBe(true);
        const event = byId.get(id);
        expect(event.patient_id).toBe(marker.patient);
        touchedUnits(event, units).forEach((unit) => represented.add(unit));
      }
    }
    for (const unit of expected) {
      allExpected.add(unit);
      expect(
        represented.has(unit),
        `Recorded ${unit} activity should appear in window ${window.from}`,
      ).toBe(true);
    }
    checked.push({
      from: window.from,
      to: window.to,
      expected: [...expected].sort(),
      represented: [...represented].sort(),
      patients_shown: markers.length,
    });
  }
  for (const unit of [
    "UNIT-WARD-A",
    "UNIT-WARD-B",
    "UNIT-WARD-C",
    "UNIT-ICU",
    "UNIT-ED",
    "discharge",
  ])
    expect(
      allExpected.has(unit),
      `Fixture must actually exercise ${unit}`,
    ).toBe(true);
  const admissions: Record<string, number> = {};
  evidence
    .filter((event: any) => event.event_type === "admission")
    .forEach(
      (event: any) =>
        (admissions[event.to_unit_id] =
          (admissions[event.to_unit_id] || 0) + 1),
    );
  record("replay-recorded-route-coverage", {
    run: run.id,
    checked,
    actual_admissions_by_unit: admissions,
    no_equal_distribution_assumed: true,
  });
  await capture(page, "replay-recorded-route-coverage", info);
});

test("bed indicators switch quickly and glow once only for actual occupancy changes, with reduced motion suppressed", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { run, initial } = await makeRun(page, "quick bed lights");
  const stateAt = (hours: number) =>
    api(
      page.request,
      `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(new Date(Date.parse(run.start_at) + hours * 3600000).toISOString())}`,
    );
  const at24 = await stateAt(24),
    at25 = await stateAt(25);
  const occupied = (slot: any) =>
    Boolean(
      slot &&
      (slot.status === "occupied" ||
        slot.patient_id ||
        slot.background_occupied),
    );
  const later = new Map(at24.slots.map((slot: any) => [slot.slot_id, slot]));
  const unchanged = new Map(
    at25.slots.map((slot: any) => [slot.slot_id, slot]),
  );
  const turnOn = initial.slots.find(
    (slot: any) =>
      slot.status === "ready" &&
      occupied(later.get(slot.slot_id)) &&
      occupied(unchanged.get(slot.slot_id)),
  );
  const turnOff = initial.slots.find(
    (slot: any) =>
      occupied(slot) && (later.get(slot.slot_id) as any)?.status === "ready",
  );
  expect(turnOn).toBeTruthy();
  expect(turnOff).toBeTruthy();
  const onBed = page.locator(
    `.floor-plan-bed[data-slot-id="${turnOn.slot_id}"]`,
  );
  const offBed = page.locator(
    `.floor-plan-bed[data-slot-id="${turnOff.slot_id}"]`,
  );
  const original = await onBed.elementHandle();
  await expect(onBed).toHaveAttribute("data-light-state", "off");
  await expect(offBed).toHaveAttribute("data-light-state", "on");
  await expect(page.locator(".floor-plan-bed[data-light-change]")).toHaveCount(
    0,
  );
  const duration = await onBed.evaluate((node) =>
    getComputedStyle(node, "::after")
      .transitionDuration.split(",")
      .map(
        (value) =>
          Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000),
      ),
  );
  expect(
    duration.some((milliseconds) => milliseconds >= 60 && milliseconds <= 120),
  ).toBe(true);
  await page.evaluate(() => {
    const audit: any = {
      running: true,
      changes: [],
      samples: [],
      started: performance.now(),
    };
    (window as any).__bedLightAudit = audit;
    const floor = document.querySelector('[data-testid="replay-floor-plan"]')!;
    const active = new Map<HTMLElement, number>();
    const observer = new MutationObserver((mutations) =>
      mutations.forEach((mutation) => {
        const node = mutation.target as HTMLElement;
        if (!node.matches(".floor-plan-bed")) return;
        if (
          mutation.attributeName === "data-light-state" &&
          mutation.oldValue !== node.dataset.lightState
        )
          active.set(node, performance.now());
        if (
          mutation.attributeName === "data-light-change" &&
          node.dataset.lightChange
        )
          audit.changes.push({
            slot: node.dataset.slotId,
            change: node.dataset.lightChange,
            at: performance.now(),
          });
      }),
    );
    observer.observe(floor, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-light-state", "data-light-change"],
    });
    const sample = () => {
      if (!audit.running) {
        observer.disconnect();
        return;
      }
      const now = performance.now();
      active.forEach((started, node) => {
        if (now - started > 260) {
          active.delete(node);
          return;
        }
        audit.samples.push({
          slot: node.dataset.slotId,
          target: node.dataset.lightState,
          elapsed: now - started,
          opacity: Number(getComputedStyle(node, "::after").opacity),
        });
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await seekFloorPlan(page, run, 24 * 60);
  await expect(onBed).toHaveAttribute("data-light-state", "on");
  await expect(offBed).toHaveAttribute("data-light-state", "off");
  await expect(page.locator(".floor-plan-bed[data-light-change]")).toHaveCount(
    0,
  );
  const first = await page.evaluate(() => ({
    ...(window as any).__bedLightAudit,
    running: undefined,
  }));
  for (const [slot, change] of [
    [turnOn.slot_id, "on"],
    [turnOff.slot_id, "off"],
  ]) {
    expect(
      first.changes.filter(
        (value: any) => value.slot === slot && value.change === change,
      ),
    ).toHaveLength(1);
    const samples = first.samples.filter((value: any) => value.slot === slot);
    expect(
      samples.some(
        (value: any) => value.opacity > 0.02 && value.opacity < 0.98,
      ),
    ).toBe(true);
    expect(
      samples.some(
        (value: any) =>
          value.elapsed <= 200 &&
          (change === "on" ? value.opacity >= 0.98 : value.opacity <= 0.02),
      ),
    ).toBe(true);
  }
  await seekFloorPlan(page, run, 25 * 60);
  await expect(onBed).toHaveAttribute("data-light-state", "on");
  expect(await onBed.evaluate((node, old) => node === old, original)).toBe(
    true,
  );
  await onBed.click();
  await expect(
    page.getByRole("dialog", { name: "Replay details" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const unchangedCount = await page.evaluate(
    (slot) =>
      (window as any).__bedLightAudit.changes.filter(
        (change: any) => change.slot === slot,
      ).length,
    turnOn.slot_id,
  );
  expect(unchangedCount).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedStart = await page.evaluate(() => performance.now());
  await seekFloorPlan(page, run, 0);
  await expect(onBed).toHaveAttribute("data-light-state", "off");
  const reduced = await onBed.evaluate((node) => ({
    duration: getComputedStyle(node, "::after").transitionDuration,
    glow: node.getAttribute("data-light-change"),
    opacity: getComputedStyle(node, "::after").opacity,
  }));
  expect(reduced).toEqual({ duration: "0s", glow: null, opacity: "0" });
  const final = await page.evaluate((after) => {
    const audit = (window as any).__bedLightAudit;
    audit.running = false;
    return {
      changes: audit.changes,
      samples: audit.samples,
      reducedChanges: audit.changes.filter((change: any) => change.at > after),
    };
  }, reducedStart);
  expect(final.reducedChanges).toEqual([]);
  record("replay-fast-bed-lights", {
    run: run.id,
    transition_durations_ms: duration,
    turned_on: turnOn.slot_id,
    turned_off: turnOff.slot_id,
    unchanged_bed_glows: unchangedCount,
    ...final,
  });
  await capture(page, "replay-fast-bed-lights", info);
});
