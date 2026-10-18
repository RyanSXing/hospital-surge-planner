import ReplayCampusContext from "./ReplayCampusContext";
import { useEffect, useMemo, useRef, useState } from "react";
import "./replay.css";
import { Drawer, Tabs, NativeSelect } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  prepareReplayMotion,
  replayFramePoint,
  replayMotionProgress,
  replayRouteIsVisible,
  replayRoutePoint,
  retainReplayRoute,
  type ReplayMotion,
  type ReplayPoint,
} from "./replayMotion";
import {
  fetchReplayJourneyEvents,
  recordedDischarge,
  recordedJourneySteps,
  type ReplayJourneyZone,
} from "./replayJourney";
import { drawReplayBackdrop } from "./replayBackdrop";
import { usePatientPage } from "./usePatientPage";
import {
  ReplayAnnotations,
  ReplayEventWindow,
  ReplayPatientHistory,
  ReplayRecordedCapacity,
} from "./ReplayEvidence";
import {
  replayZone as zoneFor,
  replayCounts,
  replayPresence,
  replayClinicalInventory,
} from "./patientProjection";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Expand,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, atDay, fmt, items, localDate, patientId, post } from "../api";
import { Button, EmptyState, ErrorBox } from "../components/ui";
import { ZonedDateTimeInput } from "../components/ZonedDateTimeInput";
import { utcMinute } from "../zonedTime";
import { humanLabel } from "../presentation";
import {
  patientsOf,
  queueStats,
  statsFor,
  stateUnavailable,
  unitsOf,
} from "../model";
const zones = [
  { id: "arrivals", name: "ED entry / waiting", x: 20, y: 180, w: 125, h: 170 },
  { id: "ed", name: "ED treatment", x: 190, y: 160, w: 210, h: 210 },
  {
    id: "queue",
    name: "Waiting for a bed",
    x: 440,
    y: 185,
    w: 160,
    h: 160,
  },
  { id: "ward", name: "Ward care", x: 655, y: 40, w: 310, h: 240 },
  { id: "icu", name: "ICU care", x: 655, y: 320, w: 150, h: 170 },
  {
    id: "exit",
    name: "Discharge bay",
    x: 845,
    y: 470,
    w: 120,
    h: 105,
  },
];
function hospitalZone(zone: string) {
  return (
    (
      { clinic: "ed", overflow: "ward", transport: "queue" } as Record<
        string,
        string
      >
    )[zone] || zone
  );
}
function asJourneyZone(zone: string): ReplayJourneyZone {
  return ["arrivals", "ed", "queue", "ward", "icu", "exit"].includes(zone)
    ? (zone as ReplayJourneyZone)
    : "queue";
}
function hospitalOnly<T extends Entity>(rows: T[]) {
  return rows.filter(
    (row) => !row.facility_id || row.facility_id === "FAC-MAIN",
  );
}
function careName(value?: string) {
  return (
    (
      {
        ward: "Hospital ward",
        icu: "Intensive care",
        ed: "Emergency care",
        clinic: "Outpatient care",
      } as Record<string, string>
    )[value || ""] || "Care assessment"
  );
}
function stateName(value?: string) {
  return (
    (
      {
        ed_waiting: "Waiting for emergency care",
        ed_assessment: "Receiving emergency care",
        ed_boarding: "Waiting for an inpatient bed",
        direct_waiting: "Waiting for an inpatient bed",
        inpatient: "Admitted",
        transfer_reserved: "Preparing to move to a bed",
        in_transit: "Moving to a bed",
        clinic_assessment: "Receiving outpatient care",
        discharged: "Discharged",
        departed: "Discharged",
        transfer_out: "Left the hospital",
      } as Record<string, string>
    )[value || ""] || "Awaiting assessment"
  );
}
function layoutZone(z: (typeof zones)[number], height: number) {
  return { ...z, y: (z.y * height) / 620, h: (z.h * height) / 620 };
}
function position(
  p: Entity,
  height = 620,
  unitKinds: Record<string, string> = {},
) {
  const z = layoutZone(
    zones.find((z) => z.id === hospitalZone(zoneFor(p, unitKinds)))!,
    height,
  );
  let hash = 2166136261;
  for (const c of patientId(p)) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return {
    x: z.x + 18 + (hash % Math.max(1, z.w - 36)),
    y:
      z.y +
      Math.min(52, z.h - 14) +
      ((hash >>> 8) % Math.max(1, Math.floor(z.h - 110))),
    zone: z,
  };
}
function patientAtZone(patient: Entity, zone: ReplayJourneyZone): Entity {
  const state =
    zone === "arrivals"
      ? "ed_waiting"
      : zone === "ed"
        ? "ed_assessment"
        : zone === "queue"
          ? "direct_waiting"
          : zone === "ward" || zone === "icu"
            ? "inpatient"
            : "discharged";
  return {
    ...patient,
    state,
    unit_id: undefined,
    care_level:
      zone === "icu" ? "icu" : zone === "ward" ? "ward" : patient.care_level,
  };
}
function routePosition(
  patient: Entity,
  zone: ReplayJourneyZone,
  height: number,
  unitKinds: Record<string, string>,
) {
  return position(patientAtZone(patient, zone), height, unitKinds);
}
const journeyNeighbors: Record<ReplayJourneyZone, ReplayJourneyZone[]> = {
  arrivals: ["ed"],
  ed: ["arrivals", "queue"],
  queue: ["ed", "ward", "icu"],
  ward: ["queue", "exit"],
  icu: ["queue", "exit"],
  exit: ["ward", "icu"],
};
function routeZones(
  from: ReplayJourneyZone,
  to: ReplayJourneyZone,
): ReplayJourneyZone[] {
  if (from === to) return [from];
  const pending: ReplayJourneyZone[][] = [[from]];
  const visited = new Set<ReplayJourneyZone>([from]);
  while (pending.length) {
    const path = pending.shift()!;
    const last = path.at(-1)!;
    for (const next of journeyNeighbors[last]) {
      if (visited.has(next)) continue;
      const full = [...path, next];
      if (next === to) return full;
      visited.add(next);
      pending.push(full);
    }
  }
  return [from, to];
}
function corridorPoints(
  from: ReplayJourneyZone,
  to: ReplayJourneyZone,
  height: number,
) {
  const scale = height / 620;
  const point = (x: number, y: number) => ({ x, y: y * scale });
  const route = routeZones(from, to);
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < route.length - 1; index++) {
    const edge = `${route[index]}:${route[index + 1]}`;
    const reverse = `${route[index + 1]}:${route[index]}`;
    const segments: Record<string, { x: number; y: number }[]> = {
      "arrivals:ed": [point(150, 265), point(180, 265)],
      "ed:queue": [point(410, 265), point(430, 265)],
      "queue:ward": [point(620, 265), point(640, 265), point(640, 160)],
      "queue:icu": [point(620, 265), point(640, 265), point(640, 405)],
      "ward:exit": [
        point(640, 160),
        point(640, 405),
        point(830, 405),
        point(830, 520),
      ],
      "icu:exit": [point(820, 405), point(830, 405), point(830, 520)],
    };
    const edgePoints =
      segments[edge] || segments[reverse]?.slice().reverse() || [];
    points.push(...edgePoints);
  }
  return points;
}
function transitionRoute(
  patient: Entity,
  from: ReplayJourneyZone,
  stages: ReplayJourneyZone[],
  finalZone: ReplayJourneyZone,
  origin: { x: number; y: number },
  target: { x: number; y: number },
  height: number,
  unitKinds: Record<string, string>,
) {
  const route = [origin];
  let prior = from;
  for (const stage of [...stages, finalZone]) {
    if (prior !== stage) route.push(...corridorPoints(prior, stage, height));
    const atStage =
      stage === finalZone
        ? target
        : routePosition(patient, stage, height, unitKinds);
    // A duplicated waypoint gives each recorded care area a short visible
    // dwell instead of turning it into a one-frame corner in a long corridor.
    route.push(
      atStage,
      atStage,
      atStage,
      atStage,
      atStage,
      atStage,
      atStage,
      atStage,
    );
    prior = stage;
  }
  return route;
}
type TimedJourneyRoute = {
  points: ReplayPoint[];
  keyframes: number[];
  /** Event-only patients must not appear before their recorded arrival. */
  visibleAt: number;
};
type TransientJourney = TimedJourneyRoute & { patient: Entity };
type JourneyPresentation = {
  routes: Map<string, ReplayPoint[]>;
  routeKeyframes: Map<string, number[]>;
  transientJourneys: TransientJourney[];
  departureRoutes: Map<string, TimedJourneyRoute>;
  dischargeCarries: {
    id: string;
    patient: Entity;
    point: ReplayPoint;
    at: number;
  }[];
};
type ActiveJourneyWindow = {
  rep: string;
  at: number;
  events: Entity[];
  presentation?: JourneyPresentation;
};
function timedTransitionRoute(
  patient: Entity,
  from: ReplayJourneyZone,
  steps: { zone: ReplayJourneyZone; at: number }[],
  finalZone: ReplayJourneyZone,
  origin: ReplayPoint,
  target: ReplayPoint,
  height: number,
  unitKinds: Record<string, string>,
  fromAt: number,
  toAt: number,
  visibleAt = 0,
): TimedJourneyRoute {
  const points: ReplayPoint[] = [origin];
  const keyframes = [visibleAt];
  const span = Math.max(1, toAt - fromAt);
  let prior = from;
  let current = origin;
  let priorAt = visibleAt;
  const put = (point: ReplayPoint, at: number) => {
    const last = points.at(-1)!;
    const lastAt = keyframes.at(-1)!;
    if (last.x !== point.x || last.y !== point.y || lastAt !== at) {
      points.push(point);
      keyframes.push(at);
    }
  };
  const move = (
    stage: ReplayJourneyZone,
    eventAt: number,
    point: ReplayPoint,
  ) => {
    const eventProgress = Math.max(
      priorAt,
      Math.min(1, (eventAt - fromAt) / span),
    );
    if (stage === prior) {
      put(point, eventProgress);
      current = point;
      priorAt = eventProgress;
      return;
    }
    // Keep the dot in its recorded source until shortly before the trace
    // records the destination. This makes the displayed clock truthful.
    const travel = Math.min(
      0.12,
      Math.max(0.012, (eventProgress - priorAt) * 0.4),
    );
    const travelStart = Math.max(priorAt, eventProgress - travel);
    put(current, travelStart);
    const leg = [...corridorPoints(prior, stage, height), point];
    for (const [index, waypoint] of leg.entries())
      put(
        waypoint,
        travelStart +
          ((eventProgress - travelStart) * (index + 1)) / leg.length,
      );
    prior = stage;
    current = point;
    priorAt = eventProgress;
  };
  for (const step of steps) {
    if (!Number.isFinite(step.at)) continue;
    move(
      step.zone,
      step.at,
      routePosition(patient, step.zone, height, unitKinds),
    );
  }
  // The exact state at the sample end remains authoritative. In the unusual
  // event that the bounded event list has no matching final transition, delay
  // this presentation-only catch-up until the endpoint rather than inventing
  // an earlier clinical move.
  move(finalZone, toAt, target);
  put(target, 1);
  return { points, keyframes, visibleAt };
}
const timestamp = (at: string) =>
  localDate(at, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
export default function Replay({ ctx }: { ctx: PlanningContext }) {
  const queryClient = useQueryClient();
  const latestContext = useRef(ctx);
  latestContext.current = ctx;
  const displayClock = useRef<HTMLSpanElement>(null);
  const scrubber = useRef<HTMLInputElement>(null);
  const [buffering, setBuffering] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<string | null>("patient");
  const [advanced, setAdvanced] = useState(false);
  const [censusOpen, setCensusOpen] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    canvasHeight = 620,
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(4),
    [replications, setReplications] = useState<Entity[]>([]),
    [reduced, setReduced] = useState(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [pendingRep, setPendingRep] = useState(""),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(1),
    [mobileFocus, setMobileFocus] = useState("all"),
    [jumpTime, setJumpTime] = useState(utcMinute(ctx.selectedTime)),
    [stateFilter, setStateFilter] = useState("all"),
    [stepping, setStepping] = useState(false),
    [eventCursor, setEventCursor] = useState<Entity | null>(null),
    [selectedDetail, setSelectedDetail] = useState<Entity | null>(null);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  const motionState = useRef<ReplayMotion | null>(null);
  useEffect(() => setJumpTime(utcMinute(ctx.selectedTime)), [ctx.selectedTime]);
  const drawnPoints = useRef(new Map<string, { x: number; y: number }>());
  const drawnPatients = useRef<Entity[]>([]);
  const journeyWindows = useRef(new Map<string, Entity[]>());
  const activeJourneyWindow = useRef<ActiveJourneyWindow | null>(null);
  const dischargeHolds = useRef<
    Map<
      string,
      {
        patient: Entity;
        point: { x: number; y: number };
        notBefore: number;
        until: number | null;
      }
    >
  >(new Map());
  const dischargeHoldRegistrations = useRef(new Set<string>());
  const fadingPatients = useRef<{
    rep: string;
    at: number;
    patients: Entity[];
    origins: Map<string, { x: number; y: number }>;
  } | null>(null);
  const unavailable = stateUnavailable(ctx);
  const facilityTypes = useMemo(
    () =>
      Object.fromEntries(
        (ctx.dataset?.facilities || []).map((facility: Entity) => [
          facility.facility_id || facility.id,
          facility.kind,
        ]),
      ),
    [ctx.dataset?.facilities],
  );
  const unitKinds = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        unitsOf(ctx).map((unit: Entity) => [
          unit.unit_id || unit.id,
          unit.kind,
        ]),
      ),
    [ctx.dataset?.units, ctx.state?.units],
  );
  const patients = useMemo<Entity[]>(
    () =>
      hospitalOnly(patientsOf(ctx)).map((patient: Entity) => ({
        ...patient,
        facility_type: facilityTypes[patient.facility_id],
      })),
    [ctx.state, ctx.dataset, unavailable, facilityTypes],
  );
  const selectedProjection = useMemo<Entity | null>(
    () =>
      selectedDetail
        ? {
            ...selectedDetail,
            facility_type: facilityTypes[selectedDetail.facility_id],
          }
        : null,
    [selectedDetail, facilityTypes],
  );
  const q = queueStats(ctx, "FAC-MAIN"),
    ward = statsFor(ctx, "ward", "FAC-MAIN"),
    icu = statsFor(ctx, "icu", "FAC-MAIN");
  const rep = ctx.activeReplicationId || ctx.run?.selected_replication_id;
  const start =
    ctx.run?.start_at ||
    ctx.metrics?.start_at ||
    (ctx.resultScenario || ctx.scenario)?.start_at ||
    ctx.dataset?.snapshot_at ||
    "";
  const end =
    ctx.run?.end_at ||
    ctx.metrics?.end_at ||
    (start
      ? atDay(
          start,
          (ctx.resultScenario || ctx.scenario)?.horizon_calendar_days || 30,
          0,
          (ctx.resultScenario || ctx.scenario)?.timezone || "America/Chicago",
        )
      : "");
  const startMs = Date.parse(start),
    endMs = Date.parse(end),
    currentMs = Date.parse(ctx.selectedTime),
    durationHours = (endMs - startMs) / 3600000;
  const currentRep = replications.find(
      (r) => (r.replication_id || r.id) === rep,
    ),
    repIndex =
      currentRep?.replication_index ??
      ctx.metrics?.selected_replication_index ??
      0;
  const selected =
    patients.find(
      (p) => patientId(p) === patientId(ctx.selectedPatient || {}),
    ) ||
    (selectedProjection &&
    patientId(selectedProjection) === patientId(ctx.selectedPatient || {}) &&
    replayPresence(selectedProjection, ctx.selectedTime) === "active"
      ? selectedProjection
      : null);
  const inspected =
    selectedDetail &&
    patientId(selectedDetail) === patientId(ctx.selectedPatient || {})
      ? selectedDetail
      : selected || ctx.selectedPatient;
  const unitName = (id?: string) =>
    unitsOf(ctx).find((unit: Entity) => (unit.unit_id || unit.id) === id)
      ?.name ||
    (
      {
        "UNIT-ED": "Emergency department",
        "UNIT-WARD": "Hospital ward",
        "UNIT-ICU": "Intensive care",
      } as Record<string, string>
    )[id || ""] ||
    "Waiting area";
  const patientName = (patient: Entity) => {
    const id = patientId(patient);
    return `Patient ${id.match(/(\d+)$/)?.[1] || id.slice(-6)}`;
  };
  const patientTotal = Number(
    ctx.state?.patient_counts?.by_facility?.["FAC-MAIN"] ?? patients.length,
  );
  const lastScene = useRef({
    total: patientTotal,
    queue: q.total,
    at: ctx.selectedTime,
  });
  if (!unavailable)
    lastScene.current = {
      total: patientTotal,
      queue: q.total,
      at: ctx.state?.at || ctx.selectedTime,
    };
  const displayedScene = lastScene.current;
  const inspectedPresence = inspected
    ? replayPresence(inspected, ctx.selectedTime)
    : "unknown";
  const pathSignature = JSON.stringify([
    patientId(inspected || {}),
    inspected?.state_intervals || [],
  ]);
  const recordedPath = useMemo(
    () =>
      (inspected?.state_intervals || [])
        .filter(
          (interval: Entity) =>
            !interval.facility_id || interval.facility_id === "FAC-MAIN",
        )
        .map((interval: Entity) => ({
          at: Date.parse(interval.start_at),
          patient: {
            ...interval,
            facility_type: facilityTypes[interval.facility_id],
            patient_id: patientId(inspected || {}),
          },
        })),
    [pathSignature, facilityTypes],
  );
  useEffect(() => {
    let ignore = false;
    setSelectedDetail(null);
    if (!playing && rep && ctx.selectedPatient?.patient_id)
      api(
        `/runs/${rep}/patients/${encodeURIComponent(ctx.selectedPatient.patient_id)}?at=${encodeURIComponent(ctx.selectedTime)}`,
      )
        .then((value) => {
          if (!ignore) setSelectedDetail(value);
        })
        .catch((e) => {
          if (!ignore) setError(e.message);
        });
    return () => {
      ignore = true;
    };
  }, [rep, ctx.selectedPatient?.patient_id, ctx.selectedTime, playing]);
  const visiblePatients = useMemo<Entity[]>(() => {
    const sorted = [...patients].sort((a, b) =>
      patientId(a).localeCompare(patientId(b)),
    );
    if (selected) {
      const rest = sorted.filter((p) => patientId(p) !== patientId(selected));
      return [selected, ...rest].slice(0, 500);
    }
    return sorted.slice(0, 500);
  }, [patients, selected]);
  const hospitalCounts = useMemo(
    () =>
      replayCounts(
        ctx.state?.patient_groups
          ?.filter(
            (group: Entity) =>
              !group.facility_id || group.facility_id === "FAC-MAIN",
          )
          .map((group: Entity) => ({
            ...group,
            facility_type: facilityTypes[group.facility_id],
          })),
        patients,
        visiblePatients,
        unitKinds,
      ),
    [
      ctx.state?.patient_groups,
      patients,
      visiblePatients,
      facilityTypes,
      unitKinds,
    ],
  );
  const { totals: zoneTotals, grouped: groups } = useMemo(() => {
    const fold = (rows: Record<string, number>) =>
      Object.entries(rows).reduce<Record<string, number>>(
        (acc, [zone, count]) => {
          const target = hospitalZone(zone);
          acc[target] = (acc[target] || 0) + count;
          return acc;
        },
        {},
      );
    return {
      totals: fold(hospitalCounts.totals),
      grouped: fold(hospitalCounts.grouped),
    };
  }, [hospitalCounts]);
  const zoneInventory = useMemo(
    () => replayClinicalInventory(hospitalOnly(unitsOf(ctx)), facilityTypes),
    [ctx.state, ctx.dataset, unavailable, facilityTypes],
  );
  const backgroundOccupants = Object.values(zoneInventory).reduce(
    (total, inventory) => total + inventory.background,
    0,
  );
  const census = usePatientPage(
      censusOpen ? rep : undefined,
      ctx.selectedTime,
      {
        facility_id: "FAC-MAIN",
        state: stateFilter === "all" ? undefined : stateFilter,
      },
      50,
      patients.filter((p) => stateFilter === "all" || p.state === stateFilter),
    ),
    { page, setPage } = census;
  useEffect(() => {
    setEventCursor(null);
    setPlaying(false);
    journeyWindows.current.clear();
    activeJourneyWindow.current = null;
    dischargeHolds.current.clear();
    dischargeHoldRegistrations.current.clear();
    drawnPoints.current.clear();
    drawnPatients.current = [];
    motionState.current = null;
  }, [rep]);
  useEffect(() => {
    let ignore = false;
    setReplications([]);
    if (!ctx.run?.id) return;
    const load = async () => {
      try {
        let cursor: string | null = null;
        const rows: Entity[] = [];
        do {
          const value: Entity = await api(
            `/run-groups/${ctx.run!.id}/replications?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          if (ignore) return;
          rows.push(...items(value));
          cursor = value.next_cursor || null;
        } while (cursor);
        setReplications(
          rows.sort((a, b) => a.replication_index - b.replication_index),
        );
      } catch (e) {
        if (!ignore) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      ignore = true;
    };
  }, [ctx.run?.id]);
  useEffect(() => {
    if (!pendingRep) return;
    let ignore = false;
    const check = async () => {
      try {
        const status = await api(`/runs/${pendingRep}/trace`);
        if (ignore) return;
        if (status.ready || status.status === "SUCCEEDED") {
          ctx.setReplication(pendingRep);
          setPendingRep("");
          setError("");
          ctx.notify("This simulation run is ready to replay.");
        } else if (["FAILED", "CANCELLED"].includes(status.status)) {
          setError(
            status.error?.message || "Trace reconstruction did not complete.",
          );
          setPendingRep("");
        }
      } catch (e) {
        if (!ignore) {
          setError((e as Error).message);
          setPendingRep("");
        }
      }
    };
    void check();
    const timer = setInterval(check, 1500);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [pendingRep, ctx.setReplication, ctx.notify]);
  // Read ahead into the same immutable state cache used by the rest of the app.
  // Publish the next frame only once it is ready, so a sample boundary never
  // swaps the scene for a loading screen.
  useEffect(() => {
    if (!playing || !rep || !Number.isFinite(endMs)) return;
    let active = true;
    let frame = 0;
    let cursor = Date.parse(latestContext.current.selectedTime);
    let nextDue = performance.now();
    let waiting = false;
    const pending = new Set<number>();
    const ready = new Set<number>();
    const readAhead = () => {
      for (let index = 1; index <= 3; index++) {
        const at = Math.min(endMs, cursor + index * speed * 3600000);
        if (at <= cursor || ready.has(at) || pending.has(at)) continue;
        pending.add(at);
        const instant = new Date(at).toISOString();
        const intervalStart = new Date(
          cursor + (index - 1) * speed * 3600000,
        ).toISOString();
        const journeyKey = `${rep}|${intervalStart}|${instant}`;
        void Promise.all([
          queryClient.fetchQuery({
            queryKey: ["run-state", rep, instant],
            queryFn: () =>
              api(`/runs/${rep}/state?at=${encodeURIComponent(instant)}`),
            staleTime: Infinity,
          }),
          queryClient.fetchQuery({
            queryKey: ["replay-journey-events", rep, intervalStart, instant],
            queryFn: () =>
              fetchReplayJourneyEvents(api, rep, intervalStart, instant),
            staleTime: Infinity,
            gcTime: 5 * 60 * 1000,
          }),
        ])
          .then(([, events]) => {
            if (active) {
              journeyWindows.current.set(journeyKey, events);
              // Keep the in-memory window cache bounded during long replays.
              while (journeyWindows.current.size > 12)
                journeyWindows.current.delete(
                  journeyWindows.current.keys().next().value!,
                );
              ready.add(at);
            }
          })
          .catch((failure) => {
            if (active) {
              setError(
                `Playback could not load the next moment. ${failure.message}`,
              );
              setPlaying(false);
            }
          })
          .finally(() => pending.delete(at));
      }
    };
    const tick = (now: number) => {
      if (!active) return;
      if (document.hidden) {
        setPlaying(false);
        return;
      }
      if (now >= nextDue) {
        if (cursor >= endMs) {
          setPlaying(false);
          return;
        }
        const next = Math.min(endMs, cursor + speed * 3600000);
        if (ready.has(next)) {
          cursor = next;
          ready.delete(next);
          nextDue = now + 1000;
          latestContext.current.setTime(new Date(cursor).toISOString());
          if (waiting) {
            waiting = false;
            setBuffering(false);
          }
          readAhead();
        } else if (!waiting) {
          waiting = true;
          setBuffering(true);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    readAhead();
    frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      setBuffering(false);
    };
  }, [playing, speed, rep, endMs, queryClient]);
  useEffect(() => {
    const listener = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
  useEffect(() => {
    const node = canvas.current;
    if (!node || unavailable) return;
    const g = node.getContext("2d");
    if (!g) return;
    const dpr = window.devicePixelRatio || 1,
      W = 1000,
      H = canvasHeight;
    if (
      node.width !== Math.round(W * dpr) ||
      node.height !== Math.round(H * dpr)
    ) {
      node.width = Math.round(W * dpr);
      node.height = Math.round(H * dpr);
    }
    g.setTransform(node.width / W, 0, 0, node.height / H, 0, 0);
    const previous = motionState.current;
    const targetPoints = new Map(
      visiblePatients.map((patient) => [
        patientId(patient),
        position(patient, H, unitKinds),
      ]),
    );
    const recordedTime = Date.parse(ctx.state?.at || ctx.selectedTime);
    const cachedJourney = activeJourneyWindow.current;
    const sameSample =
      previous &&
      previous.rep === rep &&
      previous.at === recordedTime &&
      cachedJourney?.rep === rep &&
      cachedJourney.at === recordedTime;
    const advancingSample =
      !!previous && previous.rep === rep && previous.at < recordedTime;
    if (advancingSample) dischargeHoldRegistrations.current.clear();
    // A scheduled state can advance before the final animation frame. Carry
    // any explicit discharge that reached the prior sample boundary into this
    // frame so its discharge-bay dwell is never skipped at a window handoff.
    if (
      playing &&
      !reduced &&
      previous &&
      cachedJourney &&
      previous.rep === rep &&
      previous.at < recordedTime &&
      cachedJourney.rep === rep &&
      cachedJourney.at === previous.at
    ) {
      for (const carry of cachedJourney.presentation?.dischargeCarries || [])
        dischargeHolds.current.set(carry.id, {
          patient: carry.patient,
          point: carry.point,
          notBefore: carry.at,
          until: null,
        });
      for (const carry of cachedJourney.presentation?.dischargeCarries || [])
        dischargeHoldRegistrations.current.add(carry.id);
    }
    // At the natural end there is no following state change to trigger the
    // carry path. The endpoint is now exact, so it is safe to begin the same
    // short bay dwell for an explicit discharge stamped at that boundary.
    if (
      !playing &&
      !reduced &&
      recordedTime >= endMs &&
      sameSample &&
      cachedJourney?.presentation
    )
      for (const carry of cachedJourney.presentation.dischargeCarries) {
        if (!dischargeHoldRegistrations.current.has(carry.id)) {
          dischargeHoldRegistrations.current.add(carry.id);
          dischargeHolds.current.set(carry.id, {
            patient: carry.patient,
            point: carry.point,
            notBefore: carry.at,
            until: null,
          });
        }
      }
    const journeyEvents = sameSample
      ? cachedJourney.events
      : previous && previous.at < recordedTime
        ? journeyWindows.current.get(
            `${rep}|${new Date(previous.at).toISOString()}|${new Date(recordedTime).toISOString()}`,
          ) || []
        : [];
    if (previous && previous.rep === rep && previous.at < recordedTime)
      activeJourneyWindow.current = {
        rep,
        at: recordedTime,
        events: journeyEvents,
      };
    const previousPatients = new Map(
      drawnPatients.current.map((patient) => [patientId(patient), patient]),
    );
    const journeyEventsByPatient = new Map<string, Entity[]>();
    for (const event of journeyEvents) {
      if (!event.patient_id) continue;
      const rows = journeyEventsByPatient.get(event.patient_id) || [];
      rows.push(event);
      journeyEventsByPatient.set(event.patient_id, rows);
    }
    const journeyDischarges = new Map(
      Array.from(journeyEventsByPatient, ([id, events]) => [
        id,
        recordedDischarge(events, id),
      ]),
    );
    if (!previous || previous.rep !== rep || recordedTime < previous.at) {
      dischargeHolds.current.clear();
      dischargeHoldRegistrations.current.clear();
      activeJourneyWindow.current = null;
    }
    node.dataset.recordedAt = new Date(recordedTime).toISOString();
    const originPoints = new Map(
      drawnPoints.current.size ? drawnPoints.current : previous?.points || [],
    );
    for (const patient of visiblePatients) {
      if (
        !originPoints.has(patientId(patient)) &&
        previous &&
        Date.parse(patient.arrival_at) > previous.at &&
        Date.parse(patient.arrival_at) <= recordedTime
      )
        originPoints.set(
          patientId(patient),
          position(
            {
              ...patient,
              state:
                patient.entry_type === "direct_ward"
                  ? "direct_waiting"
                  : "ed_waiting",
            },
            H,
            unitKinds,
          ),
        );
    }
    const animationFromAt = Number.isFinite(
      Date.parse(node.dataset.visualAt || ""),
    )
      ? Date.parse(node.dataset.visualAt!)
      : previous?.at || recordedTime;
    const routes = new Map<string, ReplayPoint[]>();
    const routeKeyframes = new Map<string, number[]>();
    for (const patient of visiblePatients) {
      const id = patientId(patient);
      const origin = originPoints.get(id);
      const target = targetPoints.get(id)!;
      if (!origin || !previous || previous.at >= recordedTime) continue;
      const steps = recordedJourneySteps(
        journeyEventsByPatient.get(id) || [],
        id,
        unitKinds,
      ).filter((step) => step.zone !== "exit");
      const arrivedInWindow =
        !previousPatients.has(id) &&
        Date.parse(patient.arrival_at) > previous.at &&
        Date.parse(patient.arrival_at) <= recordedTime;
      const initialZone =
        steps[0]?.zone ||
        (patient.entry_type === "direct_ward" ? "queue" : "arrivals");
      const prior = previousPatients.get(id) || patient;
      const from = arrivedInWindow
        ? initialZone
        : asJourneyZone(hospitalZone(zoneFor(prior, unitKinds)));
      const final = asJourneyZone(hospitalZone(zoneFor(patient, unitKinds)));
      const arrivalEvent = (journeyEventsByPatient.get(id) || []).find(
        (event) => event.event_type === "arrival",
      );
      const visibleAt = arrivedInWindow
        ? Math.max(
            0,
            Math.min(
              1,
              (Date.parse(arrivalEvent?.occurred_at || patient.arrival_at) -
                animationFromAt) /
                Math.max(1, recordedTime - animationFromAt),
            ),
          )
        : 0;
      const route = timedTransitionRoute(
        patient,
        from,
        steps,
        final,
        origin,
        target,
        H,
        unitKinds,
        animationFromAt,
        recordedTime,
        visibleAt,
      );
      if (retainReplayRoute(route.points.length, visibleAt)) {
        routes.set(id, route.points);
        routeKeyframes.set(id, route.keyframes);
      }
    }
    const visibleIds = new Set(
      visiblePatients.map((patient) => patientId(patient)),
    );
    let transientJourneys: TransientJourney[] = Array.from(
      journeyEventsByPatient,
    )
      .filter(([id, events]) => {
        const names = new Set(events.map((event) => event.event_type));
        return (
          !visibleIds.has(id) &&
          !previousPatients.has(id) &&
          names.has("arrival") &&
          names.has("discharge")
        );
      })
      .map(([id, events]) => {
        const arrival = events.find((event) => event.event_type === "arrival")!;
        const patient = {
          patient_id: id,
          entry_type: arrival.payload?.entry_type || "ed",
          care_level: "ambulatory",
          state: "ed_waiting",
        };
        const steps = recordedJourneySteps(events, id, unitKinds);
        const first = steps[0]?.zone || "arrivals";
        const origin = routePosition(patient, first, H, unitKinds);
        const target = routePosition(patient, "exit", H, unitKinds);
        const arrivalAt = Math.max(
          0,
          Math.min(
            1,
            (Date.parse(arrival.occurred_at) - animationFromAt) /
              Math.max(1, recordedTime - animationFromAt),
          ),
        );
        return {
          patient,
          ...timedTransitionRoute(
            patient,
            first,
            steps,
            "exit",
            origin,
            target,
            H,
            unitKinds,
            animationFromAt,
            recordedTime,
            arrivalAt,
          ),
        };
      });
    if (!playing || reduced || !previous || previous.rep !== rep)
      fadingPatients.current = null;
    else if (previous.at !== recordedTime) {
      const patients = drawnPatients.current.filter(
        (patient) => !targetPoints.has(patientId(patient)),
      );
      fadingPatients.current = {
        rep: rep || "",
        at: recordedTime,
        patients,
        origins: new Map(
          patients.map((patient) => [
            patientId(patient),
            drawnPoints.current.get(patientId(patient)) ||
              position(patient, H, unitKinds),
          ]),
        ),
      };
    }
    const departing = fadingPatients.current?.patients || [];
    const departingOrigins = fadingPatients.current?.origins || new Map();
    const recordedDepartures = departing.filter((patient) =>
      journeyDischarges.get(patientId(patient)),
    );
    let departureRoutes = new Map<string, TimedJourneyRoute>();
    for (const patient of recordedDepartures) {
      const id = patientId(patient);
      const origin =
        departingOrigins.get(id) || position(patient, H, unitKinds);
      departureRoutes.set(
        id,
        timedTransitionRoute(
          patient,
          asJourneyZone(hospitalZone(zoneFor(patient, unitKinds))),
          recordedJourneySteps(
            journeyEventsByPatient.get(id) || [],
            id,
            unitKinds,
          ),
          "exit",
          origin,
          routePosition(patient, "exit", H, unitKinds),
          H,
          unitKinds,
          animationFromAt,
          recordedTime,
        ),
      );
    }
    const dischargeCarries = [
      ...recordedDepartures.flatMap((patient) => {
        const id = patientId(patient);
        const route = departureRoutes.get(id);
        return route
          ? [
              {
                id,
                patient,
                point: route.points.at(-1)!,
                at: Date.parse(journeyDischarges.get(id)!.occurred_at),
              },
            ]
          : [];
      }),
      ...transientJourneys.map((journey) => ({
        id: patientId(journey.patient),
        patient: journey.patient,
        point: journey.points.at(-1)!,
        at: Date.parse(
          journeyDischarges.get(patientId(journey.patient))!.occurred_at,
        ),
      })),
    ];
    const freshPresentation: JourneyPresentation = {
      routes,
      routeKeyframes,
      transientJourneys,
      departureRoutes,
      dischargeCarries,
    };
    // Selection and drawer changes rerender the same sample while the canvas
    // is moving. Keep the original timed plan; rebuilding it from a later
    // visual clock would shift recorded transitions under the viewer.
    const presentation =
      sameSample && cachedJourney?.presentation
        ? cachedJourney.presentation
        : freshPresentation;
    if (previous && previous.rep === rep && previous.at < recordedTime)
      activeJourneyWindow.current = {
        rep,
        at: recordedTime,
        events: journeyEvents,
        presentation,
      };
    transientJourneys = presentation.transientJourneys;
    departureRoutes = presentation.departureRoutes;
    drawnPatients.current = visiblePatients;
    const movedMarkers = visiblePatients.filter((patient) => {
      const prior = originPoints.get(patientId(patient));
      const target = targetPoints.get(patientId(patient))!;
      return prior && (prior.x !== target.x || prior.y !== target.y);
    }).length;
    const motion = prepareReplayMotion({
      previous,
      rep: rep || "",
      at: recordedTime,
      height: H,
      points: targetPoints,
      origins: originPoints,
      routes: presentation.routes,
      routeKeyframes: presentation.routeKeyframes,
      playing,
      reduced,
      now: performance.now(),
      originAt: animationFromAt,
    });
    const moving = motion.duration > 0;
    const presentationActive = playing && !reduced && moving;
    const finishingDischargeHold =
      !playing &&
      !reduced &&
      recordedTime >= endMs &&
      dischargeHolds.current.size > 0;
    node.dataset.previousMarkers = String(previous?.points.size || 0);
    node.dataset.movedMarkers = String(movedMarkers);
    node.dataset.visibleMarkers = String(visiblePatients.length);
    node.dataset.journeyEvents = String(journeyEvents.length);
    node.dataset.journeyRoutes = String(presentation.routes.size);
    node.dataset.dischargeJourneys = String(
      recordedDepartures.length + transientJourneys.length,
    );
    node.dataset.transientJourneys = String(transientJourneys.length);
    node.dataset.transientPatientIds = transientJourneys
      .map((journey) => patientId(journey.patient))
      .join(",");
    if (!transientJourneys.length) {
      node.dataset.journeyFrame = "[]";
      node.dataset.journeyFrameAt = "0";
    }
    node.dataset.snapshotOmissions = String(
      departing.length - recordedDepartures.length,
    );
    motionState.current = motion;
    function draw(progress: number) {
      if (!g || !node) return;
      if (!presentationActive && !finishingDischargeHold)
        dischargeHolds.current.clear();
      if (!presentationActive && !finishingDischargeHold)
        dischargeHoldRegistrations.current.clear();
      node.dataset.animating = String(presentationActive);
      node.dataset.paintCount = String(
        Number(node.dataset.paintCount || 0) + 1,
      );
      const visualTime =
        motion.fromAt + (recordedTime - motion.fromAt) * progress;
      node.dataset.visualAt = new Date(visualTime).toISOString();
      if (displayClock.current)
        displayClock.current.textContent = timestamp(
          new Date(visualTime).toISOString(),
        );
      if (scrubber.current && playing)
        scrubber.current.value = String((visualTime - startMs) / 60000);
      g.fillStyle = "#f7fafc";
      g.fillRect(0, 0, W, H);
      drawReplayBackdrop(g, W, H);
      g.lineCap = "round";
      g.strokeStyle = "#e5edf2";
      g.lineWidth = 30;
      g.beginPath();
      const yScale = H / 620;
      g.moveTo(145, 265 * yScale);
      g.lineTo(650, 265 * yScale);
      g.lineTo(650, 160 * yScale);
      g.moveTo(650, 265 * yScale);
      g.lineTo(650, 405 * yScale);
      g.lineTo(840, 405 * yScale);
      g.lineTo(840, 520 * yScale);
      g.lineTo(845, 520 * yScale);
      g.stroke();
      g.strokeStyle = "#bbcbd6";
      g.lineWidth = 1;
      g.setLineDash([5, 8]);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "#8aa2b1";
      for (const [x, y, angle] of [
        [168, 265 * yScale, 0],
        [425, 265 * yScale, 0],
        [640, 335 * yScale, Math.PI / 2],
        [832, 462 * yScale, Math.PI / 2],
      ]) {
        g.save();
        g.translate(x, y);
        g.rotate(angle);
        g.beginPath();
        g.moveTo(5, 0);
        g.lineTo(-4, -4);
        g.lineTo(-4, 4);
        g.closePath();
        g.fill();
        g.restore();
      }
      for (const original of zones) {
        const z = layoutZone(original, H);
        g.fillStyle =
          z.id === "queue"
            ? "#fff8eb"
            : z.id === "ward"
              ? "#f0f8fb"
              : "#ffffff";
        g.fillRect(z.x, z.y, z.w, z.h);
        g.strokeStyle =
          z.id === "queue"
            ? "#e3c58e"
            : z.id === "ward"
              ? "#5eafbf"
              : "#d2e0e8";
        g.lineWidth = z.id === "ward" ? 1.5 : 1;
        g.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
        g.fillStyle = "#243c4c";
        g.font = "600 13px system-ui";
        g.fillText(z.name, z.x + 10, z.y + 24);
        g.fillStyle = "#536b7d";
        g.font = "11px system-ui";
        const n = zoneTotals[z.id] || 0;
        if (z.id !== "exit" || z.h > 60)
          g.fillText(
            z.id === "exit"
              ? "Recorded discharges pause here"
              : `${n} patients`,
            z.x + 12,
            z.y + 44,
          );
        const inventory = zoneInventory[z.id];
        if (inventory && z.w >= 150) {
          g.fillStyle = "#536b7d";
          g.font = "10px system-ui";
          g.fillText(
            `${inventory.occupied}/${inventory.staffed} occupied / staffed`,
            z.x + 12,
            z.y + z.h - 10,
          );
        }
      }
      if (recordedPath.length) {
        const intervals = recordedPath.filter(
          (value: { at: number }) => value.at <= visualTime,
        ) as { at: number; patient: Entity }[];
        const path: { x: number; y: number }[] = [];
        for (const [index, interval] of intervals.entries()) {
          const target = position(interval.patient, H, unitKinds);
          if (!index) {
            path.push(target);
            continue;
          }
          const prior = intervals[index - 1].patient;
          const origin = path.at(-1)!;
          path.push(
            ...transitionRoute(
              interval.patient,
              asJourneyZone(hospitalZone(zoneFor(prior, unitKinds))),
              [],
              asJourneyZone(hospitalZone(zoneFor(interval.patient, unitKinds))),
              origin,
              target,
              H,
              unitKinds,
            ).slice(1),
          );
        }
        g.beginPath();
        for (let i = 0; i < path.length; i++) {
          if (i === 0) g.moveTo(path[i].x, path[i].y);
          else g.lineTo(path[i].x, path[i].y);
        }
        g.strokeStyle = "#0e849a";
        g.lineWidth = 2;
        g.setLineDash([4, 4]);
        g.stroke();
        g.setLineDash([]);
      }
      const framePoints = new Map<string, { x: number; y: number }>();
      const journeyFrame = new Map<
        string,
        { id: string; x: number; y: number }
      >();
      const dischargeProgress = (discharge: Entity) =>
        Math.max(
          0,
          Math.min(
            1,
            (Date.parse(discharge.occurred_at) - motion.fromAt) /
              Math.max(1, recordedTime - motion.fromAt),
          ),
        );
      const registerDischargeHold = (
        id: string,
        patient: Entity,
        point: ReplayPoint,
        at: number,
      ) => {
        if (!dischargeHoldRegistrations.current.has(id)) {
          dischargeHoldRegistrations.current.add(id);
          dischargeHolds.current.set(id, {
            patient,
            point,
            notBefore: at,
            until: performance.now() + 550,
          });
        }
      };
      for (const p of visiblePatients) {
        const target = targetPoints.get(patientId(p))!;
        const prior = motion.origins.get(patientId(p));
        const route = motion.routes.get(patientId(p));
        const keyframes = motion.routeKeyframes.get(patientId(p));
        if (moving && route && !replayRouteIsVisible(keyframes, progress))
          continue;
        const pos =
          moving && route?.length
            ? replayRoutePoint(route, progress, keyframes)
            : moving && prior
              ? replayFramePoint(prior, target, progress)
              : target;
        framePoints.set(patientId(p), pos);
        const chosen = patientId(ctx.selectedPatient || {}) === patientId(p);
        const visibleAt = keyframes?.[0] || 0;
        g.globalAlpha =
          moving && motion.entering.has(patientId(p))
            ? Math.min(1, Math.max(0, (progress - visibleAt) * 4))
            : 1;
        g.beginPath();
        g.arc(pos.x, pos.y, chosen ? 5.5 : 3, 0, Math.PI * 2);
        g.fillStyle = p.admission_pending
          ? "#b66b07"
          : p.care_level === "icu"
            ? "#c94b63"
            : "#0b8ca5";
        g.fill();
        if (chosen) {
          g.beginPath();
          g.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
          g.strokeStyle = "#0b8ca5";
          g.lineWidth = 1.5;
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      for (const patient of presentationActive ? departing : []) {
        const origin = departingOrigins.get(patientId(patient))!;
        const id = patientId(patient);
        const discharge = journeyDischarges.get(id);
        // A bounded snapshot can omit an active patient. Only an explicit,
        // recorded discharge sends a dot to the discharge bay.
        const dischargeRoute = departureRoutes.get(id);
        const point = dischargeRoute
          ? replayRoutePoint(
              dischargeRoute.points,
              progress,
              dischargeRoute.keyframes,
            )
          : origin;
        if (
          discharge &&
          dischargeRoute &&
          progress >= dischargeProgress(discharge)
        )
          registerDischargeHold(
            id,
            patient,
            dischargeRoute.points.at(-1)!,
            Date.parse(discharge.occurred_at),
          );
        if (discharge)
          journeyFrame.set(id, {
            id,
            x: Math.round(point.x),
            y: Math.round(point.y),
          });
        g.globalAlpha = discharge ? 1 : 1 - progress;
        g.beginPath();
        g.arc(point.x, point.y, 3, 0, Math.PI * 2);
        g.fillStyle = discharge ? "#4d7c5c" : "#0b8ca5";
        g.fill();
      }
      for (const journey of presentationActive ? transientJourneys : []) {
        const id = patientId(journey.patient);
        if (!replayRouteIsVisible(journey.keyframes, progress)) continue;
        const point = replayRoutePoint(
          journey.points,
          progress,
          journey.keyframes,
        );
        journeyFrame.set(id, {
          id,
          x: Math.round(point.x),
          y: Math.round(point.y),
        });
        const discharge = journeyDischarges.get(id);
        if (discharge && progress >= dischargeProgress(discharge))
          registerDischargeHold(
            id,
            journey.patient,
            journey.points.at(-1)!,
            Date.parse(discharge.occurred_at),
          );
        g.globalAlpha = Math.min(1, progress * 4);
        g.beginPath();
        g.arc(point.x, point.y, 3, 0, Math.PI * 2);
        g.fillStyle = "#4d7c5c";
        g.fill();
      }
      const now = performance.now();
      for (const [id, hold] of presentationActive || finishingDischargeHold
        ? dischargeHolds.current
        : []) {
        if (visualTime < hold.notBefore) continue;
        if (hold.until === null) hold.until = now + 550;
        if (hold.until <= now) {
          dischargeHolds.current.delete(id);
          continue;
        }
        journeyFrame.set(id, {
          id,
          x: Math.round(hold.point.x),
          y: Math.round(hold.point.y),
        });
        g.globalAlpha = Math.min(1, (hold.until - now) / 180);
        g.beginPath();
        g.arc(hold.point.x, hold.point.y, 3, 0, Math.PI * 2);
        g.fillStyle = "#4d7c5c";
        g.fill();
      }
      if (now - Number(node.dataset.journeyFrameAt || 0) >= 75) {
        node.dataset.journeyFrameAt = String(now);
        node.dataset.journeyFrame = JSON.stringify(
          Array.from(journeyFrame.values()),
        );
      }
      g.globalAlpha = 1;
      drawnPoints.current = framePoints;
      for (const original of zones) {
        if (!groups[original.id]) continue;
        const z = layoutZone(original, H),
          width = Math.min(z.w - 16, 138),
          x = z.x + (z.w - width) / 2,
          y = z.y + z.h - (zoneInventory[z.id] && z.w >= 150 ? 47 : 26);
        g.fillStyle = "#fff7e8";
        g.fillRect(x, y, width, 22);
        g.strokeStyle = "#e6bd72";
        g.lineWidth = 1;
        g.strokeRect(x, y, width, 22);
        g.fillStyle = "#b66b07";
        g.font = "600 10px system-ui";
        g.fillText(`+${fmt(groups[z.id])} more patients`, x + 7, y + 15);
      }
      g.fillStyle = "#536b7d";
      g.font = "10px system-ui";
      g.fillText("Vanderbilt hospital · care flow", 20, H - 14);
    }
    let frame = 0;
    if (playing && !reduced) {
      const paint = (now: number) => {
        const progress = replayMotionProgress(motion, now);
        draw(progress);
        frame = requestAnimationFrame(paint);
      };
      draw(replayMotionProgress(motion, performance.now()));
      frame = requestAnimationFrame(paint);
    } else if (finishingDischargeHold) {
      const paintHold = () => {
        draw(1);
        if (dischargeHolds.current.size)
          frame = requestAnimationFrame(paintHold);
      };
      paintHold();
    } else draw(1);
    return () => {
      cancelAnimationFrame(frame);
      node.dataset.animating = "false";
    };
  }, [
    patients,
    visiblePatients,
    groups,
    zoneTotals,
    ctx.selectedPatient,
    recordedPath,
    playing,
    reduced,
    rep,
    unavailable,
    ctx.state?.at,
    ctx.selectedTime,
    canvasHeight,
    zoneInventory,
    unitKinds,
    startMs,
    endMs,
  ]);
  async function chooseReplication(id: string) {
    setPlaying(false);
    setError("");
    if (!id || id === rep) return;
    try {
      const result = await post(`/runs/${id}/trace`);
      if (result.ready || result.status === "SUCCEEDED") ctx.setReplication(id);
      else setPendingRep(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function step(direction: "before" | "after") {
    if (!rep || stepping) return;
    setPlaying(false);
    setStepping(true);
    setError("");
    try {
      const sameInstant =
        eventCursor &&
        Date.parse(eventCursor.occurred_at) === Date.parse(ctx.selectedTime);
      const sequence =
        direction === "after"
          ? sameInstant
            ? eventCursor.sequence_number
            : 0
          : sameInstant
            ? eventCursor.sequence_number
            : Number.MAX_SAFE_INTEGER;
      const result = await api(
        `/runs/${rep}/events?at=${encodeURIComponent(ctx.selectedTime)}&direction=${direction}&${direction === "after" ? "after_sequence" : "before_sequence"}=${sequence}&limit=1`,
      );
      const next = items(result)[0];
      if (next) {
        setEventCursor(next);
        ctx.setTime(next.occurred_at);
      } else
        ctx.notify(
          direction === "after"
            ? "No later recorded event within this run."
            : "No earlier recorded event within this run.",
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStepping(false);
    }
  }
  async function restoreCheckpoint() {
    if (!rep) return;
    setPlaying(false);
    setError("");
    try {
      const result = await api(
        `/runs/${rep}/checkpoints?at=${encodeURIComponent(ctx.selectedTime)}`,
      );
      const checkpoint = items(result).at(-1);
      if (checkpoint?.at) ctx.setTime(checkpoint.at);
      else ctx.notify("No saved checkpoint exists before the selected time.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function pauseAtVisibleTime() {
    setPlaying(false);
    const visibleAt = canvas.current?.dataset.visualAt;
    const instant = Date.parse(visibleAt || "");
    // Freeze the moment the viewer was actually seeing. Request its exact
    // recorded state once; retain the canvas while that one seek completes.
    if (
      playing &&
      !reduced &&
      visibleAt &&
      Number.isFinite(instant) &&
      instant >= startMs &&
      instant <= endMs
    )
      ctx.setTime(visibleAt);
  }
  function move(at: string) {
    setPlaying(false);
    setEventCursor(null);
    ctx.setTime(at);
  }
  if (!ctx.run || ctx.run.status !== "SUCCEEDED")
    return (
      <div className="replay-page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">SIMULATION EXPLORER</div>
            <h1>Patient flow replay</h1>
          </div>
        </div>
        <EmptyState
          icon={Play}
          title="A patient-level view of your scenario"
          description="Run a simulation to watch patients arrive, receive care and leave the hospital."
          action={
            <Button
              primary
              disabled={ctx.canWrite === false}
              onClick={() => ctx.runScenario()}
            >
              Run scenario <ChevronRight size={15} />
            </Button>
          }
        />
      </div>
    );
  return (
    <div className="replay-page planning-panels">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SIMULATION EXPLORER</div>
          <h1>Patient flow replay</h1>
          <p>Watch patients move from arrival to treatment and discharge.</p>
        </div>
        <div className="heading-actions">
          <Button
            onClick={() => {
              pauseAtVisibleTime();
              setDetailOpen(true);
            }}
            aria-label="Inspect replay"
          >
            Inspect replay
          </Button>
          <label className="micro-label">
            <span>Simulation run</span>
            <NativeSelect
              aria-label="Select replication to replay"
              value={pendingRep || rep || ""}
              disabled={!!pendingRep}
              onChange={(e) => void chooseReplication(e.target.value)}
            >
              {replications.length ? (
                replications.map((r) => (
                  <option
                    key={r.replication_id || r.id}
                    value={r.replication_id || r.id}
                  >
                    Run {Number(r.replication_index) + 1}
                    {(r.replication_id || r.id) ===
                    ctx.run?.selected_replication_id
                      ? " · representative"
                      : ""}
                  </option>
                ))
              ) : (
                <option value={rep}>Run {Number(repIndex) + 1}</option>
              )}
            </NativeSelect>
          </label>
          <Button
            onClick={() => canvas.current?.parentElement?.requestFullscreen()}
          >
            <Expand size={15} />
            <span className="replay-expand-label">Expand</span>
          </Button>
        </div>
      </div>
      {error ? <ErrorBox error={error} onDismiss={() => setError("")} /> : null}
      {pendingRep ? (
        <div className="info-note" role="status">
          Preparing this simulation run…
        </div>
      ) : null}
      {unavailable && !playing ? (
        <div className="info-note" role="status">
          {ctx.stateError || "Loading the exact state at this timestamp…"}
        </div>
      ) : null}
      <div className="replay-location">
        <div>
          <strong>Vanderbilt hospital campus</strong>
          <span>Nashville, Tennessee · 1211 Medical Center Drive</span>
        </div>
        <details className="replay-campus-reference">
          <summary>Campus context · local map</summary>
          <ReplayCampusContext />
          <p>
            Planning simulation with generated patient data. Care zones are a
            simplified illustration, not a clinical floor plan.
          </p>
          <a
            href="https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center"
            target="_blank"
            rel="noreferrer"
          >
            Location reference ↗
          </a>
        </details>
      </div>
      <div className="replay-stage">
        <div className="replay-playback-panel">
          <div className="replay-controls">
            <div className="playback-buttons">
              <button
                aria-label="Return to run start"
                onClick={() => move(start)}
              >
                <SkipBack size={17} />
              </button>
              <button
                aria-label="Previous recorded event"
                disabled={stepping || unavailable}
                onClick={() => void step("before")}
              >
                <ChevronLeft size={18} />
              </button>
              <Button
                primary
                disabled={
                  (!playing && unavailable) || (!playing && currentMs >= endMs)
                }
                onClick={() =>
                  playing ? pauseAtVisibleTime() : setPlaying(true)
                }
                aria-label={playing ? "Pause replay" : "Play replay"}
              >
                {playing ? <Pause size={18} /> : <Play size={18} />}
                {playing ? "Pause" : "Play"}
              </Button>
              <button
                aria-label="Next recorded event"
                disabled={stepping || unavailable}
                onClick={() => void step("after")}
              >
                <ChevronRight size={18} />
              </button>
              <button aria-label="Go to run horizon" onClick={() => move(end)}>
                <SkipForward size={17} />
              </button>
              <NativeSelect
                aria-label="Replay speed"
                value={speed}
                onChange={(event) =>
                  setSpeed(Number(event.currentTarget.value))
                }
                className="replay-speed"
              >
                <option value={1}>1× · 1 hour / sec</option>
                <option value={4}>4× · 4 hours / sec</option>
                <option value={16}>16× · 16 hours / sec</option>
              </NativeSelect>
            </div>
            <div className="replay-time">
              <strong>
                <span ref={displayClock}>
                  {timestamp(
                    unavailable ? displayedScene.at : ctx.selectedTime,
                  )}
                </span>
              </strong>
              <span>
                {playing
                  ? buffering
                    ? "Preparing the next moment…"
                    : "Playing"
                  : unavailable
                    ? "Loading selected time…"
                    : "Paused"}
              </span>
            </div>
            <Button
              small
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              Advanced replay tools
            </Button>
          </div>
          <div className="replay-scrubber">
            <span>{localDate(start)}</span>
            <input
              ref={scrubber}
              aria-label="Replay timestamp across actual elapsed horizon"
              type="range"
              min={0}
              max={Math.max(0, (endMs - startMs) / 60000)}
              step={1}
              value={Math.max(
                0,
                Math.min(
                  (endMs - startMs) / 60000,
                  (currentMs - startMs) / 60000,
                ),
              )}
              onChange={(e) =>
                move(
                  new Date(
                    startMs + Number(e.target.value) * 60000,
                  ).toISOString(),
                )
              }
            />
            <span>
              {localDate(end)} · {fmt(durationHours)} elapsed h
            </span>
          </div>
        </div>
        <div className="replay-workspace">
          <div className="replay-scene">
            <div className="scene-topline">
              <span className="scene-tag">
                <span className="cyan-dot" />
                Hospital care flow
              </span>
              <div className="scene-legend">
                <span>
                  <i className="cyan-dot" />
                  Active
                </span>
                <span>
                  <i className="amber-dot" />
                  Inpatient waiting
                </span>
                <span>
                  <i className="red-dot" />
                  ICU care
                </span>

                <Button
                  small
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(0.75, z - 0.25))}
                >
                  <Minus size={13} />
                </Button>
                <Button
                  small
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(2, z + 0.25))}
                >
                  <Plus size={13} />
                </Button>
                <Button
                  small
                  aria-label="Reset schematic zoom"
                  onClick={() => setZoom(1)}
                >
                  <RotateCcw size={13} />
                </Button>
              </div>
            </div>
            <div className="replay-mobile-navigation">
              <label>
                Focus care zone
                <NativeSelect
                  value={mobileFocus}
                  onChange={(event) => {
                    const value = event.target.value;
                    setMobileFocus(value);
                    const node = canvas.current,
                      viewport = node?.parentElement;
                    if (!node || !viewport) return;
                    const zone = zones.find((zone) => zone.id === value);
                    const scale = node.getBoundingClientRect().width / 1000;
                    viewport.scrollTo({
                      left: zone
                        ? (zone.x + zone.w / 2) * scale -
                          viewport.clientWidth / 2
                        : 0,
                      top: zone
                        ? (zone.y + zone.h / 2) * scale -
                          viewport.clientHeight / 2
                        : 0,
                      behavior: reduced ? "instant" : "smooth",
                    });
                  }}
                >
                  <option value="all">Explore all zones</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name} · {fmt(zoneTotals[zone.id] || 0)} patients
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <p>
                Swipe the schematic to explore. Tap a patient to inspect their
                recorded care path.
              </p>
            </div>
            <div className="replay-canvas-viewport">
              <canvas
                ref={canvas}
                className="replay-canvas"
                style={{ "--replay-zoom": zoom } as React.CSSProperties}
                role="img"
                aria-label={`Hospital care flow: ${displayedScene.total} patients in the hospital; ${displayedScene.queue} waiting for an inpatient bed. Every patient is available in the patient list below.`}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect(),
                    x = ((e.clientX - rect.left) / rect.width) * 1000,
                    y = ((e.clientY - rect.top) / rect.height) * canvasHeight;
                  let best: Entity | null = null,
                    distance = 18;
                  for (const p of visiblePatients) {
                    const pos =
                        drawnPoints.current.get(patientId(p)) ||
                        position(p, canvasHeight, unitKinds),
                      d = Math.hypot(pos.x - x, pos.y - y);
                    if (d < distance) {
                      best = p;
                      distance = d;
                    }
                  }
                  if (best) {
                    pauseAtVisibleTime();
                    ctx.setPatient(best);
                    setDetailTab("patient");
                    setDetailOpen(true);
                  }
                }}
              />
            </div>
            <div className="replay-summary">
              <span>
                <strong>{fmt(displayedScene.total)}</strong> active patients
              </span>
              <span>
                <strong className="amber">{fmt(displayedScene.queue)}</strong>{" "}
                waiting for a bed
              </span>
              <span>
                {unavailable
                  ? "Showing the last loaded moment."
                  : inspected
                    ? "Selected patient highlighted."
                    : patientTotal > visiblePatients.length
                      ? `${visiblePatients.length} individual markers; ${fmt(patientTotal - visiblePatients.length)} grouped. Full census below.`
                      : backgroundOccupants > 0
                        ? `Includes ${fmt(backgroundOccupants)} beds occupied at the start.`
                        : "Select a dot to see the patient’s care journey."}
              </span>
            </div>
          </div>
          <Drawer
            opened={detailOpen}
            onClose={() => setDetailOpen(false)}
            title="Replay details"
            closeButtonProps={{ "aria-label": "Close replay details" }}
            position="right"
            size="440px"
            className="replay-detail-drawer"
            keepMounted
          >
            <Tabs value={detailTab} onChange={setDetailTab}>
              <Tabs.List>
                <Tabs.Tab value="patient">Patient</Tabs.Tab>
                <Tabs.Tab value="capacity">Capacity</Tabs.Tab>
                <Tabs.Tab value="events">Events</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="patient">
                <div className="replay-inspector" id="replay-inspector-dock">
                  <div className="inspector-header">
                    <div className="inspector-icon">
                      <Clock3 size={19} />
                    </div>
                    <div>
                      <span className="eyebrow">SELECTED SIMULATED TIME</span>
                      <h2>{timestamp(ctx.selectedTime)}</h2>
                    </div>
                  </div>
                  <div className="inspector-section">
                    <h3>
                      {inspected ? patientName(inspected) : "Hospital beds"}
                    </h3>
                    {inspected ? (
                      <dl className="detail-list">
                        <div>
                          <dt>Care status</dt>
                          <dd>
                            {inspectedPresence === "not_arrived"
                              ? "Not yet arrived"
                              : inspectedPresence === "departed"
                                ? "Discharged"
                                : stateName(inspected.state)}
                          </dd>
                        </div>
                        <div>
                          <dt>Current location</dt>
                          <dd>
                            {inspectedPresence !== "active"
                              ? "No active location at this timestamp"
                              : unitName(inspected.unit_id)}
                          </dd>
                        </div>
                        <div>
                          <dt>Required care</dt>
                          <dd>
                            {careName(
                              inspected.target_unit_kind ||
                                inspected.care_level,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Waiting for a bed</dt>
                          <dd>
                            {inspectedPresence === "active" &&
                            inspected.admission_pending
                              ? "Yes"
                              : "No"}
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <>
                        <div className="replay-count">
                          <span>Main ward</span>
                          <strong>
                            {ward.occupied} <small>/ {ward.staffed}</small>
                          </strong>
                        </div>
                        <div className="replay-count">
                          <span>ICU</span>
                          <strong>
                            {icu.occupied} <small>/ {icu.staffed}</small>
                          </strong>
                        </div>
                        <p className="small-copy muted">
                          Beds occupied / beds supported by available staff.
                        </p>
                      </>
                    )}
                    {inspected && inspectedPresence === "active" ? (
                      <div className="replay-patient-resources">
                        {inspected.blockers?.length ? (
                          <div className="constraint-callout">
                            <strong className="amber">
                              Why this patient is waiting
                            </strong>
                            <ul>
                              {inspected.blockers.map((reason: string) => (
                                <li key={reason}>{humanLabel(reason)}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <details>
                          <summary>Occupied resources and requirements</summary>
                          <p className="small-copy">
                            Allocated:{" "}
                            {(inspected.allocated_resource_ids || []).join(
                              " · ",
                            ) ||
                              inspected.slot_id ||
                              "No allocated resource recorded"}
                          </p>
                          <ul className="requirements-list">
                            {(
                              inspected.inpatient_resource_requirements ||
                              inspected.resource_requirements ||
                              []
                            ).map(
                              (requirement: Entity | string, index: number) => (
                                <li key={index}>
                                  {typeof requirement === "string"
                                    ? humanLabel(requirement)
                                    : `${humanLabel(requirement.capability_code || requirement.resource_type || "Resource")} × ${requirement.quantity ?? 1}`}
                                </li>
                              ),
                            )}
                          </ul>
                        </details>
                        <details className="replay-identifiers">
                          <summary>Technical record</summary>
                          <dl className="detail-list">
                            <div>
                              <dt>Patient record</dt>
                              <dd>{patientId(inspected)}</dd>
                            </div>
                            <div>
                              <dt>Unit record</dt>
                              <dd>{inspected.unit_id || "No unit assigned"}</dd>
                            </div>
                            <div>
                              <dt>Bed record</dt>
                              <dd>{inspected.slot_id || "No bed assigned"}</dd>
                            </div>
                          </dl>
                        </details>
                      </div>
                    ) : null}
                    <Button small onClick={() => ctx.setPage("patients")}>
                      Inspect detailed census <ChevronRight size={13} />
                    </Button>
                    {inspected ? (
                      <ReplayPatientHistory
                        patient={inspected}
                        at={ctx.selectedTime}
                        cursor={eventCursor}
                        onSelect={(event) => {
                          move(event.occurred_at);
                          setEventCursor(event);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              </Tabs.Panel>
              <Tabs.Panel value="capacity">
                <ReplayRecordedCapacity ctx={ctx} />
              </Tabs.Panel>
              <Tabs.Panel value="events">
                <ReplayEventWindow
                  rep={detailOpen && detailTab === "events" ? rep || "" : ""}
                  at={ctx.selectedTime}
                  patient={inspected || null}
                  cursor={eventCursor}
                  onSelect={(event) => {
                    move(event.occurred_at);
                    setEventCursor(event);
                  }}
                />
              </Tabs.Panel>
            </Tabs>
          </Drawer>
        </div>
      </div>
      {advanced ? (
        <section className="replay-advanced" aria-label="Advanced replay tools">
          <form
            className="replay-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const instant = Date.parse(`${jumpTime}Z`);
              if (
                Number.isFinite(instant) &&
                instant >= startMs &&
                instant <= endMs
              )
                move(new Date(instant).toISOString());
              else
                setError(
                  "Choose a valid local time within this completed run.",
                );
            }}
          >
            <ZonedDateTimeInput
              label="Jump replay date and time"
              value={jumpTime}
              onChange={setJumpTime}
              timeZone={
                (ctx.resultScenario || ctx.scenario)?.timezone ||
                "America/Chicago"
              }
              required
            />
            <Button small type="submit">
              Go
            </Button>
          </form>
          <label className="reduced-motion">
            <input
              type="checkbox"
              checked={reduced}
              onChange={(e) => {
                setReduced(e.target.checked);
                setPlaying(false);
              }}
            />
            Reduced motion
          </label>
          <Button
            small
            disabled={!rep || unavailable}
            onClick={() => void restoreCheckpoint()}
          >
            <RotateCcw size={13} />
            Go to saved checkpoint
          </Button>
          <p className="small-copy">
            Exact times and event sequences come from the saved run. Smooth
            movement only connects recorded states; it does not create
            intermediate clinical events.
          </p>
          <ReplayAnnotations
            rep={rep || ""}
            start={start}
            end={end}
            at={ctx.selectedTime}
            onSeek={move}
          />
        </section>
      ) : null}
      <div className="replay-census-toggle">
        <Button
          aria-expanded={censusOpen}
          onClick={() => {
            pauseAtVisibleTime();
            setCensusOpen(!censusOpen);
          }}
        >
          {censusOpen ? "Hide patient census" : "View patient census"}
        </Button>
        <span>
          {fmt(patientTotal)} active patients · {visiblePatients.length}{" "}
          individual dots
          {patientTotal > visiblePatients.length
            ? ` · ${fmt(patientTotal - visiblePatients.length)} represented in grouped counts`
            : ""}
        </span>
      </div>
      {censusOpen ? (
        <section className="patient-census">
          <div className="census-toolbar">
            <div>
              <h3>
                Patient list <span className="muted">{fmt(census.total)}</span>
              </h3>
              <span className="micro-label">
                Patients in the hospital at the selected time.
              </span>
            </div>
            <NativeSelect
              aria-label="Replay census state filter"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
            >
              <option value="all">All active states</option>
              {Object.keys(
                ctx.state?.patient_counts?.by_state ||
                  Object.fromEntries(patients.map((p) => [p.state, 1])),
              )
                .sort()
                .map((state) => (
                  <option key={state} value={state}>
                    {stateName(state)}
                  </option>
                ))}
            </NativeSelect>
          </div>
          {census.error ? <ErrorBox error={census.error} /> : null}
          {census.loading ? (
            <div className="info-note" role="status">
              Loading this census page…
            </div>
          ) : null}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Care status</th>
                  <th>Care unit</th>
                  <th>Required care</th>
                  <th>Waiting for a bed</th>
                </tr>
              </thead>
              <tbody>
                {census.rows.map((p) => (
                  <tr
                    key={patientId(p)}
                    className={
                      patientId(selected || {}) === patientId(p)
                        ? "selected"
                        : ""
                    }
                  >
                    <td>
                      <button
                        className="link-button"
                        onClick={() => {
                          setPlaying(false);
                          ctx.setPatient(p);
                          setDetailTab("patient");
                          setDetailOpen(true);
                        }}
                      >
                        {patientName(p)}
                      </button>
                    </td>
                    <td>{stateName(p.state)}</td>
                    <td>{unitName(p.unit_id)}</td>
                    <td>{careName(p.target_unit_kind || p.care_level)}</td>
                    <td>{p.admission_pending ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span>
              {Math.min(page * 50 + 1, census.total)}–
              {Math.min((page + 1) * 50, census.total)} of {fmt(census.total)}
            </span>
            <div>
              <button
                disabled={!page || census.loading}
                aria-label="Previous replay census page"
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                disabled={!census.hasNext || census.loading}
                aria-label="Next replay census page"
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
