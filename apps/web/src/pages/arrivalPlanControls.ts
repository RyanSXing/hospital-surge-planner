import type { Entity } from "../types";
import {
  normalizedArrivalCurve,
  plannedArrivals,
} from "./plannedArrivalSeries";
import type {
  ArrivalCurvePoint,
  ArrivalPreviewOptions,
} from "./plannedArrivalSeries";

export type ArrivalPlanShape = "sustained" | "ramp" | "wave";
const selectedWindow = (condition: Entity, stream: string) =>
  condition.kind === "arrival_multiplier" &&
  (condition.entry_stream_id || "ED_MAIN") === stream;
function exposure(options: ArrivalPreviewOptions) {
  return plannedArrivals(options).reduce(
    (sum, day) => ({
      baseline: sum.baseline + day.baseline,
      variable: sum.variable + day.variable,
    }),
    { baseline: 0, variable: 0 },
  );
}
function desiredMultiplier(percent: number) {
  if (!Number.isFinite(percent) || percent < -100)
    throw new Error(
      "Arrival change must be a finite percentage of at least −100%.",
    );
  return 1 + percent / 100;
}
/** Fixed, scheduled batches never contribute to the editable global percentage. */
export function arrivalPlanPercent(options: ArrivalPreviewOptions): number {
  const total = exposure(options);
  return total.baseline > 0 ? (total.variable / total.baseline - 1) * 100 : 0;
}
function valueAt(points: ArrivalCurvePoint[], at: number, linear: boolean) {
  const last = points.at(-1)!;
  if (at >= Date.parse(last.at)) return last.multiplier;
  let index = 0;
  while (index < points.length - 2 && Date.parse(points[index + 1].at) <= at)
    index++;
  const left = points[index],
    right = points[index + 1];
  return linear
    ? left.multiplier +
        ((right.multiplier - left.multiplier) * (at - Date.parse(left.at))) /
          (Date.parse(right.at) - Date.parse(left.at))
    : left.multiplier;
}
function clip(
  points: ArrivalCurvePoint[],
  start: number,
  end: number,
  linear: boolean,
) {
  const boundary = (at: number) => ({
    at: new Date(at).toISOString(),
    multiplier: valueAt(points, at, linear),
  });
  return [
    boundary(start),
    ...points
      .filter((p) => Date.parse(p.at) > start && Date.parse(p.at) < end)
      .map((p) => ({ ...p })),
    boundary(end),
  ];
}
interface Curve {
  points: ArrivalCurvePoint[];
  linear: boolean;
}
/** Keep care/source boundaries while replacing only the selected stream's exposure. */
function replacePlan(
  options: ArrivalPreviewOptions,
  transform: (curve: Curve, start: number, end: number) => Curve,
): Entity[] {
  const start = Date.parse(options.start),
    end = Date.parse(options.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new Error(
      "Choose an ordered simulation period before editing arrivals.",
    );
  const ids = new Set(options.conditions.map((c) => String(c.id || "")));
  function identity(a: number, b: number) {
    const prefix = `arrival-plan-${options.stream.toLowerCase()}-${a.toString(36)}-${b.toString(36)}`;
    let id = prefix,
      suffix = 2;
    while (ids.has(id)) id = `${prefix}-${suffix++}`;
    ids.add(id);
    return id;
  }
  const covered: { start: number; end: number }[] = [],
    result: Entity[] = [];
  function canonical(original: Entity, curve: Curve, id: string) {
    return {
      ...original,
      id,
      kind: "arrival_multiplier",
      entry_stream_id: options.stream,
      shape: curve.linear ? "piecewise_linear" : "step",
      start_at: curve.points[0].at,
      end_at: curve.points.at(-1)!.at,
      control_points: curve.points,
      surge_percent:
        (Math.max(...curve.points.map((p) => p.multiplier)) - 1) * 100,
      source: original.source || "user_assumption",
    };
  }
  for (const original of options.conditions) {
    if (!selectedWindow(original, options.stream)) {
      result.push(original);
      continue;
    }
    const normalized = normalizedArrivalCurve(original, options);
    const curve: Curve = {
      ...normalized,
      points: normalized.points.filter(
        (point, i, all) =>
          i === 0 || Date.parse(point.at) !== Date.parse(all[i - 1].at),
      ),
    };
    if (
      curve.points.length < 2 ||
      curve.points.some(
        (p, i) =>
          !Number.isFinite(Date.parse(p.at)) ||
          !Number.isFinite(p.multiplier) ||
          p.multiplier < 0 ||
          (i > 0 && Date.parse(p.at) <= Date.parse(curve.points[i - 1].at)),
      )
    )
      throw new Error("Fix the arrival curve before adjusting the plan.");
    const a = Date.parse(curve.points[0].at),
      b = Date.parse(curve.points.at(-1)!.at),
      lo = Math.max(a, start),
      hi = Math.min(b, end);
    if (lo >= hi) {
      result.push(original);
      continue;
    }
    covered.push({ start: lo, end: hi });
    const cuts = [...new Set([a, lo, hi, b])].sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      const x = cuts[i],
        y = cuts[i + 1],
        part = {
          linear: curve.linear,
          points: clip(curve.points, x, y, curve.linear),
        };
      const transformed = x >= start && y <= end ? transform(part, x, y) : part;
      result.push(
        canonical(
          original,
          transformed,
          i === 0 && original.id ? original.id : identity(x, y),
        ),
      );
    }
  }
  covered.sort((a, b) => a.start - b.start);
  if (covered.some((span, i) => i > 0 && span.start < covered[i - 1].end))
    throw new Error("Arrival schedules for the same stream cannot overlap.");
  let cursor = start;
  for (const span of [...covered, { start: end, end }]) {
    if (cursor < span.start) {
      const usual = {
        linear: false,
        points: [
          { at: new Date(cursor).toISOString(), multiplier: 1 },
          { at: new Date(span.start).toISOString(), multiplier: 1 },
        ],
      };
      result.push(
        canonical(
          {},
          transform(usual, cursor, span.start),
          identity(cursor, span.start),
        ),
      );
    }
    cursor = Math.max(cursor, span.end);
  }
  return result;
}
/** Scale every window and ordinary uncovered hour by the same weighted factor. */
export function scaleArrivalPlan(
  options: ArrivalPreviewOptions,
  percent: number,
): Entity[] {
  const target = desiredMultiplier(percent),
    total = exposure(options);
  if (total.baseline <= 0) return options.conditions;
  const desired = total.baseline * target;
  if (Math.abs(desired - total.variable) < 1e-9) return options.conditions;
  const factor = total.variable > 1e-12 ? desired / total.variable : null;
  return replacePlan(options, (curve) => ({
    ...curve,
    points: curve.points.map((point) => ({
      ...point,
      multiplier: factor === null ? target : point.multiplier * factor,
    })),
  }));
}
/** A preset redistributes the whole period while retaining its overall volume. */
export function reshapeArrivalPlan(
  options: ArrivalPreviewOptions,
  percent: number,
  shape: ArrivalPlanShape,
): Entity[] {
  const target = desiredMultiplier(percent),
    start = Date.parse(options.start),
    end = Date.parse(options.end);
  if (!["sustained", "ramp", "wave"].includes(shape))
    throw new Error("Choose a supported arrival pattern.");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new Error(
      "Choose an ordered simulation period before editing arrivals.",
    );
  const curve: Curve = {
    linear: shape !== "sustained",
    points: [
      { at: options.start, multiplier: 1 },
      ...(shape === "wave"
        ? [{ at: new Date((start + end) / 2).toISOString(), multiplier: 2 }]
        : []),
      { at: options.end, multiplier: shape === "ramp" ? 2 : 1 },
    ],
  };
  const preset = {
    kind: "arrival_multiplier",
    entry_stream_id: options.stream,
    shape: curve.linear ? "piecewise_linear" : "step",
    control_points: curve.points,
  };
  const total = exposure({ ...options, conditions: [preset] });
  const factor =
    total.variable > 0 ? (total.baseline * target) / total.variable : 0;
  curve.points = curve.points.map((point) => ({
    ...point,
    multiplier: point.multiplier * factor,
  }));
  return replacePlan(options, (_original, a, b) => ({
    linear: curve.linear,
    points: clip(curve.points, a, b, curve.linear),
  })).map((condition) =>
    selectedWindow(condition, options.stream)
      ? { ...condition, arrival_plan_shape: shape }
      : condition,
  );
}
