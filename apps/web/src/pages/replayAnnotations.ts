import type { Entity } from "../types";

/** Match the engine's curve domain, which takes precedence over step-window fields. */
export function conditionReplayInterval(
  condition: Entity,
  runStart: string,
  runEnd: string,
): Entity {
  const points: Entity[] = [...(condition.control_points || [])]
    .filter((point) => Number.isFinite(Date.parse(point.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const isCurve = condition.kind === "arrival_multiplier" && points.length >= 2;
  const defaultWave =
    condition.kind === "arrival_multiplier" &&
    condition.shape === "wave" &&
    !points.length;
  return {
    ...condition,
    start_at: isCurve
      ? points[0].at
      : defaultWave
        ? runStart
        : condition.start_at || condition.at || runStart,
    end_at: isCurve
      ? points.at(-1)!.at
      : defaultWave
        ? runEnd
        : condition.end_at || condition.at || runEnd,
  };
}
