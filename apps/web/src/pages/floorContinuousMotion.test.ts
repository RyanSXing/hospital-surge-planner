import { describe, expect, it } from "vitest";
import {
  createContinuousFloorMotion,
  floorPathLength,
} from "./floorContinuousMotion";
import { floorRecordedTime, type FloorJourney } from "./floorPlanTransitModel";

const start = Date.parse("2026-10-16T05:00:00Z"),
  hour = 3600000;
const move = (from: string, to: string, hourAt: number, eventId: string) => ({
  from,
  to,
  at: new Date(start + hourAt * hour).toISOString(),
  eventId,
});
const anchors: Record<string, [number, number]> = {
  entrance: [0, 0],
  ED: [100, 0],
  WARD: [100, 100],
  ICU: [200, 100],
  discharge: [300, 100],
};
const pathFor = (journey: FloorJourney) => {
  const points: string[] = [];
  for (const [index, move] of journey.moves.entries()) {
    if (index && move.from !== journey.moves[index - 1].to) return null;
    const a = anchors[move.from],
      b = anchors[move.to];
    if (!a || !b) return null;
    if (!index) points.push(`M${a[0]},${a[1]}`);
    points.push(`L${b[0]},${a[1]} L${b[0]},${b[1]}`);
  }
  return points.join(" ");
};
describe("persistent recorded corridor traffic", () => {
  it("waits for a real recorded transition, never drawing future patient traffic", () => {
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    scheduler.observe([
      { patientId: "P1", moves: [move("entrance", "ED", 1, "arrive")] },
    ]);
    expect(scheduler.tick(start + hour - 1, 0)).toEqual([]);
    const first = scheduler.tick(start + hour, 0);
    expect(first).toHaveLength(1);
    expect(scheduler.tick(start + hour + 1, 100)).toBe(first);
    expect(first[0].journey.moves[0].eventId).toBe("arrive");
  });
  it("retains a running head across data/chunk loads instead of restarting a batch", () => {
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    const first = {
      patientId: "P1",
      moves: [move("entrance", "ED", 3.99, "enter")],
    };
    scheduler.observe([first]);
    const running = scheduler.tick(start + 3.99 * hour, 100);
    scheduler.observe([
      first,
      { patientId: "P2", moves: [move("ED", "WARD", 4.2, "later")] },
    ]);
    expect(scheduler.tick(start + 4 * hour, 200)).toBe(running);
    expect(scheduler.tick(start + 4 * hour, 200)[0]).toBe(running[0]);
  });
  it("extends a patient's actual contiguous route from the current head distance with no clone or teleport", () => {
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    const first = move("entrance", "ED", 1, "one"),
      second = move("ED", "WARD", 1.1, "two");
    scheduler.observe([{ patientId: "P1", moves: [first, second] }]);
    const running = scheduler.tick(start + hour, 0)[0];
    const extended = scheduler.tick(start + 1.1 * hour, 200);
    expect(extended).toHaveLength(1);
    expect(extended[0].continued).toBe(true);
    expect(extended[0].path.startsWith(running.path)).toBe(true);
    expect(extended[0].length * extended[0].startFraction).toBeCloseTo(
      (running.length * 200) / running.durationMs,
      7,
    );
    expect(extended[0].journey.moves.map((move) => move.eventId)).toEqual([
      "one",
      "two",
    ]);
  });
  it("never joins a missing physical leg between disjoint recorded phases", () => {
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    scheduler.observe([
      { patientId: "P1", moves: [move("entrance", "ED", 1, "one")] },
      { patientId: "P1", moves: [move("ICU", "discharge", 1.1, "two")] },
    ]);
    const first = scheduler.tick(start + 2 * hour, 0);
    expect(first[0].journey.moves.map((move) => move.eventId)).toEqual(["one"]);
    const next = scheduler.tick(start + 2 * hour, 1200);
    expect(next[0].journey.moves.map((move) => move.eventId)).toEqual(["two"]);
    expect(next[0].path.startsWith("M200,100")).toBe(true);
  });
  it("clears old movement on a seek/resize and cannot replay consumed evidence", () => {
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    const journeys = [
      { patientId: "P1", moves: [move("entrance", "ED", 1, "one")] },
      { patientId: "P2", moves: [move("ED", "WARD", 2, "two")] },
    ];
    scheduler.observe(journeys);
    expect(scheduler.tick(start + hour, 0)).toHaveLength(1);
    expect(scheduler.clear(start + 1.5 * hour)).toEqual([]);
    scheduler.observe(journeys);
    expect(scheduler.tick(start + 1.5 * hour, 100)).toEqual([]);
    expect(scheduler.tick(start + 2 * hour, 200)[0].journey.patientId).toBe(
      "P2",
    );
  });
  it("routes later recorded movement through the newly measured corridor after a resize", () => {
    let shifted = false;
    const scheduler = createContinuousFloorMotion({
      startMs: start,
      pathFor: () => (shifted ? "M200,200 L200,300" : "M100,100 L100,200"),
    });
    scheduler.observe([
      { patientId: "P1", moves: [move("ED", "WARD", 1, "old")] },
      { patientId: "P2", moves: [move("ED", "WARD", 2, "new")] },
    ]);
    expect(scheduler.tick(start + hour, 0)[0].path).toBe("M100,100 L100,200");
    scheduler.clear(start + hour);
    shifted = true;
    const next = scheduler.tick(start + 2 * hour, 200);
    expect(next).toHaveLength(1);
    expect(next[0].path).toBe("M200,200 L200,300");
    expect(next[0].journey.moves[0].eventId).toBe("new");
  });
  it("keeps at most12 moving heads and only one per patient under dense recorded traffic", () => {
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    scheduler.observe(
      Array.from({ length: 100 }, (_, index) => ({
        patientId: `P${index}`,
        moves: [move("entrance", "ED", 1, `event-${index}`)],
      })),
    );
    const routes = scheduler.tick(start + hour, 0);
    expect(routes).toHaveLength(12);
    expect(new Set(routes.map((route) => route.journey.patientId)).size).toBe(
      12,
    );
    expect(scheduler.tick(start + hour, 2000).length).toBeLessThanOrEqual(12);
  });
  it("preserves fractional event timing and corridor path distance", () => {
    const fractional = "2026-10-16T06:00:00.000500Z";
    expect(floorRecordedTime(fractional)).toBe(start + hour + 0.5);
    const scheduler = createContinuousFloorMotion({ startMs: start, pathFor });
    scheduler.observe([
      {
        patientId: "P1",
        moves: [
          { from: "ED", to: "WARD", at: fractional, eventId: "fractional" },
        ],
      },
    ]);
    expect(scheduler.tick(start + hour, 0)).toEqual([]);
    expect(scheduler.tick(start + hour + 0.5, 1)).toHaveLength(1);
    expect(floorPathLength("M0,0 L0,100 L200,100")).toBe(300);
  });
});
