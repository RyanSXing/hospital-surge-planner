import { atDay } from "../api";
import { utcToWall, wallTimeCandidates } from "../zonedTime";
import type { Entity } from "../types";

export interface ArrivalPreviewOptions {
  conditions: Entity[];
  stream: string;
  baselineRate: number;
  start: string;
  end: string;
  days: number;
  timeZone: string;
  hourWeights?: number[];
  weekdayWeights?: number[];
}
export interface ArrivalPreviewDay {
  at: string;
  endAt: string;
  baseline: number;
  /** Arrivals generated from the usual rate and editable multiplier curves. */
  variable: number;
  /** Reported batches stay fixed when an arrival curve is edited. */
  scheduled: number;
  planned: number;
}
export interface ArrivalCurvePoint {
  at: string;
  multiplier: number;
}
/** Resolve legacy inputs using exactly the same defaults as the preview/engine. */
export function normalizedArrivalCurve(
  condition: Entity,
  options: ArrivalPreviewOptions,
): { linear: boolean; points: ArrivalCurvePoint[] } {
  const value = 1 + (condition.surge_percent ?? 70) / 100;
  const points: Entity[] = condition.control_points?.length
    ? condition.control_points
    : condition.shape === "wave"
      ? [
          { at: options.start, multiplier: 1 },
          {
            at: atDay(
              options.start,
              Math.min(10, options.days),
              0,
              options.timeZone,
            ),
            multiplier: value,
          },
          { at: options.end, multiplier: 1 },
        ]
      : [
          { at: condition.start_at || options.start, multiplier: value },
          { at: condition.end_at || options.end, multiplier: value },
        ];
  return {
    linear:
      condition.shape === "piecewise_linear" || condition.shape === "wave",
    points: points.map((point) => ({
      at: point.at,
      multiplier: Number(point.multiplier),
    })),
  };
}
/** Control points drive the engine; surge_percent is used only when no points exist. */
export function arrivalControlPercent(condition: Entity | undefined) {
  if (!condition) return 0;
  const points: Entity[] = condition.control_points || [];
  if (points.length >= 2) {
    if (
      condition.shape === "piecewise_linear" &&
      points[0].multiplier === 1 &&
      (points.length === 2 ||
        (points.length === 3 && points[2].multiplier === 1))
    )
      return (Number(points[1].multiplier) - 1) * 100;
    const effective =
      condition.shape === "piecewise_linear" ? points : points.slice(0, -1);
    const strongest = effective.reduce((best, point) =>
      Math.abs(Number(point.multiplier) - 1) >
      Math.abs(Number(best.multiplier) - 1)
        ? point
        : best,
    );
    return (Number(strongest.multiplier) - 1) * 100;
  }
  return Number(condition.surge_percent ?? 70);
}

/** Suppress binary floating-point noise only in editable control presentation. */
export function displayArrivalPercent(value: number) {
  return Number(value.toPrecision(12));
}

interface CalendarExposureDay {
  start: number;
  end: number;
  weekdayWeight: number;
  total: number;
  hours: { start: number; end: number; weight: number; fullWidth: number }[];
}
// Calendar exposure never depends on editable demand. Keep a small browser cache
// so long-horizon slider edits do not repeat thousands of timezone conversions.
const calendarCache = new Map<string, CalendarExposureDay[]>();
function calendarExposure(options: ArrivalPreviewOptions) {
  const { start, end, timeZone, hourWeights, weekdayWeights } = options;
  const key = JSON.stringify([
    start,
    end,
    timeZone,
    hourWeights,
    weekdayWeights,
  ]);
  const cached = calendarCache.get(key);
  if (cached) return cached;
  const endMs = Date.parse(end);
  const localHour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  });
  const result: CalendarExposureDay[] = [];
  let current = Date.parse(start);
  while (current < endMs && result.length < 366) {
    const date = utcToWall(new Date(current).toISOString(), timeZone).slice(
      0,
      10,
    );
    const midnight = Date.parse(
      `${wallTimeCandidates(`${date}T00:00`, timeZone)[0]}:00Z`,
    );
    const next = Date.parse(
      atDay(new Date(midnight).toISOString(), 1, 0, timeZone),
    );
    const finish = Math.min(endMs, next);
    const weekday = (new Date(`${date}T00:00Z`).getUTCDay() + 6) % 7;
    const hours: CalendarExposureDay["hours"] = [];
    let total = 0;
    for (let hour = midnight; hour < next; hour += 3_600_000) {
      const hourEnd = Math.min(next, hour + 3_600_000);
      const weight =
        hourWeights?.[Number(localHour.format(new Date(hour)))] ?? 1;
      total += weight;
      const a = Math.max(current, hour),
        b = Math.min(finish, hourEnd);
      if (a < b)
        hours.push({ start: a, end: b, weight, fullWidth: hourEnd - hour });
    }
    result.push({
      start: current,
      end: finish,
      weekdayWeight: weekdayWeights?.[weekday] ?? 1,
      total,
      hours,
    });
    current = finish;
  }
  if (calendarCache.size >= 16)
    calendarCache.delete(calendarCache.keys().next().value!);
  calendarCache.set(key, result);
  return result;
}

/** Same expected exposure as the engine: local weekday and actual-hour weights, then exact curve integration. */
export function plannedArrivals(
  options: ArrivalPreviewOptions,
): ArrivalPreviewDay[] {
  const { conditions, stream, baselineRate } = options;
  const arrivalConditions = conditions
    .filter(
      (condition) =>
        condition.kind === "arrival_multiplier" &&
        (condition.entry_stream_id || "ED_MAIN") === stream,
    )
    .map((condition) => {
      const { points, linear } = normalizedArrivalCurve(condition, options);
      return {
        linear,
        points: points.map((point) => ({
          at: Date.parse(point.at),
          value: Number(point.multiplier),
        })),
      };
    });
  const multiplier = (a: number, b: number) => {
    let exposure = b - a;
    for (const condition of arrivalConditions) {
      for (let index = 0; index < condition.points.length - 1; index++) {
        const left = condition.points[index],
          right = condition.points[index + 1];
        if (
          ![left.at, right.at, left.value, right.value].every(
            Number.isFinite,
          ) ||
          right.at <= left.at
        )
          continue;
        const x = Math.max(a, left.at),
          y = Math.min(b, right.at);
        if (x >= y) continue;
        const at = (time: number) =>
          condition.linear
            ? left.value +
              ((right.value - left.value) * (time - left.at)) /
                (right.at - left.at)
            : left.value;
        exposure += ((at(x) + at(y)) / 2 - 1) * (y - x);
      }
    }
    return exposure / (b - a);
  };
  return calendarExposure(options).map((day) => {
    const daily = baselineRate * day.weekdayWeight;
    let usual = 0,
      variable = 0,
      scheduled = 0;
    for (const hour of day.hours) {
      if (!day.total) continue;
      const base =
        (((daily * hour.weight) / day.total) * (hour.end - hour.start)) /
        hour.fullWidth;
      usual += base;
      variable += base * multiplier(hour.start, hour.end);
    }
    for (const condition of conditions) {
      if (
        condition.kind !== "arrival_batch" ||
        (condition.entry_stream_id || "ED_MAIN") !== stream
      )
        continue;
      const at = Date.parse(condition.at),
        count = Number(condition.count || 0),
        spread = Number(condition.spread_minutes || 0) * 60_000;
      if (spread > 0)
        scheduled +=
          (count *
            Math.max(
              0,
              Math.min(day.end, at + spread) - Math.max(day.start, at),
            )) /
          spread;
      else if (at >= day.start && at < day.end) scheduled += count;
    }
    return {
      at: new Date(day.start).toISOString(),
      endAt: new Date(day.end).toISOString(),
      baseline: usual,
      variable: Math.max(0, variable),
      scheduled,
      planned: Math.max(0, variable + scheduled),
    };
  });
}
