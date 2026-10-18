import type { Entity } from "../types";
import {
  normalizedArrivalCurve,
  plannedArrivals,
} from "./plannedArrivalSeries";
import type {
  ArrivalCurvePoint,
  ArrivalPreviewOptions,
} from "./plannedArrivalSeries";

export interface ArrivalDayEdit {
  conditions: Entity[];
  conditionId: string;
  planned: number;
  minimum: number;
}

function valueAt(
  points: ArrivalCurvePoint[],
  timestamp: number,
  linear: boolean,
) {
  let index = -1;
  for (let candidate = 0; candidate < points.length; candidate++)
    if (Date.parse(points[candidate].at) <= timestamp) index = candidate;
  index = Math.max(0, Math.min(points.length - 2, index));
  const left = points[index],
    right = points[index + 1];
  if (!linear) {
    // At the exclusive final boundary the value is only a boundary marker.
    return timestamp >= Date.parse(points.at(-1)!.at)
      ? points.at(-1)!.multiplier
      : left.multiplier;
  }
  return (
    left.multiplier +
    ((right.multiplier - left.multiplier) * (timestamp - Date.parse(left.at))) /
      (Date.parse(right.at) - Date.parse(left.at))
  );
}

function clipPoints(
  points: ArrivalCurvePoint[],
  start: number,
  end: number,
  linear: boolean,
) {
  const boundary = (timestamp: number) => {
    const exact = points.find((point) => Date.parse(point.at) === timestamp);
    return exact
      ? { ...exact }
      : {
          at: new Date(timestamp).toISOString(),
          multiplier: valueAt(points, timestamp, linear),
        };
  };
  return [
    boundary(start),
    ...points
      .filter((point) => {
        const at = Date.parse(point.at);
        return at > start && at < end;
      })
      .map((point) => ({ ...point })),
    boundary(end),
  ];
}

/**
 * Change one local day's total without changing other days or fixed batches.
 * Multipliers cannot overlap, so an intersecting curve is clipped into adjacent
 * windows. Within the edited day its exact shape and care mix are retained and
 * scaled; outside the day its exposure and all original control points remain.
 */
export function editPlannedArrivalDay(
  options: ArrivalPreviewOptions,
  dayAt: string,
  requestedTotal: number,
): ArrivalDayEdit {
  const day = plannedArrivals(options).find(
    (point) => Date.parse(point.at) === Date.parse(dayAt),
  );
  if (!day || !Number.isFinite(requestedTotal))
    throw new Error("Choose a valid day and a finite arrival count.");
  if (day.baseline <= 0)
    throw new Error(
      "This day has no usual arrivals. Change the arrival schedule before editing its volume.",
    );
  const planned = Math.max(day.scheduled, requestedTotal, 0);
  if (Math.abs(planned - day.planned) < 1e-8)
    return {
      conditions: options.conditions,
      conditionId: "",
      planned,
      minimum: day.scheduled,
    };
  const start = Date.parse(day.at),
    end = Date.parse(day.endAt),
    desiredVariable = planned - day.scheduled,
    factor = day.variable > 1e-12 ? desiredVariable / day.variable : 0,
    resetMultiplier = desiredVariable / day.baseline;
  const usedIds = new Set(
    options.conditions.map((condition) => String(condition.id || "")),
  );
  function newId(a: number, b: number) {
    const base = `arrival-edit-${options.stream.toLowerCase()}-${a.toString(36)}-${b.toString(36)}`;
    let id = base,
      suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    return id;
  }
  let conditionId = "";
  const covered: { start: number; end: number }[] = [];
  const conditions: Entity[] = [];
  for (const condition of options.conditions) {
    if (
      condition.kind !== "arrival_multiplier" ||
      (condition.entry_stream_id || "ED_MAIN") !== options.stream
    ) {
      conditions.push(condition);
      continue;
    }
    const curve = normalizedArrivalCurve(condition, options);
    // A legacy wave may end with a duplicate endpoint. Its zero-width segment
    // contributes nothing; retaining the first endpoint matches its exposure.
    const points = curve.points.filter(
      (point, index, all) =>
        index === 0 || Date.parse(point.at) !== Date.parse(all[index - 1].at),
    );
    if (
      points.length < 2 ||
      points.some(
        (point, index) =>
          !Number.isFinite(Date.parse(point.at)) ||
          !Number.isFinite(point.multiplier) ||
          point.multiplier < 0 ||
          (index > 0 &&
            Date.parse(point.at) <= Date.parse(points[index - 1].at)),
      )
    )
      throw new Error("Fix the arrival schedule before editing its graph.");
    const a = Date.parse(points[0].at),
      b = Date.parse(points.at(-1)!.at),
      lo = Math.max(a, start),
      hi = Math.min(b, end);
    if (lo >= hi) {
      conditions.push(condition);
      continue;
    }
    covered.push({ start: lo, end: hi });
    const cuts = [...new Set([a, lo, hi, b])].sort((x, y) => x - y);
    for (let index = 0; index < cuts.length - 1; index++) {
      const pieceStart = cuts[index],
        pieceEnd = cuts[index + 1],
        edited = pieceStart >= start && pieceEnd <= end;
      let controlPoints = clipPoints(
        points,
        pieceStart,
        pieceEnd,
        curve.linear,
      );
      if (edited)
        controlPoints = controlPoints.map((point) => ({
          ...point,
          multiplier:
            day.variable > 1e-12 ? point.multiplier * factor : resetMultiplier,
        }));
      const id =
        index === 0 && condition.id
          ? condition.id
          : newId(pieceStart, pieceEnd);
      if (edited && !conditionId) conditionId = id;
      conditions.push({
        ...condition,
        id,
        shape: curve.linear ? "piecewise_linear" : "step",
        start_at: controlPoints[0].at,
        end_at: controlPoints.at(-1)!.at,
        control_points: controlPoints,
        surge_percent:
          (Math.max(...controlPoints.map((point) => point.multiplier)) - 1) *
          100,
      });
    }
  }
  covered.sort((a, b) => a.start - b.start);
  if (
    covered.some(
      (span, index) => index > 0 && span.start < covered[index - 1].end,
    )
  )
    throw new Error("Arrival schedules for the same stream cannot overlap.");
  // Usual, uncovered hours also need the same scale, with no overlapping windows.
  let cursor = start;
  for (const span of [...covered, { start: end, end }]) {
    if (cursor < span.start) {
      const id = newId(cursor, span.start),
        multiplier = day.variable > 1e-12 ? factor : resetMultiplier;
      conditions.push({
        id,
        kind: "arrival_multiplier",
        entry_stream_id: options.stream,
        shape: "step",
        start_at: new Date(cursor).toISOString(),
        end_at: new Date(span.start).toISOString(),
        control_points: [
          { at: new Date(cursor).toISOString(), multiplier },
          { at: new Date(span.start).toISOString(), multiplier },
        ],
        surge_percent: (multiplier - 1) * 100,
        source: "user_assumption",
      });
      if (!conditionId) conditionId = id;
    }
    cursor = Math.max(cursor, span.end);
  }
  return { conditions, conditionId, planned, minimum: day.scheduled };
}
