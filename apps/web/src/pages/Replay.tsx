import { useEffect, useMemo, useRef, useState } from "react";
import "./replay.css";
import { drawReplayBackdrop } from "./replayBackdrop";
import {
  PlanningPanelControls,
  PlanningTimelineDock,
  usePlanningPanels,
} from "../components/PlanningPanels";
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
  BedDouble,
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
  Users,
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
      ((hash >>> 8) % Math.max(1, Math.floor(z.h - 66))),
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
  const panels = usePlanningPanels(260);
  const canvas = useRef<HTMLCanvasElement>(null),
    [canvasHeight, setCanvasHeight] = useState(620),
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
  const motionState = useRef<{
    rep: string;
    at: number;
    height: number;
    points: Map<string, { x: number; y: number }>;
  } | null>(null);
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
    const timer = setTimeout(() => {
      if (document.hidden) {
        setPlaying(false);
        return;
      }
      const next = Math.min(endMs, currentMs + speed * 3600000);
      ctx.setTime(new Date(next).toISOString());
      if (next >= endMs) setPlaying(false);
    }, 1000);
    return () => clearTimeout(timer);
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
    const viewport = canvas.current?.parentElement;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0)
        setCanvasHeight(
          window.matchMedia("(max-width: 767px)").matches
            ? 620
            : (1000 * height) / width,
        );
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [ctx.run?.status]);
  useEffect(() => {
    const node = canvas.current;
    if (!node || unavailable) return;
    const g = node.getContext("2d");
    if (!g) return;
    const dpr = window.devicePixelRatio || 1,
      W = 1000,
      H = canvasHeight;
    node.width = W * dpr;
    node.height = H * dpr;
    g.scale(dpr, dpr);
    const previous = motionState.current;
    const targetPoints = new Map(
      visiblePatients.map((patient) => [
        patientId(patient),
        position(patient, H, unitKinds),
      ]),
    );
    const recordedTime = Date.parse(ctx.state?.at || ctx.selectedTime);
    node.dataset.recordedAt = new Date(recordedTime).toISOString();
    const originPoints = new Map(previous?.points || []);
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
    const moving =
      playing &&
      !reduced &&
      previous !== null &&
      previous.rep === rep &&
      previous.height === H &&
      recordedTime > previous.at &&
      movedMarkers > 0;
    node.dataset.previousMarkers = String(previous?.points.size || 0);
    node.dataset.movedMarkers = String(movedMarkers);
    node.dataset.visibleMarkers = String(visiblePatients.length);
    motionState.current = {
      rep: rep || "",
      at: recordedTime,
      height: H,
      points: targetPoints,
    };
    function draw(progress: number) {
      if (!g || !node) return;
      node.dataset.animating = String(moving && progress < 1);
      g.fillStyle = "#0c1a25";
      g.fillRect(0, 0, W, H);
      drawReplayBackdrop(g, W, H);
      g.lineCap = "round";
      g.strokeStyle = "#253d4d";
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
      g.strokeStyle = "#426274";
      g.lineWidth = 1;
      g.setLineDash([5, 8]);
      g.stroke();
      g.setLineDash([]);
      for (const original of zones) {
        const z = layoutZone(original, H);
        g.fillStyle =
          z.id === "queue"
            ? "#28291e"
            : z.id === "ward"
              ? "#102d3d"
              : "#112431";
        g.fillRect(z.x, z.y, z.w, z.h);
        g.strokeStyle =
          z.id === "queue"
            ? "#6f6235"
            : z.id === "ward"
              ? "#3b9bb6"
              : "#2b485a";
        g.lineWidth = z.id === "ward" ? 1.5 : 1;
        g.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
        g.fillStyle = "#dbe8f0";
        g.font = "600 13px system-ui";
        g.fillText(z.name, z.x + 10, z.y + 24);
        g.fillStyle = "#91a7b5";
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
          const x = z.x + z.w - 81;
          g.strokeStyle = "#b2d5e9";
          g.lineWidth = 1.2;
          g.strokeRect(x, z.y + 15, 14, 7);
          g.beginPath();
          g.moveTo(x, z.y + 12);
          g.lineTo(x, z.y + 26);
          g.moveTo(x + 14, z.y + 18);
          g.lineTo(x + 14, z.y + 26);
          g.stroke();
          g.fillStyle = "#c6e3ee";
          g.font = "10px system-ui";
          g.fillText(
            `${inventory.occupied}/${inventory.staffed}`,
            x + 20,
            z.y + 23,
          );
          g.fillStyle = "#60bfff";
          g.fillRect(x + 1, z.y + 37, 7, 8);
          g.beginPath();
          g.arc(x + 4.5, z.y + 33, 2.4, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#a9ccdf";
          g.fillText(`${inventory.assigned} assigned`, x + 13, z.y + 44);
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
        g.strokeStyle = "#49dddf";
        g.lineWidth = 2;
        g.setLineDash([4, 4]);
        g.stroke();
        g.setLineDash([]);
      }
      const framePoints = new Map<string, { x: number; y: number }>();
      for (const p of visiblePatients) {
        const target = targetPoints.get(patientId(p))!;
        const prior = originPoints.get(patientId(p));
        const pos =
          moving && prior
            ? {
                x: prior.x + (target.x - prior.x) * progress,
                y: prior.y + (target.y - prior.y) * progress,
              }
            : target;
        framePoints.set(patientId(p), pos);
        const chosen = patientId(ctx.selectedPatient || {}) === patientId(p);
        g.beginPath();
        g.arc(pos.x, pos.y, chosen ? 6 : 3.6, 0, Math.PI * 2);
        g.fillStyle = p.admission_pending
          ? "#f3bc53"
          : p.care_level === "icu"
            ? "#ff7c88"
            : "#61cbe8";
        g.fill();
        if (chosen) {
          g.beginPath();
          g.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
          g.strokeStyle = "#64e3ed";
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
          y = z.y + z.h - 26;
        g.fillStyle = "#152a35";
        g.fillRect(x, y, width, 22);
        g.strokeStyle = "#c69745";
        g.lineWidth = 1;
        g.strokeRect(x, y, width, 22);
        g.fillStyle = "#f3bc53";
        g.font = "600 10px system-ui";
        g.fillText(`1 marker = ${fmt(groups[z.id])}`, x + 7, y + 15);
      }
      g.fillStyle = "#728f9f";
      g.font = "10px system-ui";
      g.fillText(
        "STATE SCHEMATIC · ED BOARDERS RETAIN ED SLOTS · NO INTERPOLATED CLINICAL EVENTS",
        20,
        H - 14,
      );
    }
    let frame = 0;
    if (moving) {
      const began = performance.now();
      const paint = (now: number) => {
        const progress = Math.min(1, (now - began) / 180);
        draw(progress);
        if (progress < 1) frame = requestAnimationFrame(paint);
      };
      draw(0);
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
          <p>Explore the recorded events behind one computed outcome.</p>
        </div>
        <div className="heading-actions">
          <PlanningPanelControls panels={panels} name="replay" />
          <Badge tone="cyan">One simulation trajectory</Badge>
          <label className="micro-label">
            Replication
            <select
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
            </select>
          </label>
          <Button
            onClick={() => canvas.current?.parentElement?.requestFullscreen()}
          >
            <Expand size={15} />
            Expand
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
      <div className="replay-stage">
        <div className="replay-workspace">
          <div className="replay-scene">
            <div className="scene-topline">
              <span className="scene-tag">
                <span className="cyan-dot" />
                REPLICATION {Number(repIndex) + 1} · ALL SITES
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
                <span title="Bed totals cover all modeled sites, including anonymous partner occupancy.">
                  <BedDouble size={14} /> Occupied / staffed
                </span>
                <span>
                  <Users size={14} /> Assigned staff
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
                <select
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
                </select>
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
                aria-label={`Hospital state schematic across all sites: ${patientTotal} active patients; ${q.total} awaiting inpatient placement. Bed totals also include ${backgroundOccupants} anonymous partner occupants. Every individual patient is available in the accessible census below.`}
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
                  if (best) ctx.setPatient(best);
                }}
              />
            </div>
            <div className="replay-summary">
              <span>
                <strong>{fmt(patientTotal)}</strong> active patients
              </span>
              <span>
                <strong className="amber">{fmt(q.total)}</strong> inpatient
                requests
              </span>
              <span>
                {inspected
                  ? `Highlighted recorded path: ${patientId(inspected)}.`
                  : patientTotal > visiblePatients.length
                    ? `${visiblePatients.length} individual markers; ${fmt(patientTotal - visiblePatients.length)} grouped. Full census below.`
                    : backgroundOccupants > 0
                      ? `Beds include ${fmt(backgroundOccupants)} anonymous partner occupants; positions are schematic.`
                      : "Exact recorded state; schematic positions only."}
              </span>
            </div>
          </div>
          <aside
            className="inspector replay-inspector"
            id="replay-inspector-dock"
            hidden={panels.inspectorHidden}
          >
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
                {inspected ? patientId(inspected) : "Main hospital capacity"}
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
                      <dd>{inspected.pending_transfer.destination_unit_id}</dd>
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
                          <li key={reason}>{reason.replaceAll("_", " ")}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <details>
                    <summary>Occupied resources and requirements</summary>
                    <p className="small-copy">
                      Allocated:{" "}
                      {(inspected.allocated_resource_ids || []).join(" · ") ||
                        inspected.slot_id ||
                        "No allocated resource recorded"}
                    </p>
                    <ul className="requirements-list">
                      {(
                        inspected.inpatient_resource_requirements ||
                        inspected.resource_requirements ||
                        []
                      ).map((requirement: Entity | string, index: number) => (
                        <li key={index}>
                          {typeof requirement === "string"
                            ? requirement.replaceAll("_", " ")
                            : `${String(requirement.capability_code || requirement.resource_type || "Resource").replaceAll("_", " ")} × ${requirement.quantity ?? 1}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                  {inspected.pending_transfer ? (
                    <details
                      key={inspected.pending_transfer.request_id}
                      className="replay-transfer-detail"
                    >
                      <summary>
                        Inspect transfer · {inspected.pending_transfer.status}
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
                            {inspected.pending_transfer.destination_unit_id}
                            <br />
                            {inspected.pending_transfer.destination_slot_id}
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
                              inspected.pending_transfer.planned_departure_at,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Planned arrival</dt>
                          <dd>
                            {timestamp(
                              inspected.pending_transfer.planned_arrival_at,
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
            <ReplayRecordedCapacity ctx={ctx} />
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
          </aside>
        </div>
        <PlanningTimelineDock panels={panels} name="replay">
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
              <div className="segmented">
                {[1, 4, 16].map((v) => (
                  <button
                    className={speed === v ? "active" : ""}
                    key={v}
                    onClick={() => setSpeed(v)}
                  >
                    {v}×
                  </button>
                ))}
              </div>
            </div>
            <div className="replay-time">
              <strong>{timestamp(ctx.selectedTime)}</strong>
              <span>1× = one elapsed simulation hour per second</span>
            </div>
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
          <ReplayAnnotations
            rep={rep || ""}
            start={start}
            end={end}
            at={ctx.selectedTime}
            onSeek={move}
          />
        </PlanningTimelineDock>
      </div>
      <div className="spread" style={{ padding: "12px 0" }}>
        <Button
          small
          disabled={!rep || unavailable}
          onClick={() => void restoreCheckpoint()}
        >
          <RotateCcw size={13} />
          Go to saved checkpoint
        </Button>
        <span className="small-copy muted">
          Calendar and daylight-saving boundaries use the stored UTC endpoint.
          Replay controls never alter the scenario.
        </span>
      </div>
      <section className="patient-census">
        <div className="census-toolbar">
          <div>
            <h3>
              Accessible replay census{" "}
              <span className="muted">{fmt(census.total)}</span>
            </h3>
            <span className="micro-label">
              Every active patient at this timestamp, including grouped markers
            </span>
          </div>
          <select
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
          </select>
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
                    patientId(selected || {}) === patientId(p) ? "selected" : ""
                  }
                >
                  <td>
                    <button
                      className="link-button"
                      onClick={() => ctx.setPatient(p)}
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
    </div>
  );
}
