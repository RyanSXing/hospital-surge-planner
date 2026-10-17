import { describe, expect, it } from "vitest";
import { conditionReplayInterval } from "./replayAnnotations";

describe("recorded condition bands", () => {
  const start = "2026-10-16T05:00:00Z";
  const end = "2026-10-19T05:00:00Z";
  it("limits a control-point-only arrival curve to its actual domain", () => {
    const curve = conditionReplayInterval(
      {
        kind: "arrival_multiplier",
        control_points: [
          { at: "2026-10-17T05:00:00Z", multiplier: 1.2 },
          { at: "2026-10-17T17:00:00Z", multiplier: 1.7 },
          { at: "2026-10-18T05:00:00Z", multiplier: 1.2 },
        ],
      },
      start,
      end,
    );
    expect(curve.start_at).toBe("2026-10-17T05:00:00Z");
    expect(curve.end_at).toBe("2026-10-18T05:00:00Z");
    const duration = Date.parse(end) - Date.parse(start);
    const left = (Date.parse(curve.start_at) - Date.parse(start)) / duration;
    const width =
      (Date.parse(curve.end_at) - Date.parse(curve.start_at)) / duration;
    expect(left).toBeCloseTo(1 / 3);
    expect(width).toBeCloseTo(1 / 3);
  });
  it("uses the engine's curve domain even when step-window fields are also present", () => {
    expect(
      conditionReplayInterval(
        {
          kind: "arrival_multiplier",
          start_at: start,
          end_at: end,
          control_points: [
            { at: "2026-10-17T05:00:00Z", multiplier: 1.2 },
            { at: "2026-10-18T05:00:00Z", multiplier: 1.7 },
          ],
        },
        start,
        end,
      ),
    ).toMatchObject({
      start_at: "2026-10-17T05:00:00Z",
      end_at: "2026-10-18T05:00:00Z",
    });
  });
  it("retains explicit windows and point events for non-curve conditions", () => {
    expect(
      conditionReplayInterval({ kind: "arrival_multiplier" }, start, end),
    ).toMatchObject({ start_at: start, end_at: end });
    expect(
      conditionReplayInterval(
        {
          kind: "arrival_multiplier",
          shape: "wave",
          start_at: "2026-10-17T05:00:00Z",
        },
        start,
        end,
      ),
    ).toMatchObject({ start_at: start, end_at: end });
    expect(conditionReplayInterval({ at: start }, start, end)).toMatchObject({
      start_at: start,
      end_at: start,
    });
    expect(
      conditionReplayInterval(
        {
          start_at: start,
          end_at: end,
          control_points: [{ at: "2026-10-17T05:00:00Z" }],
        },
        start,
        end,
      ),
    ).toMatchObject({ start_at: start, end_at: end });
  });
});
