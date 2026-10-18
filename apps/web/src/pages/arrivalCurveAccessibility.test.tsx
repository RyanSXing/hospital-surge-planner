import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ArrivalPreview from "./ArrivalPreview";
import type { ArrivalPreviewProps } from "./ArrivalPreview";

const options: ArrivalPreviewProps = {
  start: "2026-10-16T05:00:00Z",
  end: "2026-10-19T05:00:00Z",
  days: 3,
  timeZone: "America/Chicago",
  stream: "ED_MAIN",
  baselineRate: 100,
  conditions: [],
};

describe("arrival chart editing accessibility", () => {
  it("exposes daily sliders instead of hiding them under an image role", () => {
    const html = renderToStaticMarkup(
      <ArrivalPreview {...options} editable onConditionsChange={() => {}} />,
    );
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="img"');
    expect(html.match(/role="slider"/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Fri, Oct 16 arrivals"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain("Arrow keys adjust a focused point");
  });
  it("keeps read-only previews free of focusable editing controls", () => {
    for (const props of [
      { editable: false, onConditionsChange: () => {} },
      { editable: true },
    ]) {
      const html = renderToStaticMarkup(
        <ArrivalPreview {...options} {...props} />,
      );
      expect(html).toContain('role="img"');
      expect(html).not.toContain('role="slider"');
      expect(html).not.toContain('tabindex="0"');
    }
  });
  it("reports the fixed scheduled-patient minimum to keyboard and screen reader users", () => {
    const html = renderToStaticMarkup(
      <ArrivalPreview
        {...options}
        conditions={[{ kind: "arrival_batch", at: options.start, count: 25 }]}
        editable
        onConditionsChange={() => {}}
      />,
    );
    expect(html).toContain('aria-valuemin="25"');
    expect(html).toContain("including 25 scheduled arrivals");
    expect(html).toContain("Scheduled arrivals stay fixed");
  });
  it("does not offer edits that multipliers cannot represent on zero-rate days", () => {
    const html = renderToStaticMarkup(
      <ArrivalPreview
        {...options}
        baselineRate={0}
        editable
        onConditionsChange={() => {}}
      />,
    );
    expect(html).not.toContain('role="slider"');
  });
});
