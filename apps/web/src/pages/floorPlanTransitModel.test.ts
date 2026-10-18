import { describe, expect, it } from "vitest";
import {
  corridorRoute,
  floorJourneyPath,
  floorMotionIsCurrent,
  floorTransitTiming,
  floorTransitWindowAction,
  recordedFloorJourneys,
} from "./floorPlanTransitModel";

const from = "2026-10-16T05:00:00Z",
  to = "2026-10-16T09:00:00Z";
const event = (event_type: string, minute: number, fields: any = {}) => ({
  event_type,
  patient_id: "P1",
  event_id: `${event_type}-${minute}`,
  occurred_at: new Date(Date.parse(from) + minute * 60000).toISOString(),
  ...fields,
});

describe("smooth recorded window pacing", () => {
  const journey = (minute: number) => ({
    patientId: "P1",
    moves: [
      {
        from: "ED",
        to: "WARD-A",
        at: event("admission", minute).occurred_at,
        eventId: "admission",
      },
    ],
  });
  it("gives early and late recorded moves enough time to remain readable, finishing within their frame", () => {
    const early = floorTransitTiming(journey(1), from, to)!,
      late = floorTransitTiming(journey(240), from, to)!;
    expect(late.delayMs).toBeGreaterThan(early.delayMs);
    for (const timing of [early, late]) {
      expect(timing.durationMs).toBeGreaterThanOrEqual(850);
      expect(timing.delayMs + timing.durationMs).toBe(976);
    }
    expect(floorTransitTiming(journey(240), from, to, 500)).toEqual({
      delayMs: 60,
      durationMs: 428,
    });
    const shortFrame = floorTransitTiming(journey(240), from, to, 60)!;
    expect(shortFrame.delayMs + shortFrame.durationMs).toBeLessThan(60);
  });
  it("rejects stale, future, malformed, backwards and discontinuous movement evidence", () => {
    for (const input of [
      journey(0),
      journey(-1),
      journey(241),
      { patientId: "P1", moves: [] },
    ])
      expect(floorTransitTiming(input, from, to)).toBeNull();
    expect(floorTransitTiming(journey(1), "bad", to)).toBeNull();
    expect(floorTransitTiming(journey(1), to, from)).toBeNull();
    expect(floorTransitTiming(journey(1), from, to, Infinity)).toBeNull();
    expect(floorTransitTiming(journey(1), from, to, 0)).toBeNull();
    expect(
      floorTransitTiming(
        {
          patientId: "P1",
          moves: [
            ...journey(10).moves,
            {
              from: "WARD-A",
              to: "discharge",
              at: event("discharge", 5).occurred_at,
              eventId: "discharge",
            },
          ],
        },
        from,
        to,
      ),
    ).toBeNull();
    expect(
      floorTransitTiming(
        {
          patientId: "P1",
          moves: [
            ...journey(10).moves,
            {
              from: "ICU",
              to: "discharge",
              at: event("discharge", 20).occurred_at,
              eventId: "discharge",
            },
          ],
        },
        from,
        to,
      ),
    ).toBeNull();
  });
  it("starts each exact window once, and holds the running animation on an ordinary rerender", () => {
    const next = { key: "REP1|first", zoom: 1, active: true, from, to };
    expect(floorTransitWindowAction(null, next)).toBe("start");
    const consumed = { key: next.key, zoom: next.zoom };
    expect(floorTransitWindowAction(consumed, next)).toBe("hold");
    expect(floorTransitWindowAction(consumed, { ...next, active: false })).toBe(
      "clear",
    );
    // The component retains the consumed stamp while paused or resized.
    expect(floorTransitWindowAction(consumed, next)).toBe("hold");
    expect(floorTransitWindowAction(consumed, { ...next, zoom: 1.1 })).toBe(
      "clear",
    );
    expect(
      floorTransitWindowAction(
        { key: next.key, zoom: 1.1 },
        { ...next, zoom: 1.1 },
      ),
    ).toBe("hold");
    expect(
      floorTransitWindowAction(consumed, {
        ...next,
        key: "REP1|second",
        from: to,
        to: event("x", 480).occurred_at,
      }),
    ).toBe("start");
    expect(
      floorTransitWindowAction(consumed, { ...next, key: "REP2|first" }),
    ).toBe("start");
  });
  it("clears inactive or invalid windows without accepting a fabricated forward step", () => {
    const next = { key: "REP1|first", zoom: 1, active: true, from, to };
    for (const update of [
      { active: false },
      { key: "" },
      { from: to, to: from },
      { to: "bad" },
    ])
      expect(floorTransitWindowAction(null, { ...next, ...update })).toBe(
        "clear",
      );
  });
});
const units = ["ED", "WARD-A", "WARD-B", "ICU"];
describe("recorded floor-plan movements", () => {
  it("preserves the actual ED to specific ward to discharge sequence", () => {
    const journeys = recordedFloorJourneys(
      [
        event("arrival", 1, { payload: { entry_type: "ed" } }),
        event("assessment_start", 10, { to_unit_id: "ED" }),
        event("admission_request", 15, { from_unit_id: "ED" }),
        event("queue_entry", 16),
        event("admission", 20, { from_unit_id: "ED", to_unit_id: "WARD-B" }),
        event("discharge", 100, { from_unit_id: "WARD-B" }),
      ],
      units,
      from,
      to,
    );
    expect(journeys).toHaveLength(1);
    expect(journeys[0].moves.map((move) => [move.from, move.to])).toEqual([
      ["entrance", "ed-waiting"],
      ["ed-waiting", "ED"],
      ["ED", "WARD-B"],
      ["WARD-B", "discharge"],
    ]);
    expect(journeys[0].moves.map((move) => move.eventId)).not.toContain(
      "admission_request-15",
    );
  });
  it("does not move a held ICU stepdown patient until recorded arrival in the ward", () => {
    const requests = [
      event("assessment_end", 2, { from_unit_id: "ICU" }),
      event("admission_request", 3, {
        from_unit_id: "ICU",
        reason_code: "icu_stepdown_to_ward",
      }),
      event("transfer_departed", 4, {
        from_unit_id: "ICU",
        to_unit_id: "WARD-A",
      }),
    ];
    expect(recordedFloorJourneys(requests, units, from, to)).toEqual([]);
    const journeys = recordedFloorJourneys(
      [
        ...requests,
        event("transfer_arrived", 5, {
          to_unit_id: "WARD-A",
          payload: { source_unit_id: "ICU" },
        }),
      ],
      units,
      from,
      to,
    );
    expect(journeys[0].moves).toMatchObject([
      { from: "ICU", to: "WARD-A", at: event("x", 5).occurred_at },
    ]);
  });
  it("never invents an unknown discharge source, unknown ward or offsite destination", () => {
    expect(
      recordedFloorJourneys(
        [
          event("discharge", 1),
          event("admission", 3, { from_unit_id: "ED", to_unit_id: "OFFSITE" }),
          event("transfer_arrived", 4, {
            to_unit_id: "WARD-A",
            payload: { source_unit_id: "OFFSITE" },
          }),
        ],
        units,
        from,
        to,
      ),
    ).toEqual([]);
  });
  it("orders trace events and excludes past or future events outside the playback step", () => {
    const journeys = recordedFloorJourneys(
      [
        event("discharge", 40, { from_unit_id: "ED" }),
        event("assessment_start", 20, { to_unit_id: "ED" }),
        event("arrival", -1),
        event("arrival", 300),
      ],
      units,
      from,
      to,
    );
    expect(journeys[0].moves.map((move) => move.to)).toEqual([
      "ED",
      "discharge",
    ]);
  });
  it("keeps direct arrivals in the bed waiting area and ignores same-unit administrative transitions", () => {
    const journeys = recordedFloorJourneys(
      [
        event("arrival", 1, { payload: { entry_type: "direct_ward" } }),
        event("admission", 2, { to_unit_id: "WARD-A" }),
        event("admission", 3, { from_unit_id: "WARD-A", to_unit_id: "WARD-A" }),
      ],
      units,
      from,
      to,
    );
    expect(journeys[0].moves.map((move) => move.to)).toEqual([
      "bed-waiting",
      "WARD-A",
    ]);
  });
  it("bounds a deterministic visual sample while never cloning a patient into concurrent paths", () => {
    const events = Array.from({ length: 80 }, (_, i) =>
      event("assessment_start", i + 1, {
        patient_id: `P${i}`,
        to_unit_id: "ED",
      }),
    );
    const first = recordedFloorJourneys(events, units, from, to);
    expect(first).toHaveLength(12);
    expect(new Set(first.map((journey) => journey.patientId)).size).toBe(12);
    expect(recordedFloorJourneys(events, units, from, to)).toEqual(first);
  });
  it("represents rare wards, ICU, discharge and direct admissions within a heavily skewed sample", () => {
    const actualUnits = [...units, "WARD-C"];
    const patient = (id: string, minute: number, unit: string) => [
      event("arrival", minute, { patient_id: id }),
      event("assessment_start", minute + 0.01, {
        patient_id: id,
        to_unit_id: "ED",
      }),
      event("admission", minute + 0.02, {
        patient_id: id,
        from_unit_id: "ED",
        to_unit_id: unit,
      }),
      event("discharge", minute + 0.03, { patient_id: id, from_unit_id: unit }),
    ];
    const events = [
      ...Array.from({ length: 300 }, (_, index) =>
        patient(`common-${index}`, index / 2 + 0.1, "WARD-A"),
      ).flat(),
      ...patient("rare-B", 60.111, "WARD-B"),
      ...patient("rare-C", 60.112, "WARD-C"),
      ...patient("rare-ICU", 60.113, "ICU"),
      event("arrival", 60.114, {
        patient_id: "direct",
        payload: { entry_type: "direct_ward" },
      }),
      event("admission", 60.115, {
        patient_id: "direct",
        to_unit_id: "WARD-A",
      }),
    ];
    const sample = recordedFloorJourneys(events, actualUnits, from, to);
    expect(sample).toHaveLength(12);
    expect(new Set(sample.map((journey) => journey.patientId)).size).toBe(12);
    const covered = new Set(
      sample.flatMap((journey) =>
        journey.moves.flatMap((move) => [move.from, move.to]),
      ),
    );
    for (const place of [
      ...actualUnits,
      "bed-waiting",
      "ed-waiting",
      "entrance",
      "discharge",
    ])
      expect(covered.has(place), place).toBe(true);
    const routes = (journeys: ReturnType<typeof recordedFloorJourneys>) =>
      [
        ...new Set(
          journeys.flatMap((journey) =>
            journey.moves.map((move) => `${move.from}→${move.to}`),
          ),
        ),
      ].sort();
    expect(routes(sample)).toEqual(
      routes(recordedFloorJourneys(events, actualUnits, from, to, 1000)),
    );
    const actualEvents = new Set(events.map((row) => row.event_id));
    expect(
      sample.every((journey) =>
        journey.moves.every((move) => actualEvents.has(move.eventId)),
      ),
    ).toBe(true);
    expect(
      recordedFloorJourneys([...events].reverse(), actualUnits, from, to),
    ).toEqual(sample);
  });
  it("chooses a rare recorded phase over a longer common phase without joining a missing journey or duplicating its patient", () => {
    const events = [
      event("arrival", 1),
      event("assessment_start", 2, { to_unit_id: "ED" }),
      event("admission", 3, { from_unit_id: "ED", to_unit_id: "WARD-A" }),
      // The source does not continue the prior chain. That gap must stay a gap.
      event("transfer_arrived", 4, {
        from_unit_id: "ICU",
        to_unit_id: "WARD-C",
      }),
      ...Array.from({ length: 40 }, (_, index) => [
        event("assessment_start", index + 5, {
          patient_id: `common-${index}`,
          to_unit_id: "ED",
        }),
        event("admission", index + 5.1, {
          patient_id: `common-${index}`,
          from_unit_id: "ED",
          to_unit_id: "WARD-A",
        }),
      ]).flat(),
    ];
    const sample = recordedFloorJourneys(
      events,
      [...units, "WARD-C"],
      from,
      to,
    );
    const rare = sample.filter((journey) => journey.patientId === "P1");
    expect(rare).toHaveLength(1);
    expect(rare[0].moves.map((move) => [move.from, move.to])).toEqual([
      ["ICU", "WARD-C"],
    ]);
    expect(sample).toHaveLength(12);
    expect(
      sample.every((journey) =>
        journey.moves.every(
          (move, index) => !index || move.from === journey.moves[index - 1].to,
        ),
      ),
    ).toBe(true);
  });
  it("does not fabricate traffic to units without a physical recorded movement", () => {
    const sample = recordedFloorJourneys(
      [
        event("admission", 1, { from_unit_id: "ED", to_unit_id: "WARD-A" }),
        event("admission_request", 2, {
          from_unit_id: "WARD-A",
          to_unit_id: "ICU",
        }),
      ],
      [...units, "WARD-C"],
      from,
      to,
    );
    expect(sample.flatMap((journey) => journey.moves)).toMatchObject([
      { from: "ED", to: "WARD-A" },
    ]);
  });
  it("honors empty and small sample budgets without mutating recorded input", () => {
    const events = [
      event("admission", 1, { from_unit_id: "ED", to_unit_id: "WARD-A" }),
    ];
    const saved = JSON.stringify(events);
    for (const maximum of [0, -1, NaN, Infinity])
      expect(recordedFloorJourneys(events, units, from, to, maximum)).toEqual(
        [],
      );
    expect(recordedFloorJourneys(events, units, from, to, 1)).toHaveLength(1);
    expect(JSON.stringify(events)).toBe(saved);
  });
});
describe("floor-plan corridor routing and suppression", () => {
  it("routes between actual door anchors through the corridor and waiting-wing hallway", () => {
    const points = corridorRoute(
      { x: 20, y: 10 },
      { x: 100, y: 90, corridorX: 90 },
      50,
    );
    expect(points).toEqual([
      { x: 20, y: 10 },
      { x: 20, y: 50 },
      { x: 90, y: 50 },
      { x: 90, y: 90 },
      { x: 100, y: 90, corridorX: 90 },
    ]);
    expect(
      points
        .slice(1)
        .every(
          (point, i) => point.x === points[i].x || point.y === points[i].y,
        ),
    ).toBe(true);
  });
  it("joins a patient's section changes into one continuous path without room-crossing diagonals", () => {
    const journeys = recordedFloorJourneys(
      [
        event("admission", 5, { from_unit_id: "ED", to_unit_id: "WARD-A" }),
        event("discharge", 10, { from_unit_id: "WARD-A" }),
      ],
      units,
      from,
      to,
    );
    const anchors = new Map([
      ["ED", { x: 10, y: 80 }],
      ["WARD-A", { x: 100, y: 20 }],
      ["discharge", { x: 200, y: 90, corridorX: 180 }],
    ]);
    expect(floorJourneyPath(journeys[0], anchors, 50)).toBe(
      "M10.00,80.00 L10.00,50.00 L100.00,50.00 L100.00,20.00 L100.00,50.00 L180.00,50.00 L180.00,90.00 L200.00,90.00",
    );
    anchors.delete("WARD-A");
    expect(floorJourneyPath(journeys[0], anchors, 50)).toBeNull();
  });
  it("suppresses motion for pause, reduced motion, manual jumps, old snapshots, changed runs and non-forward windows", () => {
    const window = { rep: "REP1", from, to, events: [] },
      context = {
        rep: "REP1",
        selectedAt: to,
        recordedAt: to,
        playing: true,
        reduced: false,
      };
    expect(floorMotionIsCurrent(window, context)).toBe(true);
    for (const update of [
      { playing: false },
      { reduced: true },
      { rep: "REP2" },
      { selectedAt: from },
      { recordedAt: from },
      { selectedAt: "bad" },
    ])
      expect(floorMotionIsCurrent(window, { ...context, ...update })).toBe(
        false,
      );
    expect(
      floorMotionIsCurrent({ ...window, from: to, to: from }, context),
    ).toBe(false);
    expect(floorMotionIsCurrent(null, context)).toBe(false);
  });
});
