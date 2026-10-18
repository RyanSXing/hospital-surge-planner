import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForecastChart } from "./Charts";

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
