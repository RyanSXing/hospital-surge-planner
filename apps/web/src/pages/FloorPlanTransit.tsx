import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { FloorJourney } from "./floorPlanTransitModel";
import {
  floorGraphJourneyPath,
  measureFloorCorridorGraph,
} from "./floorPlanGeometry";

export default function FloorPlanTransit({
  building,
  journeys,
  windowKey,
  from,
  to,
  active,
  zoom,
}: {
  building: RefObject<HTMLDivElement | null>;
  journeys: FloorJourney[];
  windowKey: string;
  from: string;
  to: string;
  active: boolean;
  zoom: number;
}) {
  const overlay = useRef<HTMLDivElement>(null),
    lastWindow = useRef("");
  const [routes, setRoutes] = useState<
    Array<{ journey: FloorJourney; path: string; delay: number }>
  >([]);
  useLayoutEffect(() => {
    setRoutes([]);
    const node = building.current;
    if (!active || !node || !windowKey) {
      lastWindow.current = "";
      return;
    }
    if (lastWindow.current === windowKey) return;
    lastWindow.current = windowKey;
    const graph = measureFloorCorridorGraph(node);
    if (!graph) return;
    setRoutes(
      journeys.flatMap((journey) => {
        const path = floorGraphJourneyPath(journey, graph);
        const fraction =
          (Date.parse(journey.moves[0].at) - Date.parse(from)) /
          (Date.parse(to) - Date.parse(from));
        return path
          ? [
              {
                journey,
                path,
                delay: Math.max(0, Math.min(500, fraction * 500)),
              },
            ]
          : [];
      }),
    );
  }, [active, windowKey, zoom, building, journeys, from, to]);
  useEffect(() => {
    const animations = [
      ...(overlay.current?.querySelectorAll<HTMLElement>(
        ".floor-transit-marker",
      ) || []),
    ].map((marker) =>
      marker.animate(
        [
          { offsetDistance: "0%", opacity: 0 },
          { offsetDistance: "8%", opacity: 0.9, offset: 0.08 },
          { offsetDistance: "92%", opacity: 0.9, offset: 0.92 },
          { offsetDistance: "100%", opacity: 0 },
        ],
        {
          duration: 900 - Number(marker.dataset.delay),
          delay: Number(marker.dataset.delay),
          fill: "both",
          easing: "linear",
        },
      ),
    );
    return () => animations.forEach((animation) => animation.cancel());
  }, [routes]);
  useEffect(() => {
    const clear = () => setRoutes([]);
    const node = building.current;
    let width = node?.offsetWidth,
      height = node?.offsetHeight;
    const observer = new ResizeObserver(() => {
      if (node && (node.offsetWidth !== width || node.offsetHeight !== height)) {
        width = node.offsetWidth;
        height = node.offsetHeight;
        // Keep the last window consumed: a resize must not replay earlier moves.
        clear();
      }
    });
    if (node) observer.observe(node);
    window.addEventListener("resize", clear);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", clear);
    };
  }, [building]);
  return (
    <div
      ref={overlay}
      className="floor-plan-transit"
      aria-hidden="true"
      data-testid="floor-plan-transit"
      data-window-from={active ? from : ""}
      data-window-to={active ? to : ""}
    >
      {active
        ? routes.map(({ journey, path, delay }) => (
            <span
              key={`${windowKey}:${journey.patientId}`}
              className="floor-transit-marker"
              data-patient-id={journey.patientId}
              data-from={journey.moves[0].from}
              data-to={journey.moves.at(-1)!.to}
              data-events={journey.moves.map((move) => move.eventId).join(",")}
              data-delay={delay}
              data-path={path}
              style={{
                offsetPath: `path("${path}")`,
                offsetAnchor: "center",
                opacity: 0,
              }}
            />
          ))
        : null}
    </div>
  );
}
