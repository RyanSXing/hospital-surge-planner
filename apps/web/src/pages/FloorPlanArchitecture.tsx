import { useLayoutEffect, useState, type RefObject } from "react";
import {
  hospitalFootprintPath,
  measureFloorCorridorGraph,
  type FloorCorridorGraph,
} from "./floorPlanGeometry";

export default function FloorPlanArchitecture({
  building,
  layoutKey,
  zoom,
}: {
  building: RefObject<HTMLDivElement | null>;
  layoutKey: string;
  zoom: number;
}) {
  const [layout, setLayout] = useState<{
    graph: FloorCorridorGraph;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const node = building.current;
    if (!node) return;
    const update = () => {
      const graph = measureFloorCorridorGraph(node);
      if (graph)
        setLayout({
          graph,
          width: node.offsetWidth,
          height: node.offsetHeight,
        });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [building, layoutKey, zoom]);
  return (
    <svg
      className="floor-plan-architecture"
      data-testid="hospital-footprint"
      data-corridor-nodes={
        layout ? JSON.stringify(Object.fromEntries(layout.graph.nodes)) : "{}"
      }
      aria-hidden="true"
      viewBox={`0 0 ${layout?.width || 1} ${layout?.height || 1}`}
    >
      {layout ? (
        <>
          <path
            data-testid="hospital-footprint-outline"
            className="floor-plan-outline"
            d={hospitalFootprintPath(layout.graph.footprint)}
          />
          {layout.graph.edges.map(([a, b]) => {
            const p = layout.graph.nodes.get(a)!,
              q = layout.graph.nodes.get(b)!;
            return (
              <path
                key={`${a}|${b}`}
                data-corridor-edge={`${a}|${b}`}
                className="floor-plan-network-edge"
                d={`M${p.x},${p.y} L${q.x},${q.y}`}
              />
            );
          })}
        </>
      ) : null}
    </svg>
  );
}
