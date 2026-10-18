import { describe, expect, it } from "vitest";
import {
  prepareReplayMotion,
  replayFramePoint,
  replayMotionProgress,
  replayRouteIsVisible,
  replayRoutePoint,
  retainReplayRoute,
  type ReplayMotion,
} from "./replayMotion";
const old = new Map([["patient-a", { x: 100, y: 100 }]]);
const next = new Map([["patient-a", { x: 500, y: 300 }]]);
const previous: ReplayMotion = {
  rep: "rep1",
  at: 0,
  fromAt: 0,
  height: 620,
  points: old,
  origins: old,
  routes: new Map(),
  routeKeyframes: new Map(),
  entering: new Set(),
  startedAt: 0,
  duration: 0,
};
const input = {
  previous,
  rep: "rep1",
  at: 3600000,
  height: 620,
  points: next,
  origins: old,
  playing: true,
  reduced: false,
  now: 1000,
};
describe("recorded replay presentation", () => {
  it("moves stable IDs smoothly between exact endpoints", () => {
    const motion = prepareReplayMotion(input);
    expect(motion.duration).toBe(1000);
    expect(
      replayFramePoint(
        old.get("patient-a")!,
        next.get("patient-a")!,
        replayMotionProgress(motion, 1000),
      ),
    ).toEqual(old.get("patient-a"));
    expect(
      replayFramePoint(
        old.get("patient-a")!,
        next.get("patient-a")!,
        replayMotionProgress(motion, 1500),
      ),
    ).toEqual({ x: 300, y: 200 });
    expect(
      replayFramePoint(
        old.get("patient-a")!,
        next.get("patient-a")!,
        replayMotionProgress(motion, 2000),
      ),
    ).toEqual(next.get("patient-a"));
  });
  it("keeps the presentation clock continuous even when no patient changes zones", () => {
    const motion = prepareReplayMotion({ ...input, points: old });
    expect(motion.duration).toBe(1000);
    expect(motion.fromAt).toBe(0);
    expect(motion.at).toBe(3600000);
  });
  it("retains in-flight timing when patient inspection rerenders the same recorded instant", () => {
    const routes = new Map([
      [
        "patient-a",
        [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
        ],
      ],
    ]);
    const routeKeyframes = new Map([["patient-a", [0, 1]]]);
    const motion = prepareReplayMotion({ ...input, routes, routeKeyframes });
    const rerender = prepareReplayMotion({
      ...input,
      previous: motion,
      origins: new Map([["patient-a", { x: 200, y: 150 }]]),
      now: 1200,
    });
    expect(rerender.startedAt).toBe(1000);
    expect(rerender.fromAt).toBe(0);
    expect(rerender.origins).toBe(old);
    expect(rerender.routes).toBe(routes);
    expect(rerender.routeKeyframes).toBe(routeKeyframes);
    expect(rerender.entering).toBe(motion.entering);
    expect(replayMotionProgress(rerender, 1500)).toBe(0.5);
    const rebuiltRoutes = new Map([
      [
        "patient-a",
        [
          { x: 100, y: 100 },
          { x: 999, y: 999 },
        ],
      ],
    ]);
    expect(
      prepareReplayMotion({
        ...input,
        previous: motion,
        routes: rebuiltRoutes,
        routeKeyframes: new Map([["patient-a", [0, 1]]]),
      }).routes,
    ).toBe(routes);
  });
  it("snaps on pause, reduced motion, manual backward seeks, replication changes and resized geometry", () => {
    for (const change of [
      { playing: false },
      { reduced: true },
      { at: -1000 },
      { rep: "rep2" },
      { height: 500 },
    ]) {
      const motion = prepareReplayMotion({ ...input, ...change });
      expect(motion.duration).toBe(0);
      expect(motion.origins).toBe(next);
    }
  });
  it("continues its visible clock when a sample boundary lands between screen frames", () => {
    const motion = prepareReplayMotion({ ...input, originAt: 3599900 });
    expect(motion.fromAt).toBe(3599900);
    expect(motion.at).toBe(3600000);
  });
  it("uses the actually drawn point as origin when a new recorded state interrupts movement", () => {
    const drawn = new Map([["patient-a", { x: 300, y: 200 }]]);
    const motion = prepareReplayMotion({
      ...input,
      previous: prepareReplayMotion(input),
      at: 7200000,
      now: 1600,
      origins: drawn,
    });
    expect(motion.origins).toBe(drawn);
    expect(replayMotionProgress(motion, 1600)).toBe(0);
  });
  it("visits every recorded intermediate stage instead of cutting diagonally across care zones", () => {
    const route = [
      { x: 20, y: 20 },
      { x: 100, y: 20 },
      { x: 100, y: 100 },
      { x: 180, y: 100 },
    ];
    expect(replayRoutePoint(route, 0)).toEqual(route[0]);
    expect(replayRoutePoint(route, 1 / 3)).toEqual(route[1]);
    expect(replayRoutePoint(route, 2 / 3)).toEqual(route[2]);
    expect(replayRoutePoint(route, 1)).toEqual(route[3]);
  });
  it("holds a patient in the recorded source until a late transition", () => {
    const ed = { x: 100, y: 100 };
    const corridor = { x: 220, y: 100 };
    const ward = { x: 300, y: 60 };
    const points = [ed, ed, corridor, ward];
    const frames = [0, 0.7, 0.725, 0.75];
    expect(replayRoutePoint(points, 0.69, frames)).toEqual(ed);
    expect(replayRoutePoint(points, 0.75, frames)).toEqual(ward);
    expect(replayRoutePoint(points, 0.8, frames)).toEqual(ward);
  });
  it("keeps a persistent late arrival off screen until its recorded arrival", () => {
    expect(replayRouteIsVisible([0.75, 1], 0.74)).toBe(false);
    expect(replayRouteIsVisible([0.75, 1], 0.75)).toBe(true);
    expect(replayRouteIsVisible([1], 0.999)).toBe(false);
    expect(retainReplayRoute(1, 1)).toBe(true);
  });
  it("applies same-timestamp trace events through their final sequence state", () => {
    const points = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
    ];
    expect(replayRoutePoint(points, 0, [0, 0, 0])).toEqual(points[2]);
  });
});
