import { describe, expect, it } from "vitest";
import {
  replayCounts,
  replayZone,
  replayPresence,
  plannedReplayInterval,
} from "./patientProjection";
import { patientPageQuery } from "./usePatientPage";
describe("bounded census presentation", () => {
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
