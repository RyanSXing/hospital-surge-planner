import ReplayCampusContext from "./ReplayCampusContext";
import { useEffect, useMemo, useRef, useState } from "react";
import "./replay.css";
import { Drawer, Tabs, NativeSelect } from "@mantine/core";
import {
  prepareReplayMotion,
  replayFramePoint,
  replayMotionProgress,
  type ReplayMotion,
} from "./replayMotion";
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
import { Badge, Button, EmptyState, ErrorBox } from "../components/ui";
import { ZonedDateTimeInput } from "../components/ZonedDateTimeInput";
import { utcMinute } from "../zonedTime";
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
    name: "Direct holding / transit",
    x: 440,
    y: 185,
    w: 160,
    h: 160,
  },
  { id: "ward", name: "Ward care", x: 655, y: 40, w: 310, h: 240 },
  { id: "icu", name: "ICU care", x: 655, y: 320, w: 150, h: 170 },
  { id: "clinic", name: "Outpatient clinic", x: 190, y: 445, w: 210, h: 130 },
  {
    id: "overflow",
    name: "Overflow",
    x: 440,
    y: 445,
    w: 160,
    h: 130,
  },
  { id: "transport", name: "Transport", x: 845, y: 320, w: 120, h: 145 },
  {
    id: "exit",
    name: "Discharge",
    x: 845,
    y: 470,
    w: 120,
    h: 105,
  },
];
function layoutZone(z: (typeof zones)[number], height: number) {
  return { ...z, y: (z.y * height) / 620, h: (z.h * height) / 620 };
}
function position(
  p: Entity,
  height = 620,
  unitKinds: Record<string, string> = {},
) {
  const z = layoutZone(
    zones.find((z) => z.id === zoneFor(p, unitKinds))!,
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
      patientsOf(ctx).map((patient: Entity) => ({
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
  const q = queueStats(ctx, "all"),
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
  const patientTotal = Number(ctx.state?.patient_total ?? patients.length);
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
      (inspected?.state_intervals || []).map((interval: Entity) => ({
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
    if (rep && ctx.selectedPatient?.patient_id)
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
  }, [rep, ctx.selectedPatient?.patient_id, ctx.selectedTime]);
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
  const { totals: zoneTotals, grouped: groups } = useMemo(
    () =>
      replayCounts(
        ctx.state?.patient_groups?.map((group: Entity) => ({
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
  const zoneInventory = useMemo(
    () => replayClinicalInventory(unitsOf(ctx), facilityTypes),
    [ctx.state, ctx.dataset, unavailable, facilityTypes],
  );
  const backgroundOccupants = Object.values(zoneInventory).reduce(
    (total, inventory) => total + inventory.background,
    0,
  );
  const census = usePatientPage(
      rep,
      ctx.selectedTime,
      { state: stateFilter === "all" ? undefined : stateFilter },
      50,
      patients.filter((p) => stateFilter === "all" || p.state === stateFilter),
    ),
    { page, setPage } = census;
  useEffect(() => {
    setEventCursor(null);
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
          ctx.notify(
            "Selected replication reconstructed from its saved inputs and seed.",
          );
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
  useEffect(() => {
    if (!playing || ctx.stateLoading || unavailable || !Number.isFinite(endMs))
      return;
    let frame = 0;
    const began = performance.now();
    const advance = (now: number) => {
      if (document.hidden) {
        setPlaying(false);
        return;
      }
      if (now - began < 1000) {
        frame = requestAnimationFrame(advance);
        return;
      }
      const next = Math.min(endMs, currentMs + speed * 3600000);
      ctx.setTime(new Date(next).toISOString());
      if (next >= endMs) setPlaying(false);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [
    playing,
    speed,
    ctx.stateLoading,
    unavailable,
    currentMs,
    endMs,
    ctx.setTime,
  ]);
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
      playing,
      reduced,
      now: performance.now(),
    });
    const moving = motion.duration > 0;
    node.dataset.previousMarkers = String(previous?.points.size || 0);
    node.dataset.movedMarkers = String(movedMarkers);
    node.dataset.visibleMarkers = String(visiblePatients.length);
    motionState.current = motion;
    function draw(progress: number) {
      if (!g || !node) return;
      node.dataset.animating = String(moving && progress < 1);
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
      g.lineTo(650, 405 * yScale);
      g.lineTo(840, 405 * yScale);
      g.lineTo(840, 520 * yScale);
      g.lineTo(845, 520 * yScale);
      g.moveTo(295, 370 * yScale);
      g.lineTo(295, 445 * yScale);
      g.moveTo(520, 345 * yScale);
      g.lineTo(520, 445 * yScale);
      g.stroke();
      g.strokeStyle = "#bbcbd6";
      g.lineWidth = 1;
      g.setLineDash([5, 8]);
      g.stroke();
      g.setLineDash([]);
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
            z.id === "exit" ? "Path endpoint" : `${n} active`,
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
        const path = recordedPath
          .filter((value: { at: number }) => value.at <= recordedTime)
          .map((value: { patient: Entity }) =>
            position(value.patient, H, unitKinds),
          );
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
      for (const p of visiblePatients) {
        const target = targetPoints.get(patientId(p))!;
        const prior = motion.origins.get(patientId(p));
        const pos =
          moving && prior ? replayFramePoint(prior, target, progress) : target;
        framePoints.set(patientId(p), pos);
        const chosen = patientId(ctx.selectedPatient || {}) === patientId(p);
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
        g.fillText(`1 marker = ${fmt(groups[z.id])}`, x + 7, y + 15);
      }
      g.fillStyle = "#536b7d";
      g.font = "10px system-ui";
      g.fillText(
        "SYNTHETIC CARE FLOW · SCHEMATIC POSITIONS · RECORDED PATIENT STATES",
        20,
        H - 14,
      );
    }
    let frame = 0;
    if (moving) {
      const paint = (now: number) => {
        const progress = replayMotionProgress(motion, now);
        draw(progress);
        if (progress < 1) frame = requestAnimationFrame(paint);
      };
      draw(replayMotionProgress(motion, performance.now()));
      frame = requestAnimationFrame(paint);
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
          description="Complete a simulation to inspect its recorded patient movements, queues, resource changes, and transfers."
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
          <p>Follow one simulated patient population through care.</p>
        </div>
        <div className="heading-actions">
          <Button
            onClick={() => setDetailOpen(true)}
            aria-label="Inspect replay"
          >
            Inspect replay
          </Button>
          <label className="micro-label">
            <span>Replication</span>
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
          Reconstructing this replication from its saved seed and frozen inputs…
        </div>
      ) : null}
      {unavailable ? (
        <div className="info-note" role="status">
          {ctx.stateError || "Loading the exact state at this timestamp…"}
        </div>
      ) : null}
      <div className="replay-location">
        <div>
          <strong>Vanderbilt hospital campus</strong>
          <span>Nashville, Tennessee · 1211 Medical Center Drive</span>
        </div>
        <Badge>Synthetic simulation</Badge>
        <a
          href="https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center"
          target="_blank"
          rel="noreferrer"
        >
          Location reference ↗
        </a>
        <p>
          Synthetic care flow, not Vanderbilt operational data or actual patient
          positions.
        </p>
        <details className="replay-campus-reference">
          <summary>Campus context · local map</summary>
          <ReplayCampusContext />
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
                disabled={unavailable || currentMs >= endMs}
                onClick={() => setPlaying(!playing)}
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
                {timestamp(unavailable ? displayedScene.at : ctx.selectedTime)}
              </strong>
              <span>
                {unavailable
                  ? "Loading recorded state…"
                  : playing
                    ? "Playing recorded simulation"
                    : "Paused · exact recorded state"}
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
                RUN {Number(repIndex) + 1} · CARE FLOW
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
                aria-label={`Hospital state schematic across all sites: ${displayedScene.total} active patients; ${displayedScene.queue} awaiting inpatient placement. Bed totals also include ${backgroundOccupants} anonymous partner occupants. Every individual patient is available in the accessible census below.`}
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
                inpatient requests
              </span>
              <span>
                {unavailable
                  ? "Loading the requested timestamp; the last recorded frame remains visible."
                  : inspected
                    ? `Highlighted recorded path: ${patientId(inspected)}.`
                    : patientTotal > visiblePatients.length
                      ? `${visiblePatients.length} individual markers; ${fmt(patientTotal - visiblePatients.length)} grouped. Full census below.`
                      : backgroundOccupants > 0
                        ? `Beds include ${fmt(backgroundOccupants)} anonymous partner occupants; positions are schematic.`
                        : "Exact recorded state; schematic positions only."}
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
                      {inspected
                        ? patientId(inspected)
                        : "Main hospital capacity"}
                    </h3>
                    {inspected ? (
                      <dl className="detail-list">
                        <div>
                          <dt>State</dt>
                          <dd>
                            {inspectedPresence === "not_arrived"
                              ? "Not yet arrived"
                              : inspectedPresence === "departed"
                                ? "Discharged"
                                : inspected.state?.replaceAll("_", " ") ||
                                  "Loading patient state…"}
                          </dd>
                        </div>
                        <div>
                          <dt>Actual unit / slot</dt>
                          <dd>
                            {inspectedPresence !== "active"
                              ? "No active location at this timestamp"
                              : inspected.unit_id || "Transit / queue"}
                            <br />
                            {inspectedPresence === "active"
                              ? inspected.slot_id || "No treatment slot"
                              : ""}
                          </dd>
                        </div>
                        <div>
                          <dt>Required care</dt>
                          <dd>
                            {inspected.target_unit_kind || inspected.care_level}
                          </dd>
                        </div>
                        <div>
                          <dt>Unresolved request</dt>
                          <dd>
                            {inspectedPresence === "active" &&
                            inspected.admission_pending
                              ? "Yes; waiting continues"
                              : "No"}
                          </dd>
                        </div>
                        {inspectedPresence === "active" &&
                        inspected.pending_transfer ? (
                          <div>
                            <dt>Destination</dt>
                            <dd>
                              {inspected.pending_transfer.destination_unit_id}
                            </dd>
                          </div>
                        ) : null}
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
                          Occupied / staffed. Partner patients remain tracked
                          separately in the full census.
                        </p>
                      </>
                    )}
                    {inspected && inspectedPresence === "active" ? (
                      <div className="replay-patient-resources">
                        {inspected.blockers?.length ? (
                          <div className="constraint-callout">
                            <strong className="amber">
                              Recorded placement blockers
                            </strong>
                            <ul>
                              {inspected.blockers.map((reason: string) => (
                                <li key={reason}>
                                  {reason.replaceAll("_", " ")}
                                </li>
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
                                    ? requirement.replaceAll("_", " ")
                                    : `${String(requirement.capability_code || requirement.resource_type || "Resource").replaceAll("_", " ")} × ${requirement.quantity ?? 1}`}
                                </li>
                              ),
                            )}
                          </ul>
                        </details>
                        {inspected.pending_transfer ? (
                          <details
                            key={inspected.pending_transfer.request_id}
                            className="replay-transfer-detail"
                          >
                            <summary>
                              Inspect transfer ·{" "}
                              {inspected.pending_transfer.status}
                            </summary>
                            <dl className="detail-list">
                              <div>
                                <dt>Request</dt>
                                <dd>{inspected.pending_transfer.request_id}</dd>
                              </div>
                              <div>
                                <dt>Source</dt>
                                <dd>
                                  {inspected.pending_transfer.source_unit_id ||
                                    "Holding queue"}
                                </dd>
                              </div>
                              <div>
                                <dt>Destination / reservation</dt>
                                <dd>
                                  {
                                    inspected.pending_transfer
                                      .destination_unit_id
                                  }
                                  <br />
                                  {
                                    inspected.pending_transfer
                                      .destination_slot_id
                                  }
                                </dd>
                              </div>
                              <div>
                                <dt>Vehicle</dt>
                                <dd>{inspected.pending_transfer.vehicle_id}</dd>
                              </div>
                              <div>
                                <dt>Planned departure</dt>
                                <dd>
                                  {timestamp(
                                    inspected.pending_transfer
                                      .planned_departure_at,
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>Planned arrival</dt>
                                <dd>
                                  {timestamp(
                                    inspected.pending_transfer
                                      .planned_arrival_at,
                                  )}
                                </dd>
                              </div>
                            </dl>
                            <p className="small-copy muted">
                              The source place remains occupied until recorded
                              departure. Planned times do not imply arrival has
                              occurred.
                            </p>
                          </details>
                        ) : null}
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
                  rep={rep || ""}
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
          onClick={() => setCensusOpen(!censusOpen)}
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
                Accessible replay census{" "}
                <span className="muted">{fmt(census.total)}</span>
              </h3>
              <span className="micro-label">
                Every active patient at this timestamp, including grouped
                markers
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
                    {state.replaceAll("_", " ")}
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
                  <th>State</th>
                  <th>Actual location</th>
                  <th>Required care</th>
                  <th>Inpatient waiting</th>
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
                          ctx.setPatient(p);
                          setDetailTab("patient");
                          setDetailOpen(true);
                        }}
                      >
                        {patientId(p)}
                      </button>
                    </td>
                    <td>{p.state?.replaceAll("_", " ")}</td>
                    <td>
                      {p.unit_id ||
                        p.pending_transfer?.vehicle_id ||
                        "Holding queue"}
                      {p.slot_id ? ` · ${p.slot_id}` : ""}
                    </td>
                    <td>{p.target_unit_kind || p.care_level}</td>
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
