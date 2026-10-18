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
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!maximum) return [];
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
        Number(a.sequence_number || 0) - Number(b.sequence_number || 0) ||
        String(a.patient_id).localeCompare(String(b.patient_id)) ||
        String(a.event_id || "").localeCompare(String(b.event_id || "")),
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
  return sampleRecordedFloorJourneys(
    [...chains.values()],
    new Set(unitIds),
    maximum,
  );
}

/**
 * A visual sample must show the recorded routes that exist, including rare
 * wards and discharges. Chronological strides alone can omit an entire unit.
 * Counts still come from the full saved state; this is not a proportional flow
 * estimate. Each patient contributes at most one continuous recorded chain.
 */
function sampleRecordedFloorJourneys(
  patients: FloorJourney[][],
  unitIds: Set<string>,
  maximum: number,
): FloorJourney[] {
  const candidates = patients.flat().map((journey) => {
    const locations = new Set(
      journey.moves.flatMap((move) => [move.from, move.to]),
    );
    return {
      journey,
      features: [
        new Set([...locations].filter((id) => unitIds.has(id))),
        new Set([...locations].filter((id) => !unitIds.has(id))),
        new Set(
          journey.moves.map((move) => JSON.stringify([move.from, move.to])),
        ),
      ],
    };
  });
  const frequencies = [0, 1, 2].map((group) => {
    const holders = new Map<string, Set<string>>();
    for (const candidate of candidates)
      for (const key of candidate.features[group]) {
        if (!holders.has(key)) holders.set(key, new Set());
        holders.get(key)!.add(candidate.journey.patientId);
      }
    return new Map([...holders].map(([key, ids]) => [key, ids.size]));
  });
  const covered = [new Set<string>(), new Set<string>(), new Set<string>()],
    usedPatients = new Set<string>(),
    selected: FloorJourney[] = [];
  const add = (candidate: (typeof candidates)[number]) => {
    selected.push(candidate.journey);
    usedPatients.add(candidate.journey.patientId);
    candidate.features.forEach((features, group) => {
      for (const key of features) covered[group].add(key);
    });
  };
  while (selected.length < maximum) {
    let best: (typeof candidates)[number] | null = null;
    let bestScore = [0, 0, 0];
    for (const candidate of candidates) {
      if (usedPatients.has(candidate.journey.patientId)) continue;
      const score = candidate.features.map((features, group) =>
        [...features].reduce(
          (sum, key) =>
            sum +
            (covered[group].has(key) ? 0 : 1 / frequencies[group].get(key)!),
          0,
        ),
      );
      // Unit coverage comes first, followed by waiting/exit areas and directed
      // routes. Rarity breaks the dominance of the busiest unit without
      // inventing any movement to a quiet unit.
      const difference = score.findIndex(
        (value, index) => Math.abs(value - bestScore[index]) > 1e-12,
      );
      if (difference !== -1 && score[difference] > bestScore[difference]) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    add(best);
  }
  // Fill the remaining budget across recorded time after route coverage, using
  // a patient's longest actual continuous chain and never joining missing legs.
  const remaining = patients
    .filter((chunks) => !usedPatients.has(chunks[0].patientId))
    .map(
      (chunks) =>
        [...chunks].sort((a, b) => b.moves.length - a.moves.length)[0],
    );
  const spaces = Math.min(maximum - selected.length, remaining.length);
  for (let index = 0; index < spaces; index++)
    selected.push(remaining[Math.floor((index * remaining.length) / spaces)]);
  return selected.sort(
    (a, b) =>
      Date.parse(a.moves[0].at) - Date.parse(b.moves[0].at) ||
      a.patientId.localeCompare(b.patientId),
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
