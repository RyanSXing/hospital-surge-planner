import { describe, expect, it } from "vitest";
import {
  fetchReplayJourneyEvents,
  recordedDischarge,
  recordedJourneySteps,
  recordedJourneyZones,
  replayJourneyZone,
} from "./replayJourney";

const unitKinds = { "UNIT-ED": "ed", "UNIT-WARD": "ward", "UNIT-ICU": "icu" };
const events = [
  {
    patient_id: "P-1",
    event_type: "arrival",
    occurred_at: "2026-10-16T00:00:00Z",
    sequence_number: 1,
    payload: { entry_type: "ed" },
  },
  {
    patient_id: "P-1",
    event_type: "queue_entry",
    occurred_at: "2026-10-16T00:00:00Z",
    sequence_number: 2,
    reason_code: "ed_placement",
  },
  {
    patient_id: "P-1",
    event_type: "assessment_start",
    occurred_at: "2026-10-16T00:20:00Z",
    sequence_number: 3,
    to_unit_id: "UNIT-ED",
  },
  {
    patient_id: "P-1",
    event_type: "assessment_end",
    occurred_at: "2026-10-16T01:00:00Z",
    sequence_number: 4,
    from_unit_id: "UNIT-ED",
  },
  {
    patient_id: "P-1",
    event_type: "admission_request",
    occurred_at: "2026-10-16T01:00:00Z",
    sequence_number: 5,
    from_unit_id: "UNIT-ED",
  },
  {
    patient_id: "P-1",
    event_type: "admission",
    occurred_at: "2026-10-16T01:30:00Z",
    sequence_number: 6,
    to_unit_id: "UNIT-WARD",
  },
  {
    patient_id: "P-1",
    event_type: "discharge",
    occurred_at: "2026-10-16T03:00:00Z",
    sequence_number: 7,
    from_unit_id: "UNIT-WARD",
  },
];

describe("recorded replay journeys", () => {
  it("keeps a fast admission and discharge in its recorded care order", () => {
    expect(recordedJourneyZones(events, "P-1", unitKinds)).toEqual([
      "arrivals",
      "ed",
      "ward",
      "exit",
    ]);
  });

  it("only routes to ICU when a recorded event names an ICU unit", () => {
    expect(replayJourneyZone(events[5], unitKinds)).toBe("ward");
    expect(
      replayJourneyZone(
        { event_type: "admission", to_unit_id: "UNIT-ICU" },
        unitKinds,
      ),
    ).toBe("icu");
  });

  it("does not move an ICU patient for a stepdown request before recorded ward admission", () => {
    const stepdown = [
      {
        patient_id: "P-2",
        event_type: "queue_entry",
        occurred_at: "2026-10-16T01:00:00Z",
        sequence_number: 1,
        reason_code: "ward_placement",
      },
      {
        patient_id: "P-2",
        event_type: "admission_request",
        occurred_at: "2026-10-16T01:00:00Z",
        sequence_number: 2,
        reason_code: "icu_stepdown_to_ward",
        from_unit_id: "UNIT-ICU",
      },
    ];
    expect(recordedJourneyZones(stepdown, "P-2", unitKinds)).toEqual([]);
  });

  it("does not move an ED boarding patient for a placement request", () => {
    expect(
      replayJourneyZone(
        {
          event_type: "queue_entry",
          reason_code: "ward_placement",
          from_unit_id: "UNIT-ED",
        },
        unitKinds,
      ),
    ).toBeNull();
    expect(
      replayJourneyZone(
        {
          event_type: "admission_request",
          from_unit_id: "UNIT-ED",
        },
        unitKinds,
      ),
    ).toBeNull();
  });

  it("uses a recorded discharge event, never snapshot omission, to identify discharge travel", () => {
    expect(recordedDischarge(events, "P-1")?.sequence_number).toBe(7);
    expect(recordedDischarge(events.slice(0, -1), "P-1")).toBeNull();
  });

  it("retains the recorded time for a late admission so presentation can hold in ED", () => {
    const late = [
      {
        patient_id: "P-late",
        event_type: "assessment_start",
        occurred_at: "2026-10-16T00:00:00Z",
        sequence_number: 1,
      },
      {
        patient_id: "P-late",
        event_type: "admission",
        occurred_at: "2026-10-16T03:45:00Z",
        sequence_number: 2,
        to_unit_id: "UNIT-WARD",
      },
    ];
    expect(recordedJourneySteps(late, "P-late", unitKinds)).toEqual([
      { zone: "ed", at: Date.parse("2026-10-16T00:00:00Z") },
      { zone: "ward", at: Date.parse("2026-10-16T03:45:00Z") },
    ]);
  });

  it("keeps a boundary event while paging a bounded journey window", async () => {
    const calls: string[] = [];
    const result = await fetchReplayJourneyEvents(
      async (path) => {
        calls.push(path);
        return calls.length === 1
          ? {
              items: [
                { occurred_at: "2026-10-16T00:00:00Z", event_type: "arrival" },
              ],
              next_cursor: "200",
            }
          : {
              items: [
                {
                  occurred_at: "2026-10-16T04:00:00Z",
                  event_type: "discharge",
                },
                {
                  occurred_at: "2026-10-16T04:00:00.001Z",
                  event_type: "future",
                },
              ],
              next_cursor: null,
            };
      },
      "rep-1",
      "2026-10-16T00:00:00Z",
      "2026-10-16T04:00:00Z",
    );
    expect(calls).toHaveLength(2);
    expect(result.map((event) => event.event_type)).toEqual(["discharge"]);
  });
});
