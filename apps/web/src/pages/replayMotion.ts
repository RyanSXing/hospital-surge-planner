export type ReplayPoint = { x: number; y: number };
export type ReplayMotion = {
  rep: string;
  at: number;
  fromAt: number;
  height: number;
  points: Map<string, ReplayPoint>;
  origins: Map<string, ReplayPoint>;
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

export function prepareReplayMotion({
  previous,
  rep,
  at,
  height,
  points,
  origins,
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
  playing: boolean;
  reduced: boolean;
  now: number;
  originAt?: number;
}): ReplayMotion {
  const continuous =
    playing && !reduced && previous?.rep === rep && previous.height === height;
  // Inspection/selection rerenders must not restart an animation already in flight.
  if (continuous && previous.at === at) return { ...previous, points };
  const advance = continuous && at > previous.at;
  return {
    rep,
    at,
    fromAt: advance ? Math.min(at, originAt ?? previous.at) : at,
    height,
    points,
    origins: advance ? origins : points,
    entering: advance
      ? new Set(
          Array.from(points.keys()).filter((id) => !previous.points.has(id)),
        )
      : new Set(),
    startedAt: now,
    duration: advance ? 1000 : 0,
  };
}
