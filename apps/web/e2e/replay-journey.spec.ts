import { test, expect, type APIRequestContext } from "@playwright/test";
import { expectFloorPlanAt } from "./replay-floorplan-helpers";
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

test("recorded arrivals occupy an actual ED bed only during care and increment cumulative discharges", async ({
  page,
}, info) => {
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
  const rep = run.selected_replication_id;
  const journey = await recordedDischargeWindow(page.request, rep, run);
  expect(
    journey,
    "controlled batch contains a recorded queued ED visit and discharge",
  ).not.toBeNull();
  if (!journey) throw new Error("Missing controlled journey");
  await open(page, context.scenario.id, "replay", run.id);
  const url = new URL(page.url());
  url.searchParams.set("patient", journey.patientId);
  const moments = [
    { at: journey.startAt, bed: false, name: "Before arrival" },
    { at: journey.arrivalAt, bed: false, name: "Waiting for assessment" },
    { at: journey.assessmentAt, bed: true, name: "Receiving ED care" },
    {
      at: new Date(Date.parse(journey.dischargeAt) - 1000).toISOString(),
      bed: true,
      name: "Still receiving ED care",
    },
    {
      at: new Date(Date.parse(journey.dischargeAt) + 1000).toISOString(),
      bed: false,
      name: "Discharged",
    },
  ];
  const counts: number[] = [];
  for (const moment of moments) {
    url.searchParams.set("at", moment.at);
    await page.goto(url.toString());
    const state = await expectFloorPlanAt(page, rep, moment.at);
    const bed = page.locator(
      `.floor-plan-bed[data-patient-id="${journey.patientId}"]`,
    );
    await expect(bed, moment.name).toHaveCount(moment.bed ? 1 : 0);
    if (moment.bed) {
      await expect(bed).toHaveAttribute("data-unit-id", "UNIT-ED");
      await expect(bed).toHaveAttribute("data-status", "occupied");
    }
    counts.push(state.flow_counts["FAC-MAIN"].discharges);
  }
  expect(counts.at(-1)).toBeGreaterThan(counts.at(-2)!);
  await page
    .getByRole("button", { name: "Inspect replay", exact: true })
    .click();
  await expect(page.locator(".replay-inspector")).toContainText(
    "No active location at this timestamp",
  );
  await expect(
    page.locator(".replay-patient-history .info-note"),
  ).toContainText("Discharged at");
  await info.attach("recorded-floorplan-journey", {
    body: JSON.stringify({ journey, moments, counts }, null, 2),
    contentType: "application/json",
  });
});
