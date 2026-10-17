import { useEffect, useMemo, useRef, useState } from "react";
import "./replay.css";
import { usePatientPage } from "./usePatientPage";
import { replayZone as zoneFor, replayCounts } from "./patientProjection";
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
import { patientsOf, queueStats, statsFor, stateUnavailable } from "../model";
const zones = [
  { id: "arrivals", name: "ED waiting", x: 20, y: 180, w: 125, h: 170 },
  { id: "ed", name: "ED treatment & boarding", x: 190, y: 160, w: 210, h: 210 },
  {
    id: "queue",
    name: "Direct holding / transit",
    x: 440,
    y: 185,
    w: 160,
    h: 160,
  },
  { id: "ward", name: "Ward care", x: 655, y: 40, w: 310, h: 240 },
  { id: "icu", name: "Intensive care", x: 655, y: 320, w: 150, h: 170 },
  { id: "clinic", name: "Outpatient clinic", x: 190, y: 445, w: 210, h: 130 },
  {
    id: "exit",
    name: "Other active locations",
    x: 845,
    y: 470,
    w: 120,
    h: 105,
  },
];
function position(p: Entity) {
  const z = zones.find((z) => z.id === zoneFor(p))!;
  let hash = 2166136261;
  for (const c of patientId(p)) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return {
    x: z.x + 18 + (hash % Math.max(1, z.w - 36)),
    y: z.y + 65 + ((hash >>> 8) % Math.max(1, z.h - 100)),
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
  const canvas = useRef<HTMLCanvasElement>(null),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(4),
    [events, setEvents] = useState<Entity[]>([]),
    [replications, setReplications] = useState<Entity[]>([]),
    [reduced, setReduced] = useState(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [pendingRep, setPendingRep] = useState(""),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(1),
    [stateFilter, setStateFilter] = useState("all"),
    [stepping, setStepping] = useState(false),
    [eventCursor, setEventCursor] = useState<Entity | null>(null),
    [selectedDetail, setSelectedDetail] = useState<Entity | null>(null);
  const patients = patientsOf(ctx),
    q = queueStats(ctx, "all"),
    ward = statsFor(ctx, "ward", "FAC-MAIN"),
    icu = statsFor(ctx, "icu", "FAC-MAIN"),
    unavailable = stateUnavailable(ctx);
  const rep = ctx.activeReplicationId || ctx.run?.selected_replication_id;
  const start =
    ctx.run?.start_at ||
    ctx.metrics?.start_at ||
    ctx.scenario?.start_at ||
    ctx.dataset?.snapshot_at ||
    "";
  const end =
    ctx.run?.end_at ||
    ctx.metrics?.end_at ||
    (start
      ? atDay(
          start,
          ctx.scenario?.horizon_calendar_days || 30,
          0,
          ctx.scenario?.timezone || "America/Chicago",
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
    (selectedDetail &&
    !["discharged", "departed"].includes(selectedDetail.state)
      ? selectedDetail
      : null);
  const patientTotal = Number(ctx.state?.patient_total ?? patients.length);
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
  const visiblePatients = useMemo(() => {
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
    () => replayCounts(ctx.state?.patient_groups, patients, visiblePatients),
    [ctx.state?.patient_groups, patients, visiblePatients],
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
    setEvents([]);
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
    let ignore = false;
    setEvents([]);
    if (!rep) return;
    api(
      `/runs/${rep}/events?limit=100&at=${encodeURIComponent(ctx.selectedTime)}`,
    )
      .then((value) => {
        if (!ignore) setEvents(items(value));
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [rep, ctx.selectedTime]);
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
    if (
      !playing ||
      reduced ||
      ctx.stateLoading ||
      unavailable ||
      !Number.isFinite(endMs)
    )
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
    reduced,
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
    if (!node) return;
    const g = node.getContext("2d");
    if (!g) return;
    const dpr = window.devicePixelRatio || 1,
      W = 1000,
      H = 620;
    node.width = W * dpr;
    node.height = H * dpr;
    g.scale(dpr, dpr);
    g.fillStyle = "#0c1a25";
    g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 20)
      for (let y = 0; y < H; y += 20) {
        g.fillStyle = "#152633";
        g.fillRect(x, y, 1, 1);
      }
    g.lineCap = "round";
    g.strokeStyle = "#253d4d";
    g.lineWidth = 30;
    g.beginPath();
    g.moveTo(145, 265);
    g.lineTo(650, 265);
    g.lineTo(650, 405);
    g.lineTo(840, 405);
    g.lineTo(840, 520);
    g.lineTo(845, 520);
    g.moveTo(295, 370);
    g.lineTo(295, 445);
    g.stroke();
    g.strokeStyle = "#426274";
    g.lineWidth = 1;
    g.setLineDash([5, 8]);
    g.stroke();
    g.setLineDash([]);
    for (const z of zones) {
      g.fillStyle =
        z.id === "queue" ? "#28291e" : z.id === "ward" ? "#102d3d" : "#112431";
      g.fillRect(z.x, z.y, z.w, z.h);
      g.strokeStyle =
        z.id === "queue" ? "#6f6235" : z.id === "ward" ? "#3b9bb6" : "#2b485a";
      g.lineWidth = z.id === "ward" ? 1.5 : 1;
      g.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
      g.fillStyle = "#dbe8f0";
      g.font = "600 13px system-ui";
      g.fillText(z.name, z.x + 10, z.y + 24);
      g.fillStyle = "#91a7b5";
      g.font = "11px system-ui";
      const n = zoneTotals[z.id] || 0;
      g.fillText(`${n} active patients`, z.x + 12, z.y + 44);
      if (groups[z.id]) {
        g.fillStyle = "#f3bc53";
        g.font = "600 11px system-ui";
        g.fillText(`+ ${fmt(groups[z.id])} grouped`, z.x + 12, z.y + z.h - 13);
      }
    }
    for (const p of visiblePatients) {
      const pos = position(p),
        chosen = patientId(ctx.selectedPatient || {}) === patientId(p);
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
    g.fillStyle = "#728f9f";
    g.font = "10px system-ui";
    g.fillText(
      "STATE SCHEMATIC · ED BOARDERS RETAIN ED SLOTS · NO INTERPOLATED CLINICAL EVENTS",
      20,
      602,
    );
  }, [patients, visiblePatients, groups, zoneTotals, ctx.selectedPatient]);
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
    <div className="replay-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SIMULATION EXPLORER</div>
          <h1>Patient flow replay</h1>
          <p>Explore the recorded events behind one computed outcome.</p>
        </div>
        <div className="heading-actions">
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
      <div className="replay-workspace">
        <div className="replay-scene">
          <div className="scene-topline">
            <span className="scene-tag">
              <span className="cyan-dot" />
              REPLICATION {Number(repIndex) + 1}
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
          <div className="replay-canvas-viewport">
            <canvas
              ref={canvas}
              className="replay-canvas"
              style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
              role="img"
              aria-label={`Hospital state schematic: ${patientTotal} active patients; ${q.total} awaiting inpatient placement. Every patient is available in the accessible census below.`}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect(),
                  x = ((e.clientX - rect.left) / rect.width) * 1000,
                  y = ((e.clientY - rect.top) / rect.height) * 620;
                let best: Entity | null = null,
                  distance = 18;
                for (const p of visiblePatients) {
                  const pos = position(p),
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
              {patientTotal > visiblePatients.length
                ? `${visiblePatients.length} individual markers; ${fmt(patientTotal - visiblePatients.length)} grouped. Full census below.`
                : "Exact recorded state; schematic positions only."}
            </span>
          </div>
        </div>
        <aside className="inspector replay-inspector">
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
            <h3>{selected ? patientId(selected) : "Main hospital capacity"}</h3>
            {selected ? (
              <dl className="detail-list">
                <div>
                  <dt>State</dt>
                  <dd>{selected.state?.replaceAll("_", " ")}</dd>
                </div>
                <div>
                  <dt>Actual unit / slot</dt>
                  <dd>
                    {selected.unit_id || "Transit / queue"}
                    <br />
                    {selected.slot_id || "No treatment slot"}
                  </dd>
                </div>
                <div>
                  <dt>Required care</dt>
                  <dd>{selected.target_unit_kind || selected.care_level}</dd>
                </div>
                <div>
                  <dt>Unresolved request</dt>
                  <dd>
                    {selected.admission_pending
                      ? "Yes; waiting continues"
                      : "No"}
                  </dd>
                </div>
                {selected.pending_transfer ? (
                  <div>
                    <dt>Destination</dt>
                    <dd>{selected.pending_transfer.destination_unit_id}</dd>
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
                  Occupied / staffed. Partner patients remain tracked separately
                  in the full census.
                </p>
              </>
            )}
            <Button small onClick={() => ctx.setPage("patients")}>
              Inspect detailed census <ChevronRight size={13} />
            </Button>
          </div>
          <div className="inspector-section event-feed">
            <div className="spread">
              <h3>Event window</h3>
              <Badge>{events.length} loaded</Badge>
            </div>
            {eventCursor &&
            Date.parse(eventCursor.occurred_at) === currentMs ? (
              <div className="info-note">
                <strong>
                  Event {eventCursor.sequence_number}:{" "}
                  {eventCursor.event_type?.replaceAll("_", " ")}
                </strong>
                <p>
                  Sequence controls include events sharing this timestamp. The
                  state shown reflects all events at this instant.
                </p>
              </div>
            ) : null}
            <p className="small-copy muted">
              One hour before and after the selected timestamp. Choose an event
              to inspect its resulting state.
            </p>
            {events
              .slice(-15)
              .reverse()
              .map((e) => (
                <button
                  key={e.event_id || e.sequence_number}
                  onClick={() => {
                    move(e.occurred_at);
                    setEventCursor(e);
                  }}
                >
                  <span className="event-time">
                    {localDate(e.occurred_at, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <div>
                    <strong>{e.event_type?.replaceAll("_", " ")}</strong>
                    <small>
                      {e.patient_id ||
                        e.reason_code ||
                        e.to_unit_id ||
                        "Resource state change"}
                    </small>
                  </div>
                </button>
              ))}
            {!events.length ? (
              <p className="small-copy muted">
                No events in this window. Step to the nearest recorded event.
              </p>
            ) : null}
          </div>
        </aside>
      </div>
      <div className="replay-controls">
        <div className="playback-buttons">
          <button aria-label="Return to run start" onClick={() => move(start)}>
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
            disabled={reduced || unavailable || currentMs >= endMs}
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
            Math.min((endMs - startMs) / 60000, (currentMs - startMs) / 60000),
          )}
          onChange={(e) =>
            move(
              new Date(startMs + Number(e.target.value) * 60000).toISOString(),
            )
          }
        />
        <span>
          {localDate(end)} · {fmt(durationHours)} elapsed h
        </span>
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
