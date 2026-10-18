import type { Entity } from "../types";

/** A single percentage or preset cannot describe an independently edited day. */
export function usesCustomArrivalSchedule(
  conditions: Entity[],
  stream: string,
  selectedShape: string,
) {
  const windows = conditions.filter(
    (condition) =>
      condition.kind === "arrival_multiplier" &&
      (condition.entry_stream_id || "ED_MAIN") === stream,
  );
  return (
    selectedShape === "custom" ||
    windows.length > 1 ||
    windows.some((condition) => {
      if (String(condition.id || "").startsWith("arrival-edit-")) return true;
      const points: Entity[] = condition.control_points || [];
      if (condition.shape === "piecewise_linear" && points.length >= 2)
        return !(
          (points.length === 2 && points[0].multiplier === 1) ||
          (points.length === 3 &&
            points[0].multiplier === 1 &&
            points[2].multiplier === 1)
        );
      return (
        points.length > 2 &&
        new Set(points.slice(0, -1).map((point) => point.multiplier)).size > 1
      );
    })
  );
}
