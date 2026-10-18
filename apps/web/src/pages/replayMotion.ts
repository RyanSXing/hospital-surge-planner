export type ReplayPoint = { x: number; y: number };
export type ReplayMotion = {
  rep: string;
  at: number;
  fromAt: number;
  height: number;
  points: Map<string, ReplayPoint>;
  origins: Map<string, ReplayPoint>;
  routes: Map<string, ReplayPoint[]>;
  routeKeyframes: Map<string, number[]>;
  entering: Set<string>;
  startedAt: number;
  duration: number;
};

export function replayMotionProgress(
  motion: ReplayMotion,
  now: number,
): number {
  return motion.duration > 0
    ? Math.max(0, Math.min(1, (now - motion.startedAt) / motion.duration))
    : 1;
}

/** An event-only or newly-arrived marker stays absent until its first keyframe. */
export function replayRouteIsVisible(
  keyframes: number[] | undefined,
  progress: number,
): boolean {
  return !keyframes?.length || progress >= keyframes[0];
}

/** A stationary late arrival still needs its keyframe so it stays hidden. */
export function retainReplayRoute(
  pointCount: number,
  visibleAt: number,
): boolean {
  return pointCount > 1 || visibleAt > 0;
}

/** A presentation curve between two known states, not a clinical route or event. */
export function replayFramePoint(
  from: ReplayPoint,
  to: ReplayPoint,
  progress: number,
): ReplayPoint {
  const t = Math.max(0, Math.min(1, progress));
  const eased = t;
  const u = 1 - eased;
  const dx = to.x - from.x;
  return {
    x:
      u * u * u * from.x +
      3 * u * u * eased * (from.x + dx * 0.45) +
      3 * u * eased * eased * (to.x - dx * 0.45) +
      eased * eased * eased * to.x,
    y:
      u * u * u * from.y +
      3 * u * u * eased * from.y +
      3 * u * eased * eased * to.y +
      eased * eased * eased * to.y,
  };
}

/** Draw through the recorded stages in a window, at a constant readable pace. */
export function replayRoutePoint(
  points: ReplayPoint[],
  progress: number,
  keyframes?: number[],
): ReplayPoint {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  if (keyframes?.length === points.length) {
    const t = Math.max(0, Math.min(1, progress));
    // Several trace events can share a timestamp. At that instant the state
    // has already applied the highest sequence event, so use the final
    // keyframe at or before the displayed clock rather than the first one.
    let current = 0;
    while (current + 1 < keyframes.length && keyframes[current + 1] <= t)
      current++;
    if (current === keyframes.length - 1) return points[current];
    const from = keyframes[current];
    const to = keyframes[current + 1];
    return replayFramePoint(
      points[current],
      points[current + 1],
      to === from ? 1 : (t - from) / (to - from),
    );
  }
  const segments = points.length - 1;
  const value = Math.max(0, Math.min(1, progress)) * segments;
  const index = Math.min(segments - 1, Math.floor(value));
  const local = value - index;
  return replayFramePoint(points[index], points[index + 1], local);
}

export function prepareReplayMotion({
  previous,
  rep,
  at,
  height,
  points,
  origins,
  routes = new Map(),
  routeKeyframes = new Map(),
  replaceRoutes = false,
  playing,
  reduced,
  now,
  originAt,
}: {
  previous: ReplayMotion | null;
  rep: string;
  at: number;
  height: number;
  points: Map<string, ReplayPoint>;
  origins: Map<string, ReplayPoint>;
  routes?: Map<string, ReplayPoint[]>;
  routeKeyframes?: Map<string, number[]>;
  /** Only a deliberate cached-plan replacement may alter a same-sample route. */
  replaceRoutes?: boolean;
  playing: boolean;
  reduced: boolean;
  now: number;
  originAt?: number;
}): ReplayMotion {
  const continuous =
    playing && !reduced && previous?.rep === rep && previous.height === height;
  // Inspection/selection rerenders must not restart an animation already in flight.
  if (continuous && previous.at === at)
    return {
      ...previous,
      points,
      routes: replaceRoutes ? routes : previous.routes,
      routeKeyframes: replaceRoutes ? routeKeyframes : previous.routeKeyframes,
    };
  const advance = continuous && at > previous.at;
  return {
    rep,
    at,
    fromAt: advance ? Math.min(at, originAt ?? previous.at) : at,
    height,
    points,
    origins: advance ? origins : points,
    routes: advance ? routes : new Map(),
    routeKeyframes: advance ? routeKeyframes : new Map(),
    entering: advance
      ? new Set(
          Array.from(points.keys()).filter((id) => !previous.points.has(id)),
        )
      : new Set(),
    startedAt: now,
    duration: advance ? 1000 : 0,
  };
}
