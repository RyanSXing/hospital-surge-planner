import type { Entity } from "../types";

export interface FloorMove {
  from: string;
  to: string;
  at: string;
  eventId: string;
}
export interface FloorJourney {
  patientId: string;
  moves: FloorMove[];
}
export interface FloorMotionWindow {
  rep: string;
  from: string;
  to: string;
  events: Entity[];
}
export interface FloorAnchor {
  x: number;
  y: number;
  corridorX?: number;
}
export interface FloorTransitStamp {
  key: string;
  zoom: number;
}

/** A consumed window never restarts after a rerender, pause, resize or zoom. */
export function floorTransitWindowAction(
  previous: FloorTransitStamp | null,
  next: FloorTransitStamp & { active: boolean; from: string; to: string },
): "clear" | "hold" | "start" {
  if (
    !next.active ||
    !next.key ||
    !Number.isFinite(Date.parse(next.from)) ||
    !Number.isFinite(Date.parse(next.to)) ||
    Date.parse(next.to) <= Date.parse(next.from)
  )
    return "clear";
  if (previous?.key === next.key)
    return previous.zoom === next.zoom ? "hold" : "clear";
  return "start";
}

/** Visual pacing only: actual event times and saved patient states are unchanged. */
export function floorTransitTiming(
  journey: FloorJourney,
  from: string,
  to: string,
  motionDurationMs = 1000,
): { delayMs: number; durationMs: number } | null {
  const start = Date.parse(from),
    end = Date.parse(to),
    eventTimes = journey.moves.map((move) => Date.parse(move.at));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(motionDurationMs) ||
    motionDurationMs <= 0 ||
    !eventTimes.length ||
    eventTimes.some(
      (at, index) =>
        !Number.isFinite(at) ||
        at <= start ||
        at > end ||
        (index > 0 && at < eventTimes[index - 1]),
    ) ||
    journey.moves.some(
      (move, index) => index > 0 && move.from !== journey.moves[index - 1].to,
    )
  )
    return null;
  const cadence = Math.min(5000, motionDurationMs);
  // Start events in recorded order, but reserve almost the whole frame for a
  // legible walk rather than making late-window routes race through the map.
  const delayMs =
    (Math.min(120, cadence * 0.12) * (eventTimes[0] - start)) / (end - start);
  return {
    delayMs,
    durationMs: cadence - delayMs - Math.min(24, cadence * 0.024),
  };
}
export function floorMotionIsCurrent(
  window: FloorMotionWindow | null,
  context: {
    playing: boolean;
    reduced: boolean;
    rep?: string;
    selectedAt: string;
    recordedAt: string | null;
  },
): boolean {
  return Boolean(
    window &&
    context.playing &&
    !context.reduced &&
    window.rep === context.rep &&
    Date.parse(window.to) > Date.parse(window.from) &&
    Date.parse(window.to) === Date.parse(context.selectedAt) &&
    Date.parse(window.to) === Date.parse(context.recordedAt || ""),
  );
}

/** Physical section changes only; placement requests never move an occupied patient. */
export function recordedFloorJourneys(
  events: Entity[],
  unitIds: string[],
  from: string,
  to: string,
  limit = 12,
): FloorJourney[] {
  const allowed = new Set([
    ...unitIds,
    "entrance",
    "ed-waiting",
    "bed-waiting",
    "discharge",
  ]);
  const positions = new Map<string, string>();
  const chains = new Map<string, FloorJourney[]>();
  const ordered = [...events]
    .filter(
      (event) =>
        event.patient_id &&
        Date.parse(event.occurred_at) > Date.parse(from) &&
        Date.parse(event.occurred_at) <= Date.parse(to),
    )
    .sort(
      (a, b) =>
        Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
        Number(a.sequence_number || 0) - Number(b.sequence_number || 0),
    );
  for (const event of ordered) {
    const id = event.patient_id;
    let source: string | undefined, destination: string | undefined;
    if (event.event_type === "arrival") {
      source = "entrance";
      destination =
        event.payload?.entry_type === "direct_ward"
          ? "bed-waiting"
          : "ed-waiting";
    } else if (
      ["assessment_start", "clinic_start", "admission"].includes(
        event.event_type,
      )
    ) {
      source =
        event.from_unit_id ||
        positions.get(id) ||
        (event.event_type === "admission" ? "bed-waiting" : "ed-waiting");
      destination = event.to_unit_id;
    } else if (event.event_type === "transfer_arrived") {
      source =
        event.from_unit_id ||
        event.payload?.source_unit_id ||
        positions.get(id);
      destination = event.to_unit_id;
    } else if (event.event_type === "discharge") {
      source = event.from_unit_id || positions.get(id);
      destination = "discharge";
    }
    if (!destination) continue;
    if (!allowed.has(destination)) {
      positions.delete(id);
      continue;
    }
    positions.set(id, destination);
    if (!source || !allowed.has(source) || source === destination) continue;
    const move = {
      from: source,
      to: destination,
      at: event.occurred_at,
      eventId: String(event.event_id || event.sequence_number),
    };
    const existing = chains.get(id) || [];
    const last = existing.at(-1);
    if (last?.moves.at(-1)?.to === source) last.moves.push(move);
    else existing.push({ patientId: id, moves: [move] });
    chains.set(id, existing);
  }
  // One continuous path per patient avoids simultaneous duplicates at different locations.
  const candidates = [...chains.values()].map(
    (chunks) => [...chunks].sort((a, b) => b.moves.length - a.moves.length)[0],
  );
  if (candidates.length <= limit) return candidates;
  return Array.from(
    { length: limit },
    (_, index) => candidates[Math.floor((index * candidates.length) / limit)],
  );
}

export function corridorRoute(
  from: FloorAnchor,
  to: FloorAnchor,
  corridorY: number,
): FloorAnchor[] {
  const sourceX = from.corridorX ?? from.x,
    destinationX = to.corridorX ?? to.x;
  return [
    from,
    { x: sourceX, y: from.y },
    { x: sourceX, y: corridorY },
    { x: destinationX, y: corridorY },
    { x: destinationX, y: to.y },
    to,
  ].filter(
    (point, index, all) =>
      index === 0 ||
      point.x !== all[index - 1].x ||
      point.y !== all[index - 1].y,
  );
}
export function floorJourneyPath(
  journey: FloorJourney,
  anchors: Map<string, FloorAnchor>,
  corridorY: number,
): string | null {
  const points: FloorAnchor[] = [];
  for (const move of journey.moves) {
    const from = anchors.get(move.from),
      to = anchors.get(move.to);
    if (!from || !to) return null;
    const route = corridorRoute(from, to, corridorY);
    points.push(...(points.length ? route.slice(1) : route));
  }
  return points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
    )
    .join(" ");
}
