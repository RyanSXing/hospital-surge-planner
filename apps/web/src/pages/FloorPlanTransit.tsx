import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  Fragment,
  type RefObject,
} from "react";
import {
  floorTransitTiming,
  floorTransitWindowAction,
  type FloorJourney,
  type FloorTransitStamp,
} from "./floorPlanTransitModel";
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
  motionDurationMs = 1000,
}: {
  building: RefObject<HTMLDivElement | null>;
  journeys: FloorJourney[];
  windowKey: string;
  from: string;
  to: string;
  active: boolean;
  zoom: number;
  motionDurationMs?: number;
}) {
  const overlay = useRef<HTMLDivElement>(null),
    lastWindow = useRef<FloorTransitStamp | null>(null);
  const [routes, setRoutes] = useState<
    Array<{
      journey: FloorJourney;
      path: string;
      delayMs: number;
      durationMs: number;
    }>
  >([]);
  useLayoutEffect(() => {
    const node = building.current;
    const action = floorTransitWindowAction(lastWindow.current, {
      key: windowKey,
      zoom,
      active,
      from,
      to,
    });
    if (!node || action === "clear") {
      setRoutes((current) => (current.length ? [] : current));
      if (lastWindow.current?.key === windowKey)
        lastWindow.current = { key: windowKey, zoom };
      return;
    }
    if (action === "hold") return;
    lastWindow.current = { key: windowKey, zoom };
    const graph = measureFloorCorridorGraph(node);
    if (!graph) {
      setRoutes([]);
      return;
    }
    setRoutes(
      journeys.flatMap((journey) => {
        const path = floorGraphJourneyPath(journey, graph);
        const timing = floorTransitTiming(journey, from, to, motionDurationMs);
        return path && timing
          ? [
              {
                journey,
                path,
                ...timing,
              },
            ]
          : [];
      }),
    );
  }, [active, windowKey, zoom, building, journeys, from, to, motionDurationMs]);
  useLayoutEffect(() => {
    const animations = [
      ...(overlay.current?.querySelectorAll<HTMLElement>(
        ".floor-transit-marker",
      ) || []),
    ].flatMap((marker) => {
      const timing = {
        duration: Number(marker.dataset.duration),
        delay: Number(marker.dataset.delay),
        fill: "both" as FillMode,
        easing: "linear",
      };
      const head = marker.animate(
        [
          { offsetDistance: "0%", opacity: 0 },
          { offsetDistance: "9%", opacity: 1, offset: 0.09 },
          { offsetDistance: "91%", opacity: 1, offset: 0.91 },
          { offsetDistance: "100%", opacity: 0 },
        ],
        timing,
      );
      const trail =
        marker.previousElementSibling?.querySelector<SVGPathElement>(
          ".floor-transit-trail",
        );
      return [
        head,
        ...(trail
          ? [
              trail.animate(
                [
                  { strokeDashoffset: "12", opacity: 0 },
                  { strokeDashoffset: "3", opacity: 0.55, offset: 0.09 },
                  { strokeDashoffset: "-79", opacity: 0.55, offset: 0.91 },
                  { strokeDashoffset: "-88", opacity: 0 },
                ],
                timing,
              ),
            ]
          : []),
      ];
    });
    return () => animations.forEach((animation) => animation.cancel());
  }, [routes]);
  useEffect(() => {
    const clear = () => setRoutes([]);
    const node = building.current;
    let width = node?.offsetWidth,
      height = node?.offsetHeight;
    const observer = new ResizeObserver(() => {
      if (
        node &&
        (node.offsetWidth !== width || node.offsetHeight !== height)
      ) {
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
      data-motion-duration={motionDurationMs}
    >
      {active
        ? routes.map(({ journey, path, delayMs, durationMs }) => (
            <Fragment key={journey.patientId}>
              <svg
                className="floor-transit-route"
                aria-hidden="true"
                data-patient-id={journey.patientId}
              >
                <path
                  className="floor-transit-trail"
                  d={path}
                  pathLength="100"
                />
              </svg>
              <span
                className="floor-transit-marker"
                data-patient-id={journey.patientId}
                data-from={journey.moves[0].from}
                data-to={journey.moves.at(-1)!.to}
                data-events={journey.moves
                  .map((move) => move.eventId)
                  .join(",")}
                data-delay={delayMs}
                data-duration={durationMs}
                data-window-to={to}
                data-path={path}
                style={{
                  offsetPath: `path("${path}")`,
                  offsetAnchor: "center",
                  opacity: 0,
                }}
              />
            </Fragment>
          ))
        : null}
    </div>
  );
}
