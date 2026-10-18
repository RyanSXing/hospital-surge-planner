import ReplayCampusContext from "./ReplayCampusContext";
import ReplayFloorPlan from "./ReplayFloorPlan";
import ReplayDischargeHistory from "./ReplayDischargeHistory";
import { buildReplayFloorPlan } from "./replayFloorPlanModel";
import { createReplaySeekQueue } from "./replaySeekQueue";
import {
  advancePlaybackClock,
  createPlaybackBuffer,
  createPlaybackProjection,
  playbackTimestamp,
  type PreparedPlaybackWindow,
  type ReplayPlaybackWindow,
} from "./replayPlayback";
import {
  recordedFloorJourneys,
  floorRecordedTime,
  type FloorMotionWindow,
  type FloorPlaybackClock,
} from "./floorPlanTransitModel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./replay.css";
import { Drawer, Tabs, NativeSelect } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { usePatientPage } from "./usePatientPage";
import {
  ReplayAnnotations,
  ReplayEventWindow,
  ReplayPatientHistory,
  ReplayRecordedCapacity,
} from "./ReplayEvidence";
import { replayPresence } from "./patientProjection";
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
  const navigationGeneration = useRef(0);
  const pauseLatest = useRef<() => void>(() => {});
  pauseLatest.current = pauseAtVisibleTime;
  const displayClock = useRef<HTMLSpanElement>(null);
  const scrubber = useRef<HTMLInputElement>(null);
  const playbackRoot = useRef<HTMLDivElement>(null);
  const playhead = useRef(Date.parse(ctx.selectedTime));
  const awaitingExactAt = useRef<string | null>(null);
  const playbackSerial = useRef(0);
  const playbackLive = useRef<{
    rep: string;
    clock: FloorPlaybackClock;
    state: Entity;
    validUntilMs: number;
  } | null>(null);
  const [playbackSnapshot, setPlaybackSnapshot] = useState<{
    rep: string;
    state: Entity;
    validUntilMs: number;
    clock?: FloorPlaybackClock;
    playheadMs?: number;
  } | null>(null);
  const committedPlayback = useRef<{ session: string; state: Entity } | null>(
    null,
  );
  const [buffering, setBuffering] = useState(false);
  const [motionWindow, setMotionWindow] = useState<FloorMotionWindow | null>(
    null,
  );
  const [scrubTarget, setScrubTarget] = useState<{
    rep: string | undefined;
    at: string;
    pending: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const playbackExpectedTime = useRef(ctx.selectedTime);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<string | null>("patient");
  const [advanced, setAdvanced] = useState(false);
  const [censusOpen, setCensusOpen] = useState(false);
  const floorViewport = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(4),
    [replications, setReplications] = useState<Entity[]>([]),
    [reduced, setReduced] = useState(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [pendingRep, setPendingRep] = useState(""),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(1),
    [jumpTime, setJumpTime] = useState(utcMinute(ctx.selectedTime)),
    [stateFilter, setStateFilter] = useState("all"),
    [stepping, setStepping] = useState(false),
    [eventCursor, setEventCursor] = useState<Entity | null>(null),
    [selectedDetail, setSelectedDetail] = useState<Entity | null>(null);
  useEffect(
    () => () => {
      const live = playbackLive.current;
      if (!live?.clock.active) return;
      // Page navigation may unmount Replay before a normal pause. Commit only
      // this visible moment; App rejects it if navigation selected a different
      // run or explicitly changed the parent timestamp in the meantime.
      live.clock.active = false;
      latestContext.current.preserveReplayTime?.(
        live.rep,
        playbackExpectedTime.current,
        playbackTimestamp(live.clock.atMs),
      );
    },
    [],
  );
  useEffect(() => {
    const update = () =>
      setFullscreen(
        Boolean(floorViewport.current) &&
          document.fullscreenElement === floorViewport.current,
      );
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => setJumpTime(utcMinute(ctx.selectedTime)), [ctx.selectedTime]);
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
  const startMs = floorRecordedTime(start),
    endMs = floorRecordedTime(end),
    currentMs = floorRecordedTime(ctx.selectedTime),
    durationHours = (endMs - startMs) / 3600000;
  const seekQueue = useMemo(
    () =>
      createReplaySeekQueue<Entity>({
        load: async (at) => {
          if (!rep) throw new Error("Select a simulation run to replay.");
          const state = await queryClient.fetchQuery<Entity>({
            queryKey: ["run-state", rep, at],
            queryFn: () =>
              api(`/runs/${rep}/state?at=${encodeURIComponent(at)}`),
            staleTime: Infinity,
          });
          if (
            state.replication_id !== rep ||
            Date.parse(state.at) !== Date.parse(at)
          )
            throw new Error(
              "The recorded state does not match the selected moment.",
            );
          return state;
        },
        publish: (_state, at) => {
          awaitingExactAt.current = at;
          latestContext.current.setTime(at);
        },
        status: (at, pending) => setScrubTarget({ rep, at, pending }),
        error: (failure) =>
          setError(`Replay could not load that moment. ${failure.message}`),
      }),
    [rep, queryClient],
  );
  useEffect(() => {
    seekQueue.activate();
    return () => seekQueue.cancel();
  }, [seekQueue]);
  const seeking = Boolean(
    scrubTarget && scrubTarget.rep === rep && scrubTarget.pending,
  );
  const sliderMs =
    scrubTarget && scrubTarget.rep === rep && (dragging || seeking)
      ? Date.parse(scrubTarget.at)
      : currentMs;
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
  const retainedState = useRef<{
    rep: string | undefined;
    state: Entity | null;
  }>({ rep, state: null });
  if (retainedState.current.rep !== rep)
    retainedState.current = { rep, state: null };
  if (
    !unavailable &&
    ctx.state &&
    (!ctx.state.replication_id || ctx.state.replication_id === rep) &&
    Date.parse(ctx.state.at) === Date.parse(ctx.selectedTime)
  )
    retainedState.current.state = ctx.state;
  const localPlayback = playbackSnapshot?.rep === rep ? playbackSnapshot : null;
  const floorState = localPlayback?.state || retainedState.current.state;
  const floorPlan = useMemo(
    () => buildReplayFloorPlan(ctx.dataset, floorState),
    [ctx.dataset, floorState],
  );
  const motionUnitIds = floorPlan.units.map((unit) => unit.id).join("|");
  const floorJourneys = useMemo(
    () =>
      motionWindow
        ? (motionWindow.windows || [motionWindow]).flatMap((window) =>
            recordedFloorJourneys(
              window.events,
              motionUnitIds.split("|"),
              window.from,
              window.to,
            ),
          )
        : [],
    [motionWindow, motionUnitIds],
  );
  useEffect(() => {
    if (!playing || reduced) setMotionWindow(null);
  }, [playing, reduced, rep, speed]);
  useEffect(() => {
    if (playing && playbackExpectedTime.current !== ctx.selectedTime) {
      if (playbackLive.current) playbackLive.current.clock.active = false;
      playbackLive.current = null;
      setPlaying(false);
      setMotionWindow(null);
    }
    awaitingExactAt.current = ctx.selectedTime;
  }, [ctx.selectedTime]);
  useEffect(() => {
    if (
      !playing &&
      !unavailable &&
      ctx.state &&
      ctx.state.replication_id === rep &&
      floorRecordedTime(ctx.state.at) === currentMs &&
      floorRecordedTime(awaitingExactAt.current || "") === currentMs
    )
      setPlaybackSnapshot(null);
  }, [playing, unavailable, ctx.state, rep, currentMs]);
  const patientTotal = floorPlan.total;
  const displayedScene = {
    total: floorPlan.total,
    queue: floorPlan.bedWaiting,
    at: floorPlan.at || ctx.selectedTime,
  };
  function paintClock(atMs: number) {
    playhead.current = atMs;
    const at = new Date(atMs).toISOString();
    if (displayClock.current) {
      displayClock.current.textContent = timestamp(at);
      displayClock.current.dataset.playheadMs = String(atMs);
      displayClock.current.dataset.playbackSession = playbackLive.current?.clock
        .active
        ? playbackLive.current.clock.session
        : "";
    }
    if (playbackRoot.current)
      playbackRoot.current.dataset.playheadMs = String(atMs);
    if (scrubber.current)
      scrubber.current.value = String((atMs - startMs) / 60000);
  }
  useLayoutEffect(() => {
    if (!playing && Number.isFinite(Date.parse(displayedScene.at)))
      paintClock(Date.parse(displayedScene.at));
  }, [playing, displayedScene.at]);
  useLayoutEffect(() => {
    const snapshot = playbackSnapshot;
    if (
      !snapshot?.clock?.active ||
      snapshot.rep !== rep ||
      snapshot.playheadMs === undefined
    )
      return;
    snapshot.clock.atMs = snapshot.playheadMs;
    playbackLive.current = {
      rep: snapshot.rep,
      clock: snapshot.clock,
      state: snapshot.state,
      validUntilMs: snapshot.validUntilMs,
    };
    committedPlayback.current = {
      session: snapshot.clock.session,
      state: snapshot.state,
    };
    paintClock(snapshot.playheadMs);
  }, [playbackSnapshot, rep]);
  const inspectedPresence = inspected
    ? replayPresence(inspected, ctx.selectedTime)
    : "unknown";
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
  const census = usePatientPage(
      censusOpen ? rep : undefined,
      ctx.selectedTime,
      {
        facility_id: floorPlan.mainFacility,
        state: ["all", "awaiting_bed"].includes(stateFilter)
          ? undefined
          : stateFilter,
        admission_pending: stateFilter === "awaiting_bed" ? "true" : undefined,
      },
      50,
      patients.filter(
        (p) =>
          stateFilter === "all" ||
          (stateFilter === "awaiting_bed"
            ? p.admission_pending
            : p.state === stateFilter),
      ),
    ),
    { page, setPage } = census;
  useEffect(() => {
    navigationGeneration.current += 1;
    if (playbackLive.current) playbackLive.current.clock.active = false;
    playbackLive.current = null;
    setPlaybackSnapshot(null);
    setEventCursor(null);
    setPlaying(false);
    setDragging(false);
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
  // A video clock runs through complete, bounded recorded-change windows.
  // Clinical state changes only at their recorded boundaries; loading a window
  // never publishes its future end state or restarts the scene.
  useEffect(() => {
    if (!playing || !rep || !Number.isFinite(endMs) || !floorState) return;
    let active = true,
      frame = 0,
      lastWall = performance.now(),
      waiting = true;
    const prior = playbackLive.current;
    let cursor =
      prior?.rep === rep && prior.clock.atMs >= currentMs
        ? prior.clock.atMs
        : currentMs;
    let visibleState =
      prior?.rep === rep && cursor === prior.clock.atMs
        ? prior.state
        : floorState;
    const clock: FloorPlaybackClock = {
      session: `${rep}:${++playbackSerial.current}`,
      atMs: cursor,
      startMs: cursor,
      speed,
      active: true,
    };
    playbackLive.current = {
      rep,
      clock,
      state: visibleState,
      validUntilMs: cursor,
    };
    playbackExpectedTime.current = latestContext.current.selectedTime;
    const projectors = new Map<
      PreparedPlaybackWindow,
      ReturnType<typeof createPlaybackProjection>
    >();
    let lastPublished: Entity | null = null;
    const buffer = createPlaybackBuffer({
      replication: rep,
      runStartMs: startMs,
      startMs: cursor,
      endMs,
      lookAhead: Math.max(4, Math.ceil((speed * 3) / 4)),
      load: (from, to) =>
        api<ReplayPlaybackWindow>(
          `/runs/${rep}/playback-window?${new URLSearchParams({ start_at: from, end_at: to })}`,
        ),
      changed: () => {
        if (!active || !clock.active) return;
        const windows = buffer.windows();
        if (!reduced && windows.length)
          setMotionWindow({
            rep,
            from: windows[0].value.start_at,
            to: windows.at(-1)!.value.end_at,
            events: [],
            windows: windows.map(({ value }) => ({
              from: value.start_at,
              to: value.end_at,
              events: value.events,
            })),
            playback: clock,
          });
      },
      failure: (failure) => {
        if (!active || !clock.active) return;
        setError(
          `Playback could not load the next recorded interval. ${failure.message}`,
        );
        pauseAtVisibleTime();
      },
    });
    const tick = (now: number) => {
      if (!active || !clock.active) return;
      if (document.hidden) {
        pauseAtVisibleTime();
        return;
      }
      const elapsed = Math.min(100, Math.max(0, now - lastWall));
      lastWall = now;
      const next = advancePlaybackClock(
        cursor,
        elapsed,
        speed,
        buffer.runway(),
        endMs,
      );
      cursor = next.atMs;
      if (waiting !== next.buffering) {
        waiting = next.buffering;
        setBuffering(waiting);
      }
      const windows = buffer.windows();
      const window = windows.find(
        (value) => cursor >= value.startMs && cursor <= value.endMs + 0.001,
      );
      if (window) {
        if (!projectors.has(window))
          projectors.set(window, createPlaybackProjection(window));
        const projected = projectors.get(window)!.at(cursor);
        visibleState = projected.state;
        if (
          committedPlayback.current?.session === clock.session &&
          committedPlayback.current.state === visibleState
        ) {
          clock.atMs = cursor;
          playbackLive.current = {
            rep,
            clock,
            state: visibleState,
            validUntilMs: projected.validUntilMs,
          };
          paintClock(cursor);
        } else if (visibleState !== lastPublished) {
          lastPublished = visibleState;
          setPlaybackSnapshot({
            rep,
            state: visibleState,
            validUntilMs: projected.validUntilMs,
            clock,
            playheadMs: cursor,
          });
        }
        for (const value of projectors.keys())
          if (!windows.includes(value)) projectors.delete(value);
      }
      buffer.advance(clock.atMs);
      if (next.ended && clock.atMs >= endMs) {
        pauseAtVisibleTime();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    setBuffering(true);
    buffer.start();
    frame = requestAnimationFrame(tick);
    return () => {
      active = false;
      clock.active = false;
      cancelAnimationFrame(frame);
      buffer.cancel();
      setBuffering(false);
    };
  }, [playing, speed, rep, endMs, queryClient, reduced]);
  useEffect(() => {
    const listener = () => {
      if (document.hidden) pauseLatest.current();
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
  async function chooseReplication(id: string) {
    pauseAtVisibleTime();
    setError("");
    if (!id || id === rep) return;
    const navigation = navigationGeneration.current;
    try {
      const result = await post(`/runs/${id}/trace`);
      if (!isCurrentNavigation(navigation, rep)) return;
      if (result.ready || result.status === "SUCCEEDED") ctx.setReplication(id);
      else setPendingRep(id);
    } catch (e) {
      if (isCurrentNavigation(navigation, rep)) setError((e as Error).message);
    }
  }
  async function step(direction: "before" | "after") {
    if (!rep || stepping) return;
    const visibleAt = pauseAtVisibleTime();
    const navigation = navigationGeneration.current;
    setStepping(true);
    setError("");
    try {
      const sameInstant =
        eventCursor &&
        Date.parse(eventCursor.occurred_at) === Date.parse(visibleAt);
      const sequence =
        direction === "after"
          ? sameInstant
            ? eventCursor.sequence_number
            : 0
          : sameInstant
            ? eventCursor.sequence_number
            : Number.MAX_SAFE_INTEGER;
      const result = await api(
        `/runs/${rep}/events?at=${encodeURIComponent(visibleAt)}&direction=${direction}&${direction === "after" ? "after_sequence" : "before_sequence"}=${sequence}&limit=1`,
      );
      if (!isCurrentNavigation(navigation, rep)) return;
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
      if (isCurrentNavigation(navigation, rep)) setError((e as Error).message);
    } finally {
      setStepping(false);
    }
  }
  async function restoreCheckpoint() {
    if (!rep) return;
    const visibleAt = pauseAtVisibleTime();
    const navigation = navigationGeneration.current;
    setError("");
    try {
      const result = await api(
        `/runs/${rep}/checkpoints?at=${encodeURIComponent(visibleAt)}`,
      );
      if (!isCurrentNavigation(navigation, rep)) return;
      const checkpoint = items(result).at(-1);
      if (checkpoint?.at) ctx.setTime(checkpoint.at);
      else ctx.notify("No saved checkpoint exists before the selected time.");
    } catch (e) {
      if (isCurrentNavigation(navigation, rep)) setError((e as Error).message);
    }
  }
  function pauseAtVisibleTime() {
    const live =
      playbackLive.current?.rep === rep ? playbackLive.current : null;
    const visibleAt = live ? playbackTimestamp(live.clock.atMs) : floorPlan.at;
    if (live) {
      live.clock.active = false;
      setPlaybackSnapshot({
        rep: live.rep,
        state: {
          ...live.state,
          at: visibleAt,
          elapsed_minutes: (live.clock.atMs - startMs) / 60000,
        },
        validUntilMs: live.validUntilMs,
      });
    }
    setPlaying(false);
    cancelScrub();
    if (visibleAt) {
      awaitingExactAt.current = visibleAt;
      playbackExpectedTime.current = visibleAt;
      if (visibleAt !== ctx.selectedTime) ctx.setTime(visibleAt);
    }
    return visibleAt || ctx.selectedTime;
  }

  function move(at: string) {
    setPlaying(false);
    cancelScrub();
    setEventCursor(null);
    awaitingExactAt.current = at;
    ctx.setTime(at);
  }
  function cancelScrub() {
    if (playbackLive.current) playbackLive.current.clock.active = false;
    playbackLive.current = null;
    awaitingExactAt.current = null;
    setMotionWindow(null);
    navigationGeneration.current += 1;
    seekQueue.cancel();
    seekQueue.activate();
    setDragging(false);
    setScrubTarget(null);
  }
  function scrub(at: string) {
    if (playbackLive.current) playbackLive.current.clock.active = false;
    playbackLive.current = null;
    awaitingExactAt.current = null;
    navigationGeneration.current += 1;
    setPlaying(false);
    setMotionWindow(null);
    setEventCursor(null);
    seekQueue.request(at);
  }
  function isCurrentNavigation(
    generation: number,
    replication: string | undefined,
  ) {
    const current = latestContext.current;
    return (
      generation === navigationGeneration.current &&
      replication ===
        (current.activeReplicationId || current.run?.selected_replication_id)
    );
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
    <div
      ref={playbackRoot}
      className="replay-page planning-panels"
      data-seeking={seeking || undefined}
      data-playhead-ms={playhead.current}
      data-playback-session={
        playing ? motionWindow?.playback?.session || "preparing" : ""
      }
    >
      <div className="page-heading">
        <div>
          <div className="eyebrow">SIMULATION EXPLORER</div>
          <h1>Patient flow replay</h1>
          <p>
            See occupied beds, available capacity and pressure across the
            hospital.
          </p>
        </div>
        <div className="heading-actions">
          <details className="replay-campus-reference">
            <summary>Campus map</summary>
            <div className="replay-campus-popover">
              <strong>Vanderbilt hospital campus</strong>
              <span>Nashville, Tennessee · 1211 Medical Center Drive</span>
              <ReplayCampusContext />
              <p>
                Care zones illustrate the recorded hospital units and installed
                beds. This is a planning layout, not a clinical floor plan.
                Available places include shared staffing and equipment limits.
              </p>
              <a
                href="https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center"
                target="_blank"
                rel="noreferrer"
              >
                Location reference ↗
              </a>
            </div>
          </details>
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
          <Button onClick={() => floorViewport.current?.requestFullscreen()}>
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

      <div ref={floorViewport} className="replay-stage">
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
                  seeking ||
                  (!playing && unavailable) ||
                  (!playing && currentMs >= endMs)
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
            <div className="replay-map-tools" aria-label="Hospital map zoom">
              <Button
                small
                aria-label="Zoom out"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              >
                <Minus size={13} />
              </Button>
              <Button
                small
                aria-label="Zoom in"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              >
                <Plus size={13} />
              </Button>
              <Button
                small
                aria-label="Fit hospital map"
                aria-pressed={zoom === 1}
                onClick={() => setZoom(1)}
              >
                Fit
              </Button>
              {fullscreen ? (
                <Button
                  small
                  aria-label="Exit full screen"
                  onClick={() =>
                    void document
                      .exitFullscreen()
                      .catch((failure) =>
                        setError(
                          `Could not exit full screen. ${failure.message}`,
                        ),
                      )
                  }
                >
                  Exit full screen
                </Button>
              ) : null}
            </div>
            <div className="replay-time">
              <strong>
                <span
                  ref={displayClock}
                  data-testid="replay-playhead"
                  data-playhead-ms={playhead.current}
                  data-playback-session={
                    playing
                      ? motionWindow?.playback?.session || "preparing"
                      : ""
                  }
                >
                  {timestamp(
                    playing
                      ? new Date(playhead.current).toISOString()
                      : displayedScene.at,
                  )}
                </span>
              </strong>
              <span>
                {playing
                  ? buffering
                    ? "Preparing the next moment…"
                    : "Playing"
                  : seeking
                    ? "Updating recorded moment…"
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
              data-seeking={seeking || undefined}
              value={Math.max(
                0,
                Math.min(
                  (endMs - startMs) / 60000,
                  ((playing ? playhead.current : sliderMs) - startMs) / 60000,
                ),
              )}
              onPointerDown={() => {
                const at = pauseAtVisibleTime();
                setDragging(true);
                setScrubTarget({ rep, at, pending: false });
              }}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              onBlur={() => setDragging(false)}
              onChange={(e) =>
                scrub(
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
            <div className="replay-floor-viewport">
              <ReplayFloorPlan
                plan={floorPlan}
                retaining={(!playing && unavailable) || seeking}
                validUntil={
                  localPlayback
                    ? new Date(localPlayback.validUntilMs).toISOString()
                    : undefined
                }
                validUntilMs={localPlayback?.validUntilMs}
                zoom={zoom}
                selectedPatientId={patientId(ctx.selectedPatient || {})}
                selectedUnitId={ctx.selectedUnit}
                reducedMotion={reduced}
                journeys={floorJourneys}
                motionWindow={motionWindow}
                moving={Boolean(
                  playing && !reduced && motionWindow?.playback?.active,
                )}
                onBedSelect={(bed, unit) => {
                  pauseAtVisibleTime();
                  if (bed.patientId) {
                    ctx.setPatient(
                      bed.patient || {
                        patient_id: bed.patientId,
                        unit_id: unit.id,
                        slot_id: bed.id,
                      },
                    );
                    setDetailTab("patient");
                    setDetailOpen(true);
                  } else ctx.inspectEntity("slot", bed.id);
                }}
                onUnitSelect={(unit) => {
                  pauseAtVisibleTime();
                  ctx.setUnit(unit.id);
                  setDetailTab("capacity");
                  setDetailOpen(true);
                }}
                onAreaSelect={(area) => {
                  pauseAtVisibleTime();
                  if (area === "discharge") {
                    ctx.setPatient(null);
                    setDetailTab("discharges");
                    setDetailOpen(true);
                  } else {
                    setStateFilter(
                      area === "ed" ? "ed_waiting" : "awaiting_bed",
                    );
                    setCensusOpen(true);
                  }
                }}
              />
            </div>
            <div className="replay-summary">
              <span>
                <strong>
                  {displayedScene.total === null
                    ? "—"
                    : fmt(displayedScene.total)}
                </strong>{" "}
                active patients
              </span>
              <span>
                <strong className="amber">
                  {displayedScene.queue === null
                    ? "—"
                    : fmt(displayedScene.queue)}
                </strong>{" "}
                waiting for a bed
              </span>
              <Button
                small
                aria-expanded={censusOpen}
                onClick={() => {
                  pauseAtVisibleTime();
                  setCensusOpen(!censusOpen);
                }}
              >
                {censusOpen ? "Hide patient census" : "View patient census"}
              </Button>
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
                <Tabs.Tab value="discharges">Discharges</Tabs.Tab>
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
                <ReplayRecordedCapacity
                  key={ctx.selectedUnit || rep}
                  ctx={ctx}
                  initialUnit={ctx.selectedUnit}
                />
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
              <Tabs.Panel value="discharges">
                <ReplayDischargeHistory
                  rep={
                    detailOpen && detailTab === "discharges" ? rep || "" : ""
                  }
                  plan={floorPlan}
                  onSelect={(event) => {
                    move(event.occurred_at);
                    setEventCursor(event);
                    if (event.patient_id)
                      ctx.setPatient({ patient_id: event.patient_id });
                    setDetailTab("patient");
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
                pauseAtVisibleTime();
                setReduced(e.target.checked);
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
              <option value="ed_waiting">Waiting for emergency care</option>
              <option value="awaiting_bed">Waiting for a bed</option>
              {Object.keys(
                ctx.state?.patient_counts?.by_state ||
                  Object.fromEntries(patients.map((p) => [p.state, 1])),
              )
                .sort()
                .filter((state) => state !== "ed_waiting")
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
