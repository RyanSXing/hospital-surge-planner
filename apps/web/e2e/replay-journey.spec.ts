import { test, expect, type APIRequestContext } from "@playwright/test";
import { api, open, scenario, waitRun } from "./helpers";

type JourneyWindow = {
  patientId: string;
  events: any[];
  startAt: string;
  endAt: string;
  speed: 4 | 16;
  arrivalAt: string;
  assessmentAt: string;
  dischargeAt: string;
};

const batchId = "replay-journey-ed-batch";
const batchPatientPrefix = `PAT-REPORT-${batchId}-`;

async function eventsInWindow(
  request: APIRequestContext,
  replicationId: string,
  startAt: string,
  endAt: string,
) {
  let cursor: string | null = null;
  const rows: any[] = [];
  do {
    const params = new URLSearchParams({
      start_at: startAt,
      end_at: endAt,
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);
    const page = await api(request, `/runs/${replicationId}/events?${params}`);
    rows.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return rows;
}

async function recordedDischargeWindow(
  request: APIRequestContext,
  replicationId: string,
  run: { start_at: string; end_at: string },
): Promise<JourneyWindow | null> {
  const runStart = Date.parse(run.start_at);
  const runEnd = Date.parse(run.end_at);
  // Prefer the normal four-hour replay step. A sixteen-hour step retains
  // coverage if this small real run has no brief ED visit in any four-hour
  // interval.
  for (const hours of [4, 16] as const) {
    for (
      let start = runStart;
      start + hours * 3_600_000 <= runEnd;
      start += hours * 3_600_000
    ) {
      const startAt = new Date(start).toISOString();
      const endAt = new Date(start + hours * 3_600_000).toISOString();
      const byPatient = new Map<string, any[]>();
      for (const event of await eventsInWindow(
        request,
        replicationId,
        startAt,
        endAt,
      )) {
        if (!event.patient_id) continue;
        const values = byPatient.get(event.patient_id) || [];
        values.push(event);
        byPatient.set(event.patient_id, values);
      }
      for (const [patientId, events] of byPatient) {
        if (!patientId.startsWith(batchPatientPrefix)) continue;
        const arrival = events.find((event) => event.event_type === "arrival");
        const assessment = events.find(
          (event) => event.event_type === "assessment_start",
        );
        const discharge = events.find(
          (event) => event.event_type === "discharge",
        );
        const entryWait =
          assessment && arrival
            ? Date.parse(assessment.occurred_at) -
              Date.parse(arrival.occurred_at)
            : 0;
        const assessedFor =
          discharge && assessment
            ? Date.parse(discharge.occurred_at) -
              Date.parse(assessment.occurred_at)
            : 0;
        const windowMs = hours * 3_600_000;
        if (
          arrival &&
          assessment &&
          discharge &&
          Date.parse(arrival.occurred_at) > start &&
          entryWait >= windowMs * 0.1 &&
          assessedFor >= windowMs * 0.1 &&
          Date.parse(discharge.occurred_at) < start + windowMs * 0.9
        )
          return {
            patientId,
            events,
            startAt,
            endAt,
            speed: hours,
            arrivalAt: arrival.occurred_at,
            assessmentAt: assessment.occurred_at,
            dischargeAt: discharge.occurred_at,
          };
      }
    }
  }
  return null;
}

test("replay shows a recorded patient through ED and the discharge bay", async ({
  page,
}, testInfo) => {
  const context = await scenario(page, "recorded replay journey", {
    horizon_calendar_days: 2,
    replications: 1,
    conditions: [
      {
        id: batchId,
        kind: "arrival_batch",
        entry_stream_id: "ED_MAIN",
        at: "2026-10-16T05:15:00Z",
        count: 60,
        spread_minutes: 0,
        care_mix: { discharge: 1 },
        source: "user_assumption",
      },
    ],
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const replicationId = run.selected_replication_id;
  const journey = await recordedDischargeWindow(
    page.request,
    replicationId,
    run,
  );
  expect(
    journey,
    "the controlled ED batch needs a queued arrival, timed ED care, and discharge inside one replay step",
  ).not.toBeNull();
  if (!journey) return;

  // This confirms the selected patient is an event-only journey. Neither
  // endpoint snapshot can supply its dot, so the canvas must use recorded
  // events rather than accidentally animating a current census record.
  for (const at of [journey.startAt, journey.endAt]) {
    const state = await api(
      page.request,
      `/runs/${replicationId}/state?at=${encodeURIComponent(at)}`,
    );
    expect(
      state.patients.some(
        (patient: any) => patient.patient_id === journey.patientId,
      ),
      `patient ${journey.patientId} must be absent from the ${at} snapshot`,
    ).toBe(false);
  }

  await open(page, context.scenario.id, "replay", run.id);
  const url = new URL(page.url());
  url.searchParams.set("at", journey.startAt);
  await page.goto(url.toString());
  const canvas = page.locator(".replay-canvas");
  await expect(canvas).toHaveAttribute("data-recorded-at", journey.startAt);
  await page
    .getByLabel("Replay speed", { exact: true })
    .selectOption(String(journey.speed));

  // Read diagnostics emitted by the actual canvas draw loop. The collector
  // starts before Play so it observes the full route rather than only its last
  // frame in the discharge bay.
  const frames = page.evaluate(async ({ patientId, startAt, endAt }) => {
    const node = document.querySelector<HTMLCanvasElement>(".replay-canvas");
    if (!node) return { samples: [], diagnostics: null };
    const samples: {
      recordedAt: string;
      clock: string;
      x: number;
      y: number;
    }[] = [];
    let diagnostics: Record<string, string> | null = null;
    let observedAt = "";
    const started = performance.now();
    while (performance.now() - started < 6_000) {
      const frameAt = node.dataset.journeyFrameAt || "";
      if (frameAt && frameAt !== observedAt) {
        observedAt = frameAt;
        if (node.dataset.recordedAt === endAt)
          diagnostics = {
            recordedAt: node.dataset.recordedAt || "",
            visualAt: node.dataset.visualAt || "",
            journeyEvents: node.dataset.journeyEvents || "",
            dischargeJourneys: node.dataset.dischargeJourneys || "",
            transientJourneys: node.dataset.transientJourneys || "",
            transientPatientIds: node.dataset.transientPatientIds || "",
            frameAt,
          };
        const point = JSON.parse(node.dataset.journeyFrame || "[]").find(
          (value: { id?: string }) => value.id === patientId,
        );
        if (
          point &&
          Date.parse(node.dataset.visualAt || "") >= Date.parse(startAt)
        )
          samples.push({
            recordedAt: node.dataset.recordedAt || "",
            clock: node.dataset.visualAt || "",
            ...point,
          });
        const dischargeBayFrames = samples.filter(
          (value) =>
            value.x >= 845 &&
            value.x <= 965 &&
            value.y >= 470 &&
            value.y <= 575,
        );
        if (diagnostics && dischargeBayFrames.length >= 2)
          return { samples, diagnostics };
      }
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return { samples, diagnostics };
  }, journey);
  await page.getByLabel("Play replay", { exact: true }).click();
  const observations = await frames;
  await testInfo.attach("replay-journey-observations", {
    body: JSON.stringify({ journey, observations }, null, 2),
    contentType: "application/json",
  });
  const observed = observations.samples;

  expect(observations.diagnostics?.recordedAt).toBe(journey.endAt);
  expect(observations.diagnostics?.transientPatientIds).toMatch(
    new RegExp(`(^|,)${journey.patientId}(,|$)`),
  );
  expect(
    Number(observations.diagnostics?.journeyEvents),
  ).toBeGreaterThanOrEqual(journey.events.length);
  expect(Number(observations.diagnostics?.dischargeJourneys)).toBeGreaterThan(
    0,
  );
  expect(Number(observations.diagnostics?.transientJourneys)).toBeGreaterThan(
    0,
  );

  const inZone = (
    point: { x: number; y: number },
    zone: "arrivals" | "ed" | "exit",
  ) =>
    zone === "arrivals"
      ? point.x >= 20 && point.x <= 145 && point.y >= 180 && point.y <= 350
      : zone === "ed"
        ? point.x >= 190 && point.x <= 400 && point.y >= 160 && point.y <= 370
        : point.x >= 845 && point.x <= 965 && point.y >= 470 && point.y <= 575;
  const first = (zone: "arrivals" | "ed" | "exit") =>
    observed.findIndex((point) => inZone(point, zone));
  const arrival = first("arrivals");
  const emergency = first("ed");
  const dischargeBay = first("exit");
  expect(
    arrival,
    "actual draw frames include the arrivals area",
  ).toBeGreaterThanOrEqual(0);
  expect(emergency, "actual draw frames include the ED area").toBeGreaterThan(
    arrival,
  );
  expect(
    dischargeBay,
    "actual draw frames reach the discharge bay",
  ).toBeGreaterThan(emergency);
  expect(
    observed.filter((point) => inZone(point, "exit")).length,
    "the discharge bay remains visible before the event-only dot fades",
  ).toBeGreaterThanOrEqual(2);

  const toleranceMs = 250;
  const elapsed = (value: string) => Date.parse(value);
  expect(
    observed.filter(
      (point) =>
        elapsed(point.clock) < elapsed(journey.arrivalAt) - toleranceMs,
    ),
    "the event-only dot is not drawn before its recorded arrival",
  ).toHaveLength(0);
  expect(
    observed.filter(
      (point) =>
        inZone(point, "ed") &&
        elapsed(point.clock) < elapsed(journey.assessmentAt) - toleranceMs,
    ),
    "the dot does not enter the ED before recorded assessment starts",
  ).toHaveLength(0);
  expect(
    observed.filter(
      (point) =>
        inZone(point, "exit") &&
        elapsed(point.clock) < elapsed(journey.dischargeAt) - toleranceMs,
    ),
    "the dot does not reach the discharge bay before its recorded discharge",
  ).toHaveLength(0);

  const pause = page.getByLabel("Pause replay", { exact: true });
  if (await pause.isVisible()) await pause.click();
});
