import {
  floorRecordedTime,
  type FloorJourney,
  type FloorMove,
} from "./floorPlanTransitModel";

export interface ContinuousFloorRoute {
  journey: FloorJourney;
  path: string;
  length: number;
  startFraction: number;
  startedWallMs: number;
  durationMs: number;
  delayMs: number;
  continued: boolean;
}
export function floorPathLength(path: string): number {
  const points = [...path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
  return points.reduce(
    (length, point, index) =>
      index
        ? length +
          Math.hypot(
            point.x - points[index - 1].x,
            point.y - points[index - 1].y,
          )
        : 0,
    0,
  );
}
const progress = (route: ContinuousFloorRoute, wallMs: number) =>
  route.startFraction +
  (1 - route.startFraction) *
    Math.min(1, Math.max(0, (wallMs - route.startedWallMs) / route.durationMs));

/** Append only a recorded contiguous move, retaining the moving head's distance. */
export function extendContinuousFloorRoute(
  route: ContinuousFloorRoute,
  moves: FloorMove[],
  path: string,
  wallMs: number,
): ContinuousFloorRoute | null {
  if (!moves.length || route.journey.moves.at(-1)?.to !== moves[0].from)
    return null;
  const tail = path.replace(/^M-?[\d.]+,-?[\d.]+\s*/, "");
  const length = route.length + floorPathLength(path);
  if (!length) return null;
  const startFraction = (route.length * progress(route, wallMs)) / length;
  return {
    journey: {
      patientId: route.journey.patientId,
      moves: [...route.journey.moves, ...moves],
    },
    path: `${route.path} ${tail}`,
    length,
    startFraction,
    startedWallMs: wallMs,
    durationMs: Math.min(
      1100,
      Math.max(350, (1 - startFraction) * length * 1.2),
    ),
    delayMs: 0,
    continued: true,
  };
}

/** Sampled recorded traffic runs independently of chunk loads and state commits. */
export function createContinuousFloorMotion({
  startMs,
  pathFor,
  maximum = 12,
}: {
  startMs: number;
  pathFor: (journey: FloorJourney) => string | null;
  maximum?: number;
}) {
  let cutoff = startMs;
  let candidates: Array<{ patientId: string; move: FloorMove; atMs: number }> =
    [];
  const seen = new Set<string>(),
    active = new Map<string, ContinuousFloorRoute>(),
    pending = new Map<string, FloorMove[][]>();
  let published: ContinuousFloorRoute[] = [];
  function clear(atMs: number) {
    cutoff = atMs;
    active.clear();
    pending.clear();
    published = [];
    return published;
  }
  return {
    observe(journeys: FloorJourney[]) {
      candidates = journeys
        .flatMap((journey) =>
          journey.moves.map((move) => ({
            patientId: journey.patientId,
            move,
            atMs: floorRecordedTime(move.at),
          })),
        )
        .sort(
          (a, b) =>
            a.atMs - b.atMs || a.move.eventId.localeCompare(b.move.eventId),
        );
      const ids = new Set(candidates.map(({ move }) => move.eventId));
      for (const id of seen) if (!ids.has(id)) seen.delete(id);
    },
    clear,
    tick(atMs: number, wallMs: number) {
      let changed = false;
      for (const [id, route] of active)
        if (wallMs >= route.startedWallMs + route.durationMs) {
          active.delete(id);
          changed = true;
        }
      const due = new Map<string, FloorMove[]>();
      for (const candidate of candidates) {
        if (
          candidate.atMs <= cutoff ||
          candidate.atMs > atMs ||
          seen.has(candidate.move.eventId)
        )
          continue;
        seen.add(candidate.move.eventId);
        due.set(candidate.patientId, [
          ...(due.get(candidate.patientId) || []),
          candidate.move,
        ]);
      }
      for (const [id, moves] of due) {
        const chunks: FloorMove[][] = [];
        for (const move of moves) {
          const last = chunks.at(-1);
          if (last?.at(-1)?.to === move.from) last.push(move);
          else chunks.push([move]);
        }
        for (const chunk of chunks) {
          const existing = active.get(id),
            path = pathFor({ patientId: id, moves: chunk });
          if (!path) continue;
          const continued =
            existing &&
            !pending.has(id) &&
            existing.journey.moves.length + chunk.length <= 32
              ? extendContinuousFloorRoute(existing, chunk, path, wallMs)
              : null;
          if (continued) {
            active.set(id, continued);
            changed = true;
          } else {
            const queued = pending.get(id) || [];
            const last = queued.at(-1);
            if (
              last?.at(-1)?.to === chunk[0].from &&
              last.length + chunk.length <= 32
            )
              last.push(...chunk);
            else queued.push(chunk);
            pending.set(id, queued.slice(-32));
          }
        }
      }
      // At most one marker per patient, with a bounded visual sample queue.
      for (const [id, chunks] of pending) {
        if (active.has(id)) continue;
        if (active.size >= maximum) break;
        const journey = { patientId: id, moves: chunks[0] },
          path = pathFor(journey);
        if (chunks.length > 1) pending.set(id, chunks.slice(1));
        else pending.delete(id);
        if (!path) continue;
        const length = floorPathLength(path);
        active.set(id, {
          journey,
          path,
          length,
          startFraction: 0,
          startedWallMs: wallMs,
          durationMs: Math.min(1000, Math.max(450, length * 1.2)),
          delayMs: 0,
          continued: false,
        });
        changed = true;
      }
      while (pending.size > maximum * 2)
        pending.delete(pending.keys().next().value!);
      if (changed) published = [...active.values()];
      return published;
    },
  };
}
