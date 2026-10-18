import type { FloorAnchor, FloorJourney } from "./floorPlanTransitModel";

export interface FloorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FloorGeometryInput {
  spine: FloorRect;
  wardHall: FloorRect;
  entrance: FloorRect;
  edWaiting: FloorRect;
  bedWaiting: FloorRect;
  discharge: FloorRect;
  westHall: FloorRect;
  careHall: FloorRect;
  exitHall: FloorRect;
  units: Array<{ id: string; kind: string; rect: FloorRect }>;
  footprint: FloorRect[];
}
export interface FloorCorridorGraph {
  nodes: Map<string, FloorAnchor>;
  edges: Array<[string, string]>;
  footprint: FloorRect[];
}
const center = (rect: FloorRect) => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

/** The visible hospital spine and wing corridors are the only permitted transit routes. */
export function buildFloorCorridorGraph(
  input: FloorGeometryInput,
): FloorCorridorGraph {
  const laneX = input.spine.x + input.spine.width - 24;
  const entrance = center(input.entrance),
    waiting = center(input.edWaiting),
    admissions = center(input.bedWaiting);
  const nodes = new Map<string, FloorAnchor>([
    ["entrance", entrance],
    ["junction:entry", { x: laneX, y: entrance.y }],
    ["ed-waiting", { x: laneX, y: waiting.y }],
    ["bed-waiting", { x: laneX, y: admissions.y }],
    ["junction:wards", { x: laneX, y: center(input.wardHall).y }],
    ["discharge", { x: input.discharge.x, y: center(input.discharge).y }],
    [
      "junction:exit",
      { x: center(input.exitHall).x, y: center(input.discharge).y },
    ],
  ]);
  const edges: Array<[string, string]> = [
    ["entrance", "junction:entry"],
    ["junction:entry", "ed-waiting"],
    ["ed-waiting", "bed-waiting"],
    ["bed-waiting", "junction:wards"],
    ["ed-waiting", "junction:exit"],
    ["junction:exit", "discharge"],
  ];
  const emergency = input.units.filter(
    (unit) => !["ward", "icu"].includes(unit.kind),
  );
  const critical = input.units.filter((unit) => unit.kind === "icu");
  if (emergency.length) {
    nodes.set("junction:emergency", {
      x: center(input.westHall).x,
      y: waiting.y,
    });
    edges.push(["ed-waiting", "junction:emergency"]);
  }
  if (critical.length) {
    nodes.set("junction:critical", {
      x: center(input.careHall).x,
      y: admissions.y,
    });
    edges.push(["bed-waiting", "junction:critical"]);
  }
  for (const unit of input.units) {
    const middle = center(unit.rect),
      portal = `portal:${unit.id}`;
    if (unit.kind === "ward") {
      nodes.set(unit.id, { x: middle.x, y: unit.rect.y + unit.rect.height });
      nodes.set(portal, { x: middle.x, y: center(input.wardHall).y });
      edges.push([unit.id, portal], [portal, "junction:wards"]);
    } else {
      const isIcu = unit.kind === "icu",
        hall = isIcu ? input.careHall : input.westHall;
      nodes.set(unit.id, {
        x: isIcu ? unit.rect.x : unit.rect.x + unit.rect.width,
        y: middle.y,
      });
      nodes.set(portal, { x: center(hall).x, y: middle.y });
      edges.push(
        [unit.id, portal],
        [portal, isIcu ? "junction:critical" : "junction:emergency"],
      );
    }
  }
  // Keep edges axis-aligned even if a count-area label changes its height.
  const axisEdges: Array<[string, string]> = [];
  edges.forEach(([a, b], index) => {
    const start = nodes.get(a)!,
      end = nodes.get(b)!;
    if (start.x !== end.x && start.y !== end.y) {
      const corner = `corner:${index}`;
      nodes.set(corner, { x: start.x, y: end.y });
      axisEdges.push([a, corner], [corner, b]);
    } else axisEdges.push([a, b]);
  });
  return { nodes, edges: axisEdges, footprint: input.footprint };
}

export function floorGraphRoute(
  graph: FloorCorridorGraph,
  from: string,
  to: string,
): string[] | null {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null;
  const distances = new Map<string, number>([[from, 0]]),
    prior = new Map<string, string>(),
    pending = new Set(graph.nodes.keys());
  while (pending.size) {
    const current = [...pending].sort(
      (a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity),
    )[0];
    if (!Number.isFinite(distances.get(current))) break;
    if (current === to) {
      const route = [to];
      while (route[0] !== from) route.unshift(prior.get(route[0])!);
      return route;
    }
    pending.delete(current);
    for (const [a, b] of graph.edges) {
      const next = a === current ? b : b === current ? a : null;
      if (!next || !pending.has(next)) continue;
      const p = graph.nodes.get(current)!,
        q = graph.nodes.get(next)!;
      const value =
        distances.get(current)! + Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (value < (distances.get(next) ?? Infinity)) {
        distances.set(next, value);
        prior.set(next, current);
      }
    }
  }
  return null;
}
export function floorGraphJourneyPath(
  journey: FloorJourney,
  graph: FloorCorridorGraph,
): string | null {
  const points: FloorAnchor[] = [];
  for (const move of journey.moves) {
    const route = floorGraphRoute(graph, move.from, move.to);
    if (!route) return null;
    points.push(
      ...(points.length ? route.slice(1) : route).map((id) =>
        graph.nodes.get(id)!,
      ),
    );
  }
  return points
    .filter(
      (point, index) =>
        !index ||
        point.x !== points[index - 1].x ||
        point.y !== points[index - 1].y,
    )
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
    )
    .join(" ");
}

/** Union of occupied architectural rectangles; exterior courtyards stay outside the outline. */
export function hospitalFootprintPath(rectangles: FloorRect[]): string {
  const measured = rectangles
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.x,
      right: rect.x + rect.width,
      top: rect.y,
      bottom: rect.y + rect.height,
    }));
  // Reversing CSS zoom can give a shared edge two representations differing by
  // a few floating-point units. Canonicalize that numerical noise only; a pixel
  // tolerance would incorrectly close real courtyard or doorway gaps.
  const sharedEdges = (values: number[]) => {
    const canonical = new Map<number, number>();
    let anchor: number | undefined;
    for (const value of [...new Set(values)].sort((a, b) => a - b)) {
      const tolerance =
        64 *
        Number.EPSILON *
        Math.max(1, Math.abs(value), Math.abs(anchor ?? value));
      if (anchor === undefined || value - anchor > tolerance) anchor = value;
      canonical.set(value, anchor);
    }
    return canonical;
  };
  const horizontal = sharedEdges(
      measured.flatMap((rect) => [rect.left, rect.right]),
    ),
    vertical = sharedEdges(measured.flatMap((rect) => [rect.top, rect.bottom]));
  const rects = measured.map((rect) => ({
    left: horizontal.get(rect.left)!,
    right: horizontal.get(rect.right)!,
    top: vertical.get(rect.top)!,
    bottom: vertical.get(rect.bottom)!,
  }));
  const xs = [
    ...new Set(rects.flatMap((rect) => [rect.left, rect.right])),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set(rects.flatMap((rect) => [rect.top, rect.bottom])),
  ].sort((a, b) => a - b);
  const inside = (x: number, y: number) =>
    rects.some(
      (rect) =>
        x > rect.left && x < rect.right && y > rect.top && y < rect.bottom,
    );
  const covered = (i: number, j: number) =>
    i >= 0 &&
    j >= 0 &&
    i < xs.length - 1 &&
    j < ys.length - 1 &&
    inside((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
  const edges = new Map<string, string[]>(),
    // Vertex identity must use the same precision as the union grid. Rounding
    // here can collapse two real edges into a self-loop after topology is built.
    point = (x: number, y: number) => `${x},${y}`;
  const add = (a: string, b: string) =>
    edges.set(a, [...(edges.get(a) || []), b]);
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++)
      if (covered(i, j)) {
        const a = point(xs[i], ys[j]),
          b = point(xs[i + 1], ys[j]),
          c = point(xs[i + 1], ys[j + 1]),
          d = point(xs[i], ys[j + 1]);
        if (!covered(i, j - 1)) add(a, b);
        if (!covered(i + 1, j)) add(b, c);
        if (!covered(i, j + 1)) add(c, d);
        if (!covered(i - 1, j)) add(d, a);
      }
  const paths: string[] = [];
  while (edges.size) {
    const start = edges.keys().next().value!;
    let current = start;
    const path = [`M${start}`];
    do {
      const choices = edges.get(current)!;
      const next = choices.shift()!;
      if (!choices.length) edges.delete(current);
      path.push(`L${next}`);
      current = next;
    } while (current !== start && edges.has(current));
    paths.push(path.join(" ") + " Z");
  }
  return paths.join(" ");
}

export function measureFloorCorridorGraph(
  node: HTMLDivElement,
): FloorCorridorGraph | null {
  const bounds = node.getBoundingClientRect(),
    scale = bounds.width / node.offsetWidth;
  if (!scale) return null;
  const rect = (element: Element): FloorRect => {
    const box = element.getBoundingClientRect();
    return {
      x: (box.left - bounds.left) / scale,
      y: (box.top - bounds.top) / scale,
      width: box.width / scale,
      height: box.height / scale,
    };
  };
  const required = (selector: string) => {
    const element = node.querySelector(selector);
    return element ? rect(element) : null;
  };
  const spine = required(".floor-plan-front-spine"),
    wardHall = required(".floor-plan-ward-hall"),
    entrance = required(".floor-plan-entrance"),
    edWaiting = required('[data-testid="floor-plan-ed-waiting"]'),
    bedWaiting = required('[data-testid="floor-plan-bed-waiting"]'),
    discharge = required('[data-testid="floor-plan-discharges"]'),
    westHall = required(".floor-plan-emergency-hall"),
    careHall = required(".floor-plan-critical-hall"),
    exitHall = required(".floor-plan-exit-hall");
  if (
    !spine ||
    !wardHall ||
    !entrance ||
    !edWaiting ||
    !bedWaiting ||
    !discharge ||
    !westHall ||
    !careHall ||
    !exitHall
  )
    return null;
  return buildFloorCorridorGraph({
    spine,
    wardHall,
    entrance,
    edWaiting,
    bedWaiting,
    discharge,
    westHall,
    careHall,
    exitHall,
    units: [...node.querySelectorAll<HTMLElement>(".floor-plan-unit")].map(
      (room) => ({
        id: room.dataset.unitId!,
        kind: room.dataset.unitKind!,
        rect: rect(room),
      }),
    ),
    footprint: [...node.querySelectorAll("[data-footprint]")].map(rect),
  });
}
