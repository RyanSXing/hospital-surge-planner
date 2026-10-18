import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReplayFloorPlan from "./ReplayFloorPlan";
import { buildReplayFloorPlan } from "./replayFloorPlanModel";

const dataset = {
  units: [
    {
      unit_id: "WARD-A",
      name: "Ward A",
      kind: "ward",
      facility_id: "FAC-MAIN",
    },
  ],
};
const plan = () =>
  buildReplayFloorPlan(dataset, {
    at: "2026-10-16T05:00:00Z",
    replication_id: "REP1",
    units: [
      {
        ...dataset.units[0],
        physical: 2,
        enabled: 2,
        occupied: 1,
        staffed: 2,
        available: 1,
      },
    ],
    slots: [
      {
        slot_id: "BED-1",
        unit_id: "WARD-A",
        status: "occupied",
        patient_id: "P1",
      },
      { slot_id: "BED-2", unit_id: "WARD-A", status: "ready" },
    ],
    queue_counts: { "FAC-MAIN": { ed: 10, total: 4 } },
    flow_counts: { "FAC-MAIN": { discharges: 15 } },
    blocker_counts_by_unit: { "WARD-A": { medical_supplies: 1 } },
  });
const handlers = {
  onBedSelect: () => {},
  onUnitSelect: () => {},
  onAreaSelect: () => {},
};

describe("floor plan presentation", () => {
  it("uses a connected building map and plain bed rectangles without illustration detail", () => {
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={plan()} {...handlers} />,
    );
    for (const part of [
      "floor-plan-building",
      "floor-plan-upper-wing",
      "floor-plan-corridor",
      "floor-plan-door",
      "Main entrance",
    ])
      expect(html).toContain(part);
    for (const detail of [
      "floor-bed-pillow",
      "floor-bed-cover",
      "floor-bed-label",
      "floor-plan-unit-icon",
      "floor-area-icon",
    ])
      expect(html).not.toContain(detail);
  });
  it("exposes actual bed state and patient selection as accessible buttons", () => {
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={plan()} selectedPatientId="P1" {...handlers} />,
    );
    expect(html).toContain('data-slot-id="BED-1"');
    expect(html).toContain('aria-label="Ward A, Bed 1: Occupied"');
    expect(html).toContain(
      'aria-label="Ward A, Bed 2: Ready. Staffing and equipment are shared across this unit"',
    );
    expect(html).toContain('data-patient-id="P1"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain('role="img"');
  });
  it("keeps unit pressure and numeric non-capacity areas legible without inventing beds", () => {
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={plan()} {...handlers} />,
    );
    expect(html).toContain('data-unit-id="WARD-A" data-pressure="1"');
    expect(html).toContain(
      'data-testid="floor-plan-ed-waiting" data-count="10"',
    );
    expect(html).toContain(
      'data-testid="floor-plan-bed-waiting" data-count="4"',
    );
    expect(html).toContain(
      'data-testid="floor-plan-discharges" data-count="15"',
    );
    expect(html).toContain("Discharged so far");
    expect(html.match(/data-slot-id=/g)).toHaveLength(2);
  });
  it("labels held data with the actual earlier timestamp while a seek loads", () => {
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={plan()} retaining {...handlers} />,
    );
    expect(html).toContain('data-recorded-at="2026-10-16T05:00:00Z"');
    expect(html).toContain('data-retaining="true"');
    expect(html).toContain("Holding the last recorded moment");
  });
  it("labels 88% supported occupancy consistently as high occupancy", () => {
    const fairlyFull = plan();
    fairlyFull.units[0].reasons = [];
    fairlyFull.units[0].utilization = 0.88;
    fairlyFull.units[0].pressure = (0.88 - 0.65) / 0.35;
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={fairlyFull} {...handlers} />,
    );
    expect(html).toContain("High occupancy");
  });
  it("renders unavailable counts and empty actual inventory honestly", () => {
    const missing = buildReplayFloorPlan(dataset, {
      at: "2026-10-16T05:00:00Z",
      units: [],
      slots: [],
    });
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={missing} {...handlers} />,
    );
    expect(html).toContain('data-count="unknown"');
    expect(html).toContain('data-pressure="unknown"');
    expect(html).toContain("Recorded bed inventory unavailable");
    expect(html).not.toContain("data-slot-id");
  });
  it("uses a count instead of a fabricated bed grid for an actual zero-capacity area", () => {
    const empty = buildReplayFloorPlan(dataset, {
      units: [{ ...dataset.units[0], physical: 0, occupied: 0 }],
      slots: [],
    });
    const html = renderToStaticMarkup(
      <ReplayFloorPlan plan={empty} reducedMotion {...handlers} />,
    );
    expect(html).toContain("patients in this area");
    expect(html).not.toContain('class="floor-plan-beds"');
    expect(html).toContain("hospital-floor-plan--still");
  });
});
