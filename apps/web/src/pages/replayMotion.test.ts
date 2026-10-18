import { describe, expect, it } from "vitest";
import {
  prepareReplayMotion,
  replayFramePoint,
  replayMotionProgress,
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
    const motion = prepareReplayMotion(input);
    const rerender = prepareReplayMotion({
      ...input,
      previous: motion,
      origins: new Map([["patient-a", { x: 200, y: 150 }]]),
      now: 1200,
    });
    expect(rerender.startedAt).toBe(1000);
    expect(rerender.fromAt).toBe(0);
    expect(rerender.origins).toBe(old);
    expect(rerender.entering).toBe(motion.entering);
    expect(replayMotionProgress(rerender, 1500)).toBe(0.5);
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
});
