import { describe, expect, it } from "vitest";
import {
  buildFloorCorridorGraph,
  floorGraphJourneyPath,
  floorGraphRoute,
  hospitalFootprintPath,
  type FloorGeometryInput,
  type FloorRect,
} from "./floorPlanGeometry";
import type { FloorJourney } from "./floorPlanTransitModel";

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
): FloorRect => ({
  x,
  y,
  width,
  height,
});
function hospital(wardHeight = 132): FloorGeometryInput {
  const row = wardHeight + 42;
  const input: FloorGeometryInput = {
    spine: rect(395, wardHeight, 210, 406),
    wardHall: rect(0, wardHeight, 1000, 42),
    entrance: rect(395, row + 328, 210, 36),
    edWaiting: rect(395, row + 164, 210, 164),
    bedWaiting: rect(395, row, 210, 164),
    discharge: rect(635, row + 203, 365, 86),
    westHall: rect(365, row + 232, 30, 28),
    careHall: rect(605, row + 68, 30, 28),
    exitHall: rect(605, row + 232, 30, 28),
    units: [
      { id: "WARD-A", kind: "ward", rect: rect(0, 0, 325, wardHeight) },
      { id: "WARD-B", kind: "ward", rect: rect(337, 0, 326, wardHeight) },
      { id: "WARD-C", kind: "ward", rect: rect(675, 0, 325, wardHeight) },
      { id: "ICU", kind: "icu", rect: rect(635, row + 16, 365, 132) },
      { id: "ED", kind: "ed", rect: rect(0, row + 180, 365, 132) },
    ],
    footprint: [],
  };
  input.footprint = [
    rect(0, 0, 1000, wardHeight),
    input.wardHall,
    input.spine,
    input.careHall,
    input.westHall,
    input.exitHall,
    input.discharge,
    ...input.units
      .filter((unit) => unit.kind !== "ward")
      .map((unit) => unit.rect),
  ];
  return input;
}
const contains = (r: FloorRect, x: number, y: number, tolerance = 0) =>
  x >= r.x - tolerance &&
  x <= r.x + r.width + tolerance &&
  y >= r.y - tolerance &&
  y <= r.y + r.height + tolerance;
function expectCorridorOnly(input: FloorGeometryInput) {
  const graph = buildFloorCorridorGraph(input);
  for (const [from, to] of graph.edges) {
    const a = graph.nodes.get(from)!,
      b = graph.nodes.get(to)!;
    expect(
      a.x === b.x || a.y === b.y,
      `${from} → ${to} must be orthogonal`,
    ).toBe(true);
    for (let i = 0; i <= 50; i++) {
      const x = a.x + ((b.x - a.x) * i) / 50,
        y = a.y + ((b.y - a.y) * i) / 50;
      expect(
        input.footprint.some((area) => contains(area, x, y, 0.01)),
        `${from} → ${to} leaves the hospital`,
      ).toBe(true);
      expect(
        input.units.some(
          ({ rect: room }) =>
            x > room.x + 0.01 &&
            x < room.x + room.width - 0.01 &&
            y > room.y + 0.01 &&
            y < room.y + room.height - 0.01,
        ),
        `${from} → ${to} crosses a room wall`,
      ).toBe(false);
    }
  }
}

describe("hospital footprint and corridor geometry", () => {
  it("puts waiting between the front entrance and the actual bed wings", () => {
    const graph = buildFloorCorridorGraph(hospital());
    const route = floorGraphRoute(graph, "entrance", "WARD-A")!;
    expect(route.indexOf("ed-waiting")).toBeGreaterThan(
      route.indexOf("entrance"),
    );
    expect(route.indexOf("bed-waiting")).toBeGreaterThan(
      route.indexOf("ed-waiting"),
    );
    expect(route.indexOf("junction:wards")).toBeGreaterThan(
      route.indexOf("bed-waiting"),
    );
    expect(route.at(-1)).toBe("WARD-A");
    expect(graph.nodes.get("entrance")!.y).toBeGreaterThan(
      graph.nodes.get("ed-waiting")!.y,
    );
    expect(graph.nodes.get("ed-waiting")!.y).toBeGreaterThan(
      graph.nodes.get("bed-waiting")!.y,
    );
    expect(graph.nodes.get("bed-waiting")!.y).toBeGreaterThan(
      graph.nodes.get("WARD-A")!.y,
    );
  });

  it("routes emergency arrivals through ED waiting before the nearby treatment door", () => {
    const graph = buildFloorCorridorGraph(hospital());
    expect(floorGraphRoute(graph, "entrance", "ED")).toEqual([
      "entrance",
      "junction:entry",
      "ed-waiting",
      "junction:emergency",
      "portal:ED",
      "ED",
    ]);
    expect(floorGraphRoute(graph, "entrance", "ED")).not.toContain(
      "bed-waiting",
    );
    expect(graph.nodes.get("ED")!.x).toBeLessThan(
      graph.nodes.get("ed-waiting")!.x,
    );
  });

  it("connects ED and ICU via admission waiting and keeps discharge on its separate side exit", () => {
    const graph = buildFloorCorridorGraph(hospital());
    const intensiveCare = floorGraphRoute(graph, "ED", "ICU")!;
    expect(intensiveCare).toContain("bed-waiting");
    expect(intensiveCare.at(-1)).toBe("ICU");
    const discharge = floorGraphRoute(graph, "ED", "discharge")!;
    expect(discharge).toContain("junction:exit");
    expect(discharge).not.toContain("entrance");
    expect(discharge).not.toContain("bed-waiting");
    expect(graph.nodes.get("discharge")!.x).toBeGreaterThan(
      graph.nodes.get("ed-waiting")!.x,
    );
  });

  it("keeps every movement segment on the visible hospital, outside treatment rooms", () => {
    expectCorridorOnly(hospital());
  });

  it("remeasures taller wards without routing through a room or truncating the entrance spine", () => {
    const normal = buildFloorCorridorGraph(hospital()),
      large = buildFloorCorridorGraph(hospital(258));
    expect(
      large.nodes.get("junction:wards")!.y -
        normal.nodes.get("junction:wards")!.y,
    ).toBe(126);
    expect(
      large.nodes.get("entrance")!.y - normal.nodes.get("entrance")!.y,
    ).toBe(126);
    expectCorridorOnly(hospital(258));
  });

  it("joins actual recorded section changes without introducing an unrecorded destination", () => {
    const graph = buildFloorCorridorGraph(hospital());
    const journey: FloorJourney = {
      patientId: "P1",
      moves: [
        {
          from: "entrance",
          to: "bed-waiting",
          at: "2026-10-16T05:00:01Z",
          eventId: "arrival",
        },
        {
          from: "bed-waiting",
          to: "WARD-C",
          at: "2026-10-16T05:00:02Z",
          eventId: "admission",
        },
        {
          from: "WARD-C",
          to: "discharge",
          at: "2026-10-16T05:00:03Z",
          eventId: "discharge",
        },
      ],
    };
    const path = floorGraphJourneyPath(journey, graph)!;
    const end = graph.nodes.get("discharge")!;
    expect(path).toMatch(/^M500\.00,/);
    expect(path.endsWith(`L${end.x.toFixed(2)},${end.y.toFixed(2)}`)).toBe(
      true,
    );
    expect(
      floorGraphJourneyPath(
        {
          patientId: "unknown",
          moves: [
            {
              from: "ED",
              to: "OFFSITE",
              at: "2026-10-16T05:00:01Z",
              eventId: "unsupported",
            },
          ],
        },
        graph,
      ),
    ).toBeNull();
  });

  it("draws one connected hospital with inset courtyards rather than its rectangular bounding box", () => {
    const path = hospitalFootprintPath(hospital().footprint);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path.match(/Z/g)).toHaveLength(1);
    const vertices = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(
      (point) => [Number(point[1]), Number(point[2])],
    );
    expect(new Set(vertices.map(([x]) => x)).size).toBeGreaterThan(4);
    expect(new Set(vertices.map(([, y]) => y)).size).toBeGreaterThan(4);
    const area =
      Math.abs(
        vertices.reduce((sum, [x, y], index) => {
          const next = vertices[(index + 1) % vertices.length];
          return sum + x * next[1] - next[0] * y;
        }, 0),
      ) / 2;
    expect(area).toBeLessThan(1000 * 538 * 0.8);
    expect(area).toBeGreaterThan(1000 * 132);
  });

  it("leaves unknown rooms unavailable and does not fabricate an exterior for missing inventory", () => {
    const graph = buildFloorCorridorGraph(hospital());
    expect(floorGraphRoute(graph, "WARD-A", "unmodeled-room")).toBeNull();
    expect(hospitalFootprintPath([])).toBe("");
  });
});

// Captured getBoundingClientRect()/CSS-zoom measurements from the three
// failing desktop fits. Adjacent edges differed by approximately5.7e-14px.
const fractionalFitMeasurements: Array<[string, number[][]]> = [
  [
    "normal1440",
    [
      [
        13.997724624007992, 7.989344580720351, 1152.004550751984,
        122.00122093345914,
      ],
      [
        13.997724624007992, 129.99056551417948, 1152.004550751984,
        27.995449248015984,
      ],
      [
        484.992507908319, 129.99056551417948, 209.99861257561463,
        293.0026638548199,
      ],
      [
        694.9911204839336, 199.9955602419668, 29.992785393196073,
        27.995449248015984,
      ],
      [
        724.9839058771297, 165.97535934291582, 441.01836949886234,
        96.035851046118,
      ],
      [
        13.997724624007992, 277.9898995504745, 441.00199789111497,
        109.01853598978856,
      ],
      [
        454.9997225151229, 318.49325711748713, 29.992785393196073,
        27.995449248015984,
      ],
      [
        694.9911204839336, 318.49325711748713, 29.992785393196073,
        27.995449248015984,
      ],
      [
        724.9839058771297, 289.4991397968811, 441.01836949886234,
        86.00005549697542,
      ],
    ],
  ],
  [
    "normal1001280",
    [
      [
        13.98604001861331, 7.973941368078176, 992.0279199627735,
        162.8013029315961,
      ],
      [
        13.98604001861331, 170.77524429967428, 992.0279199627735,
        27.97208003722662,
      ],
      [
        404.99395067473245, 170.77524429967428, 209.98045602605865,
        296.68124709167057,
      ],
      [
        614.9744067007911, 241.68636575151234, 29.997208003722662,
        27.97208003722662,
      ],
      [
        644.9716147045137, 206.72126570497906, 361.042345276873,
        97.93392275476967,
      ],
      [
        13.98604001861331, 320.6030711959051, 361.0107026523965,
        110.90739879013495,
      ],
      [
        374.99674267100977, 362.054909260121, 29.997208003722662,
        27.97208003722662,
      ],
      [
        614.9744067007911, 362.054909260121, 29.997208003722662,
        27.97208003722662,
      ],
      [
        644.9716147045137, 333.07026523964635, 361.042345276873,
        85.9730107026524,
      ],
    ],
  ],
  [
    "fullscreen1600",
    [
      [
        13.994224538667417, 7.989998591350894, 1526.011550922665,
        122.49246372728553,
      ],
      [
        13.994224538667417, 130.48246231863644, 1526.011550922665,
        27.988449077334835,
      ],
      [
        672.0042259473165, 130.48246231863644, 209.99154810536695,
        293.98816734751375,
      ],
      [
        881.9957740526835, 200.73503310325398, 29.98985772644034,
        27.988449077334835,
      ],
      [
        911.9856317791238, 166.46090998732214, 628.0201436822088,
        96.53669530919848,
      ],
      [
        13.994224538667417, 278.9776024792224, 628.0201436822088,
        109.514579518242,
      ],
      [
        642.0143682208761, 319.740667699676, 29.98985772644034,
        27.988449077334835,
      ],
      [
        881.9957740526835, 319.740667699676, 29.98985772644034,
        27.988449077334835,
      ],
      [
        911.9856317791238, 290.7358782927173, 628.0201436822088,
        85.99802789125229,
      ],
    ],
  ],
];

describe("fractional fit footprint regression", () => {
  it.each(fractionalFitMeasurements)(
    "keeps the actual%s hospital connected without degenerate subpaths",
    (_label, values) => {
      const footprint = values.map(([x, y, width, height]) =>
        rect(x, y, width, height),
      );
      const original = JSON.stringify(footprint);
      const path = hospitalFootprintPath(footprint);
      expect(path.match(/M/g)).toHaveLength(1);
      expect(path.match(/Z/g)).toHaveLength(1);
      const points = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(
        (match) => [Number(match[1]), Number(match[2])],
      );
      expect(points.length).toBeGreaterThan(12);
      expect(
        points.every(
          (point, index) =>
            !index ||
            point[0] !== points[index - 1][0] ||
            point[1] !== points[index - 1][1],
        ),
      ).toBe(true);
      // Check the union still has inward courtyard corners, not an exterior box.
      expect(new Set(points.map(([x]) => x)).size).toBeGreaterThan(4);
      expect(new Set(points.map(([, y]) => y)).size).toBeGreaterThan(4);
      expect(JSON.stringify(footprint)).toBe(original);
    },
  );

  it.each([0.000001, 0.001, 0.25, 16])(
    "preserves a deliberate%spx separation instead of joining distinct rooms",
    (gap) => {
      const path = hospitalFootprintPath([
        rect(0, 0, 100, 100),
        rect(100 + gap, 0, 100, 100),
      ]);
      expect(path.match(/M/g)).toHaveLength(2);
      expect(path.match(/Z/g)).toHaveLength(2);
    },
  );

  it.each([0.32, 0.53, 0.67, 0.731, 0.86, 0.934])(
    "survives inverse measurement at CSS zoom%s with the intended courtyards intact",
    (scale) => {
      const input = hospital();
      const measured = input.footprint.map((r) => ({
        x: (r.x * scale + 234.453125 - 234.453125) / scale,
        y: (r.y * scale + 456.140625 - 456.140625) / scale,
        width: (r.width * scale) / scale,
        height: (r.height * scale) / scale,
      }));
      const path = hospitalFootprintPath(measured);
      expect(path.match(/M/g)).toHaveLength(1);
      expect(path.match(/Z/g)).toHaveLength(1);
      const points = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(
        (match) => [Number(match[1]), Number(match[2])],
      );
      const area =
        Math.abs(
          points.reduce((sum, [x, y], index) => {
            const next = points[(index + 1) % points.length];
            return sum + x * next[1] - next[0] * y;
          }, 0),
        ) / 2;
      expect(area).toBeLessThan(1000 * 538 * 0.8);
      expect(area).toBeGreaterThan(1000 * 132);
    },
  );
});
