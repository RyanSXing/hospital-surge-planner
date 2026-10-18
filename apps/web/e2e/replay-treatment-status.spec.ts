import { expect, test, type Page } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";
import { expectFloorPlanAt, seekFloorPlan } from "./replay-floorplan-helpers";

const MINUTE = 60_000;
const instant = (start: string, minutes: number) =>
  new Date(Date.parse(start) + minutes * MINUTE).toISOString();
const tokens = (value: string | null) =>
  (value || "").split(/\s+/).filter(Boolean).sort();

type TreatmentStatus = {
  care_paused: boolean;
  treatment_disrupted: boolean;
  reasons: string[];
  since_at: string;
  last_resumed_at: string | null;
};

async function createRun(
  page: Page,
  name: string,
  options: {
    emptyWard?: boolean;
    supplies?: boolean;
    unconfigured?: boolean;
  } = {},
) {
  const context = await scenario(page, name, {
    horizon_calendar_days: 2,
    replications: 1,
    base_seed: 20261016,
  });
  let datasetId = context.dataset.id;
  if (options.emptyWard) {
    // A real immutable dataset copy leaves one active clinical room empty.
    // The source inventory and all other saved scenarios remain unchanged.
    const source = await api(page.request, `/datasets/${datasetId}`);
    const emptyCensus = source.patients.filter(
      (patient: any) => patient.unit_id === "UNIT-WARD-C",
    );
    expect(emptyCensus.length).toBeGreaterThan(0);
    const draft = await api(page.request, "/dataset-drafts", "POST", {
      dataset_version_id: datasetId,
    });
    const editedResponse = await page.request.patch(
      `/api/dataset-drafts/${draft.id}/entities`,
      {
        headers: { "If-Match": String(draft.revision) },
        data: {
          operations: emptyCensus.map((patient: any) => ({
            collection: "patients",
            action: "delete",
            entity_id: patient.patient_id,
          })),
        },
      },
    );
    expect(editedResponse.ok(), await editedResponse.text()).toBeTruthy();
    const edited = await editedResponse.json();
    expect(edited.validation.valid, JSON.stringify(edited.validation)).toBe(
      true,
    );
    const committedResponse = await page.request.post(
      `/api/dataset-drafts/${draft.id}/commit`,
      {
        headers: { "If-Match": String(edited.revision) },
      },
    );
    expect(committedResponse.ok(), await committedResponse.text()).toBeTruthy();
    datasetId = (await committedResponse.json()).id;
    expect(await api(page.request, `/datasets/${context.dataset.id}`)).toEqual(
      source,
    );
  }
  const pause = {
    id: "recorded-status-pause",
    name: "Recorded treatment pause",
    start_at: instant(context.scenario.start_at, 120),
    end_at: instant(context.scenario.start_at, 180),
  };
  const hospitalOperations = options.unconfigured
    ? null
    : {
        disruptions: [pause],
        ...(options.supplies
          ? {
              supplies: {
                initial_percent: 0,
                capacity: 1000,
                usage_per_patient_day: 1,
                refill_every_days: 1,
                refill_percent: 100,
              },
            }
          : {}),
      };
  const updatedResponse = await page.request.patch(
    `/api/scenarios/${context.scenario.id}`,
    {
      headers: { "If-Match": String(context.scenario.revision) },
      data: {
        dataset_version_id: datasetId,
        hospital_operations: hospitalOperations,
      },
    },
  );
  expect(updatedResponse.ok(), await updatedResponse.text()).toBeTruthy();
  const saved = await updatedResponse.json();
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: saved.id,
        expected_scenario_revision: saved.revision,
      })
    ).id,
  );
  await open(page, saved.id, "replay", run.id);
  await expectFloorPlanAt(page, run.selected_replication_id, run.start_at);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId("replay-treatment-status")).toBeVisible();
  return { saved, run, pause, sourceDatasetId: context.dataset.id, datasetId };
}

async function uiTreatment(page: Page) {
  const status = page.getByTestId("replay-treatment-status");
  return {
    state: await status.getAttribute("data-state"),
    reasons: tokens(await status.getAttribute("data-reasons")),
    since: (await status.getAttribute("data-since-at")) || null,
    resumed: (await status.getAttribute("data-last-resumed-at")) || null,
    text: (await status.innerText()).replace(/\s+/g, " "),
  };
}

function expectedTreatment(value: TreatmentStatus | null) {
  return value
    ? {
        state: value.care_paused
          ? "paused"
          : value.last_resumed_at
            ? "resumed"
            : "available",
        reasons: [...value.reasons].sort(),
        since: value.since_at,
        resumed: value.last_resumed_at,
      }
    : { state: "unknown", reasons: [], since: null, resumed: null };
}

function expectLocalResume(text: string, at: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  expect(text).toMatch(/Treatment resumed/i);
  expect(text).toContain(parts.month);
  expect(text).toMatch(new RegExp(`\\b${parts.day}\\b`));
  expect(text).toMatch(
    new RegExp(
      `\\b0?${Number(parts.hour)}:${parts.minute}(?::\\d\\d)?\\s*${parts.dayPeriod}`,
      "i",
    ),
  );
}

async function expectStatusFromExact(page: Page, run: any, at: string) {
  const exact = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(at)}`,
  );
  const expected = expectedTreatment(exact.treatment_status);
  await expect
    .poll(async () => {
      const { text: _text, ...value } = await uiTreatment(page);
      return value;
    })
    .toEqual(expected);
  const shown = await uiTreatment(page);
  if (expected.state === "resumed")
    expectLocalResume(shown.text, expected.resumed!);
  if (expected.state === "paused") {
    expect(shown.text).toMatch(/Treatment paused/i);
    if (expected.reasons.includes("treatment_disruption"))
      expect(shown.text).toMatch(/disruption/i);
    if (expected.reasons.includes("medical_supplies"))
      expect(shown.text).toMatch(/suppl/i);
  }
  const active = exact.units.filter(
    (unit: any) =>
      unit.facility_id === "FAC-MAIN" &&
      ["ed", "ward", "icu", "clinic"].includes(unit.kind) &&
      unit.active === true,
  );
  expect(active.length).toBeGreaterThan(0);
  for (const unit of active) {
    const room = page.locator(
      `.floor-plan-unit[data-unit-id="${unit.unit_id}"]`,
    );
    await expect(room).toHaveAttribute(
      "data-treatment-paused",
      String(!!exact.treatment_status?.care_paused),
    );
    expect(tokens(await room.getAttribute("data-treatment-reasons"))).toEqual(
      exact.treatment_status?.care_paused ? expected.reasons : [],
    );
    if (exact.treatment_status?.care_paused) {
      const visiblyRed = () =>
        room.evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            style.backgroundColor,
            style.borderColor,
            style.boxShadow,
          ].some((color) =>
            [
              ...color.matchAll(
                /rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)/g,
              ),
            ].some(
              (match) =>
                Number(match[1]) > Number(match[2]) + 12 &&
                Number(match[1]) > Number(match[3]) + 6 &&
                Number(match[4] ?? 1) > 0,
            ),
          );
        });
      await expect
        .poll(visiblyRed, {
          message: `${unit.unit_id} must visibly show its hospital-wide care pause`,
        })
        .toBe(true);
    }
  }
  await expect(
    page.locator('.floor-plan-count-area[data-treatment-paused="true"]'),
  ).toHaveCount(0);
  return { exact, shown };
}

async function seekStatus(page: Page, run: any, minutes: number) {
  const at = await seekFloorPlan(page, run, minutes);
  return { at, ...(await expectStatusFromExact(page, run, at)) };
}

async function beginStableSceneAudit(page: Page) {
  await page.evaluate(() => {
    const floor = document.querySelector<HTMLElement>(
      '[data-testid="replay-floor-plan"]',
    )!;
    const status = document.querySelector<HTMLElement>(
      '[data-testid="replay-treatment-status"]',
    )!;
    const key = floor.querySelector<HTMLElement>(".floor-plan-key")!;
    const canvas = floor.querySelector<HTMLElement>(
      '[data-testid="floor-plan-fit-viewport"]',
    )!;
    const building = floor.querySelector<HTMLElement>(".floor-plan-building")!;
    const timeline = document.querySelector<HTMLElement>(
      'input[aria-label="Replay timestamp across actual elapsed horizon"]',
    )!;
    const rooms = [...floor.querySelectorAll<HTMLElement>(".floor-plan-unit")];
    const beds = [...floor.querySelectorAll<HTMLElement>(".floor-plan-bed")];
    const queues = [
      ...floor.querySelectorAll<HTMLElement>(".floor-plan-count-area"),
    ];
    const rect = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const originalRects = [floor, key, status, canvas, building].map(rect);
    const queueStyles = queues.map((node) => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.borderColor, style.boxShadow].join(
        "|",
      );
    });
    const audit = {
      phase: "scrubbing",
      nodeReplaced: false,
      bedsReplaced: false,
      queueStyleChanged: false,
      maxLayoutShift: 0,
      outside: [] as string[],
      banners: 0,
      observations: [] as any[],
    };
    let frame = 0,
      last = "";
    const sample = () => {
      const currentFloor = document.querySelector(
        '[data-testid="replay-floor-plan"]',
      );
      const currentStatus = document.querySelector(
        '[data-testid="replay-treatment-status"]',
      );
      if (
        currentFloor !== floor ||
        currentStatus !== status ||
        rooms.some((room) => !room.isConnected)
      )
        audit.nodeReplaced = true;
      const currentBeds = [...floor.querySelectorAll(".floor-plan-bed")];
      if (
        currentBeds.length !== beds.length ||
        currentBeds.some((bed, index) => bed !== beds[index])
      )
        audit.bedsReplaced = true;
      [floor, key, status, canvas, building].map(rect).forEach((box, index) => {
        const original = originalRects[index];
        for (const dimension of ["x", "y", "width", "height"] as const)
          audit.maxLayoutShift = Math.max(
            audit.maxLayoutShift,
            Math.abs(box[dimension] - original[dimension]),
          );
      });
      queues.forEach((node, index) => {
        const style = getComputedStyle(node);
        if (
          [style.backgroundColor, style.borderColor, style.boxShadow].join(
            "|",
          ) !== queueStyles[index]
        )
          audit.queueStyleChanged = true;
      });
      const limits = canvas.getBoundingClientRect();
      for (const node of [
        ...rooms,
        ...queues,
        ...floor.querySelectorAll<HTMLElement>(
          ".floor-plan-entrance,.floor-plan-exit",
        ),
        timeline,
      ]) {
        const box = node.getBoundingClientRect();
        const insideCanvas =
          node === timeline ||
          (box.left >= limits.left - 1 &&
            box.right <= limits.right + 1 &&
            box.top >= limits.top - 1 &&
            box.bottom <= limits.bottom + 1);
        if (
          !insideCanvas ||
          box.left < -1 ||
          box.right > innerWidth + 1 ||
          box.top < -1 ||
          box.bottom > innerHeight + 1
        )
          if (!audit.outside.includes(node.dataset.unitId || node.className))
            audit.outside.push(node.dataset.unitId || node.className);
      }
      if (
        document.querySelector(
          ".state-banner,.state-refresh-bar,.state-loading-overlay,.replay-treatment-banner",
        )
      )
        audit.banners++;
      const clock = document.querySelector<HTMLElement>(
        '[data-testid="replay-playhead"]',
      );
      const observation = {
        phase: audit.phase,
        state: status.dataset.state,
        reasons: status.dataset.reasons || "",
        since: status.dataset.sinceAt || null,
        resumed: status.dataset.lastResumedAt || null,
        playhead: Number(clock?.dataset.playheadMs),
        playing: !!document.querySelector('button[aria-label="Pause replay"]'),
      };
      const signature = JSON.stringify([
        observation.phase,
        observation.state,
        observation.reasons,
        observation.since,
        observation.playing,
      ]);
      if (signature !== last) {
        audit.observations.push(observation);
        last = signature;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    (window as any).__treatmentStatusAudit = audit;
    (window as any).__stopTreatmentStatusAudit = () =>
      cancelAnimationFrame(frame);
  });
}

async function finishAudit(page: Page) {
  const result = await page.evaluate(() => {
    (window as any).__stopTreatmentStatusAudit();
    return (window as any).__treatmentStatusAudit;
  });
  expect(result.nodeReplaced).toBe(false);
  expect(result.bedsReplaced).toBe(false);
  expect(result.queueStyleChanged).toBe(false);
  expect(result.maxLayoutShift).toBeLessThanOrEqual(1);
  expect(result.outside).toEqual([]);
  expect(result.banners).toBe(0);
  return result;
}

async function verifyAnalyticsBackground(
  page: Page,
  scenarioId: string,
  run: any,
) {
  const metrics = await api(
    page.request,
    `/run-groups/${run.id}/metrics?grain=day`,
  );
  expect(metrics.context.run_group_id).toBe(run.id);
  const days = metrics.daily;
  expect(days).toHaveLength(2);
  const positive = (value: any) => {
    const amount =
      typeof value === "number" ? value : (value?.mean ?? value?.p50);
    return typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  };
  expect(
    days.some((day: any) => positive(day.treatment_disruption_hours)),
  ).toBe(true);
  const resourceDays = days.flatMap((day: any, index: number) =>
    Object.entries(day.blocker_patient_hours || {}).some(
      ([reason, value]) => reason !== "treatment_disruption" && positive(value),
    ) || positive(day.medical_supplies_shortage_hours)
      ? [
          {
            index,
            start: Date.parse(day.start_at || day.at),
            end: Date.parse(day.end_at),
          },
        ]
      : [],
  );
  await open(page, scenarioId, "analytics-outcomes", run.id);
  const outcomes = page.getByTestId("outcome-analytics");
  await outcomes
    .getByRole("tab", { name: "Daily ward capacity", exact: true })
    .click();
  await expect(outcomes.locator(".outcome-chart svg[role=img]")).toBeVisible();
  const periods = outcomes.locator(".chart-constraint-period");
  await expect(periods).toHaveCount(resourceDays.length);
  expect(
    await periods.evaluateAll((elements) =>
      elements.map((element) => ({
        index: Number(element.getAttribute("data-period-index")),
        start: Date.parse(element.getAttribute("data-recorded-at") || ""),
        end: Date.parse(element.getAttribute("data-recorded-end-at") || ""),
      })),
    ),
  ).toEqual(resourceDays);
  await expect(outcomes.locator(".chart-constraint-ribbon")).toHaveCount(0);
  await expect(
    outcomes.locator('.chart-constraint-band[data-kind="disruption"]'),
  ).toHaveCount(0);
  expect(
    await outcomes
      .locator(".chart-constraint-background")
      .evaluateAll((elements) =>
        elements.every((element) => Number(element.getAttribute("height")) > 4),
      ),
  ).toBe(true);
  if (resourceDays.length)
    await expect(
      outcomes.locator(".chart-constraint-background").first(),
    ).toBeVisible();
  expect(
    (
      await outcomes.locator(".chart-constraint-period title").allTextContents()
    ).join(" "),
  ).not.toMatch(/treatment disruption/i);
  return {
    resource_days: resourceDays,
    recorded_interruption_days: days.filter((day: any) =>
      positive(day.treatment_disruption_hours),
    ).length,
  };
}

test.beforeEach(async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop-only replay.");
  expect(
    ["localhost", "127.0.0.1", "[::1]"],
    "These fixtures may only write to an isolated local server",
  ).toContain(new URL(baseURL!).hostname);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("recorded treatment status survives backward scrubbing and plays through resumption without shifting the hospital", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { saved, run, pause, sourceDatasetId, datasetId } = await createRun(
    page,
    "inline recorded treatment status",
    { emptyWard: true },
  );
  const before = await expectStatusFromExact(page, run, run.start_at);
  expect(before.exact.treatment_status.care_paused).toBe(false);
  expect(before.shown.state).toBe("available");
  await beginStableSceneAudit(page);
  const boundaries: any[] = [];
  for (const minutes of [119, 120, 150, 180, 181, 150, 119, 180]) {
    const value = await seekStatus(page, run, minutes);
    expect(value.exact.treatment_status.care_paused).toBe(
      minutes >= 120 && minutes < 180,
    );
    if (minutes >= 120 && minutes < 180) {
      expect(value.exact.treatment_status.since_at).toBe(
        pause.start_at.replace(".000Z", "Z"),
      );
      expect(
        value.exact.units.find((unit: any) => unit.unit_id === "UNIT-WARD-C")
          .occupied,
      ).toBe(0);
      await expect(
        page.locator('.floor-plan-unit[data-unit-id="UNIT-WARD-C"]'),
      ).toHaveAttribute("data-treatment-paused", "true");
    }
    boundaries.push({
      minutes,
      status: value.exact.treatment_status,
      ui: value.shown,
    });
  }
  await capture(page, "treatment-resumed-inline", info);

  await seekStatus(page, run, 100);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("1");
  await page.evaluate(() => {
    (window as any).__treatmentStatusAudit.phase = "playback";
  });
  await page.getByRole("button", { name: "Play replay", exact: true }).click();
  await expect(page.getByTestId("replay-treatment-status")).toHaveAttribute(
    "data-state",
    "paused",
  );
  await expect(page.getByTestId("replay-treatment-status")).toHaveAttribute(
    "data-state",
    "resumed",
  );
  await expect
    .poll(async () =>
      Number(
        await page
          .getByTestId("replay-playhead")
          .getAttribute("data-playhead-ms"),
      ),
    )
    .toBeGreaterThanOrEqual(Date.parse(instant(run.start_at, 190)));
  await page.getByRole("button", { name: "Pause replay", exact: true }).click();
  await expect
    .poll(() => Date.parse(new URL(page.url()).searchParams.get("at") || ""))
    .toBeGreaterThanOrEqual(Date.parse(instant(run.start_at, 190)));
  const pausedAt = new URL(page.url()).searchParams.get("at")!;
  await expectFloorPlanAt(page, run.selected_replication_id, pausedAt);
  await expectStatusFromExact(page, run, pausedAt);
  const audit = await finishAudit(page);
  const playback = audit.observations.filter(
    (observation: any) =>
      observation.phase === "playback" && observation.playing,
  );
  expect(
    playback.some((observation: any) => observation.state === "available"),
  ).toBe(true);
  expect(
    playback.some((observation: any) => observation.state === "paused"),
  ).toBe(true);
  expect(
    playback.some((observation: any) => observation.state === "resumed"),
  ).toBe(true);
  for (const observation of playback) {
    if (!["available", "paused", "resumed"].includes(observation.state))
      continue;
    const state = await api(
      page.request,
      `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(new Date(observation.playhead).toISOString())}`,
    );
    expect(observation.state).toBe(
      expectedTreatment(state.treatment_status).state,
    );
    expect(tokens(observation.reasons)).toEqual(
      [...state.treatment_status.reasons].sort(),
    );
  }
  expect(errors).toEqual([]);
  const analytics = await verifyAnalyticsBackground(page, saved.id, run);
  await capture(page, "treatment-resources-background", info);
  record(`treatment-status-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    source_dataset_id: sourceDatasetId,
    isolated_dataset_id: datasetId,
    boundaries,
    audit,
    analytics,
    page_errors: errors,
  });
});

test("ending a disruption does not falsely resume care while medical supplies remain exhausted", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { saved, run } = await createRun(
    page,
    "disruption plus exhausted supplies",
    { supplies: true },
  );
  await expectStatusFromExact(page, run, run.start_at);
  await beginStableSceneAudit(page);
  const boundaries: any[] = [];
  for (const minutes of [119, 120, 150, 180, 181, 1439, 1440, 1441, 150]) {
    const value = await seekStatus(page, run, minutes);
    const status = value.exact.treatment_status as TreatmentStatus;
    if (minutes < 1440) {
      expect(status.care_paused).toBe(true);
      expect(status.last_resumed_at).toBeNull();
      expect(status.reasons).toEqual(
        minutes >= 120 && minutes < 180
          ? ["treatment_disruption", "medical_supplies"]
          : ["medical_supplies"],
      );
      expect(value.shown.text).not.toMatch(/resumed/i);
    } else {
      expect(status.care_paused).toBe(false);
      expect(Date.parse(status.last_resumed_at!)).toBe(
        Date.parse(instant(run.start_at, 1440)),
      );
    }
    boundaries.push({ minutes, status, ui: value.shown });
  }
  await capture(page, "treatment-disruption-supply-overlap", info);
  await seekStatus(page, run, 1441);
  await capture(page, "treatment-supply-refill-resumed", info);
  const audit = await finishAudit(page);
  record(`treatment-overlap-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    boundaries,
    audit,
  });
});

test("a saved run without operations history keeps treatment status unavailable", async ({
  page,
}, info) => {
  const { saved, run } = await createRun(page, "unrecorded treatment status", {
    unconfigured: true,
  });
  const initial = await expectStatusFromExact(page, run, run.start_at);
  expect(initial.exact.treatment_status).toBeNull();
  expect(initial.shown.state).toBe("unknown");
  expect(initial.shown.text).toMatch(/unavailable|not recorded/i);
  const later = await seekStatus(page, run, 180);
  expect(later.exact.treatment_status).toBeNull();
  expect(later.shown.state).toBe("unknown");
  await capture(page, "treatment-status-unavailable", info);
  record(`treatment-unknown-${info.project.name}`, {
    scenario_id: saved.id,
    run_id: run.id,
    initial: initial.shown,
    later: later.shown,
    recorded_treatment_status: null,
  });
});
