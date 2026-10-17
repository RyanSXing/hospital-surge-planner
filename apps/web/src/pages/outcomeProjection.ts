import type { Entity } from "../types";

export type OutcomeWindow = { start: number; end: number; fullStart: number };
const statistics = new Set(["p10", "p50", "p90", "mean", "min", "max"]);

export function outcomeWindow(
  metrics: Entity,
  scenario: Entity,
): OutcomeWindow {
  const fullStart = Date.parse(metrics.start_at || scenario.start_at);
  const requestedStart = Date.parse(
    scenario.measurement_start_at ||
      scenario.branch_at ||
      metrics.measurement_start_at ||
      metrics.start_at ||
      scenario.start_at,
  );
  return {
    fullStart,
    start: Math.max(fullStart, requestedStart),
    end: Date.parse(metrics.end_at || scenario.end_at),
  };
}

/** Deterministic positive scaling preserves per-run percentiles and nulls. */
export function scaleOutcomeStatistics(
  value: unknown,
  factor: number,
): unknown {
  if (typeof value === "number")
    return Number.isFinite(value) ? value * factor : null;
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value).map(([key, n]) => [
      key,
      statistics.has(key) && typeof n === "number"
        ? Number.isFinite(n)
          ? n * factor
          : null
        : n,
    ]),
  );
}

/** Engine hour integrals are measurement-clipped even when calendar buckets are not. */
export function projectOutcomePeriods(
  rows: Entity[],
  window: OutcomeWindow,
): Entity[] {
  return rows.flatMap((row, index) => {
    const sourceStart = Date.parse(row.start_at || row.at);
    const sourceEnd = Date.parse(row.end_at);
    const start = Math.max(sourceStart, window.start);
    const end = Math.min(sourceEnd, window.end);
    if (!(start < end)) return [];
    const hours = (end - start) / 3_600_000;
    const clipped = start !== sourceStart || end !== sourceEnd;
    const projected: Entity = {
      ...row,
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString(),
      source_start_at: row.start_at || row.at,
      source_end_at: row.end_at,
      source_index: index,
      measurement_hours: hours,
      measurement_clipped: clipped,
      ...(row.at ? { at: new Date(start).toISOString() } : {}),
    };
    for (const care of ["ward", "icu", "ed"]) {
      for (const measure of ["occupied", "staffed"]) {
        const key = `${care}_${measure}`;
        if (row[`${key}_hours`] !== undefined) {
          projected[key] = scaleOutcomeStatistics(
            row[`${key}_hours`],
            1 / hours,
          );
        } else if (clipped) {
          // A legacy average alone cannot recover an unknown partial interval.
          projected[key] = null;
        }
      }
    }
    return [projected];
  });
}

export function projectOutcomeSamples(
  rows: Entity[],
  window: OutcomeWindow,
): Entity[] {
  return rows.filter((row) => {
    const at = Date.parse(row.at);
    return at >= window.start && at < window.end;
  });
}

export function clampOutcomeTime(at: string, window: OutcomeWindow): string {
  const instant = Date.parse(at);
  return new Date(
    Math.max(
      window.start,
      Math.min(
        window.end - 1,
        Number.isFinite(instant) ? instant : window.start,
      ),
    ),
  ).toISOString();
}

export function outcomeRowIndex(rows: Entity[], at: string): number {
  const instant = Date.parse(at);
  const containing = rows.findIndex(
    (row) =>
      Date.parse(row.at || row.start_at) <= instant &&
      instant < Date.parse(row.end_at),
  );
  if (containing >= 0) return containing;
  return rows.reduce(
    (best, row, index) =>
      Math.abs(Date.parse(row.at || row.start_at) - instant) <
      Math.abs(Date.parse(rows[best]?.at || rows[best]?.start_at) - instant)
        ? index
        : best,
    0,
  );
}

export function isMeasurementScalar(
  key: string,
  window: OutcomeWindow,
): boolean {
  // This input expectation is generated for the full simulation before cutoff accounting.
  return key !== "expected_arrivals" || window.start === window.fullStart;
}
