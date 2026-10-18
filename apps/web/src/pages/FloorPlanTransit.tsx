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
  type FloorPlaybackClock,
} from "./floorPlanTransitModel";
import {
  floorGraphJourneyPath,
  measureFloorCorridorGraph,
} from "./floorPlanGeometry";
import { createContinuousFloorMotion } from "./floorContinuousMotion";

interface MotionRoute {
  journey: FloorJourney;
  path: string;
  delayMs: number;
  durationMs: number;
  startFraction?: number;
  length?: number;
  continued?: boolean;
  startedWallMs?: number;
}
function AnimatedRoute({ route, to }: { route: MotionRoute; to: string }) {
  const marker = useRef<HTMLSpanElement>(null),
    trail = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    if (!marker.current || !trail.current) return;
    const start = (route.startFraction || 0) * 100,
      tail = Math.min(12, 4800 / (route.length || 400)),
      span = 100 - start;
    const timing = {
      duration: route.durationMs,
      delay: route.delayMs,
      fill: "both" as FillMode,
      easing: "linear",
    };
    const head = marker.current.animate(
      [
        { offsetDistance: `${start}%`, opacity: route.continued ? 1 : 0 },
        { offsetDistance: `${start + span * 0.09}%`, opacity: 1, offset: 0.09 },
        { offsetDistance: `${start + span * 0.91}%`, opacity: 1, offset: 0.91 },
        { offsetDistance: "100%", opacity: 0 },
      ],
      timing,
    );
    const line = trail.current.animate(
      [
        {
          strokeDashoffset: String(tail - start),
          opacity: route.continued ? 0.55 : 0,
        },
        {
          strokeDashoffset: String(tail - start - span * 0.09),
          opacity: 0.55,
          offset: 0.09,
        },
        {
          strokeDashoffset: String(tail - start - span * 0.91),
          opacity: 0.55,
          offset: 0.91,
        },
        { strokeDashoffset: String(tail - 100), opacity: 0 },
      ],
      timing,
    );
    if (route.startedWallMs !== undefined) {
      // React may commit after the scheduler's RAF. Keep both animations on
      // that same wall clock so extending a path cannot jump the head by the
      // render delay or finish earlier than its visible animation.
      const elapsed = Math.max(0, performance.now() - route.startedWallMs);
      head.currentTime = elapsed;
      line.currentTime = elapsed;
    }
    return () => {
      head.cancel();
      line.cancel();
    };
  }, [route]);
  return (
    <Fragment>
      <svg
        className="floor-transit-route"
        aria-hidden="true"
        data-patient-id={route.journey.patientId}
      >
        <path
          ref={trail}
          className="floor-transit-trail"
          d={route.path}
          pathLength="100"
          style={{
            strokeDasharray: `${Math.min(12, 4800 / (route.length || 400))} 100`,
          }}
        />
      </svg>
      <span
        ref={marker}
        className="floor-transit-marker"
        data-patient-id={route.journey.patientId}
        data-from={route.journey.moves[0].from}
        data-to={route.journey.moves.at(-1)!.to}
        data-events={route.journey.moves.map((move) => move.eventId).join(",")}
        data-delay={route.delayMs}
        data-duration={route.durationMs}
        data-window-to={to}
        data-event-at={route.journey.moves.at(-1)!.at}
        data-path={route.path}
        style={{
          offsetPath: `path("${route.path}")`,
          offsetAnchor: "center",
          opacity: 0,
        }}
      />
    </Fragment>
  );
}

export default function FloorPlanTransit({
  building,
  journeys,
  windowKey,
  from,
  to,
  active,
  zoom,
  motionDurationMs = 1000,
  playback,
}: {
  building: RefObject<HTMLDivElement | null>;
  journeys: FloorJourney[];
  windowKey: string;
  from: string;
  to: string;
  active: boolean;
  zoom: number;
  motionDurationMs?: number;
  playback?: FloorPlaybackClock;
}) {
  const overlay = useRef<HTMLDivElement>(null),
    lastWindow = useRef<FloorTransitStamp | null>(null);
  const latestJourneys = useRef(journeys);
  latestJourneys.current = journeys;
  const lastSession = useRef("");
  const clearContinuous = useRef<(() => void) | null>(null);
  const [routes, setRoutes] = useState<MotionRoute[]>([]);
  useLayoutEffect(() => {
    if (!playback) return;
    setRoutes([]);
    const node = building.current;
    if (!active || !playback.active || !node) return;
    let graph = measureFloorCorridorGraph(node);
    if (!graph) return;
    const scheduler = createContinuousFloorMotion({
      startMs:
        lastSession.current === playback.session
          ? playback.atMs
          : playback.startMs,
      pathFor: (journey) =>
        graph ? floorGraphJourneyPath(journey, graph) : null,
    });
    lastSession.current = playback.session;
    let frame = 0,
      enabled = true,
      observed: FloorJourney[] | null = null,
      last: MotionRoute[] = [];
    clearContinuous.current = () => {
      last = scheduler.clear(playback.atMs);
      graph = measureFloorCorridorGraph(node);
      setRoutes(last);
    };
    const tick = (now: number) => {
      if (!enabled || !playback.active) return;
      if (observed !== latestJourneys.current) {
        observed = latestJourneys.current;
        scheduler.observe(observed);
      }
      const next = scheduler.tick(playback.atMs, now);
      if (next !== last) {
        last = next;
        setRoutes(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      enabled = false;
      cancelAnimationFrame(frame);
      clearContinuous.current = null;
    };
  }, [playback?.session, active, zoom, building]);
  useLayoutEffect(() => {
    if (playback) return;
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
  }, [
    active,
    windowKey,
    zoom,
    building,
    journeys,
    from,
    to,
    motionDurationMs,
    playback,
  ]);
  useEffect(() => {
    const clear = () => {
      clearContinuous.current?.();
      setRoutes([]);
    };
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
      data-playback-session={playback?.session || ""}
    >
      {active
        ? routes.map((route) => (
            <AnimatedRoute
              key={route.journey.patientId}
              route={route}
              to={to}
            />
          ))
        : null}
    </div>
  );
}
