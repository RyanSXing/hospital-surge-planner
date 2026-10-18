import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  floorJourneyPath,
  type FloorAnchor,
  type FloorJourney,
} from "./floorPlanTransitModel";

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
    const bounds = node.getBoundingClientRect(),
      scale = bounds.width / node.offsetWidth;
    const corridor = node
      .querySelector<HTMLElement>(".floor-plan-corridor")
      ?.getBoundingClientRect();
    if (!corridor || !scale) return;
    const corridorY = (corridor.top + corridor.height / 2 - bounds.top) / scale;
    const anchors = new Map<string, FloorAnchor>([
      ["entrance", { x: 0, y: corridorY }],
    ]);
    node.querySelectorAll<HTMLElement>(".floor-plan-unit").forEach((room) => {
      const rect = room.getBoundingClientRect();
      anchors.set(room.dataset.unitId!, {
        x: (rect.left - bounds.left + rect.width * 0.45) / scale + 18,
        y:
          (room.closest(".floor-plan-upper-wing")
            ? rect.bottom - bounds.top
            : rect.top - bounds.top) / scale,
      });
    });
    const support = node
      .querySelector<HTMLElement>(".floor-plan-support-areas")
      ?.getBoundingClientRect();
    for (const [location, testId] of [
      ["ed-waiting", "floor-plan-ed-waiting"],
      ["bed-waiting", "floor-plan-bed-waiting"],
      ["discharge", "floor-plan-discharges"],
    ]) {
      const rect = node
        .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        ?.getBoundingClientRect();
      if (rect && support)
        anchors.set(location, {
          x: (rect.left - bounds.left) / scale,
          y: (rect.top + rect.height / 2 - bounds.top) / scale,
          corridorX: (support.left - bounds.left + 9) / scale,
        });
    }
    setRoutes(
      journeys.flatMap((journey) => {
        const path = floorJourneyPath(journey, anchors, corridorY);
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
    window.addEventListener("resize", clear);
    return () => window.removeEventListener("resize", clear);
  }, []);
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
