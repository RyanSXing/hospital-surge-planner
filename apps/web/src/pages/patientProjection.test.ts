import { describe, expect, it } from "vitest";
import {
  replayCounts,
  replayZone,
  replayPresence,
  plannedReplayInterval,
  replayClinicalInventory,
} from "./patientProjection";
import { patientPageQuery } from "./usePatientPage";
describe("bounded census presentation", () => {
  const heldUnits = {
    "source-icu": "icu",
    "ward-destination": "ward",
    "ed-source": "ed",
  };
  it("keeps completed ICU stepdown requests and reservations in their occupied ICU", () => {
    const held = {
      state: "inpatient",
      unit_id: "source-icu",
      care_level: "ward",
      target_unit_kind: "ward",
      stage_status: "ready_to_exit",
      admission_pending: true,
    };
    expect(replayZone(held, heldUnits)).toBe("icu");
    expect(
      replayZone(
        {
          ...held,
          state: "transfer_reserved",
          pending_transfer: {
            prior_state: "inpatient",
            destination_unit_id: "ward-destination",
          },
        },
        heldUnits,
      ),
    ).toBe("icu");
    const counts = replayCounts(
      [{ ...held, count: 7 }],
      [held],
      [held],
      heldUnits,
    );
    expect(counts).toEqual({ totals: { icu: 7 }, grouped: { icu: 6 } });
    expect(
      replayZone({ ...held, facility_type: "ward_overflow" }, heldUnits),
    ).toBe("icu");
  });
  it("keeps recorded source and destination care paths in their actual units until movement", () => {
    const path = [
      { state: "inpatient", care_level: "icu", unit_id: "source-icu" },
      {
        state: "inpatient",
        care_level: "ward",
        unit_id: "source-icu",
        stage_status: "ready_to_exit",
      },
      {
        state: "transfer_reserved",
        care_level: "ward",
        unit_id: "source-icu",
        pending_transfer: {
          prior_state: "inpatient",
          destination_unit_id: "ward-destination",
        },
      },
      { state: "in_transit", care_level: "ward", unit_id: null },
      { state: "inpatient", care_level: "ward", unit_id: "ward-destination" },
      { state: "discharged", care_level: "ward", unit_id: null },
    ];
    expect(path.map((interval) => replayZone(interval, heldUnits))).toEqual([
      "icu",
      "icu",
      "icu",
      "transport",
      "ward",
      "exit",
    ]);
  });
  it("preserves occupied ED and unoccupied reservation sources instead of their target care", () => {
    const sources = [
      ["ed_boarding", "ed"],
      ["ed_assessment", "ed"],
      ["ed_waiting", "arrivals"],
      ["direct_waiting", "queue"],
      ["clinic_assessment", "clinic"],
    ];
    for (const [prior, zone] of sources) {
      const patient = {
        state: "transfer_reserved",
        care_level: "ward",
        unit_id: prior.startsWith("ed_") ? "ed-source" : null,
        prior_state: prior,
        facility_type: "ward_overflow",
      };
      expect(replayZone(patient, heldUnits)).toBe(zone);
      expect(
        replayCounts([{ ...patient, count: 3 }], [], [], heldUnits).totals,
      ).toEqual({ [zone]: 3 });
    }
    expect(
      replayZone(
        { state: "inpatient", care_level: "icu", unit_id: "legacy-unknown" },
        heldUnits,
      ),
    ).toBe("icu");
    expect(
      replayZone(
        { state: "inpatient", care_level: "ward", unit_id: "nonclinical" },
        { nonclinical: "shelter" },
      ),
    ).toBe("queue");
  });
  it("excludes nonclinical shelter places from the canonical ward inventory", () => {
    const values = replayClinicalInventory(
      [
        {
          kind: "ward",
          facility_id: "main",
          occupied: 64,
          staffed: 80,
          physical: 100,
          staff_by_role: { RN: 20 },
        },
        {
          kind: "ward",
          facility_id: "east",
          occupied: 20,
          staffed: 24,
          physical: 32,
          background_occupied: 20,
          staff_by_role: { RN: 6 },
        },
        {
          kind: "ward",
          facility_id: "west",
          occupied: 24,
          staffed: 28,
          physical: 36,
          background_occupied: 24,
          staff_by_role: { RN: 7 },
        },
        {
          kind: "shelter",
          facility_id: "shelter",
          occupied: 0,
          staffed: 24,
          physical: 24,
          staff_by_role: { SUPPORT: 2 },
        },
        {
          kind: "unknown",
          facility_id: "main",
          occupied: 5,
          staffed: 10,
          physical: 12,
          background_occupied: 5,
        },
      ],
      {},
    );
    expect(values).toEqual({
      ward: {
        occupied: 108,
        staffed: 132,
        physical: 168,
        assigned: 33,
        background: 44,
      },
    });
  });
  it("maps ICU by clinical kind before an overflow facility and keeps ward overflow separate", () => {
    const values = replayClinicalInventory(
      [
        {
          kind: "icu",
          facility_id: "overflow",
          occupied: 2,
          staffed: 4,
          physical: 4,
        },
        {
          kind: "ward",
          facility_id: "overflow",
          occupied: 3,
          staffed: 8,
          physical: 12,
        },
        {
          kind: "clinic",
          facility_id: "clinic",
          occupied: 1,
          staffed: 8,
          physical: 12,
        },
        {
          kind: "ed",
          facility_id: "main",
          occupied: 12,
          staffed: 24,
          physical: 30,
        },
      ],
      { overflow: "ward_overflow" },
    );
    expect(values.icu).toMatchObject({ occupied: 2, staffed: 4 });
    expect(values.overflow).toMatchObject({ occupied: 3, staffed: 8 });
    expect(values.clinic).toMatchObject({ occupied: 1, staffed: 8 });
    expect(values.ed).toMatchObject({ occupied: 12, staffed: 24 });
    expect(values.ward).toBeUndefined();
  });
  it("places planned availability after its setup delay, with distinct identities and engine defaults", () => {
    const start = "2026-10-16T05:00:00Z",
      end = "2026-10-18T05:00:00Z";
    const delayed = plannedReplayInterval(
      {
        kind: "clinic",
        start_at: "2026-10-16T06:00:00Z",
        activation_minutes: 120,
        duration_minutes: 240,
      },
      0,
      start,
      end,
    );
    expect(delayed.start_at).toBe("2026-10-16T08:00:00.000Z");
    expect(delayed.end_at).toBe("2026-10-16T10:00:00.000Z");
    const defaults = plannedReplayInterval(
      { kind: "activate_clinic" },
      1,
      start,
      end,
    );
    expect(defaults.start_at).toBe("2026-10-16T11:00:00.000Z");
    expect(defaults.id).not.toBe(delayed.id);
    expect(
      plannedReplayInterval(
        {
          kind: "clinic",
          start_at: "2026-10-15T05:00:00Z",
          activation_minutes: 0,
        },
        2,
        start,
        end,
      ).start_at,
    ).toBe("2026-10-16T05:00:00.000Z");
  });
  it("keeps future and departed selections outside the active marker census", () => {
    const future = {
      state: "inpatient",
      censored: true,
      arrival_at: "2026-10-17T06:00:00Z",
    };
    expect(replayPresence(future, "2026-10-16T05:00:00Z")).toBe("not_arrived");
    expect(replayPresence(future, "2026-10-17T06:00:00Z")).toBe("active");
    const departed = {
      state: "discharged",
      arrival_at: "2026-10-16T06:00:00Z",
      departure_at: "2026-10-16T07:00:00Z",
    };
    expect(replayPresence(departed, "2026-10-16T05:00:00Z")).toBe(
      "not_arrived",
    );
    expect(replayPresence(departed, "2026-10-16T07:00:00Z")).toBe("departed");
    expect(
      replayPresence({ patient_id: "history-loading" }, "2026-10-16T05:00:00Z"),
    ).toBe("unknown");
  });
  it("preserves all 50000 queued patients in grouped counts while drawing only a bounded subset", () => {
    const groups = [
      { state: "ed_waiting", care_level: "ambulatory", count: 50000 },
      { state: "inpatient", care_level: "ward", count: 80 },
      {
        state: "transfer_reserved",
        care_level: "icu",
        prior_state: "ed_boarding",
        count: 2,
      },
    ];
    const visible = [
      ...Array.from({ length: 400 }, () => ({ state: "ed_waiting" })),
      ...Array.from({ length: 80 }, () => ({
        state: "inpatient",
        care_level: "ward",
      })),
    ];
    const counts = replayCounts(groups, visible, visible);
    expect(counts.totals).toEqual({ arrivals: 50000, ward: 80, ed: 2 });
    expect(counts.grouped).toEqual({ arrivals: 49600, ward: 0, ed: 2 });
    expect(
      Object.values(counts.grouped).reduce((a, b) => a + b, 0) + visible.length,
    ).toBe(50082);
  });
  it("places reserved patients in their held source and moving patients in transit", () => {
    expect(
      replayZone({
        state: "transfer_reserved",
        care_level: "icu",
        prior_state: "ed_boarding",
      }),
    ).toBe("ed");
    expect(
      replayZone({
        state: "transfer_reserved",
        care_level: "ward",
        prior_state: "direct_waiting",
      }),
    ).toBe("queue");
    expect(replayZone({ state: "in_transit", care_level: "ward" })).toBe(
      "transport",
    );
    expect(
      replayZone({
        state: "inpatient",
        care_level: "ward",
        facility_type: "ward_overflow",
      }),
    ).toBe("overflow");
    expect(replayZone({ state: "discharged", care_level: "ward" })).toBe(
      "exit",
    );
  });
  it("requests exact timestamp, server filters and a bounded cursor page", () => {
    const url = patientPageQuery(
      "R",
      "2026-11-02T06:00:00Z",
      {
        facility_id: "F",
        state: "waiting",
        unit_id: undefined,
        search: "P/42",
      },
      7,
      30,
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("cursor")).toBe("210");
    expect(params.get("limit")).toBe("30");
    expect(params.get("at")).toBe("2026-11-02T06:00:00Z");
    expect(params.get("search")).toBe("P/42");
    expect(params.get("state")).toBe("waiting");
    expect(params.has("unit_id")).toBe(false);
  });
});
