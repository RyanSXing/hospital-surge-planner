import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  recordedTreatmentStatus,
  treatmentPauseLabel,
} from "./replayTreatmentModel";
import ReplayTreatmentStatus from "./ReplayTreatmentStatus";
import { buildReplayFloorPlan } from "./replayFloorPlanModel";
import ReplayFloorPlan from "./ReplayFloorPlan";

const at = "2026-10-16T07:00:00Z";
const paused = {
  care_paused: true,
  treatment_disrupted: true,
  reasons: ["treatment_disruption"],
  since_at: at,
  last_resumed_at: null,
};
const unit = (id: string, active = true) => ({
  unit_id: id,
  facility_id: "FAC-MAIN",
  kind: id === "ED" ? "ed" : "ward",
  name: id,
  active,
  physical: 2,
  staffed: 2,
  occupied: 0,
  available: 2,
});

describe("recorded Replay treatment state", () => {
  it("never uses configured probability or missing records as a recorded pause", () => {
    for (const missing of [
      null,
      undefined,
      {},
      { disruption_chance_percent: 100 },
    ])
      expect(recordedTreatmentStatus(missing, at)).toBeNull();
    const plan = buildReplayFloorPlan(
      {
        units: [unit("ED")],
        hospital_operations: { disruption_chance_percent: 100 },
      },
      {
        at,
        units: [unit("ED")],
        slots: [],
        blocker_counts_by_unit: { ED: { treatment_disruption: 2 } },
      },
    );
    expect(plan.treatmentStatus).toBeNull();
    expect(plan.units[0].treatmentPaused).toBe(false);
  });

  it("keeps resumed care distinct from the initial available observation", () => {
    const initial = recordedTreatmentStatus(
      {
        ...paused,
        care_paused: false,
        treatment_disrupted: false,
        reasons: [],
      },
      at,
    )!;
    const resumed = recordedTreatmentStatus(
      {
        ...paused,
        care_paused: false,
        treatment_disrupted: false,
        reasons: [],
        last_resumed_at: at,
      },
      at,
    )!;
    const firstHtml = renderToStaticMarkup(
      <ReplayTreatmentStatus status={initial} />,
    );
    const resumedHtml = renderToStaticMarkup(
      <ReplayTreatmentStatus status={resumed} />,
    );
    expect(firstHtml).toContain('data-state="available"');
    expect(firstHtml).not.toContain("Treatment resumed");
    expect(resumedHtml).toContain('data-state="resumed"');
    expect(resumedHtml).toContain(`data-last-resumed-at="${at}"`);
    expect(resumedHtml).toContain("Treatment resumed");
  });

  it("does not claim resumption when a disruption ends during a supply outage", () => {
    const both = recordedTreatmentStatus(
      { ...paused, reasons: ["treatment_disruption", "medical_supplies"] },
      at,
    )!;
    const supplies = recordedTreatmentStatus(
      { ...paused, treatment_disrupted: false, reasons: ["medical_supplies"] },
      at,
    )!;
    expect(treatmentPauseLabel(both)).toContain("disruption and supplies");
    expect(treatmentPauseLabel(supplies)).toBe("Treatment paused · supplies");
    const html = renderToStaticMarkup(
      <ReplayTreatmentStatus status={supplies} />,
    );
    expect(html).toContain('data-state="paused"');
    expect(html).not.toContain("Treatment resumed");
  });

  it("rejects malformed, contradictory and future status instead of showing normal care", () => {
    for (const row of [
      { ...paused, care_paused: "true" },
      { ...paused, care_paused: false },
      { ...paused, reasons: ["invented"] },
      { ...paused, since_at: "2026-10-16T07:00:00.000500Z" },
      { ...paused, since_at: null },
      { ...paused, last_resumed_at: "2026-10-16T08:00:00Z" },
      { ...paused, treatment_disrupted: false },
    ])
      expect(recordedTreatmentStatus(row, at)).toBeNull();
    const html = renderToStaticMarkup(<ReplayTreatmentStatus status={null} />);
    expect(html).toContain('data-state="unknown"');
    expect(html).not.toContain("Treatment available");
  });

  it("highlights empty active treatment rooms, preserves actual beds, and excludes inactive rooms", () => {
    const units = [unit("ED"), unit("EMPTY"), unit("INACTIVE", false)];
    const state = {
      at,
      treatment_status: paused,
      units,
      slots: [{ slot_id: "EMPTY-1", unit_id: "EMPTY", status: "ready" }],
      queue_counts: { "FAC-MAIN": { ed: 2, total: 3 } },
    };
    const during = buildReplayFloorPlan({ units }, state);
    expect(
      during.units.find((row) => row.id === "EMPTY")?.treatmentPaused,
    ).toBe(true);
    expect(
      during.units.find((row) => row.id === "INACTIVE")?.treatmentPaused,
    ).toBe(false);
    expect(during.units.find((row) => row.id === "EMPTY")?.beds[0].status).toBe(
      "ready",
    );
    const html = renderToStaticMarkup(
      <ReplayFloorPlan
        plan={during}
        onBedSelect={() => {}}
        onUnitSelect={() => {}}
        onAreaSelect={() => {}}
      />,
    );
    expect(html.match(/data-treatment-paused="true"/g)).toHaveLength(2);
    expect(html.match(/data-slot-id="EMPTY-1"/g)).toHaveLength(1);
    expect(html).toContain(
      'data-testid="replay-treatment-status" data-state="paused"',
    );
    const after = buildReplayFloorPlan(
      { units },
      {
        ...state,
        treatment_status: {
          ...paused,
          care_paused: false,
          treatment_disrupted: false,
          reasons: [],
          last_resumed_at: at,
        },
      },
    );
    expect(after.units.every((row) => !row.treatmentPaused)).toBe(true);
    expect(after.units.find((row) => row.id === "EMPTY")?.beds).toEqual(
      during.units.find((row) => row.id === "EMPTY")?.beds,
    );
  });
});
