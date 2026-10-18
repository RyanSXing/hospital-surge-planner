import { expect, test, type Page, type Route } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import {
  expectFloorPlanAt,
  expectHospitalFlowGeometry,
  seekFloorPlan,
} from "./replay-floorplan-helpers";

const sliderLabel = "Replay timestamp across actual elapsed horizon";
const instant = (run: any, minutes: number) =>
  new Date(Date.parse(run.start_at) + minutes * 60000).toISOString();

function recordedEmergencyWaiting(state: any): number | null {
  const count = state.queue_counts?.["FAC-MAIN"]?.ed;
  if (typeof count === "number" && Number.isFinite(count)) return count;
  // Exact-state queue counters omit empty facilities. The full grouped census
  // still establishes whether there are zero ED waiters; missing census is not zero.
  if (!Array.isArray(state.patient_groups)) return null;
  const groups = state.patient_groups.filter(
    (group: any) =>
      group.facility_id === "FAC-MAIN" && group.state === "ed_waiting",
  );
  if (groups.some((group: any) => !Number.isFinite(group.count))) return null;
  return groups.reduce((sum: number, group: any) => sum + group.count, 0);
}

async function createRun(page: Page, name: string, options: any = {}) {
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
  return { ...context, run };
}

async function installSceneAudit(page: Page) {
  await page.evaluate(() => {
    const floor = document.querySelector<HTMLElement>(
      '[data-testid="replay-floor-plan"]',
    )!;
    const workspace = document.querySelector<HTMLElement>(".replay-workspace")!;
    const origin = workspace.getBoundingClientRect().top;
    const audit: any = {
      running: true,
      replaced: false,
      maxTopShift: 0,
      pointerUps: 0,
      frames: [],
      transitions: [],
    };
    (window as any).__liveReplayAudit = audit;
    const pointerUp = () => audit.pointerUps++;
    document.addEventListener("pointerup", pointerUp);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const bed = mutation.target as HTMLElement;
        if (
          mutation.attributeName === "data-status" &&
          bed.matches(".floor-plan-bed") &&
          mutation.oldValue !== bed.dataset.status &&
          ["ready", "occupied"].includes(mutation.oldValue || "") &&
          ["ready", "occupied"].includes(bed.dataset.status || "")
        )
          audit.transitions.push({
            node: bed,
            slot: bed.dataset.slotId,
            from: mutation.oldValue,
            to: bed.dataset.status,
            started: performance.now(),
            values: [],
          });
      }
    });
    observer.observe(floor, {
      attributes: true,
      subtree: true,
      attributeOldValue: true,
      attributeFilter: ["data-status"],
    });
    const sample = () => {
      if (!audit.running) {
        observer.disconnect();
        document.removeEventListener("pointerup", pointerUp);
        return;
      }
      const current = document.querySelector<HTMLElement>(
        '[data-testid="replay-floor-plan"]',
      );
      if (current !== floor || !floor.isConnected) audit.replaced = true;
      audit.maxTopShift = Math.max(
        audit.maxTopShift,
        Math.abs(workspace.getBoundingClientRect().top - origin),
      );
      if (current) {
        const frame = {
          at: current.dataset.recordedAt,
          rep: current.dataset.replicationId,
          retaining: current.dataset.retaining,
        };
        const previous = audit.frames.at(-1);
        if (
          !previous ||
          previous.at !== frame.at ||
          previous.rep !== frame.rep ||
          previous.retaining !== frame.retaining
        )
          audit.frames.push(frame);
      }
      for (const transition of audit.transitions) {
        if (
          transition.node.isConnected &&
          performance.now() - transition.started < 550
        ) {
          const opacity = Number(
            getComputedStyle(transition.node, "::after").opacity,
          );
          if (Number.isFinite(opacity)) transition.values.push(opacity);
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function sceneAudit(page: Page) {
  return page.evaluate(() => {
    const audit = (window as any).__liveReplayAudit;
    return {
      replaced: audit.replaced,
      maxTopShift: audit.maxTopShift,
      pointerUps: audit.pointerUps,
      frames: audit.frames,
      transitions: audit.transitions.map((transition: any) => ({
        slot: transition.slot,
        from: transition.from,
        to: transition.to,
        values: transition.values,
      })),
    };
  });
}

async function finishSceneAudit(page: Page) {
  await page.evaluate(() => {
    if ((window as any).__liveReplayAudit)
      (window as any).__liveReplayAudit.running = false;
  });
}

async function dragGeometry(page: Page) {
  const range = page.getByLabel(sliderLabel);
  await range.scrollIntoViewIfNeeded();
  const bounds = await range.boundingBox();
  expect(bounds).toBeTruthy();
  const track = bounds!;
  return {
    range,
    y: track.y + track.height / 2,
    x: (fraction: number) => track.x + 8 + (track.width - 16) * fraction,
  };
}

async function stateAtSlider(page: Page, run: any) {
  const minutes = Number(await page.getByLabel(sliderLabel).inputValue());
  return {
    minutes,
    at: instant(run, minutes),
    state: await expectFloorPlanAt(
      page,
      run.selected_replication_id,
      instant(run, minutes),
    ),
  };
}

test("held timeline drag publishes exact intermediate map states, coalesces fast changes, and seeks backward without replacing the map", async ({
  page,
}, info) => {
  const { scenario: saved, run } = await createRun(page, "live held scrub");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page, saved.id, "replay", run.id);
  const initial = await expectFloorPlanAt(
    page,
    run.selected_replication_id,
    run.start_at,
  );
  await expectHospitalFlowGeometry(page);
  const drag = await dragGeometry(page);
  await installSceneAudit(page);
  const requests: string[] = [];
  let inFlight = 0,
    maxInFlight = 0;
  const pattern = `**/api/runs/${run.selected_replication_id}/state?*`;
  const delayExactState = async (route: Route) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    requests.push(new URL(route.request().url()).searchParams.get("at")!);
    try {
      const response = await route.fetch();
      // A deliberately slow real result exposes request backlogs and target rollback.
      await new Promise((resolve) => setTimeout(resolve, 180));
      await route.fulfill({ response });
    } finally {
      inFlight--;
    }
  };
  await page.route(pattern, delayExactState);
  try {
    await page.mouse.move(drag.x(0), drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.x(0.34), drag.y, { steps: 6 });
    const first = await stateAtSlider(page, run);
    expect(first.minutes).toBeGreaterThan(24 * 60);
    expect(first.minutes).toBeLessThan(36 * 60);
    expect((await sceneAudit(page)).pointerUps).toBe(0);
    expect(first.state.flow_counts["FAC-MAIN"].discharges).toBeGreaterThan(
      initial.flow_counts["FAC-MAIN"].discharges,
    );
    await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
    await expect(page.locator(".floor-transit-trail")).toHaveCount(0);

    await page.mouse.move(drag.x(0.72), drag.y, { steps: 6 });
    const second = await stateAtSlider(page, run);
    expect(second.minutes).toBeGreaterThan(48 * 60);
    expect(second.at).not.toBe(first.at);
    expect((await sceneAudit(page)).pointerUps).toBe(0);

    // Queue several new destinations while the first real reconstruction is delayed.
    await page.mouse.move(drag.x(0.86), drag.y);
    await page.mouse.move(drag.x(0.44), drag.y);
    await page.mouse.move(drag.x(0.18), drag.y);
    const backward = await stateAtSlider(page, run);
    expect(backward.minutes).toBeLessThan(first.minutes);
    expect((await sceneAudit(page)).pointerUps).toBe(0);
    await expect(drag.range).not.toHaveAttribute("data-seeking", "true");
    await page.mouse.up();
    await expect.poll(() => inFlight).toBe(0);
    await expectFloorPlanAt(page, run.selected_replication_id, backward.at);
    expect(Number(await drag.range.inputValue())).toBe(backward.minutes);
    expect(Date.parse(new URL(page.url()).searchParams.get("at") || "")).toBe(
      Date.parse(backward.at),
    );
    const audit = await sceneAudit(page);
    expect(audit.replaced).toBe(false);
    expect(audit.maxTopShift).toBeLessThanOrEqual(1);
    expect(
      audit.frames.every(
        (frame: any) => frame.rep === run.selected_replication_id,
      ),
    ).toBe(true);
    for (const at of [first.at, second.at, backward.at])
      expect(
        audit.frames.some(
          (frame: any) =>
            Date.parse(frame.at) === Date.parse(at) &&
            frame.retaining === "false",
        ),
      ).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const animatedBed = audit.transitions.find((transition: any) =>
      transition.values.some((value: number) => value > 0.02 && value < 0.98),
    );
    expect(
      animatedBed,
      "A changed bed should visibly fill or empty smoothly",
    ).toBeTruthy();
    await expect(page.locator(".state-loading-overlay")).toHaveCount(0);
    await expect(page.locator(".state-refresh-bar")).toHaveCount(0);
    expect(errors).toEqual([]);
    await capture(page, "replay-live-scrub", info);
    record("replay-live-scrub", {
      run: run.id,
      exact_intermediate_times: [first.at, second.at],
      exact_backward_target: backward.at,
      map_updated_before_release: true,
      max_concurrent_exact_state_requests: maxInFlight,
      requested_states: requests,
      scene_audit: audit,
      errors,
    });
  } finally {
    await page.mouse.up();
    await finishSceneAudit(page);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a late seek response from the previous replication cannot repaint the newly selected run", async ({
  page,
}, info) => {
  const { scenario: saved, run } = await createRun(page, "scrub run race", {
    replications: 2,
  });
  const list = await api(
    page.request,
    `/run-groups/${run.id}/replications?limit=200`,
  );
  const other = list.items.find(
    (item: any) => item.replication_id !== run.selected_replication_id,
  );
  expect(other).toBeTruthy();
  await api(page.request, `/runs/${other.replication_id}/trace`, "POST");
  await expect
    .poll(async () => {
      const trace = await api(
        page.request,
        `/runs/${other.replication_id}/trace`,
      );
      return trace.ready || trace.status === "SUCCEEDED";
    })
    .toBe(true);
  await open(page, saved.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  await installSceneAudit(page);
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => (unblock = resolve));
  let waiting = false,
    completed = false;
  await page.route(
    `**/api/runs/${run.selected_replication_id}/state?*`,
    async (route) => {
      const response = await route.fetch();
      waiting = true;
      await gate;
      try {
        await route.fulfill({ response });
      } finally {
        completed = true;
      }
    },
  );
  try {
    const drag = await dragGeometry(page);
    await page.mouse.move(drag.x(0), drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.x(0.55), drag.y);
    await page.mouse.up();
    await expect.poll(() => waiting).toBe(true);
    await page
      .getByLabel("Select replication to replay")
      .selectOption(other.replication_id);
    await expectFloorPlanAt(page, other.replication_id, run.start_at);
    unblock();
    await expect.poll(() => completed).toBe(true);
    await expectFloorPlanAt(page, other.replication_id, run.start_at);
    const audit = await sceneAudit(page);
    const firstNew = audit.frames.findIndex(
      (frame: any) => frame.rep === other.replication_id,
    );
    expect(firstNew).toBeGreaterThanOrEqual(0);
    expect(
      audit.frames
        .slice(firstNew)
        .every(
          (frame: any) => !frame.rep || frame.rep === other.replication_id,
        ),
    ).toBe(true);
    expect(audit.replaced).toBe(false);
    await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
    record("replay-live-scrub-run-race", {
      run: run.id,
      previous_replication: run.selected_replication_id,
      selected_replication: other.replication_id,
      late_response_did_not_repaint: true,
      scene_audit: audit,
    });
    await capture(page, "replay-live-scrub-run-race", info);
  } finally {
    unblock();
    await finishSceneAudit(page);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("recorded playback keeps patient markers and trails on the same continuous route and clears them when paused", async ({
  page,
}, info) => {
  const { scenario: saved, run } = await createRun(
    page,
    "smooth route replay",
    {
      horizon_calendar_days: 1,
    },
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page, saved.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  await expectHospitalFlowGeometry(page);
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  const marker = page.locator(".floor-transit-marker").first();
  await expect(marker).toBeAttached();
  const samples = await marker.evaluate(async (node) => {
    const element = node as HTMLElement;
    const values: number[] = [];
    const started = performance.now();
    const metadata = {
      patient: element.dataset.patientId,
      path: element.dataset.path,
      events: element.dataset.events,
      duration: Number(element.dataset.duration),
      delay: Number(element.dataset.delay),
    };
    while (element.isConnected && performance.now() - started < 3500) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const value = Number.parseFloat(getComputedStyle(element).offsetDistance);
      if (Number.isFinite(value) && value > 8 && value < 92) values.push(value);
      if (values.length >= 8) break;
    }
    const trail = element.previousElementSibling?.querySelector<SVGPathElement>(
      ".floor-transit-trail",
    );
    return {
      ...metadata,
      values,
      trailPath: trail?.getAttribute("d"),
      animations: element.getAnimations().length,
    };
  });
  expect(samples.path).toMatch(/^M/);
  expect(samples.events).toBeTruthy();
  expect(samples.duration).toBeGreaterThan(0);
  expect(samples.trailPath).toBe(samples.path);
  expect(samples.values.length).toBeGreaterThanOrEqual(4);
  expect(
    samples.values.every(
      (value, index, all) => index === 0 || value >= all[index - 1],
    ),
  ).toBe(true);
  expect(samples.values.at(-1)! - samples.values[0]).toBeGreaterThan(0);
  expect(samples.animations).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
  await expect(page.locator(".floor-transit-trail")).toHaveCount(0);
  record("replay-continuous-marker-route", { run: run.id, ...samples });
  await capture(page, "replay-continuous-marker-route", info);
});

test("the emergency waiting count can drain using recorded treatment events, with exact reduced-motion seeks", async ({
  page,
}, info) => {
  // This deterministic common prefix was independently checked against a
  // retained 14-day replication: h24 has 14 ED waiters and h36 has none.
  const { scenario: saved, run } = await createRun(
    page,
    "recorded ED queue recovery",
    {
      base_seed: 20261016,
      conditions: [
        {
          kind: "arrival_multiplier",
          entry_stream_id: "ED_MAIN",
          multiplier: 1.7,
          shape: "step",
        },
      ],
      hospital_operations: {
        severity_mix: {
          low: { percentage: 60, average_stay_hours: 24 },
          medium: { percentage: 30, average_stay_hours: 72 },
          high: { percentage: 10, average_stay_hours: 168 },
        },
        supplies: {
          initial_percent: 100,
          capacity: 200,
          usage_per_patient_day: 1,
          refill_every_days: 2,
          refill_percent: 70,
        },
      },
    },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, saved.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  const at24 = await seekFloorPlan(page, run, 24 * 60);
  const queued = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(at24)}`,
  );
  expect(recordedEmergencyWaiting(queued)).toBe(14);
  await expect(page.getByTestId("floor-plan-ed-waiting")).toHaveAttribute(
    "data-count",
    "14",
  );
  const at36 = await seekFloorPlan(page, run, 36 * 60);
  const recovered = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(at36)}`,
  );
  expect(recordedEmergencyWaiting(recovered)).toBe(0);
  await expect(page.getByTestId("floor-plan-ed-waiting")).toHaveAttribute(
    "data-count",
    "0",
  );
  await seekFloorPlan(page, run, 24 * 60);
  await expect(page.getByTestId("floor-plan-ed-waiting")).toHaveAttribute(
    "data-count",
    "14",
  );
  const transition = await page
    .locator(".floor-plan-bed")
    .first()
    .evaluate((node) => getComputedStyle(node, "::after").transitionDuration);
  expect(transition).toBe("0s");
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect
    .poll(async () =>
      Date.parse(
        (await page
          .getByTestId("replay-floor-plan")
          .getAttribute("data-recorded-at")) || "",
      ),
    )
    .toBeGreaterThan(Date.parse(at24));
  await expect(page.locator(".floor-transit-marker")).toHaveCount(0);
  await expect(page.locator(".floor-transit-trail")).toHaveCount(0);
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  // A previously published seek must remain reachable after playback moves on.
  await seekFloorPlan(page, run, 24 * 60);
  await expect(page.getByTestId("floor-plan-ed-waiting")).toHaveAttribute(
    "data-count",
    "14",
  );
  record("replay-recorded-ED-queue-recovery", {
    run: run.id,
    replication: run.selected_replication_id,
    states: [
      { at: at24, emergency_waiting: recordedEmergencyWaiting(queued) },
      { at: at36, emergency_waiting: recordedEmergencyWaiting(recovered) },
    ],
    backward_seek_restores_recorded_queue: true,
    reduced_motion_has_no_journey_animation: true,
    prior_seek_target_restored_after_playback: true,
  });
  await capture(page, "replay-recorded-ED-queue-recovery", info);
});

test("late event and checkpoint lookups cannot override a newer native timeline seek", async ({
  page,
}, info) => {
  const { scenario: saved, run } = await createRun(
    page,
    "scrub navigation race",
  );
  await open(page, saved.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  const floorNode = await page.getByTestId("replay-floor-plan").elementHandle();
  const checks: any[] = [];
  for (const kind of ["event", "checkpoint"] as const) {
    if (kind === "checkpoint")
      await page
        .getByRole("button", { name: "Advanced replay tools", exact: true })
        .click();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    let waiting = false,
      completed = false,
      oldTarget: string | null = null;
    const path = kind === "event" ? "events" : "checkpoints";
    const pattern = `**/api/runs/${run.selected_replication_id}/${path}?*`;
    const holdLookup = async (route: Route) => {
      if (
        kind === "event" &&
        new URL(route.request().url()).searchParams.get("direction") !== "after"
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const result = await response.json();
      const items = result.items || result;
      oldTarget = kind === "event" ? items[0]?.occurred_at : items.at(-1)?.at;
      waiting = true;
      await gate;
      try {
        await route.fulfill({ response });
      } finally {
        completed = true;
      }
    };
    await page.route(pattern, holdLookup);
    try {
      await page
        .getByRole("button", {
          name:
            kind === "event" ? "Next recorded event" : "Go to saved checkpoint",
          exact: true,
        })
        .click();
      await expect.poll(() => waiting).toBe(true);
      expect(oldTarget).toBeTruthy();
      const drag = await dragGeometry(page);
      await page.mouse.move(drag.x(kind === "event" ? 0 : 0.64), drag.y);
      await page.mouse.down();
      await page.mouse.move(drag.x(kind === "event" ? 0.64 : 0.12), drag.y);
      const latest = await stateAtSlider(page, run);
      await page.mouse.up();
      expect(Date.parse(oldTarget!)).not.toBe(Date.parse(latest.at));
      unblock();
      await expect.poll(() => completed).toBe(true);
      await expect(
        page.getByRole("button", { name: "Next recorded event", exact: true }),
      ).toBeEnabled();
      await expectFloorPlanAt(page, run.selected_replication_id, latest.at);
      expect(Date.parse(new URL(page.url()).searchParams.get("at") || "")).toBe(
        Date.parse(latest.at),
      );
      expect(
        await page
          .getByTestId("replay-floor-plan")
          .evaluate((node, original) => node === original, floorNode),
      ).toBe(true);
      checks.push({
        kind,
        ignored_old_target: oldTarget,
        preserved_latest_target: latest.at,
      });
    } finally {
      unblock();
      await page.mouse.up();
      await page.unrouteAll({ behavior: "wait" });
    }
  }
  record("replay-late-navigation-race", { run: run.id, checks });
  await capture(page, "replay-late-navigation-race", info);
});
