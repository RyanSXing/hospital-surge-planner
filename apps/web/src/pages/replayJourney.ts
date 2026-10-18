import type { Entity } from "../types";

export type ReplayJourneyZone =
  "arrivals" | "ed" | "queue" | "ward" | "icu" | "exit";

/** A recorded change in a patient's displayed location, with its exact trace time. */
export type RecordedJourneyStep = {
  zone: ReplayJourneyZone;
  at: number;
};

const inpatientZone = (
  event: Entity,
  unitKinds: Record<string, string>,
): ReplayJourneyZone | null => {
  const kind = unitKinds[event.to_unit_id] || unitKinds[event.from_unit_id];
  if (kind === "icu") return "icu";
  if (kind === "ed") return "ed";
  if (kind === "ward") return "ward";
  return null;
};

/**
 * These are recorded-event semantics used only to draw a journey. They never
 * guess a clinical destination: an ICU marker appears only for an event whose
 * recorded unit is ICU.
 */
export function replayJourneyZone(
  event: Entity,
  unitKinds: Record<string, string>,
): ReplayJourneyZone | null {
  switch (event.event_type) {
    case "arrival":
      return event.payload?.entry_type === "direct_ward" ? "queue" : "arrivals";
    // Placement requests do not move a patient. ED boarding remains in the
    // ED until a recorded admission/transfer arrival; direct arrivals already
    // declare their physical queue position on the arrival event itself.
    case "queue_entry":
      return null;
    case "assessment_start":
    case "assessment_end":
      return "ed";
    case "admission_request":
      return null;
    case "admission":
    case "transfer_arrived":
      return inpatientZone(event, unitKinds);
    case "transfer_departed":
      return "queue";
    case "discharge":
      return "exit";
    default:
      return null;
  }
}

export function recordedJourneyZones(
  events: Entity[],
  patient: string,
  unitKinds: Record<string, string>,
): ReplayJourneyZone[] {
  return recordedJourneySteps(events, patient, unitKinds).map(
    (step) => step.zone,
  );
}

/**
 * A trace-order view of physical locations. Administrative placement requests
 * are deliberately excluded until the trace records an actual arrival.
 */
export function recordedJourneySteps(
  events: Entity[],
  patient: string,
  unitKinds: Record<string, string>,
): RecordedJourneyStep[] {
  const seen: RecordedJourneyStep[] = [];
  const ordered = [...events]
    .filter((value) => value.patient_id === patient)
    .sort(
      (a, b) =>
        Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
        Number(a.sequence_number || 0) - Number(b.sequence_number || 0),
    );
  for (const event of ordered) {
    const zone = replayJourneyZone(event, unitKinds);
    if (zone && seen.at(-1)?.zone !== zone)
      seen.push({ zone, at: Date.parse(event.occurred_at) });
  }
  return seen;
}

export function recordedDischarge(
  events: Entity[],
  patient: string,
): Entity | null {
  return (
    [...events]
      .filter(
        (event) =>
          event.patient_id === patient && event.event_type === "discharge",
      )
      .sort(
        (a, b) =>
          Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
          Number(a.sequence_number || 0) - Number(b.sequence_number || 0),
      )
      .at(-1) || null
  );
}

export async function fetchReplayJourneyEvents(
  request: (path: string) => Promise<Entity>,
  rep: string,
  startAt: string,
  endAt: string,
): Promise<Entity[]> {
  const rows: Entity[] = [];
  let cursor: string | null = null;
  do {
    // The API window is [start, end). Ask for one extra millisecond and trim
    // locally so events stamped exactly at a rendered state are included.
    const inclusiveEnd = new Date(Date.parse(endAt) + 1).toISOString();
    const params = new URLSearchParams({
      start_at: startAt,
      end_at: inclusiveEnd,
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);
    const page = await request(`/runs/${rep}/events?${params}`);
    rows.push(...(page.items || []));
    cursor = page.next_cursor || null;
  } while (cursor);
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return rows.filter((event) => {
    const at = Date.parse(event.occurred_at);
    return at > start && at <= end;
  });
}
