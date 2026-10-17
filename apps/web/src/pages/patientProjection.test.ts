import { describe, expect, it } from "vitest";
import { replayCounts, replayZone } from "./patientProjection";
import { patientPageQuery } from "./usePatientPage";
describe("bounded census presentation", () => {
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
      "queue",
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
