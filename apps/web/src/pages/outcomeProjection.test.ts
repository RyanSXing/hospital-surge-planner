import { describe, expect, it } from "vitest";
import {
  clampOutcomeTime,
  isMeasurementScalar,
  outcomeRowIndex,
  outcomeWindow,
  projectOutcomePeriods,
  projectOutcomeSamples,
  scaleOutcomeStatistics,
} from "./outcomeProjection";
const stats = (n: number) => ({ p10: n, p50: n, p90: n, mean: n });
const window = {
  fullStart: Date.parse("2026-10-16T05:00:00Z"),
  start: Date.parse("2026-10-16T17:00:00Z"),
  end: Date.parse("2026-10-18T05:00:00Z"),
};
describe("measured outcome projection", () => {
  it("recovers exact noon-cutoff occupancy from clipped hour integrals without changing source data", () => {
    const row = {
      start_at: "2026-10-16T05:00:00Z",
      end_at: "2026-10-17T05:00:00Z",
      ward_occupied: stats(32),
      ward_staffed: stats(40),
      ward_occupied_hours: stats(768),
      ward_staffed_hours: stats(960),
      arrivals: stats(68),
    };
    const [actual] = projectOutcomePeriods([row], window);
    expect(actual.ward_occupied).toEqual(stats(64));
    expect(actual.ward_staffed).toEqual(stats(80));
    expect(actual.arrivals).toEqual(stats(68));
    expect(actual.start_at).toBe("2026-10-16T17:00:00.000Z");
    expect(actual.measurement_hours).toBe(12);
    expect(row.ward_occupied.p50).toBe(32);
  });
  it("uses elapsed overlap hours for weekly/monthly periods across DST", () => {
    const dst = {
      fullStart: Date.parse("2026-03-08T06:00:00Z"),
      start: Date.parse("2026-03-08T18:00:00Z"),
      end: Date.parse("2026-03-10T05:00:00Z"),
    };
    const rows = projectOutcomePeriods(
      [
        {
          start_at: "2026-03-08T06:00:00Z",
          end_at: "2026-03-10T05:00:00Z",
          ward_occupied_hours: { p10: 35 * 60, p50: 35 * 64, p90: 35 * 70 },
          ward_staffed_hours: stats(35 * 80),
        },
      ],
      dst,
    );
    expect(rows[0].measurement_hours).toBe(35);
    expect(rows[0].ward_occupied).toEqual({ p10: 60, p50: 64, p90: 70 });
    expect(rows[0].ward_staffed).toEqual(stats(80));
  });
  it("excludes pre-cutoff and exclusive-end samples/periods and selects inside a clipped bucket", () => {
    const samples = [
      "2026-10-16T16:00:00Z",
      "2026-10-16T17:00:00Z",
      "2026-10-17T05:00:00Z",
      "2026-10-18T05:00:00Z",
    ].map((at) => ({ at }));
    expect(projectOutcomeSamples(samples, window).map((x) => x.at)).toEqual([
      samples[1].at,
      samples[2].at,
    ]);
    const periods = projectOutcomePeriods(
      [
        { start_at: "2026-10-15T05:00:00Z", end_at: "2026-10-16T05:00:00Z" },
        { start_at: "2026-10-16T05:00:00Z", end_at: "2026-10-17T05:00:00Z" },
        { start_at: "2026-10-17T05:00:00Z", end_at: "2026-10-18T05:00:00Z" },
      ],
      window,
    );
    expect(periods.map((x) => x.source_index)).toEqual([1, 2]);
    expect(outcomeRowIndex(periods, "2026-10-17T04:00:00Z")).toBe(0);
    expect(clampOutcomeTime(samples[0].at, window)).toBe(
      "2026-10-16T17:00:00.000Z",
    );
    expect(Date.parse(clampOutcomeTime(samples[3].at, window))).toBe(
      window.end - 1,
    );
    expect(periods[0].ward_occupied).toBeNull();
  });
  it("keeps null distinct from zero and leaves statistical metadata unchanged", () => {
    expect(
      scaleOutcomeStatistics(
        { p10: 0, p50: null, p90: 0.9, replication_count: 10 },
        100,
      ),
    ).toEqual({ p10: 0, p50: null, p90: 90, replication_count: 10 });
  });
  it("resolves frozen branch cutoff and separates full-horizon expected arrivals", () => {
    const resolved = outcomeWindow(
      { start_at: "2026-10-16T05:00:00Z", end_at: "2026-10-18T05:00:00Z" },
      { branch_at: "2026-10-16T17:00:00Z" },
    );
    expect(resolved).toEqual(window);
    expect(isMeasurementScalar("expected_arrivals", resolved)).toBe(false);
    expect(isMeasurementScalar("initial_patients", resolved)).toBe(true);
    expect(
      isMeasurementScalar("expected_arrivals", {
        ...resolved,
        start: resolved.fullStart,
      }),
    ).toBe(true);
  });
});
