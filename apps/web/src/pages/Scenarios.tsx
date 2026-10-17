import { useEffect, useRef, useState } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import {
  buildScenarioPatch,
  clampWindow,
  conditionWindow,
  inputDifferences,
  mixError,
} from "./scenarioEditor";
import type { MixMode } from "./scenarioEditor";
import "./scenarios.css";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Layers,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  Users,
  Wind,
} from "lucide-react";
import type { Entity, PlanningContext, Scenario } from "../types";
import {
  api,
  atDay,
  fmt,
  idOf,
  items,
  localDate,
  localDayIndex,
  post,
} from "../api";
import { Badge, Button, Modal, PanelTitle } from "../components/ui";
import { patientsOf, statsFor } from "../model";
const presets = [
  [
    "sustained",
    "Sustained surge",
    "A constant increase throughout the interval",
  ],
  ["wave", "Surge wave", "Rises to a peak, then returns to baseline"],
  ["pulse", "Short arrival pulse", "A sharp increase lasting three days"],
  ["baseline", "Baseline", "Unchanged arrival assumptions"],
  ["staff_loss", "Staffing loss", "Reduced ward nursing coverage"],
  [
    "combined",
    "Surge + staffing loss",
    "Sustained arrivals with reduced ward nursing",
  ],
];
export default function Scenarios({ ctx }: { ctx: PlanningContext }) {
  const [advanced, setAdvanced] = useState(false),
    [startAt, setStartAt] = useState("2026-10-16T05:00:00Z"),
    [seed, setSeed] = useState(20261016),
    [stream, setStream] = useState("ED_MAIN"),
    [conditionId, setConditionId] = useState(""),
    [staffConditionId, setStaffConditionId] = useState(""),
    [peakDay, setPeakDay] = useState(10),
    [conditionsJson, setConditionsJson] = useState("[]"),
    [name, setName] = useState(""),
    [percent, setPercent] = useState(70),
    [days, setDays] = useState(30),
    [replications, setReplications] = useState(100),
    [shape, setShape] = useState("sustained"),
    [absence, setAbsence] = useState(0),
    [dirty, setDirty] = useState(false),
    [library, setLibrary] = useState(false),
    [scenarios, setScenarios] = useState<Entity[]>([]),
    [undo, setUndo] = useState<Entity[]>([]),
    [redo, setRedo] = useState<Entity[]>([]),
    [startDay, setStartDay] = useState(0),
    [endDay, setEndDay] = useState(30),
    [mixMode, setMixMode] = useState<MixMode>("default"),
    [mix, setMix] = useState<Record<string, number>>({
      discharge: 0.8,
      ward: 0.16,
      icu: 0.04,
    }),
    [diffOpen, setDiffOpen] = useState(false),
    [versions, setVersions] = useState<Entity[]>([]),
    [baseVersion, setBaseVersion] = useState(""),
    [editorError, setEditorError] = useState(""),
    [preflight, setPreflight] = useState<Entity | null>(null),
    [estimating, setEstimating] = useState(false),
    [estimateError, setEstimateError] = useState(""),
    [draftConditions, setDraftConditions] = useState<Entity[]>([]);
  function loadCondition(c: Entity | undefined, s = ctx.scenario) {
    if (!s) return;
    setStream(c?.entry_stream_id || "ED_MAIN");
    setConditionId(c?.id || "");
    const window = conditionWindow(s, c);
    setStartDay(window.startDay);
    setEndDay(window.endDay);
    const points = c?.control_points || [];
    const maxPoint = points.length
      ? points.reduce((a: Entity, p: Entity) =>
          p.multiplier > a.multiplier ? p : a,
        )
      : null;
    setPercent(
      c?.surge_percent ??
        (maxPoint ? Math.round((maxPoint.multiplier - 1) * 100) : 0),
    );
    setShape(
      c?.shape === "piecewise_linear"
        ? points.length === 2
          ? "ramp"
          : "wave"
        : c?.shape === "step"
          ? "sustained"
          : c?.shape || "baseline",
    );
    setPeakDay(
      points.length > 2 && maxPoint
        ? localDayIndex(s.start_at, maxPoint.at, s.timezone)
        : 10,
    );
    const override = c?.care_mix_override;
    setMix(override || { discharge: 0.8, ward: 0.16, icu: 0.04 });
    setMixMode(
      !override
        ? "default"
        : Object.keys(override).every((k) =>
              ["discharge", "ward", "icu"].includes(k),
            )
          ? "percentages"
          : "preserve",
    );
  }
  useEffect(() => {
    const s = ctx.scenario;
    if (!s) return;
    setStartAt(s.start_at);
    setSeed(s.base_seed);
    setConditionsJson(JSON.stringify(s.conditions || [], null, 2));
    setDraftConditions(s.conditions || []);
    setName(s.name);
    setDays(s.horizon_calendar_days);
    setReplications(s.replications || 100);
    loadCondition(
      s.conditions?.find((x) => x.kind === "arrival_multiplier"),
      s,
    );
    const staffCondition = s.conditions?.find(
      (x) =>
        ["staff_absence", "staff_unavailability"].includes(x.kind) &&
        x.unit_id === "UNIT-WARD-A",
    );
    setStaffConditionId(staffCondition?.id || "");
    const wardNurses =
      ctx.dataset?.units?.find((u) => u.unit_id === "UNIT-WARD-A")
        ?.baseline_staff?.rn || 0;
    setAbsence(
      staffCondition?.absence_percent ??
        (wardNurses && staffCondition?.count
          ? Math.round((staffCondition.count / wardNurses) * 100)
          : 0),
    );
    setDirty(false);
    setUndo([]);
    setRedo([]);
  }, [ctx.scenario?.id, ctx.scenario?.revision]);
  const snapshot = () => ({
    percent,
    days,
    shape,
    absence,
    startDay,
    endDay,
    peakDay,
    stream,
    conditionId,
    draftConditions,
    mixMode,
    mix: { ...mix },
  });
  function remember() {
    setUndo((a) => [...a.slice(-30), snapshot()]);
    setRedo([]);
    setDirty(true);
  }
  function restore(v: Entity) {
    setPercent(v.percent);
    setDays(v.days);
    setShape(v.shape);
    setAbsence(v.absence);
    setStartDay(v.startDay);
    setEndDay(v.endDay);
    setPeakDay(v.peakDay);
    setStream(v.stream);
    setConditionId(v.conditionId);
    setDraftConditions(v.draftConditions);
    setMixMode(v.mixMode);
    setMix(v.mix);
    setDirty(true);
  }
  function makePatch() {
    return buildScenarioPatch(
      ctx.scenario ? { ...ctx.scenario, conditions: draftConditions } : null,
      {
        name,
        startAt,
        seed,
        days,
        replications,
        stream,
        conditionId,
        staffConditionId,
        percent,
        shape,
        absence,
        startDay,
        endDay,
        peakDay,
        mixMode,
        mix,
      },
    );
  }
  function switchStream(next: string) {
    try {
      const staged = makePatch().conditions;
      remember();
      setDraftConditions(staged);
      const existing = staged.find(
        (c) =>
          c.kind === "arrival_multiplier" &&
          (c.entry_stream_id || "ED_MAIN") === next,
      );
      loadCondition(existing);
      setStream(next);
      if (next === "DIRECT_WARD_MAIN" && !existing?.care_mix_override) {
        setMix({ ward: 1 });
        setMixMode("default");
      }
      setEditorError("");
    } catch (e) {
      setEditorError((e as Error).message);
    }
  }
  useEffect(() => {
    let ignore = false;
    setPreflight(null);
    setEstimateError("");
    if (!ctx.scenario?.id) {
      setEstimating(false);
      return;
    }
    setEstimating(true);
    const timer = setTimeout(async () => {
      try {
        const result = await post(
          `/scenarios/${ctx.scenario!.id}/feasibility`,
          makePatch(),
        );
        if (!ignore) setPreflight(result);
      } catch (e) {
        if (!ignore) setEstimateError((e as Error).message);
      } finally {
        if (!ignore) setEstimating(false);
      }
    }, 450);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [
    ctx.scenario?.id,
    ctx.scenario?.revision,
    name,
    startAt,
    seed,
    days,
    replications,
    stream,
    conditionId,
    staffConditionId,
    percent,
    shape,
    absence,
    startDay,
    endDay,
    peakDay,
    mixMode,
    mix,
    draftConditions,
  ]);
  async function openDifferences() {
    await ctx.action("Loading saved input versions", async () => {
      if (!ctx.scenario) return;
      const current = await api(`/scenarios/${ctx.scenario.id}`);
      const rows: Entity[] = [
        { ...current, id: current.id, label: "Current saved draft" },
        ...(current.revisions || []).map((r: Entity) => ({
          ...r,
          label: r.revision_name || `Frozen version ${r.id}`,
        })),
      ];
      if (current.parent_scenario_id) {
        const parent = await api(`/scenarios/${current.parent_scenario_id}`);
        rows.push({ ...parent, label: `Parent: ${parent.name}` });
      }
      setVersions(rows);
      setBaseVersion(rows.at(-1)?.id || current.id);
      setDiffOpen(true);
    });
  }
  async function save(run = false) {
    setEditorError("");
    try {
      const s = await ctx.saveScenario(makePatch());
      if (s) {
        setDirty(false);
        if (run) await ctx.runScenario(s);
      }
    } catch (e) {
      setEditorError((e as Error).message);
    }
  }
  async function openLibrary() {
    await ctx.action("Loading scenario library", async () => {
      setScenarios(items(await api("/scenarios")));
      setLibrary(true);
    });
  }
  const multiplier = Math.max(0, 1 + percent / 100),
    minimum = Math.min(1, multiplier) * 0.9,
    maximum = Math.max(1, multiplier) * 1.12;
  const y = (v: number) => 135 - ((v - minimum) / (maximum - minimum)) * 120;
  const x = (d: number) => Math.max(0, Math.min(600, (d / days) * 600));
  const a = x(startDay),
    b = x(Math.min(days, endDay)),
    peak = x(Math.max(startDay + 1, Math.min(peakDay, endDay - 1))),
    baseY = y(1),
    peakY = y(multiplier);
  const path =
    shape === "baseline" || percent === 0
      ? `M0,${baseY} L600,${baseY}`
      : shape === "wave"
        ? `M0,${baseY} L${a},${baseY} L${peak},${peakY} L${b},${baseY} L600,${baseY}`
        : shape === "ramp"
          ? `M0,${baseY} L${a},${baseY} L${b},${peakY} L${b},${baseY} L600,${baseY}`
          : `M0,${baseY} L${a},${baseY} L${a},${peakY} L${b},${peakY} L${b},${baseY} L600,${baseY}`;
  const markerX = shape === "wave" ? peak : b,
    markerY = percent === 0 ? baseY : peakY;
  const initialCtx = {
    ...ctx,
    run: null,
    state: null,
    stateLoading: false,
    stateError: null,
    selectedFacility: "FAC-MAIN",
  };
  const baseline = ctx.dataset?.arrival_profiles || {};
  const edRate = Number(baseline.ed_arrivals_per_local_day ?? 100),
    directRate = Number(baseline.direct_ward_arrivals_per_local_day ?? 4);
  const exposure = Math.max(0, Math.min(days, endDay) - startDay),
    average =
      shape === "wave" || shape === "ramp"
        ? (1 + multiplier) / 2
        : shape === "baseline"
          ? 1
          : multiplier;
  const estimated = Math.round(
    ((edRate + directRate) * days +
      (stream === "ED_MAIN" ? edRate : directRate) * (average - 1) * exposure) *
      replications,
  );
  const invalidMix = mixError(mixMode, mix);
  const differenceRows = versions.length
    ? inputDifferences(
        versions.find((v) => v.id === baseVersion) || versions[0],
        versions[0],
      )
    : [];
  return (
    <div className="scenarios-page page-scroll">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SCENARIO WORKSPACE</div>
          <h1>Build a surge scenario</h1>
          <p>Shape demand, available resources, and your response over time.</p>
        </div>
        <div className="heading-actions">
          <Button onClick={() => setAdvanced(true)}>
            <SlidersHorizontal size={15} />
            Assumptions
          </Button>
          <Button onClick={openDifferences}>Compare saved inputs</Button>
          <Button onClick={openLibrary}>
            <Layers size={15} />
            Scenario library
          </Button>
          <Button
            onClick={() => save()}
            disabled={ctx.canWrite === false || !!ctx.busy}
          >
            <Save size={15} />
            Save draft
          </Button>
          <Button
            primary
            onClick={() => save(true)}
            disabled={
              ctx.canWrite === false ||
              !!ctx.busy ||
              estimating ||
              preflight?.valid === false ||
              !!invalidMix
            }
          >
            Run scenario <ArrowRight size={16} />
          </Button>
        </div>
      </div>
      {editorError || invalidMix ? (
        <div className="error-banner" role="alert">
          {editorError || invalidMix}
        </div>
      ) : null}
      <div className="scenario-name-row">
        <input
          aria-label="Scenario name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
        />
        <Badge tone={dirty ? "warning" : "success"}>
          {dirty ? "Unsaved changes" : "Saved draft"}
        </Badge>
        <span className="muted">
          Dataset {ctx.dataset?.fixture?.replaceAll("_", " ")} · America/Chicago
        </span>
        <div className="undo-actions">
          <button
            disabled={!undo.length}
            onClick={() => {
              const v = undo[undo.length - 1];
              setRedo((a) => [...a, snapshot()]);
              setUndo((a) => a.slice(0, -1));
              restore(v);
            }}
          >
            Undo
          </button>
          <button
            disabled={!redo.length}
            onClick={() => {
              const v = redo[redo.length - 1];
              setRedo((a) => a.slice(0, -1));
              restore(v);
            }}
          >
            Redo
          </button>
        </div>
      </div>
      <div className="builder-grid">
        <aside className="condition-palette">
          <span className="eyebrow">CONDITIONS</span>
          <h3>Shape your scenario</h3>
          <p>Add conditions to the planning timeline.</p>
          <button
            className="condition-tile selected"
            onClick={() => document.getElementById("surge-input")?.focus()}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("condition", "arrivals")}
          >
            <Wind size={21} />
            <strong>Arrival surge</strong>
            <small>Change the volume of ED arrivals.</small>
            <span className="tile-add">
              <Plus size={14} />
            </span>
          </button>
          <button
            className="condition-tile"
            onClick={() => {
              remember();
              setAbsence(absence ? 0 : 20);
            }}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("condition", "staff")}
          >
            <Users size={21} />
            <strong>Staff absence</strong>
            <small>Adjust available nursing coverage.</small>
            <span className="tile-add">
              <Plus size={14} />
            </span>
          </button>
          <button
            className="condition-tile"
            onClick={() => ctx.setPage("compare")}
          >
            <HospitalIcon />
            <strong>Overflow capacity</strong>
            <small>Schedule staffed inpatient spaces.</small>
            <span className="tile-add">
              <Plus size={14} />
            </span>
          </button>
          <div className="palette-note">
            <FileText size={16} />
            <p>
              All assumptions stay visible, editable, and attached to the
              scenario.
            </p>
          </div>
        </aside>
        <section
          className="planning-canvas"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.getData("condition") === "staff") {
              remember();
              setAbsence(20);
            } else document.getElementById("surge-input")?.focus();
          }}
        >
          <PanelTitle
            title="Planning timeline"
            eyebrow={`${days} LOCAL CALENDAR DAYS`}
            actions={
              <div className="date-chip">
                {localDate(ctx.scenario?.start_at || "")} —{" "}
                {localDate(
                  atDay(
                    ctx.scenario?.start_at || "2026-10-16T05:00:00Z",
                    days - 1,
                  ),
                )}
              </div>
            }
          />
          <div className="track">
            <div className="track-label">
              <Wind size={15} />
              <strong>
                {stream === "ED_MAIN" ? "ED arrivals" : "Direct ward arrivals"}
              </strong>
              <span>Relative to baseline</span>
              <Badge tone="cyan">
                {percent > 0 ? "+" : ""}
                {percent}%
              </Badge>
            </div>
            <div className="arrival-canvas">
              <div className="track-grid">
                <span>{(1 + percent / 100).toFixed(1)}×</span>
                <span>Baseline 1.0×</span>
              </div>
              <svg
                viewBox="0 0 600 140"
                preserveAspectRatio="none"
                aria-label={`Arrival ${shape} with ${percent}% increase`}
              >
                <defs>
                  <linearGradient id="wave-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#32d3ed" stopOpacity=".25" />
                    <stop offset="1" stopColor="#32d3ed" stopOpacity=".01" />
                  </linearGradient>
                </defs>
                <path d={`${path} L600,140 L0,140Z`} fill="url(#wave-fill)" />
                <line
                  x1="0"
                  x2="600"
                  y1={baseY}
                  y2={baseY}
                  stroke="#508397"
                  strokeDasharray="5 5"
                />
                <path d={path} fill="none" stroke="#4de3ef" strokeWidth="2" />
                <circle cx={markerX} cy={markerY} r="5" fill="#e8faff" />
              </svg>
              <label
                className="wave-peak"
                style={{
                  left: `${10 + (markerX / 600) * 75}%`,
                  top: `${markerY + 8}px`,
                }}
              >
                <strong>
                  {percent > 0 ? "+" : ""}
                  {percent}%
                </strong>
                <small>
                  {(1 + percent / 100).toFixed(2)}× baseline{" "}
                  {shape === "wave" ? "at peak" : ""}
                </small>
              </label>
              <input
                type="range"
                aria-label="Adjust arrival surge"
                min="-100"
                max="300"
                step="5"
                value={percent}
                onPointerDown={remember}
                onChange={(e) => {
                  setPercent(+e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <ConditionWindow
              start={startDay}
              end={endDay}
              days={days}
              onBegin={remember}
              onChange={(a, b) => {
                const value = clampWindow(a, b, days);
                setStartDay(value.startDay);
                setEndDay(value.endDay);
                setDirty(true);
              }}
            />
            <div className="window-handles">
              <label>
                Start
                <input
                  aria-label="Drag condition start day"
                  type="range"
                  min="0"
                  max={Math.max(0, days - 1)}
                  value={startDay}
                  onPointerDown={remember}
                  onChange={(e) => {
                    setStartDay(Math.min(+e.target.value, endDay - 1));
                    setDirty(true);
                  }}
                />
              </label>
              <label>
                End
                <input
                  aria-label="Drag condition end day"
                  type="range"
                  min="1"
                  max={days}
                  value={endDay}
                  onPointerDown={remember}
                  onChange={(e) => {
                    setEndDay(Math.max(startDay + 1, +e.target.value));
                    setDirty(true);
                  }}
                />
              </label>
            </div>
            <div className="track-dates">
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i}>
                  {localDate(
                    atDay(
                      ctx.scenario?.start_at || "2026-10-16T05:00:00Z",
                      Math.floor((i * (days - 1)) / 5),
                    ),
                  )}
                </span>
              ))}
            </div>
          </div>
          <div className="track staffing-track">
            <div className="track-label">
              <Users size={15} />
              <strong>Staff availability</strong>
              <span>Qualified nursing staff</span>
            </div>
            <div className={`staff-block ${absence ? "reduced" : ""}`}>
              <span />
              <strong>
                {absence
                  ? `${100 - absence}% ward A nursing availability`
                  : "Baseline staffing"}
              </strong>
              <small>
                {absence
                  ? "Explicit staffing-loss assumption"
                  : "No changes to existing assignments"}
              </small>
              <button
                onClick={() => {
                  remember();
                  setAbsence(absence ? 0 : 20);
                }}
              >
                {absence ? "Remove" : "Edit"}
              </button>
            </div>
          </div>
          <div className="track">
            <div className="track-label">
              <HospitalIcon />
              <strong>Overflow capacity</strong>
              <span>Additional inpatient spaces</span>
            </div>
            <button
              className="empty-track"
              onClick={() => ctx.setPage("compare")}
            >
              <Plus size={16} /> Add response intervention{" "}
              <span>Space + staff + equipment</span>
            </button>
          </div>
          <div className="timeline-ruler">
            <span>DAY 1</span>
            <span>DAY {Math.max(2, Math.round(days / 2))}</span>
            <span>DAY {days}</span>
          </div>
          <div className="scenario-summary">
            <Check size={16} />
            <span>
              {percent ? 1 : 0} arrival condition ·{" "}
              {absence ? "Modified" : "Baseline"} staffing · {days}-day horizon
            </span>
          </div>
        </section>
        <aside className="scenario-inspector">
          <PanelTitle
            eyebrow="SELECTED CONDITION"
            title="Arrival surge"
            actions={<SlidersHorizontal size={17} />}
          />
          <div className="form-stack">
            <label>
              Scenario preset
              <select
                value={shape}
                onChange={(e) => {
                  remember();
                  setShape(e.target.value);
                  if (e.target.value === "baseline") setPercent(0);
                  if (e.target.value === "staff_loss") {
                    setPercent(0);
                    setAbsence(20);
                  }
                  if (e.target.value === "combined") {
                    setPercent(70);
                    setAbsence(20);
                  }
                  if (e.target.value === "pulse") setEndDay(Math.min(3, days));
                }}
              >
                {presets.map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
                <option value="ramp">Linear ramp</option>
              </select>
            </label>
            <label>
              Increase in{" "}
              {stream === "ED_MAIN" ? "ED arrivals" : "direct ward admissions"}
              <div className="input-with-unit">
                <input
                  id="surge-input"
                  type="number"
                  min="-100"
                  max="10000"
                  value={percent}
                  onChange={(e) => {
                    remember();
                    setPercent(+e.target.value);
                  }}
                />
                <span>%</span>
              </div>
            </label>
            <div className="two-fields">
              <label>
                Starts on day
                <input
                  type="number"
                  min="1"
                  max={days}
                  value={startDay + 1}
                  onChange={(e) => {
                    remember();
                    setStartDay(
                      Math.max(0, Math.min(+e.target.value - 1, endDay - 1)),
                    );
                  }}
                />
              </label>
              <label>
                Ends on day
                <input
                  type="number"
                  min={startDay + 1}
                  max={days}
                  value={endDay}
                  onChange={(e) => {
                    remember();
                    setEndDay(
                      Math.min(days, Math.max(startDay + 1, +e.target.value)),
                    );
                  }}
                />
              </label>
            </div>
            {shape === "wave" ? (
              <label>
                Peak on day
                <input
                  type="number"
                  min={startDay + 2}
                  max={endDay - 1}
                  value={peakDay + 1}
                  onChange={(e) => {
                    remember();
                    setPeakDay(+e.target.value - 1);
                  }}
                />
              </label>
            ) : null}
            <label>
              Arrival stream
              <select
                value={stream}
                onChange={(e) => switchStream(e.target.value)}
              >
                <option value="ED_MAIN">Emergency department</option>
                <option value="DIRECT_WARD_MAIN">Direct ward admissions</option>
              </select>
            </label>
            <fieldset className="care-mix-fields">
              <legend>Disposition of new arrivals</legend>
              <label>
                Care mix
                <select
                  value={mixMode}
                  onChange={(e) => {
                    remember();
                    setMixMode(e.target.value as MixMode);
                    if (e.target.value === "percentages")
                      setMix(
                        stream === "DIRECT_WARD_MAIN"
                          ? { ward: 1 }
                          : { discharge: 0.8, ward: 0.16, icu: 0.04 },
                      );
                  }}
                >
                  <option value="default">Use stream default</option>
                  <option value="percentages">Set care percentages</option>
                  {mixMode === "preserve" ? (
                    <option value="preserve">
                      Preserve imported cohort/profile mix
                    </option>
                  ) : null}
                </select>
              </label>
              {mixMode === "percentages" ? (
                stream === "DIRECT_WARD_MAIN" ? (
                  <p>Direct ward arrivals require ward care (100%).</p>
                ) : (
                  ["discharge", "ward", "icu"].map((key) => (
                    <label key={key}>
                      {key === "discharge"
                        ? "Discharge after assessment"
                        : key === "icu"
                          ? "ICU admission"
                          : "Ward admission"}{" "}
                      (%)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round((mix[key] || 0) * 10000) / 100}
                        onChange={(e) => {
                          remember();
                          setMix((v) => ({
                            ...v,
                            [key]: Number(e.target.value) / 100,
                          }));
                        }}
                      />
                    </label>
                  ))
                )
              ) : mixMode === "preserve" ? (
                <pre>{JSON.stringify(mix, null, 2)}</pre>
              ) : null}
              {mixMode !== "default" ? (
                <small>
                  Total:{" "}
                  {fmt(Object.values(mix).reduce((a, b) => a + b, 0) * 100, 1)}
                  %. Applies only to new arrivals in this condition window.
                </small>
              ) : (
                <small>Uses the dataset pathway proportions.</small>
              )}
            </fieldset>
            <label>
              Planning horizon
              <div className="input-with-unit">
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={days}
                  onChange={(e) => {
                    remember();
                    const n = Math.max(1, Math.min(365, +e.target.value));
                    setDays(n);
                    setStartDay((a) => Math.min(a, n - 1));
                    setEndDay(n);
                  }}
                />
                <span>days</span>
              </div>
            </label>
            <label>
              Simulation runs
              <select
                value={replications}
                onChange={(e) => {
                  setReplications(+e.target.value);
                  setDirty(true);
                }}
              >
                <option value="10">10 · Quick preview</option>
                <option value="100">100 · Standard</option>
                <option value="500">500 · Extended</option>
              </select>
            </label>
            {absence ? (
              <label>
                Ward A nursing absence
                <div className="input-with-unit">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={absence}
                    onChange={(e) => {
                      remember();
                      setAbsence(+e.target.value);
                    }}
                  />
                  <span>%</span>
                </div>
              </label>
            ) : null}
            <div className="info-note">
              Changes the selected arrival stream. Existing patients and their
              remaining stays are preserved.
            </div>
            <div className="compute-estimate" aria-live="polite">
              <span>Execution estimate</span>
              <strong>
                {estimating
                  ? "Calculating…"
                  : preflight?.compute_estimate
                    ? fmt(
                        preflight.compute_estimate.expected_trajectories_total,
                      )
                    : `${fmt(estimated)} approximate arrivals`}
              </strong>
              {preflight?.compute_estimate ? (
                <>
                  <small>
                    {fmt(
                      preflight.compute_estimate
                        .expected_trajectories_per_replication,
                    )}{" "}
                    expected trajectories ×{" "}
                    {preflight.compute_estimate.replications} replications,
                    including the starting census and corrected reports.
                  </small>
                  <small>
                    Run budget:{" "}
                    {fmt(
                      preflight.compute_estimate.limits.max_run_trajectories,
                    )}{" "}
                    trajectories. Per replication:{" "}
                    {fmt(
                      preflight.compute_estimate.limits
                        .max_expected_arrivals_per_replication,
                    )}{" "}
                    arrivals.
                  </small>
                  {preflight.compute_estimate.expected_trajectories_total >
                  1000000 ? (
                    <p className="compute-warning">
                      Large workload. A shorter horizon or fewer replications
                      reduces execution time.
                    </p>
                  ) : null}
                  <small>{preflight.compute_estimate.basis}</small>
                </>
              ) : (
                <small>
                  Preview estimate; the server verifies the full draft before
                  execution.
                </small>
              )}
              {(preflight?.errors || []).map((e: Entity, i: number) => (
                <p className="compute-warning" key={i}>
                  {e.field}: {e.message}
                </p>
              ))}
              {preflight?.feasibility?.feasible === false ? (
                <p className="compute-warning">
                  Intervention prerequisites:{" "}
                  {preflight.feasibility.reasons?.join("; ")}
                </p>
              ) : null}
              {estimateError ? (
                <p className="compute-warning">
                  Estimate unavailable: {estimateError}
                </p>
              ) : null}
            </div>
          </div>
          <div className="census-summary">
            <span className="eyebrow">STARTING CENSUS</span>
            <strong>
              {patientsOf(initialCtx).length} <small>synthetic patients</small>
            </strong>
            <span>
              {statsFor(initialCtx, "ward", "FAC-MAIN").occupied +
                statsFor(initialCtx, "icu", "FAC-MAIN").occupied}{" "}
              inpatient · {statsFor(initialCtx, "ed", "FAC-MAIN").occupied} in
              ED
            </span>
            <Button small onClick={() => ctx.setPage("data")}>
              <FileText size={13} />
              Inspect source dataset
            </Button>
          </div>
        </aside>
      </div>
      {advanced ? (
        <Modal
          title="Scenario assumptions"
          wide
          onClose={() => setAdvanced(false)}
        >
          <div className="form-stack">
            <div className="two-fields">
              <label>
                Snapshot timestamp (UTC)
                <input
                  readOnly
                  type="datetime-local"
                  value={startAt.slice(0, 16)}
                  onChange={(e) => {
                    setStartAt(new Date(`${e.target.value}:00Z`).toISOString());
                    setDirty(true);
                  }}
                />
              </label>
              <label>
                Base random seed
                <input
                  type="number"
                  min="0"
                  value={seed}
                  onChange={(e) => {
                    setSeed(+e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
            </div>
            <div className="info-note">
              All conditions are versioned inputs. Existing imported conditions
              are preserved when editing a selected arrival stream. Advanced
              conditions support resource schedules, duration multipliers, and
              incident batches.
            </div>
            <label>
              Complete condition list
              <textarea
                className="json-editor"
                value={conditionsJson}
                onChange={(e) => setConditionsJson(e.target.value)}
                spellCheck={false}
              />
            </label>
            <Button
              primary
              disabled={ctx.canWrite === false}
              onClick={() =>
                ctx.action("Saving condition assumptions", async () => {
                  const conditions = JSON.parse(conditionsJson);
                  if (!Array.isArray(conditions))
                    throw new Error("Conditions must be an array.");
                  const saved = await ctx.saveScenario({
                    conditions,
                    start_at: startAt,
                    base_seed: seed,
                  });
                  if (saved) {
                    setAdvanced(false);
                    setDirty(false);
                  }
                })
              }
            >
              Validate and save all conditions <Check size={14} />
            </Button>
          </div>
        </Modal>
      ) : null}
      {diffOpen ? (
        <Modal
          title="Compare saved scenario inputs"
          wide
          onClose={() => setDiffOpen(false)}
        >
          <div className="form-stack">
            <p>
              Current saved draft: <strong>{versions[0]?.name}</strong>. Unsaved
              form edits are excluded. Frozen run inputs retain their original
              values.
            </p>
            <label>
              Compare against
              <select
                value={baseVersion}
                onChange={(e) => setBaseVersion(e.target.value)}
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            {differenceRows.length ? (
              <div className="table-scroll">
                <table className="data-table version-differences">
                  <thead>
                    <tr>
                      <th>Input</th>
                      <th>Selected saved version</th>
                      <th>Current saved draft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {differenceRows.map((row) => (
                      <tr key={row.field}>
                        <th>{row.field}</th>
                        <td>
                          <pre>{JSON.stringify(row.before, null, 2)}</pre>
                        </td>
                        <td>
                          <pre>{JSON.stringify(row.after, null, 2)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No input differences between these saved versions.</p>
            )}
          </div>
        </Modal>
      ) : null}
      {library ? (
        <Modal title="Scenario library" onClose={() => setLibrary(false)} wide>
          <div className="library-list">
            {scenarios.map((s) => (
              <div className="library-row" key={s.id}>
                <div>
                  <strong>{s.name}</strong>
                  <span>
                    {s.horizon_calendar_days} days · {s.replications} runs ·
                    Revision {s.revision}
                  </span>
                </div>
                <Badge>{s.archived ? "Archived" : "Saved"}</Badge>
                <Button
                  small
                  onClick={async () => {
                    await ctx.saveScenario({ __select: s.id });
                    setLibrary(false);
                  }}
                >
                  Open
                </Button>
                <Button
                  small
                  disabled={ctx.canWrite === false}
                  onClick={() =>
                    ctx.action("Cloning scenario", async () => {
                      await post(`/scenarios/${s.id}/clone`, {
                        name: `${s.name} — copy`,
                      });
                      setScenarios(items(await api("/scenarios")));
                    })
                  }
                >
                  <Copy size={13} />
                  Clone
                </Button>
                <Button
                  small
                  aria-label={`Archive ${s.name}`}
                  disabled={ctx.canWrite === false}
                  onClick={() =>
                    ctx.action("Archiving scenario", async () => {
                      await post(`/scenarios/${s.id}/archive`);
                      setScenarios(items(await api("/scenarios")));
                    })
                  }
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            primary
            disabled={ctx.canWrite === false}
            onClick={() =>
              ctx.action("Creating scenario", async () => {
                const s = await post("/scenarios", {
                  ...ctx.scenario,
                  name: "New planning scenario",
                  dataset_version_id: ctx.dataset?.id,
                });
                await ctx.saveScenario({ __select: s.id });
                setLibrary(false);
              })
            }
          >
            <Plus size={15} />
            New scenario
          </Button>
        </Modal>
      ) : null}
    </div>
  );
}
function HospitalIcon() {
  return <Layers size={20} />;
}
function ConditionWindow({
  start,
  end,
  days,
  onBegin,
  onChange,
}: {
  start: number;
  end: number;
  days: number;
  onBegin: () => void;
  onChange: (a: number, b: number) => void;
}) {
  const drag = useRef<{
    mode: string;
    anchor: number;
    start: number;
    end: number;
  } | null>(null);
  function day(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        days,
        Math.round(((event.clientX - rect.left) / rect.width) * days),
      ),
    );
  }
  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const mode =
      (event.target as HTMLElement).closest<HTMLElement>("[data-mode]")?.dataset
        .mode || "select";
    onBegin();
    drag.current = { mode, anchor: day(event), start, end };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active) return;
    const current = day(event);
    if (active.mode === "start")
      onChange(Math.min(current, active.end - 1), active.end);
    else if (active.mode === "end")
      onChange(active.start, Math.max(active.start + 1, current));
    else if (active.mode === "move") {
      const width = active.end - active.start,
        a = Math.max(
          0,
          Math.min(days - width, active.start + current - active.anchor),
        );
      onChange(a, a + width);
    } else {
      const a = Math.min(active.anchor, current),
        b = Math.max(active.anchor, current);
      onChange(Math.min(a, days - 1), Math.max(a + 1, b));
    }
  }
  function key(event: KeyboardEvent<HTMLButtonElement>, mode: string) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    onBegin();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    if (mode === "start")
      onChange(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? end - 1
            : Math.max(0, Math.min(end - 1, start + delta)),
        end,
      );
    else if (mode === "end")
      onChange(
        start,
        event.key === "Home"
          ? start + 1
          : event.key === "End"
            ? days
            : Math.max(start + 1, Math.min(days, end + delta)),
      );
    else {
      const width = end - start,
        a =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? days - width
              : Math.max(0, Math.min(days - width, start + delta));
      onChange(a, a + width);
    }
  }
  return (
    <>
      <p className="window-instruction">
        Drag empty track to select a window, its body to move, or its edges to
        resize. Arrow keys and numeric fields provide the same edits.
      </p>
      <div
        className="condition-window"
        aria-label="Condition time window"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div
          className="condition-window-block"
          style={{
            left: `${(start / days) * 100}%`,
            width: `${((end - start) / days) * 100}%`,
          }}
        >
          <button
            data-mode="start"
            aria-label="Resize condition start"
            role="slider"
            aria-valuemin={1}
            aria-valuemax={end}
            aria-valuenow={start + 1}
            onKeyDown={(e) => key(e, "start")}
          >
            ‹
          </button>
          <button
            className="condition-window-body"
            data-mode="move"
            aria-label="Move condition window"
            onKeyDown={(e) => key(e, "move")}
          >
            Day {start + 1}–{end}
          </button>
          <button
            data-mode="end"
            aria-label="Resize condition end"
            role="slider"
            aria-valuemin={start + 1}
            aria-valuemax={days}
            aria-valuenow={end}
            onKeyDown={(e) => key(e, "end")}
          >
            ›
          </button>
        </div>
      </div>
    </>
  );
}
