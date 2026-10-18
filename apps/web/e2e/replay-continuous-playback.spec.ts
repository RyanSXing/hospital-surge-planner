import { expect, test, type Page, type Route } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import { expectFloorPlanAt, seekFloorPlan } from "./replay-floorplan-helpers";

const HOUR = 3_600_000;
const CHUNK = 4 * HOUR;

async function createRecordedRun(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const context = await scenario(page, name, {
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
  await open(page, context.scenario.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  return { ...context, run };
}

async function visibleClock(page: Page) {
  return Number(
    await page.getByTestId("replay-playhead").getAttribute("data-playhead-ms"),
  );
}

async function installContinuousAudit(page: Page) {
  await page.evaluate(() => {
    const original = document.querySelector<HTMLElement>(
      '[data-testid="replay-floor-plan"]',
    )!;
    const originalBeds = [...original.querySelectorAll(".floor-plan-bed")];
    const initialTop = original.getBoundingClientRect().top;
    const audit = {
      frames: [] as any[],
      snapshots: [] as any[],
      motion: [] as any[],
      blanks: 0,
      replaced: false,
      bedsReplaced: false,
      banners: 0,
      maxTopShift: 0,
    };
    const identities = new WeakMap<Element, number>();
    let nextIdentity = 0,
      lastSnapshot = "",
      frame = 0;
    const sample = (now: number) => {
      const floor = document.querySelector<HTMLElement>(
        '[data-testid="replay-floor-plan"]',
      );
      const clock = document.querySelector<HTMLElement>(
        '[data-testid="replay-playhead"]',
      );
      const range = document.querySelector<HTMLInputElement>(
        'input[aria-label="Replay timestamp across actual elapsed horizon"]',
      );
      if (!floor || !floor.querySelector(".floor-plan-bed")) audit.blanks++;
      if (floor && floor !== original) audit.replaced = true;
      const beds = [...(floor?.querySelectorAll(".floor-plan-bed") || [])];
      if (
        beds.length !== originalBeds.length ||
        beds.some((bed, index) => bed !== originalBeds[index])
      )
        audit.bedsReplaced = true;
      if (
        document.querySelector(
          ".state-banner,.state-refresh-bar,.state-loading-overlay",
        )
      )
        audit.banners++;
      if (floor)
        audit.maxTopShift = Math.max(
          audit.maxTopShift,
          Math.abs(floor.getBoundingClientRect().top - initialTop),
        );
      if (floor && clock && range) {
        const playhead = Number(clock.dataset.playheadMs);
        const validUntil = floor.dataset.validUntil || "";
        const validUntilMs = Number(floor.dataset.validUntilMs);
        const at = floor.dataset.recordedAt || "";
        const playing = Boolean(
          document.querySelector('button[aria-label="Pause replay"]'),
        );
        audit.frames.push({
          real: now,
          playhead,
          text: clock.textContent,
          slider: Number(range.value),
          session: clock.dataset.playbackSession || "",
          at,
          validUntil,
          validUntilMs,
          retaining: floor.dataset.retaining === "true",
          playing,
          rep: floor.dataset.replicationId,
        });
        // Observe complete occupied-slot evidence at an interior point of an
        // actually applied recorded interval, independently of its chunk end.
        if (
          playing &&
          at !== lastSnapshot &&
          Number.isFinite(playhead) &&
          playhead > Date.parse(at) + 2 &&
          playhead < validUntilMs - 2
        ) {
          lastSnapshot = at;
          if (audit.snapshots.length < 150)
            audit.snapshots.push({
              playhead,
              at,
              validUntil,
              validUntilMs,
              occupied: [
                ...floor.querySelectorAll<HTMLElement>(
                  '.floor-plan-bed[data-status="occupied"]',
                ),
              ]
                .map((bed) => [
                  bed.dataset.slotId,
                  bed.dataset.patientId || null,
                ])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
              units: [
                ...floor.querySelectorAll<HTMLElement>(".floor-plan-unit"),
              ].map((unit) => ({
                id: unit.dataset.unitId,
                occupied: unit.dataset.occupied,
                staffed: unit.dataset.staffed,
                available: unit.dataset.available,
              })),
              ed: document.querySelector<HTMLElement>(
                '[data-testid="floor-plan-ed-waiting"]',
              )?.dataset.count,
              waiting: document.querySelector<HTMLElement>(
                '[data-testid="floor-plan-bed-waiting"]',
              )?.dataset.count,
              discharges: document.querySelector<HTMLElement>(
                '[data-testid="floor-plan-discharges"]',
              )?.dataset.count,
            });
        }
        floor
          .querySelectorAll<HTMLElement>(".floor-transit-marker")
          .forEach((marker) => {
            if (Number(getComputedStyle(marker).opacity) < 0.15) return;
            if (!identities.has(marker)) identities.set(marker, ++nextIdentity);
            const points = [
              ...(marker.dataset.path || "").matchAll(
                /[ML](-?[\d.]+),(-?[\d.]+)/g,
              ),
            ].map((point) => ({ x: Number(point[1]), y: Number(point[2]) }));
            const length = points.reduce(
              (sum, point, index) =>
                index
                  ? sum +
                    Math.hypot(
                      point.x - points[index - 1].x,
                      point.y - points[index - 1].y,
                    )
                  : sum,
              0,
            );
            const distance = Number.parseFloat(
              getComputedStyle(marker).offsetDistance,
            );
            const box = marker.getBoundingClientRect();
            audit.motion.push({
              node: identities.get(marker),
              real: now,
              playhead,
              patient: marker.dataset.patientId,
              events: marker.dataset.events,
              path: marker.dataset.path,
              distance,
              absoluteDistance: (length * distance) / 100,
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
              trailPath: marker.previousElementSibling
                ?.querySelector(".floor-transit-trail")
                ?.getAttribute("d"),
            });
          });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    (window as any).__continuousAudit = audit;
    (window as any).__stopContinuousAudit = () => cancelAnimationFrame(frame);
  });
}

async function finishContinuousAudit(page: Page) {
  return page.evaluate(() => {
    (window as any).__stopContinuousAudit();
    return (window as any).__continuousAudit;
  });
}

async function assertSnapshotAgainstExactState(
  page: Page,
  run: any,
  snapshot: any,
) {
  const at = new Date(snapshot.playhead).toISOString();
  const expected = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(at)}`,
  );
  const ids = new Set(snapshot.units.map((unit: any) => unit.id));
  const occupied = expected.slots
    .filter(
      (slot: any) =>
        ids.has(slot.unit_id) &&
        slot.installation_status !== "removed" &&
        (slot.status === "occupied" ||
          slot.patient_id ||
          slot.background_occupied === true),
    )
    .map((slot: any) => [slot.slot_id, slot.patient_id || null])
    .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])));
  expect(
    snapshot.occupied,
    `Occupied slots must match exact evidence at ${at}`,
  ).toEqual(occupied);
  for (const shown of snapshot.units) {
    const unit = expected.units.find(
      (value: any) => value.unit_id === shown.id,
    );
    expect(shown).toEqual({
      id: unit.unit_id,
      occupied: String(unit.occupied),
      staffed: String(unit.staffed),
      available: String(unit.available),
    });
  }
  expect(snapshot.ed).toBe(
    String(expected.queue_counts?.["FAC-MAIN"]?.ed ?? 0),
  );
  expect(snapshot.waiting).toBe(
    String(expected.queue_counts?.["FAC-MAIN"]?.total ?? 0),
  );
  expect(snapshot.discharges).toBe(
    String(expected.flow_counts["FAC-MAIN"].discharges),
  );
  return at;
}

test("the visible clock, real beds and patient movement advance continuously through buffered window boundaries", async ({
  page,
}, info) => {
  const { run } = await createRecordedRun(
    page,
    "continuous exact event playback",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const windows: any[] = [],
    loading: Promise<void>[] = [];
  const requests: string[] = [];
  const windowResponses = (response: any) => {
    if (
      !response
        .url()
        .includes(`/runs/${run.selected_replication_id}/playback-window?`) ||
      !response.ok()
    )
      return;
    loading.push(
      response.json().then((value: any) => {
        windows.push(value);
      }),
    );
  };
  const stateRequests = (request: any) => {
    if (request.url().includes(`/runs/${run.selected_replication_id}/state?`))
      requests.push(request.url());
  };
  page.on("response", windowResponses);
  page.on("request", stateRequests);
  await installContinuousAudit(page);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("4");
  await page.getByLabel("Play replay", { exact: true }).click();
  const origin = Date.parse(run.start_at);
  await expect
    .poll(() => visibleClock(page), { timeout: 15000, intervals: [50] })
    .toBeGreaterThan(origin + 13 * HOUR);
  const audit = await finishContinuousAudit(page);
  page.off("request", stateRequests);
  await page.getByLabel("Pause replay", { exact: true }).click();
  const paused = new URL(page.url()).searchParams.get("at")!;
  await expectFloorPlanAt(page, run.selected_replication_id, paused);
  page.off("response", windowResponses);
  await Promise.all(loading);
  expect(audit).toMatchObject({
    blanks: 0,
    replaced: false,
    bedsReplaced: false,
    banners: 0,
  });
  expect(audit.maxTopShift).toBeLessThanOrEqual(1);
  const frames = audit.frames.filter(
    (frame: any) => frame.playing && frame.playhead > origin,
  );
  expect(frames.length).toBeGreaterThan(30);
  expect(new Set(frames.map((frame: any) => frame.text)).size).toBeGreaterThan(
    20,
  );
  expect(new Set(frames.map((frame: any) => frame.session)).size).toBe(1);
  expect(frames[0].session).toBeTruthy();
  expect(
    frames.every(
      (frame: any) =>
        !frame.retaining && frame.rep === run.selected_replication_id,
    ),
  ).toBe(true);
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1],
      current = frames[index];
    expect(current.playhead).toBeGreaterThanOrEqual(previous.playhead);
    // Wall-time proportional advance is allowed on a slow machine; a 4-hour
    // endpoint jump in one display frame is not continuous playback.
    expect(current.playhead - previous.playhead).toBeLessThanOrEqual(
      (current.real - previous.real + 50) * 4 * 3600,
    );
    expect(current.slider).toBeGreaterThanOrEqual(previous.slider);
    expect(
      Math.abs(current.slider - (current.playhead - origin) / 60000),
    ).toBeLessThanOrEqual(1);
    expect(Date.parse(current.at)).toBeLessThanOrEqual(current.playhead + 1);
    expect(current.validUntilMs).toBeGreaterThanOrEqual(
      current.playhead - 0.001,
    );
  }
  const completeWindows = windows.filter(
    (window) => Date.parse(window.end_at) <= frames.at(-1).playhead,
  );
  expect(completeWindows.length).toBeGreaterThanOrEqual(3);
  for (const window of completeWindows) {
    expect(window.complete).toBe(true);
    const inside = frames.filter(
      (frame: any) =>
        frame.playhead > Date.parse(window.start_at) &&
        frame.playhead < Date.parse(window.end_at),
    );
    expect(
      new Set(inside.map((frame: any) => frame.playhead)).size,
    ).toBeGreaterThanOrEqual(8);
  }
  expect(
    requests.length,
    "Playback must use buffered recorded changes rather than a state request per event",
  ).toBeLessThanOrEqual(1);
  const snapshots = new Map<number, any>();
  for (const snapshot of audit.snapshots) {
    const chunk = Math.floor((snapshot.playhead - origin) / CHUNK);
    if (!snapshots.has(chunk)) snapshots.set(chunk, snapshot);
  }
  expect(snapshots.size).toBeGreaterThanOrEqual(3);
  const checked: string[] = [];
  for (const snapshot of [...snapshots.values()].slice(0, 3))
    checked.push(await assertSnapshotAgainstExactState(page, run, snapshot));
  expect(
    new Set(
      audit.snapshots.map((snapshot: any) => JSON.stringify(snapshot.occupied)),
    ).size,
  ).toBeGreaterThan(5);
  const motionByNode = new Map<number, any[]>();
  for (const sample of audit.motion)
    motionByNode.set(sample.node, [
      ...(motionByNode.get(sample.node) || []),
      sample,
    ]);
  const continuousJourneys = [...motionByNode.values()].flatMap((samples) => {
    const segments: any[][] = [];
    for (const sample of samples) {
      const current = segments.at(-1);
      if (current && sample.events?.startsWith(current.at(-1).events))
        current.push(sample);
      else segments.push([sample]);
    }
    return segments;
  });
  const crossing = continuousJourneys.filter(
    (samples) =>
      new Set(
        samples.map((sample) => Math.floor((sample.playhead - origin) / CHUNK)),
      ).size > 1,
  );
  expect(
    crossing.length,
    "A running recorded patient journey must survive a normal transport-window boundary",
  ).toBeGreaterThan(0);
  for (const samples of crossing) {
    expect(
      samples.every((sample, index) => {
        if (sample.trailPath !== sample.path) return false;
        if (!index) return true;
        const previous = samples[index - 1];
        // A later contiguous recorded move may extend the same route. Its
        // percentage changes, but traveled distance and visible position
        // must keep advancing rather than restarting at the entrance.
        return (
          sample.path.startsWith(previous.path) &&
          sample.absoluteDistance >= previous.absoluteDistance - 2 &&
          Math.hypot(sample.x - previous.x, sample.y - previous.y) <
            40 + (sample.real - previous.real) * 3
        );
      }),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
  await capture(page, "continuous-event-playback", info);
  record("continuous-event-playback", {
    run: run.id,
    checked_exact_times: checked,
    complete_windows: completeWindows.map((window) => ({
      start_at: window.start_at,
      end_at: window.end_at,
      frames: window.frames.length,
    })),
    state_requests_during_playback: requests.length,
    crossing_journeys: crossing.length,
    audit,
    errors,
  });
});

test("pausing inside a playback window hydrates the visible exact moment and resume finishes at the unchanged saved horizon", async ({
  page,
}, info) => {
  const { scenario: saved, run } = await createRecordedRun(
    page,
    "continuous pause and exact finish",
  );
  const savedBefore = await api(page.request, `/scenarios/${saved.id}`);
  const floor = page.getByTestId("replay-floor-plan");
  const original = await floor.elementHandle();
  const origin = Date.parse(run.start_at);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("4");
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect
    .poll(() => visibleClock(page), { timeout: 10000, intervals: [30] })
    .toBeGreaterThan(origin + HOUR);
  await page.getByLabel("Pause replay", { exact: true }).evaluate((button) => {
    button.addEventListener(
      "click",
      () => {
        (window as any).__visiblePauseTarget = Number(
          document.querySelector<HTMLElement>(
            '[data-testid="replay-playhead"]',
          )!.dataset.playheadMs,
        );
      },
      { once: true },
    );
  });
  await page.getByLabel("Pause replay", { exact: true }).click();
  const target = await page.evaluate(
    () => (window as any).__visiblePauseTarget,
  );
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBeCloseTo(Math.trunc(target), 0);
  const pausedAt = new URL(page.url()).searchParams.get("at")!;
  await expectFloorPlanAt(page, run.selected_replication_id, pausedAt);
  expect(Date.parse(pausedAt) - origin).toBeGreaterThan(0);
  expect((Date.parse(pausedAt) - origin) % CHUNK).not.toBe(0);
  await expect(
    page.locator(".floor-transit-marker,.floor-transit-trail"),
  ).toHaveCount(0);
  const pausedClocks = await page
    .getByTestId("replay-playhead")
    .evaluate(async (clock) => {
      const values: number[] = [],
        started = performance.now();
      while (performance.now() - started < 250) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        values.push(Number((clock as HTMLElement).dataset.playheadMs));
      }
      return values;
    });
  expect(new Set(pausedClocks).size).toBe(1);
  await seekFloorPlan(page, run, 0);
  expect(
    await floor.evaluate((node, before) => node === before, original),
  ).toBe(true);
  let releaseLeave!: () => void,
    deliveredLeave!: () => void,
    heldLeave = false;
  const leaveGate = new Promise<void>((resolve) => {
    releaseLeave = resolve;
  });
  const leaveDelivery = new Promise<void>((resolve) => {
    deliveredLeave = resolve;
  });
  const leavePattern = `**/api/runs/${run.selected_replication_id}/playback-window?**`;
  const delayLeaveWindow = async (route: Route) => {
    const from = Date.parse(
      new URL(route.request().url()).searchParams.get("start_at") || "",
    );
    if (heldLeave || from < origin + CHUNK) {
      await route.continue();
      return;
    }
    heldLeave = true;
    try {
      const response = await route.fetch();
      await leaveGate;
      await route.fulfill({ response });
    } finally {
      deliveredLeave();
    }
  };
  let leftAt = 0,
    returnedAt = "";
  await page.route(leavePattern, delayLeaveWindow);
  try {
    await page.getByLabel("Play replay", { exact: true }).click();
    await expect.poll(() => heldLeave).toBe(true);
    await expect
      .poll(() => visibleClock(page), { timeout: 10000, intervals: [30] })
      .toBeGreaterThan(origin + HOUR / 2);
    const analytics = page
      .getByRole("navigation", { name: "Analysis navigation" })
      .getByRole("button", { name: "Analytics", exact: true });
    await analytics.evaluate((button) => {
      button.addEventListener(
        "click",
        () => {
          (window as any).__visiblePageLeaveTarget = Number(
            document.querySelector<HTMLElement>(
              '[data-testid="replay-playhead"]',
            )!.dataset.playheadMs,
          );
        },
        { once: true },
      );
    });
    await analytics.click();
    leftAt = await page.evaluate(
      () => (window as any).__visiblePageLeaveTarget,
    );
    await expect
      .poll(() => new URL(page.url()).searchParams.get("analysis"))
      .toBe("analytics");
    await expect
      .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
      .toBeCloseTo(Math.trunc(leftAt), 0);
    returnedAt = new URL(page.url()).searchParams.get("at")!;
    releaseLeave();
    await leaveDelivery;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(new URL(page.url()).searchParams.get("at")).toBe(returnedAt);
    await expect(page.getByTestId("replay-floor-plan")).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Analysis navigation" })
      .getByRole("button", { name: "Replay", exact: true })
      .click();
    await expectFloorPlanAt(page, run.selected_replication_id, returnedAt);
    await expect(page.getByLabel("Play replay", { exact: true })).toBeEnabled();
    expect(Date.parse(new URL(page.url()).searchParams.get("at")!)).toBe(
      Date.parse(returnedAt),
    );
    expect(new URL(page.url()).searchParams.get("run")).toBe(run.id);
  } finally {
    releaseLeave();
    await page.unroute(leavePattern, delayLeaveWindow);
  }
  const returnedFloor = await floor.elementHandle();
  await seekFloorPlan(page, run, 0);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("16");
  await page.getByLabel("Play replay", { exact: true }).click();
  await expect(page.getByLabel("Play replay", { exact: true })).toBeDisabled({
    timeout: 15000,
  });
  await expect.poll(() => visibleClock(page)).toBe(Date.parse(run.end_at));
  await expectFloorPlanAt(page, run.selected_replication_id, run.end_at);
  await seekFloorPlan(page, run, 37);
  expect(
    await floor.evaluate((node, before) => node === before, returnedFloor),
  ).toBe(true);
  expect((await api(page.request, `/run-groups/${run.id}`)).input_sha256).toBe(
    run.input_sha256,
  );
  expect(await api(page.request, `/scenarios/${saved.id}`)).toEqual(
    savedBefore,
  );
  await capture(page, "continuous-pause-exact-end", info);
  record("continuous-pause-exact-end", {
    run: run.id,
    visible_pause_target_ms: target,
    exact_paused_at: pausedAt,
    exact_end_at: run.end_at,
    exact_backward_minutes: 37,
    page_leave_visible_target_ms: leftAt,
    exact_returned_from_analytics_at: returnedAt,
    paused_clocks: pausedClocks,
    saved_inputs_unchanged: true,
  });
});

test("a delayed future playback window cannot repaint a newer exact seek or resume an old playback session", async ({
  page,
}, info) => {
  const { run } = await createRecordedRun(
    page,
    "continuous stale future buffer",
  );
  const origin = Date.parse(run.start_at);
  let release!: () => void,
    delivered!: () => void,
    held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const pattern = `**/api/runs/${run.selected_replication_id}/playback-window?**`;
  const delayFuture = async (route: Route) => {
    const from = Date.parse(
      new URL(route.request().url()).searchParams.get("start_at") || "",
    );
    if (held || from < origin + CHUNK) {
      await route.continue();
      return;
    }
    held = true;
    try {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } finally {
      delivered();
    }
  };
  await page.route(pattern, delayFuture);
  try {
    await page.getByLabel("Play replay", { exact: true }).click();
    await expect.poll(() => held, { timeout: 10000 }).toBe(true);
    await expect
      .poll(() => visibleClock(page), { timeout: 10000, intervals: [30] })
      .toBeGreaterThan(origin + HOUR / 2);
    const oldSession = await page
      .getByTestId("replay-playhead")
      .getAttribute("data-playback-session");
    const target = await seekFloorPlan(page, run, 18 * 60);
    await page.evaluate(() => {
      const values: any[] = [];
      const record = () =>
        values.push({
          at: document.querySelector<HTMLElement>(
            '[data-testid="replay-floor-plan"]',
          )?.dataset.recordedAt,
          playhead: Number(
            document.querySelector<HTMLElement>(
              '[data-testid="replay-playhead"]',
            )?.dataset.playheadMs,
          ),
        });
      const observer = new MutationObserver(record);
      observer.observe(document.querySelector("main")!, {
        subtree: true,
        attributes: true,
        childList: true,
      });
      record();
      (window as any).__lateBufferAudit = values;
      (window as any).__lateBufferObserver = observer;
    });
    release();
    await delivery;
    const late = await page.evaluate(async () => {
      const started = performance.now();
      while (performance.now() - started < 300)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      (window as any).__lateBufferObserver.disconnect();
      return (window as any).__lateBufferAudit;
    });
    expect(late.length).toBeGreaterThan(0);
    expect(
      late.every(
        (value: any) =>
          Date.parse(value.at) === Date.parse(target) &&
          value.playhead === Date.parse(target),
      ),
    ).toBe(true);
    await expectFloorPlanAt(page, run.selected_replication_id, target);
    expect(Date.parse(new URL(page.url()).searchParams.get("at")!)).toBe(
      Date.parse(target),
    );
    await expect(page.getByLabel("Play replay", { exact: true })).toBeEnabled();
    await expect(
      page.locator(".floor-transit-marker,.floor-transit-trail"),
    ).toHaveCount(0);
    await page.getByLabel("Play replay", { exact: true }).click();
    await expect
      .poll(() => visibleClock(page), { timeout: 10000, intervals: [30] })
      .toBeGreaterThan(Date.parse(target));
    expect(
      await page
        .getByTestId("replay-playhead")
        .getAttribute("data-playback-session"),
    ).not.toBe(oldSession);
    await page.getByLabel("Pause replay", { exact: true }).click();
    await expectFloorPlanAt(
      page,
      run.selected_replication_id,
      new URL(page.url()).searchParams.get("at")!,
    );
    record("continuous-stale-future-buffer", {
      run: run.id,
      old_session: oldSession,
      exact_seek_target: target,
      frames_after_old_delivery: late,
      stale_window_ignored: true,
    });
    await capture(page, "continuous-stale-future-buffer", info);
  } finally {
    release();
    await page.unroute(pattern, delayFuture);
  }
});
