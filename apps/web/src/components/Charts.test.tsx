import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForecastChart } from "./Charts";
import { recordedConstraintMarkers } from "../pages/constraintMarkers";

function labels(html: string): string[] {
  return Array.from(html.matchAll(/<text[^>]*>([^<]+)/g), (match) => match[1]);
}

describe("forecast calendar labels", () => {
  it("shows distinct calendar dates for two daily observations within 36 hours", () => {
    const html = renderToStaticMarkup(
      <ForecastChart
        rows={[
          { at: "2026-10-16T05:00:00Z", patients: 100 },
          { at: "2026-10-17T05:00:00Z", patients: 120 },
        ]}
        keys={["patients"]}
        labels={["Patients"]}
        timeZone="America/Chicago"
        dateLabelMode="date"
      />,
    );
    expect(labels(html)).toContain("Oct 16");
    expect(labels(html)).toContain("Oct 17");
    expect(labels(html)).not.toContain("12:00 AM");
  });

  it("preserves automatic time labels for existing intraday charts", () => {
    const html = renderToStaticMarkup(
      <ForecastChart
        rows={[
          { at: "2026-10-16T05:00:00Z", patients: 100 },
          { at: "2026-10-16T06:00:00Z", patients: 120 },
        ]}
        keys={["patients"]}
        labels={["Patients"]}
        timeZone="America/Chicago"
      />,
    );
    expect(labels(html)).toContain("12:00 AM");
    expect(labels(html)).toContain("1:00 AM");
  });
});

describe("recorded constraint ribbons", () => {
  const days = Array.from({ length: 5 }, (_, index) => ({
    start_at: new Date(Date.UTC(2026, 9, 16 + index, 5)).toISOString(),
    end_at: new Date(Date.UTC(2026, 9, 17 + index, 5)).toISOString(),
    patients: 10 + index,
    blocker_patient_hours: {},
  }));
  const render = (
    markers: Parameters<typeof ForecastChart>[0]["markers"],
    rows = days,
    markerPresentation: "ribbon" | "background" = "ribbon",
  ) =>
    renderToStaticMarkup(
      <ForecastChart
        rows={rows}
        keys={["patients"]}
        labels={["Patients"]}
        markers={markers}
        markerPresentation={markerPresentation}
        height={300}
        timeZone="America/Chicago"
      />,
    );
  const marker = (index: number, label = "Not enough qualified nurses") => ({
    index,
    label,
    at: days[index].start_at,
    endAt: days[index].end_at,
  });
  const bands = (html: string) =>
    Array.from(html.matchAll(/<g[^>]*class="chart-constraint-band"[^>]*>/g));

  it("joins adjacent recorded periods into one thin ribbon above the plot", () => {
    const html = render([marker(2), marker(0), marker(1)]);
    expect(bands(html)).toHaveLength(1);
    expect(bands(html)[0][0]).toContain('data-first-period="0"');
    expect(bands(html)[0][0]).toContain('data-last-period="2"');
    const ribbon = html.match(
      /<rect[^>]*class="chart-constraint-ribbon"[^>]*>/,
    )![0];
    expect(ribbon).toContain('height="4"');
    expect(ribbon).toContain('y="8"');
    expect(html).not.toContain("chart-bottleneck-marker");
    expect(html).not.toContain("<circle");
    expect(html).toContain("Recorded constraints");
    // Every contributing period keeps its own evidence/title hit target.
    expect(html.match(/class="chart-constraint-period"/g)).toHaveLength(3);
  });

  it("leaves a gap for unmarked or unavailable periods and for disjoint dates", () => {
    const evidence = [
      { ...days[0], blocker_patient_hours: { nursing_capacity: { mean: 4 } } },
      {
        ...days[1],
        blocker_patient_hours: { nursing_capacity: { mean: null, p50: null } },
      },
      { ...days[2], blocker_patient_hours: { nursing_capacity: { mean: 2 } } },
      { ...days[3], blocker_patient_hours: { nursing_capacity: { mean: 0 } } },
      days[4],
    ];
    const html = render(recordedConstraintMarkers(evidence, evidence));
    expect(bands(html)).toHaveLength(2);
    expect(html).not.toContain('data-period-index="1"');
    expect(html).not.toContain('data-period-index="3"');
    expect(html).not.toContain('data-period-index="4"');

    // Adjacent array positions must not imply continuity across missing dates.
    const disjoint = render([
      { ...marker(0), endAt: "2026-10-16T06:00:00Z" },
      marker(1),
    ]);
    expect(bands(disjoint)).toHaveLength(2);
  });

  it("retains source timestamps, overlapping reasons and period precision", () => {
    const html = render([
      marker(0, "Medical supplies unavailable · Treatment interruption"),
      marker(1, "Equipment unavailable"),
    ]);
    expect(html).toContain('data-recorded-at="2026-10-16T05:00:00.000Z"');
    expect(html).toContain('data-recorded-end-at="2026-10-17T05:00:00.000Z"');
    expect(html).toContain("Oct 16, 2026");
    expect(html).toContain("Oct 17, 2026");
    expect(html).toContain("CDT");
    expect(html).toContain(
      "Medical supplies unavailable · Treatment interruption",
    );
    expect(html).toContain("Equipment unavailable");
    expect(html).toContain(
      "Period evidence does not identify exact onset or duration.",
    );
  });

  it("keeps a fully constrained horizon as a ribbon without shading the graph", () => {
    const html = render(days.map((_, index) => marker(index)));
    expect(bands(html)).toHaveLength(1);
    const ribbons = Array.from(
      html.matchAll(/<rect[^>]*class="chart-constraint-ribbon"[^>]*>/g),
    );
    expect(ribbons).toHaveLength(1);
    expect(ribbons[0][0]).toContain('height="4"');
    expect(html).not.toContain('opacity="0.065"');
  });

  it("preserves a single actual observation and bounds its ribbon to the chart", () => {
    const html = render([marker(0)], [days[0]]);
    const ribbon = html.match(
      /<rect[^>]*class="chart-constraint-ribbon"[^>]*>/,
    )![0];
    const left = Number(ribbon.match(/ x="([^"]+)"/)![1]);
    const width = Number(ribbon.match(/ width="([^"]+)"/)![1]);
    expect(left).toBeGreaterThanOrEqual(42);
    expect(left + width).toBeLessThanOrEqual(1000 - 32);
    expect(html).toContain("chart-isolated-observation");
    expect(html.match(/<circle/g)).toHaveLength(1);
  });

  it("does not invent ribbon evidence or show a key for missing/invalid markers", () => {
    const missing = render([]);
    expect(bands(missing)).toHaveLength(0);
    expect(missing).not.toContain("Recorded constraints");
    const invalid = render([
      { index: -1, label: "Outside horizon" },
      { index: 5, label: "Outside horizon" },
      { index: Number.NaN, label: "Unknown" },
    ]);
    expect(bands(invalid)).toHaveLength(0);
    expect(invalid).not.toContain("Recorded constraints");
    expect(invalid).not.toContain("Outside horizon");
  });

  it("joins only the same recorded type, keeping overlap reasons on red interruptions", () => {
    const html = render([
      marker(0, "Medical supplies unavailable"),
      {
        ...marker(1, "Treatment interruption · Medical supplies unavailable"),
        kind: "disruption",
      },
      { ...marker(2, "Treatment interruption"), kind: "disruption" },
      marker(3, "Not enough qualified nurses"),
    ]);
    expect(bands(html)).toHaveLength(3);
    expect(html.match(/data-kind="disruption"/g)).toHaveLength(1);
    expect(html.match(/data-kind="constraint"/g)).toHaveLength(2);
    expect(html.match(/fill="var\(--danger\)"/g)).toHaveLength(1);
    expect(html).toContain(
      "Treatment interruption · Medical supplies unavailable",
    );
    expect(html).toContain("Recorded constraints");
    expect(html).toContain("Treatment interruptions");
    expect(html).toContain("Recorded in one or more simulations");
    expect(bands(html)[1][0]).toContain('data-first-period="1"');
    expect(bands(html)[1][0]).toContain('data-last-period="2"');
  });

  it("shows only the present legend types and defaults generic evidence to amber", () => {
    const interruption = render([{ ...marker(0), kind: "disruption" }]);
    expect(interruption).toContain("Treatment interruptions");
    expect(interruption).not.toContain("Recorded constraints");
    const constraint = render([marker(0)]);
    expect(constraint).toContain("Recorded constraints");
    expect(constraint).not.toContain("Treatment interruptions");
    expect(constraint).not.toContain('fill="var(--danger)"');
  });

  it("keeps narrow end-period ribbons within the plot on a dense chart", () => {
    const denseRows = Array.from({ length: 2000 }, () => days[0]);
    const html = render([{ ...marker(0), index: 1999 }], denseRows);
    const ribbon = html.match(
      /<rect[^>]*class="chart-constraint-ribbon"[^>]*>/,
    )![0];
    const left = Number(ribbon.match(/ x="([^"]+)"/)![1]);
    const width = Number(ribbon.match(/ width="([^"]+)"/)![1]);
    expect(left).toBeGreaterThanOrEqual(42);
    expect(width).toBeGreaterThan(0);
    expect(left + width).toBeLessThanOrEqual(1000 - 32);
  });

  it("shades only affected period cells behind the plot and preserves clear gaps", () => {
    const html = render([marker(1), marker(2), marker(4)], days, "background");
    expect(html).not.toContain("chart-constraint-ribbon");
    expect(html).toContain(
      'class="chart-constraint-key constraint background"',
    );
    const fills = Array.from(
      html.matchAll(/<rect[^>]*class="chart-constraint-background"[^>]*>/g),
      (match) => match[0],
    );
    expect(fills).toHaveLength(2);
    const extents = fills.map((fill) => ({
      x: Number(fill.match(/ x="([^"]+)"/)![1]),
      width: Number(fill.match(/ width="([^"]+)"/)![1]),
    }));
    expect(extents[0]).toEqual({ x: 158.25, width: 462 });
    expect(extents[1]).toEqual({ x: 852.75, width: 114.75 });
    expect(extents[0].x + extents[0].width).toBeLessThan(extents[1].x);
    for (const fill of fills) {
      expect(fill).toContain('y="18"');
      expect(fill).toContain('height="254"');
      expect(fill).toContain('opacity="0.07"');
      expect(fill).toContain('pointer-events="none"');
    }
    expect(html.indexOf('class="chart-constraint-background"')).toBeLessThan(
      html.indexOf('stroke="var(--border-subtle)"'),
    );
    expect(html).not.toContain('data-period-index="0"');
    expect(html).not.toContain('data-period-index="3"');
    expect(
      bands(html).every((band) => band[0].includes('clip-path="url(')),
    ).toBe(true);
  });

  it("keeps overlapping resource reasons in one background period without summing effects", () => {
    const rows = [
      {
        ...days[0],
        blocker_patient_hours: {
          nursing_capacity: { mean: 4 },
          required_equipment_unavailable: { mean: 4 },
        },
      },
      days[1],
    ];
    const html = render(
      recordedConstraintMarkers(rows, rows),
      rows,
      "background",
    );
    expect(html.match(/class="chart-constraint-background"/g)).toHaveLength(1);
    expect(html.match(/class="chart-constraint-period"/g)).toHaveLength(1);
    expect(html).toContain(
      "No staffed bed available · Required equipment unavailable",
    );
    expect(html).toContain('data-recorded-at="2026-10-16T05:00:00.000Z"');
    expect(html).toContain('data-recorded-end-at="2026-10-17T05:00:00.000Z"');
    expect(html).toContain(
      "Period evidence does not identify exact onset or duration.",
    );
  });

  it("does not shade missing, zero or unmarked periods in background mode", () => {
    const rows = [
      {
        ...days[0],
        blocker_patient_hours: { nursing_capacity: { mean: null } },
      },
      { ...days[1], blocker_patient_hours: { nursing_capacity: { mean: 0 } } },
      days[2],
    ];
    const html = render(
      recordedConstraintMarkers(rows, rows),
      rows,
      "background",
    );
    expect(html).not.toContain("chart-constraint-background");
    expect(html).not.toContain("chart-constraint-band");
    expect(html).not.toContain("chart-constraint-key");
  });

  it("bounds dense background spans without widening isolated constrained periods", () => {
    const rows = Array.from({ length: 2000 }, () => days[0]);
    const html = render(
      [
        { ...marker(0), index: 0 },
        { ...marker(0), index: 1999 },
      ],
      rows,
      "background",
    );
    const fills = Array.from(
      html.matchAll(/<rect[^>]*class="chart-constraint-background"[^>]*>/g),
      (match) => match[0],
    );
    expect(fills).toHaveLength(2);
    for (const fill of fills) {
      const left = Number(fill.match(/ x="([^"]+)"/)![1]);
      const width = Number(fill.match(/ width="([^"]+)"/)![1]);
      expect(left).toBeGreaterThanOrEqual(42);
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThan(1);
      expect(left + width).toBeLessThanOrEqual(968);
    }
    expect(html.match(/data-period-index=/g)).toHaveLength(2);
  });

  it("covers the full chart only when every displayed period has recorded evidence", () => {
    const html = render(
      days.map((_, index) => marker(index)),
      days,
      "background",
    );
    const fill = html.match(
      /<rect[^>]*class="chart-constraint-background"[^>]*>/,
    )![0];
    expect(fill).toContain('x="42.5"');
    expect(fill).toContain('width="925"');
    expect(html.match(/class="chart-constraint-background"/g)).toHaveLength(1);
    expect(html.match(/class="chart-constraint-period"/g)).toHaveLength(
      days.length,
    );
    expect(html).not.toContain("chart-constraint-ribbon");
  });
});
