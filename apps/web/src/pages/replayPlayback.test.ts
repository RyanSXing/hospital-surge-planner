import { describe, expect, it, vi } from "vitest";
import { floorRecordedTime } from "./floorPlanTransitModel";
import {
  advancePlaybackClock,
  createPlaybackBuffer,
  createPlaybackProjection,
  preparePlaybackWindow,
  playbackTimestamp,
  type ReplayPlaybackWindow,
} from "./replayPlayback";

const start = Date.parse("2026-10-16T05:00:00Z");
const hour = 3600000;
const at = (ms: number) => new Date(ms).toISOString();
function packet(from = start, to = start + 4 * hour): ReplayPlaybackWindow {
  const aggregates = {
    patient_total: 0,
    patient_counts: { by_facility: { MAIN: 0 } },
    queue_counts: { MAIN: { ed: 0, total: 0 } },
    blocker_counts_by_unit: {},
    flow_counts: { MAIN: { discharges: 0 } },
    patient_groups: [],
  };
  return {
    replication_id: "REP1",
    start_at: at(from),
    end_at: at(to),
    complete: true,
    initial_state: {
      at: at(from),
      replication_id: "REP1",
      units: [{ unit_id: "WARD", occupied: 0, available: 1 }],
      slots: [{ slot_id: "BED1", unit_id: "WARD", status: "ready" }],
      ...aggregates,
    },
    frames: [
      {
        at: at(to),
        elapsed_minutes: (to - start) / 60000,
        units: [],
        slots: [],
        aggregates,
      },
    ],
    events: [],
  };
}
const prepare = (value: ReplayPlaybackWindow) =>
  preparePlaybackWindow(value, {
    replication: "REP1",
    startMs: Date.parse(value.start_at),
    endMs: Date.parse(value.end_at),
    runStartMs: start,
  });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("continuous exact replay", () => {
  it("preserves a fractional recorded moment when pausing instead of seeking before its last bed change", () => {
    const exact = start + hour + 0.5;
    expect(playbackTimestamp(exact)).toBe("2026-10-16T06:00:00.000500Z");
    expect(playbackTimestamp(start + hour + 1)).toBe(
      "2026-10-16T06:00:00.001000Z",
    );
  });
  it("advances repeatedly inside a window without snapping to hourly or daily boundaries", () => {
    let cursor = start;
    const readings: number[] = [];
    for (let i = 0; i < 120; i++) {
      cursor = advancePlaybackClock(
        cursor,
        1000 / 60,
        4,
        start + 8 * hour,
        start + 48 * hour,
      ).atMs;
      readings.push(cursor);
    }
    expect(
      readings.every((value, index) => !index || value > readings[index - 1]),
    ).toBe(true);
    expect(readings[29]).toBeCloseTo(start + 2 * hour, 1);
    expect(cursor).toBeCloseTo(start + 8 * hour, 1);
    const overnight = advancePlaybackClock(
      start + 23.9 * hour,
      50,
      4,
      start + 28 * hour,
      start + 48 * hour,
    );
    expect(overnight.atMs).toBeCloseTo(start + 24.1 * hour, 1);
  });
  it("holds at unavailable evidence and resumes without catching up a network stall as a time jump", () => {
    const held = advancePlaybackClock(
      start + hour,
      500,
      4,
      start + hour,
      start + 48 * hour,
    );
    expect(held).toEqual({ atMs: start + hour, buffering: true, ended: false });
    const resumed = advancePlaybackClock(
      held.atMs,
      16,
      4,
      start + 8 * hour,
      start + 48 * hour,
    );
    expect(resumed.atMs).toBe(start + hour + 230400);
    expect(resumed.buffering).toBe(false);
    expect(
      advancePlaybackClock(
        start + 47.9 * hour,
        1000,
        16,
        start + 48 * hour,
        start + 48 * hour,
      ),
    ).toEqual({ atMs: start + 48 * hour, buffering: false, ended: true });
  });
  it("changes beds, capacity, pressure and counters only at their exact recorded boundary", () => {
    const data = packet();
    data.frames.unshift({
      at: at(start + hour),
      elapsed_minutes: 60,
      slots: [
        {
          slot_id: "BED1",
          unit_id: "WARD",
          status: "occupied",
          patient_id: "P1",
        },
      ],
      units: [{ unit_id: "WARD", occupied: 1, available: 0, staffed: 1 }],
      aggregates: {
        ...data.frames[0].aggregates,
        patient_total: 1,
        flow_counts: null,
        blocker_counts_by_unit: { WARD: { qualified_staff: 1 } },
      },
    });
    const projector = createPlaybackProjection(prepare(data));
    expect(projector.at(start + hour - 1).state.slots[0].status).toBe("ready");
    const occupied = projector.at(start + hour);
    expect(occupied.state.slots[0]).toMatchObject({
      status: "occupied",
      patient_id: "P1",
    });
    expect(occupied.state.units[0]).toMatchObject({
      occupied: 1,
      available: 0,
      staffed: 1,
    });
    expect(occupied.state.flow_counts).toBeNull();
    expect(projector.at(start + 2 * hour).state).toBe(occupied.state);
    expect(projector.at(start + hour - 1).state.slots[0].status).toBe("ready");
    expect(data.initial_state.slots[0].status).toBe("ready");
  });
  it("uses exact elapsed minutes instead of applying a fractional timestamp early after Date.parse truncation", () => {
    const data = packet();
    const exact = start + hour + 0.5;
    data.frames.unshift({
      at: at(exact),
      elapsed_minutes: (exact - start) / 60000,
      slots: [{ slot_id: "BED1", status: "occupied" }],
      units: [],
      aggregates: data.frames[0].aggregates,
    });
    const projector = createPlaybackProjection(prepare(data));
    expect(projector.at(start + hour).state.slots[0].status).toBe("ready");
    expect(projector.at(exact).state.slots[0].status).toBe("occupied");
  });
  it("rejects wrong runs, incomplete windows, missing end coverage and out-of-order changes", () => {
    for (const altered of [
      { ...packet(), complete: false },
      { ...packet(), replication_id: "OLD" },
      {
        ...packet(),
        initial_state: { ...packet().initial_state, replication_id: "OLD" },
      },
      { ...packet(), frames: [] },
      {
        ...packet(),
        frames: [{ ...packet().frames[0], elapsed_minutes: 241 }],
      },
    ])
      expect(() => prepare(altered as ReplayPlaybackWindow)).toThrow();
    expect(() =>
      preparePlaybackWindow(packet(), {
        replication: "REP1",
        startMs: start + 1,
        endMs: start + 4 * hour,
        runStartMs: start,
      }),
    ).toThrow();
  });
});

describe("bounded replay runway", () => {
  it("never fetches before a fractional frozen branch origin or shifts its changes earlier", async () => {
    const origin = start + 0.5,
      change = origin + hour,
      failure = vi.fn(),
      requested: string[] = [];
    const buffer = createPlaybackBuffer({
      replication: "REP1",
      runStartMs: origin,
      startMs: origin,
      endMs: origin + 4 * hour,
      load: async (a, b) => {
        requested.push(a);
        const data = packet(floorRecordedTime(a), floorRecordedTime(b));
        data.start_at = a;
        data.end_at = b;
        data.initial_state.at = a;
        data.frames = [
          {
            at: playbackTimestamp(change),
            elapsed_minutes: 60,
            slots: [{ slot_id: "BED1", status: "occupied" }],
            units: [],
            aggregates: data.frames[0].aggregates,
          },
          {
            ...data.frames[0],
            at: b,
            elapsed_minutes: (floorRecordedTime(b) - origin) / 60000,
          },
        ];
        return data;
      },
      changed: () => {},
      failure,
    });
    buffer.start();
    await flush();
    expect(failure).not.toHaveBeenCalled();
    expect(floorRecordedTime(requested[0])).toBe(origin);
    const projection = createPlaybackProjection(buffer.windows()[0]);
    expect(projection.at(start + hour).state.slots[0].status).toBe("ready");
    expect(projection.at(change).state.slots[0].status).toBe("occupied");
    buffer.cancel();
  });
  it("buffers the containing millisecond after a speed restart without rejecting a fractional video clock", async () => {
    const from = start + hour + 0.375;
    const requests: number[] = [],
      failure = vi.fn();
    const buffer = createPlaybackBuffer({
      replication: "REP1",
      runStartMs: start,
      startMs: from,
      endMs: start + 8 * hour,
      load: async (a, b) => {
        requests.push(Date.parse(a));
        return packet(Date.parse(a), Date.parse(b));
      },
      changed: () => {},
      failure,
    });
    buffer.start();
    buffer.advance(from);
    await flush();
    expect(requests[0]).toBe(Math.floor(from));
    expect(buffer.runway()).toBeGreaterThan(from);
    expect(failure).not.toHaveBeenCalled();
    expect(
      createPlaybackProjection(buffer.windows()[0]).at(from).state.at,
    ).toBe(at(Math.floor(from)));
    buffer.cancel();
  });
  it("prefetches a bounded contiguous runway with at most two requests in flight", async () => {
    const requests: Array<{
      from: number;
      to: number;
      resolve: (value: ReplayPlaybackWindow) => void;
    }> = [];
    const changed = vi.fn(),
      failure = vi.fn();
    const buffer = createPlaybackBuffer({
      replication: "REP1",
      runStartMs: start,
      startMs: start,
      endMs: start + 48 * hour,
      lookAhead: 3,
      load: (from, to) =>
        new Promise((resolve) =>
          requests.push({
            from: Date.parse(from),
            to: Date.parse(to),
            resolve,
          }),
        ),
      changed,
      failure,
    });
    buffer.start();
    expect(requests).toHaveLength(2);
    expect(buffer.runway()).toBe(start);
    requests[1].resolve(packet(requests[1].from, requests[1].to));
    await flush();
    expect(buffer.runway()).toBe(start);
    requests[0].resolve(packet(requests[0].from, requests[0].to));
    await flush();
    expect(buffer.runway()).toBe(start + 8 * hour);
    expect(requests).toHaveLength(3);
    requests[2].resolve(packet(requests[2].from, requests[2].to));
    await flush();
    expect(buffer.windows()).toHaveLength(3);
    expect(requests).toHaveLength(3);
    buffer.advance(start + 4 * hour + 1);
    expect(requests).toHaveLength(4);
    expect(buffer.windows()).toHaveLength(2);
    expect(failure).not.toHaveBeenCalled();
    buffer.cancel();
  });
  it("ignores late responses after a seek/run cancellation and never publishes a stale window", async () => {
    let resolve!: (value: ReplayPlaybackWindow) => void;
    const changed = vi.fn(),
      failure = vi.fn();
    const buffer = createPlaybackBuffer({
      replication: "REP1",
      runStartMs: start,
      startMs: start,
      endMs: start + 4 * hour,
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
      changed,
      failure,
    });
    buffer.start();
    buffer.cancel();
    resolve(packet());
    await flush();
    expect(buffer.windows()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
  it("reduces over-budget windows without unbounded recursive request fan-out or overlapping spans", async () => {
    const requests: Array<[number, number]> = [];
    const failure = vi.fn();
    const buffer = createPlaybackBuffer({
      replication: "REP1",
      runStartMs: start,
      startMs: start,
      endMs: start + 8 * hour,
      lookAhead: 3,
      load: async (from, to) => {
        const a = Date.parse(from),
          b = Date.parse(to);
        requests.push([a, b]);
        if (b - a > 2 * hour)
          throw Object.assign(new Error("dense"), {
            code: "playback_window_too_large",
          });
        return packet(a, b);
      },
      changed: () => {},
      failure,
    });
    buffer.start();
    await flush();
    await flush();
    const windows = buffer.windows();
    expect(windows.length).toBeLessThanOrEqual(3);
    expect(buffer.runway()).toBeGreaterThanOrEqual(start + 4 * hour);
    expect(
      windows.every(
        (window, index) => !index || window.startMs >= windows[index - 1].endMs,
      ),
    ).toBe(true);
    expect(failure).not.toHaveBeenCalled();
    buffer.cancel();
  });
  it("stops a failed unsupported session instead of retrying or fabricating empty states", async () => {
    const load = vi.fn(async () => {
        throw new Error("missing history");
      }),
      failure = vi.fn();
    const buffer = createPlaybackBuffer({
      replication: "REP1",
      runStartMs: start,
      startMs: start,
      endMs: start + 24 * hour,
      load,
      changed: () => {},
      failure,
    });
    buffer.start();
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(buffer.windows()).toEqual([]);
  });
});
