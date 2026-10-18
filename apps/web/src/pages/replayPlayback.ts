import type { Entity } from "../types";
import { floorRecordedTime } from "./floorPlanTransitModel";

export interface ReplayPlaybackFrame {
  at: string;
  elapsed_minutes?: number;
  slots: Entity[];
  units: Entity[];
  aggregates: Entity;
}
export interface ReplayPlaybackWindow {
  replication_id: string;
  start_at: string;
  end_at: string;
  complete: true;
  initial_state: Entity;
  frames: ReplayPlaybackFrame[];
  events: Entity[];
  context?: Entity;
}
export interface PreparedPlaybackWindow {
  value: ReplayPlaybackWindow;
  startMs: number;
  endMs: number;
  frameTimes: number[];
}

/** Preserve the recorded sub-millisecond moment when handing the video clock
 * back to the exact-state API (whose timestamps support microseconds). */
export function playbackTimestamp(atMs: number): string {
  let whole = Math.floor(atMs);
  let micros = Math.round((atMs - whole) * 1000);
  if (micros === 1000) {
    whole += 1;
    micros = 0;
  }
  return new Date(whole)
    .toISOString()
    .replace(/Z$/, `${String(micros).padStart(3, "0")}Z`);
}

/** Validate a complete immutable window before letting its clock become visible. */
export function preparePlaybackWindow(
  value: ReplayPlaybackWindow,
  expected: {
    replication: string;
    startMs: number;
    endMs: number;
    runStartMs: number;
  },
): PreparedPlaybackWindow {
  const startMs = floorRecordedTime(value.start_at),
    endMs = floorRecordedTime(value.end_at);
  if (
    value.complete !== true ||
    value.replication_id !== expected.replication ||
    startMs !== expected.startMs ||
    endMs !== expected.endMs ||
    endMs <= startMs ||
    value.initial_state?.replication_id !== expected.replication ||
    floorRecordedTime(value.initial_state?.at) !== startMs ||
    !Array.isArray(value.initial_state?.units) ||
    !Array.isArray(value.initial_state?.slots) ||
    !Array.isArray(value.frames) ||
    !Array.isArray(value.events)
  )
    throw new Error(
      "The playback window does not match this saved run and time interval.",
    );
  const frameTimes = value.frames.map((frame) =>
    typeof frame.elapsed_minutes === "number" &&
    Number.isFinite(frame.elapsed_minutes)
      ? expected.runStartMs + frame.elapsed_minutes * 60000
      : floorRecordedTime(frame.at),
  );
  if (
    value.frames.some(
      (frame, index) =>
        !Number.isFinite(frameTimes[index]) ||
        frameTimes[index] <= startMs ||
        frameTimes[index] > endMs + 0.001 ||
        (index > 0 && frameTimes[index] < frameTimes[index - 1]) ||
        !Array.isArray(frame.units) ||
        !Array.isArray(frame.slots) ||
        !frame.aggregates ||
        Math.abs(Date.parse(frame.at) - frameTimes[index]) >= 1.1,
    )
  )
    throw new Error("The playback window contains an invalid recorded change.");
  if (!frameTimes.length || Math.abs(frameTimes.at(-1)! - endMs) > 0.001)
    throw new Error(
      "The playback window does not contain its exact end boundary.",
    );
  return { value, startMs, endMs, frameTimes };
}

/** Apply complete recorded replacements only; no interpolation of clinical state. */
export function createPlaybackProjection(window: PreparedPlaybackWindow) {
  let index = -1;
  let units = new Map<string, Entity>(),
    slots = new Map<string, Entity>();
  let state: Entity = window.value.initial_state;
  function reset() {
    index = -1;
    state = window.value.initial_state;
    units = new Map(
      state.units.map((row: Entity) => [row.unit_id || row.id, row]),
    );
    slots = new Map(
      state.slots.map((row: Entity) => [row.slot_id || row.id, row]),
    );
  }
  reset();
  return {
    at(ms: number) {
      if (ms < window.startMs || ms > window.endMs + 0.001)
        throw new Error(
          "Playback requested a state outside its recorded window.",
        );
      if (index >= 0 && ms < window.frameTimes[index]) reset();
      while (
        index + 1 < window.frameTimes.length &&
        window.frameTimes[index + 1] <= ms
      ) {
        const frame = window.value.frames[++index];
        for (const row of frame.units) units.set(row.unit_id || row.id, row);
        for (const row of frame.slots) slots.set(row.slot_id || row.id, row);
        state = {
          ...state,
          ...frame.aggregates,
          at: frame.at,
          elapsed_minutes: frame.elapsed_minutes,
          units: [...units.values()],
          slots: [...slots.values()],
        };
      }
      return {
        state,
        frameIndex: index,
        validUntilMs: window.frameTimes[index + 1] ?? window.endMs,
      };
    },
  };
}

/** A monotonic video clock advances only through already-buffered evidence. */
export function advancePlaybackClock(
  cursorMs: number,
  elapsedWallMs: number,
  hoursPerSecond: number,
  bufferedUntilMs: number,
  endMs: number,
) {
  if (
    ![cursorMs, elapsedWallMs, hoursPerSecond, bufferedUntilMs, endMs].every(
      Number.isFinite,
    ) ||
    hoursPerSecond <= 0
  )
    throw new Error("Invalid playback clock.");
  const target = cursorMs + Math.max(0, elapsedWallMs) * hoursPerSecond * 3600;
  const atMs = Math.max(cursorMs, Math.min(target, bufferedUntilMs, endMs));
  return {
    atMs,
    buffering: target > bufferedUntilMs && bufferedUntilMs < endMs,
    ended: atMs >= endMs,
  };
}

/** Keep a bounded contiguous runway. Late responses from a cancelled session are ignored. */
export function createPlaybackBuffer({
  replication,
  runStartMs,
  startMs,
  endMs,
  lookAhead = 4,
  load,
  changed,
  failure,
}: {
  replication: string;
  runStartMs: number;
  startMs: number;
  endMs: number;
  lookAhead?: number;
  load: (from: string, to: string) => Promise<ReplayPlaybackWindow>;
  changed: () => void;
  failure: (error: Error) => void;
}) {
  const chunkMs = 4 * 3600000;
  const maximum = Math.max(2, Math.min(12, Math.floor(lookAhead)));
  const windows = new Map<number, PreparedPlaybackWindow>();
  const pending = new Map<number, number>();
  let active = true,
    // ISO transport has millisecond precision. A speed change can retain the
    // sub-millisecond RAF cursor, so fetch the containing recorded millisecond
    // without moving the visible clock backwards.
    cursor = Math.max(runStartMs, Math.floor(startMs));
  async function boundedWindow(
    from: number,
    to: number,
  ): Promise<PreparedPlaybackWindow> {
    if (!active) throw new Error("Playback was cancelled.");
    try {
      const value = await load(playbackTimestamp(from), playbackTimestamp(to));
      return preparePlaybackWindow(value, {
        replication,
        startMs: from,
        endMs: to,
        runStartMs,
      });
    } catch (error) {
      if (
        active &&
        (error as { code?: string }).code === "playback_window_too_large" &&
        to - from > 60000
      )
        return boundedWindow(from, from + Math.floor((to - from) / 2));
      throw error;
    }
  }
  function request(from: number, to: number) {
    pending.set(from, to);
    void boundedWindow(from, to)
      .then((window) => {
        if (!active) return;
        windows.set(from, window);
        changed();
      })
      .catch((error) => {
        if (!active) return;
        active = false;
        failure(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (pending.get(from) === to) pending.delete(from);
        if (active) pump();
      });
  }
  function pump() {
    if (!active) return;
    for (const [from, window] of windows)
      if (window.endMs < cursor) windows.delete(from);
    while (windows.size + pending.size < maximum && pending.size < 2) {
      let next = cursor,
        boundary = endMs;
      const spans = [
        ...[...windows.values()].map((window) => [
          window.startMs,
          window.endMs,
        ]),
        ...pending.entries(),
      ].sort((a, b) => a[0] - b[0]);
      for (const [from, to] of spans) {
        if (from > next) {
          boundary = from;
          break;
        }
        if (to > next) next = to;
      }
      if (next >= endMs) break;
      request(next, Math.min(endMs, boundary, next + chunkMs));
    }
  }
  return {
    start: pump,
    advance(atMs: number) {
      cursor = atMs;
      pump();
    },
    windows() {
      return [...windows.values()].sort((a, b) => a.startMs - b.startMs);
    },
    runway() {
      let until = cursor;
      for (const window of [...windows.values()].sort(
        (a, b) => a.startMs - b.startMs,
      ))
        if (window.startMs <= until && window.endMs > until)
          until = window.endMs;
      return until;
    },
    cancel() {
      active = false;
      windows.clear();
      pending.clear();
    },
  };
}
