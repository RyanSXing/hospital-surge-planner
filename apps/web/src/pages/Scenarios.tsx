import { useEffect, useRef, useState } from "react";
import {
  Accordion,
  NativeSelect,
  NumberInput,
  SegmentedControl,
  Slider,
  TextInput,
} from "@mantine/core";
import ArrivalPreview from "./ArrivalPreview";
import { usesCustomArrivalSchedule } from "./arrivalControlMode";
import HospitalConfigurationControls from "./HospitalConfigurationControls";
import {
  applyConfigurationInputs,
  configurationTargets,
} from "./hospitalConfigurationModel";
import type { ConfigurationTargets } from "./hospitalConfigurationModel";
import {
  clampArrivalPercent,
  completeArrivalPercent,
} from "./arrivalPercentInput";
import {
  plannedArrivals,
  arrivalControlPercent,
  displayArrivalPercent,
} from "./plannedArrivalSeries";
import {
  buildScenarioPatch,
  conditionWindow,
  mixError,
  horizonDays,
  planningEnd,
  resizedArrivalWindow,
} from "./scenarioEditor";
import type { HorizonUnit, MixMode } from "./scenarioEditor";
import "./scenarios.css";
import ScenarioTracks from "./ScenarioTracks";
import { ZonedDateTimeInput } from "../components/ZonedDateTimeInput";
import { utcMinute } from "../zonedTime";
import type { PlanEditorRequest } from "./ScenarioTracks";
import {
  ArrowRight,
  Check,
  Copy,
  Layers,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  Users,
  Wind,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, atDay, fmt, items, localDate, localDayIndex, post } from "../api";
import { Badge, Busy, Button, ErrorBox, Modal } from "../components/ui";
export default function Scenarios({ ctx }: { ctx: PlanningContext }) {
  const [openSections, setOpenSections] = useState<string[]>([]);
  const [moreParameters, setMoreParameters] = useState(false);
  const [windowStartAt, setWindowStartAt] = useState<string | undefined>();
  const [windowEndAt, setWindowEndAt] = useState<string | undefined>();
  const [customInterpolation, setCustomInterpolation] = useState<
    "step" | "piecewise_linear"
  >("piecewise_linear");
  const [customPoints, setCustomPoints] = useState<
    { at: string; multiplier: number }[]
  >([]);
  const [planRequest, setPlanRequest] = useState<PlanEditorRequest | null>(
    null,
  );
  useEffect(() => {
    if (planRequest) {
      setMoreParameters(true);
      setOpenSections((value) =>
        value.includes("resources") ? value : [...value, "resources"],
      );
    }
  }, [planRequest]);
  const [draftInterventions, setDraftInterventions] = useState<Entity[]>([]);
  const [draftUpdates, setDraftUpdates] = useState<Entity[]>([]);
  const [capacityTargets, setCapacityTargets] = useState<ConfigurationTargets>({
    units: {},
  });
  const [arrivalEdited, setArrivalEdited] = useState(false);
  const [legacyStaffEdited, setLegacyStaffEdited] = useState(false);
  const [startAt, setStartAt] = useState("2026-10-16T05:00:00Z"),
    [seed, setSeed] = useState(20261016),
    [stream, setStream] = useState("ED_MAIN"),
    [conditionId, setConditionId] = useState(""),
    [staffConditionId, setStaffConditionId] = useState(""),
    [peakDay, setPeakDay] = useState(10),
    [name, setName] = useState(""),
    [percent, setPercent] = useState(70),
    [days, setDays] = useState(30),
    [horizonUnit, setHorizonUnit] = useState<HorizonUnit>("days"),
    [horizonAmount, setHorizonAmount] = useState(30),
    [replications, setReplications] = useState(100),
    [shape, setShape] = useState("sustained"),
    [absence, setAbsence] = useState(0),
    [dirty, setDirty] = useState(false),
    [library, setLibrary] = useState(false),
    [scenarios, setScenarios] = useState<Entity[]>([]),
    [librarySearch, setLibrarySearch] = useState(""),
    [libraryArchived, setLibraryArchived] = useState(false),
    [libraryCursor, setLibraryCursor] = useState<string | null>(null),
    [libraryTotal, setLibraryTotal] = useState(0),
    [libraryLoading, setLibraryLoading] = useState(false),
    [libraryError, setLibraryError] = useState(""),
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
    [editorError, setEditorError] = useState(""),
    [preflight, setPreflight] = useState<Entity | null>(null),
    [estimating, setEstimating] = useState(false),
    [estimateError, setEstimateError] = useState(""),
    [draftConditions, setDraftConditions] = useState<Entity[]>([]);
  const libraryRequest = useRef(0);
  const [arrivalInput, setArrivalInput] = useState<number | string>(70);
  const arrivalInputChanged = useRef(false);
  const arrivalInputUndoCaptured = useRef(false);
  const revealArrivalDetails = useRef(true);
  const exclusiveEnd = planningEnd(ctx.scenario, startAt, days);
  const timeZone =
    ctx.scenario?.timezone || ctx.dataset?.timezone || "America/Chicago";
  function loadCondition(
    c: Entity | undefined,
    s = ctx.scenario,
    revealDetails = true,
  ) {
    if (!s) return;
    revealArrivalDetails.current = revealDetails;
    setStream(c?.entry_stream_id || "ED_MAIN");
    setConditionId(c?.id || "");
    const window = conditionWindow(s, c);
    setStartDay(window.startDay);
    setEndDay(window.endDay);
    setWindowStartAt(c?.control_points?.[0]?.at || c?.start_at);
    setWindowEndAt(c?.control_points?.at(-1)?.at || c?.end_at);
    const points = c?.control_points || [];
    setCustomPoints(
      points.map((p: Entity) => ({ at: p.at, multiplier: p.multiplier })),
    );
    const maxPoint = points.length
      ? points.reduce((a: Entity, p: Entity) =>
          p.multiplier > a.multiplier ? p : a,
        )
      : null;
    const focusPoint =
      points.length === 2
        ? points[1]
        : points.length === 3 &&
            points[0].multiplier === 1 &&
            points[2].multiplier === 1
          ? points[1]
          : maxPoint;
    const controlPercent = arrivalControlPercent(c);
    setPercent(controlPercent);
    setArrivalInput(displayArrivalPercent(controlPercent));
    arrivalInputChanged.current = false;
    arrivalInputUndoCaptured.current = false;
    setCustomInterpolation(
      c?.shape === "piecewise_linear" ? "piecewise_linear" : "step",
    );
    setShape(
      c?.shape === "piecewise_linear" && points.length >= 2
        ? points.length === 2 && points[0].multiplier === 1
          ? "ramp"
          : points.length === 3 &&
              points[0].multiplier === 1 &&
              points[2].multiplier === 1
            ? "wave"
            : "custom"
        : points.length > 2 &&
            new Set(
              points.slice(0, -1).map((point: Entity) => point.multiplier),
            ).size > 1
          ? "custom"
          : c?.shape === "wave" && !points.length
            ? "wave"
            : c
              ? "sustained"
              : "baseline",
    );
    setPeakDay(
      points.length > 2 && focusPoint
        ? localDayIndex(s.start_at, focusPoint.at, s.timezone)
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
    setDraftConditions(s.conditions || []);
    setDraftInterventions(s.interventions || []);
    setDraftUpdates(s.updates || []);
    setCapacityTargets(
      configurationTargets({
        conditions: s.conditions || [],
        interventions: s.interventions || [],
        updates: s.updates || [],
      }),
    );
    setArrivalEdited(false);
    setLegacyStaffEdited(false);
    setName(s.name);
    setDays(s.horizon_calendar_days);
    setHorizonUnit("days");
    setHorizonAmount(s.horizon_calendar_days);
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
  useEffect(() => {
    if (shape === "custom" && revealArrivalDetails.current) {
      setMoreParameters(true);
      setOpenSections((value) =>
        value.includes("demand") ? value : [...value, "demand"],
      );
    }
  }, [shape]);
  const snapshot = () => ({
    windowStartAt,
    windowEndAt,
    customPoints,
    customInterpolation,
    name,
    startAt,
    seed,
    replications,
    staffConditionId,
    arrivalEdited,
    legacyStaffEdited,
    draftInterventions,
    draftUpdates,
    capacityTargets,
    percent,
    days,
    horizonUnit,
    horizonAmount,
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
  function rememberArrival() {
    remember();
    setArrivalEdited(true);
  }
  function restore(v: Entity) {
    setCustomPoints(v.customPoints);
    setCustomInterpolation(v.customInterpolation || "piecewise_linear");
    setWindowStartAt(v.windowStartAt);
    setWindowEndAt(v.windowEndAt);
    setName(v.name);
    setStartAt(v.startAt);
    setSeed(v.seed);
    setReplications(v.replications);
    setStaffConditionId(v.staffConditionId);
    setArrivalEdited(v.arrivalEdited);
    setLegacyStaffEdited(v.legacyStaffEdited);
    setDraftInterventions(v.draftInterventions);
    setDraftUpdates(v.draftUpdates);
    setCapacityTargets(v.capacityTargets || { units: {} });
    setPercent(v.percent);
    setArrivalInput(displayArrivalPercent(v.percent));
    arrivalInputChanged.current = false;
    arrivalInputUndoCaptured.current = false;
    setDays(v.days);
    setHorizonUnit(v.horizonUnit || "days");
    setHorizonAmount(v.horizonAmount || v.days);
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
    const patch = buildScenarioPatch(
      ctx.scenario ? { ...ctx.scenario, conditions: draftConditions } : null,
      {
        customPoints,
        windowStartAt,
        windowEndAt,
        editArrival: arrivalEdited,
        editLegacyStaff: legacyStaffEdited,
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
    if (arrivalEdited && shape === "custom") {
      patch.conditions = patch.conditions.map((condition) =>
        condition.kind === "arrival_multiplier" &&
        (conditionId
          ? condition.id === conditionId
          : (condition.entry_stream_id || "ED_MAIN") === stream)
          ? { ...condition, shape: customInterpolation }
          : condition,
      );
    }
    const draft = {
      conditions: patch.conditions,
      interventions: draftInterventions,
      updates: draftUpdates,
    };
    return {
      ...patch,
      ...(ctx.dataset
        ? applyConfigurationInputs(ctx.dataset, draft, capacityTargets)
        : draft),
    };
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
      setArrivalEdited(false);
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
    draftInterventions,
    draftUpdates,
    capacityTargets,
    arrivalEdited,
    legacyStaffEdited,
    customPoints,
    customInterpolation,
    windowStartAt,
    windowEndAt,
  ]);
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
  async function loadLibrary(cursor?: string) {
    const request = ++libraryRequest.current;
    setLibraryLoading(true);
    setLibraryError("");
    try {
      const params = new URLSearchParams({
        limit: "50",
        archived: String(libraryArchived),
        search: librarySearch.trim(),
      });
      if (cursor) params.set("cursor", cursor);
      const result = await api(`/scenarios?${params}`);
      if (request !== libraryRequest.current) return;
      setScenarios((previous) =>
        cursor
          ? [
              ...previous,
              ...items(result).filter(
                (row) => !previous.some((p) => p.id === row.id),
              ),
            ]
          : items(result),
      );
      setLibraryCursor(result.next_cursor || null);
      setLibraryTotal(result.total ?? items(result).length);
    } catch (error) {
      if (request === libraryRequest.current)
        setLibraryError((error as Error).message);
    } finally {
      if (request === libraryRequest.current) setLibraryLoading(false);
    }
  }
  useEffect(() => {
    if (!library) return;
    const timer = setTimeout(() => void loadLibrary(), librarySearch ? 200 : 0);
    return () => {
      clearTimeout(timer);
      ++libraryRequest.current;
    };
  }, [library, librarySearch, libraryArchived]);
  function openLibrary() {
    setScenarios([]);
    setLibraryCursor(null);
    setLibrary(true);
  }
  function changeHorizon(amount: number, unit: HorizonUnit = horizonUnit) {
    remember();
    const limit =
      unit === "days"
        ? 365
        : unit === "weeks"
          ? 52
          : horizonDays(startAt, 12, "months", ctx.scenario?.timezone) <= 365
            ? 12
            : 11;
    const count = Math.max(1, Math.min(limit, Math.round(amount) || 1));
    const total = horizonDays(startAt, count, unit, ctx.scenario?.timezone);
    const arrivalWindow = !customArrivalSchedule
      ? resizedArrivalWindow(
          ctx.scenario,
          {
            startAt,
            days,
            startDay,
            endDay,
            windowStartAt,
            windowEndAt,
            shape,
          },
          total,
        )
      : null;
    setHorizonUnit(unit);
    setHorizonAmount(count);
    setDays(total);
    if (arrivalWindow) {
      setEndDay(arrivalWindow.endDay);
      setWindowEndAt(arrivalWindow.windowEndAt);
      setArrivalEdited(true);
    }
  }
  let previewConditions = draftConditions;
  try {
    previewConditions = makePatch().conditions;
  } catch {
    /* Validation is shown beside Run simulation. */
  }
  function changeArrival(value: number) {
    rememberArrival();
    setPercent(value);
    setArrivalInput(displayArrivalPercent(value));
    if (shape === "baseline" && value !== 0) setShape("sustained");
  }
  function typeArrival(value: number | string) {
    setArrivalInput(value);
    arrivalInputChanged.current = true;
    const complete = completeArrivalPercent(value);
    if (complete === null || complete === percent) return;
    if (!arrivalInputUndoCaptured.current) {
      rememberArrival();
      arrivalInputUndoCaptured.current = true;
    }
    setPercent(complete);
    if (shape === "baseline" && complete !== 0) setShape("sustained");
  }
  function finishArrivalInput() {
    const complete = completeArrivalPercent(arrivalInput);
    if (arrivalInputChanged.current && complete !== null) {
      const normalized = clampArrivalPercent(complete);
      if (normalized !== percent) {
        if (!arrivalInputUndoCaptured.current) rememberArrival();
        setPercent(normalized);
        if (shape === "baseline" && normalized !== 0) setShape("sustained");
      }
      setArrivalInput(displayArrivalPercent(normalized));
    } else {
      setArrivalInput(displayArrivalPercent(percent));
    }
    arrivalInputChanged.current = false;
    arrivalInputUndoCaptured.current = false;
  }
  function changePattern(value: string) {
    revealArrivalDetails.current = true;
    rememberArrival();
    setShape(value);
    if (value === "wave")
      setPeakDay(Math.max(startDay, Math.floor((startDay + endDay) / 2)));
  }
  const baseline = ctx.dataset?.arrival_profiles || {};
  const edRate = Number(baseline.ed_arrivals_per_local_day ?? 100),
    directRate = Number(baseline.direct_ward_arrivals_per_local_day ?? 4);
  const estimated = Math.round(
    (plannedArrivals({
      conditions: previewConditions,
      stream,
      baselineRate: stream === "ED_MAIN" ? edRate : directRate,
      start: startAt,
      end: exclusiveEnd,
      days,
      timeZone,
    }).reduce((sum, point) => sum + point.planned, 0) +
      (stream === "ED_MAIN" ? directRate : edRate) * days) *
      replications,
  );
  const displayedPercent = displayArrivalPercent(percent);
  const invalidMix = mixError(mixMode, mix);
  const customArrivalSchedule =
    usesCustomArrivalSchedule(draftConditions, stream, shape) ||
    usesCustomArrivalSchedule(previewConditions, stream, shape);
  const arrivalPercentControls = (
    <div className="simulation-control">
      <div className="simulation-control-heading">
        <h3>Patient arrivals</h3>
        <NumberInput
          id="surge-input"
          aria-label={`Increase in ${stream === "ED_MAIN" ? "ED arrivals" : "direct ward admissions"}`}
          value={arrivalInput}
          min={-100}
          max={10000}
          clampBehavior="none"
          trimLeadingZeroesOnBlur={false}
          step={5}
          suffix="%"
          disabled={shape === "custom"}
          onChange={typeArrival}
          onBlur={finishArrivalInput}
        />
      </div>
      <Slider
        thumbLabel="Adjust arrival surge"
        value={displayedPercent}
        min={-100}
        max={Math.max(200, Math.ceil(percent / 100) * 100)}
        step={5}
        disabled={shape === "custom"}
        label={(value) => `${value > 0 ? "+" : ""}${value}%`}
        marks={[
          { value: -100, label: "Fewer" },
          { value: 0, label: "Usual" },
          {
            value: Math.max(200, Math.ceil(percent / 100) * 100),
            label: "More",
          },
        ]}
        onChange={changeArrival}
      />
      <p>
        {shape === "custom"
          ? "Arrival levels follow your custom schedule."
          : percent === 0
            ? "Usual arrival levels"
            : `${Math.abs(displayedPercent)}% ${percent > 0 ? "more" : "fewer"} ${stream === "ED_MAIN" ? "emergency arrivals" : "direct admissions"}${shape === "wave" || shape === "ramp" ? " at the peak" : ""}`}
      </p>
    </div>
  );
  const arrivalPatternControls = (
    <div className="simulation-control">
      <div className="simulation-control-heading">
        <h3>Arrival pattern</h3>
      </div>
      <SegmentedControl
        aria-label="Arrival pattern"
        fullWidth
        value={shape === "baseline" ? "sustained" : shape}
        onChange={changePattern}
        data={[
          { value: "sustained", label: "Steady" },
          { value: "ramp", label: "Builds up" },
          { value: "wave", label: "Rises & falls" },
          ...(shape === "custom" ? [{ value: "custom", label: "Custom" }] : []),
        ]}
      />
    </div>
  );
  return (
    <div
      className="scenarios-page guided-scenario"
      data-testid="guided-scenario"
    >
      <div className="page-heading">
        <div>
          <h2 className="scenario-editor-title">Configure your simulation</h2>
        </div>
        <div className="heading-actions">
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
        </div>
      </div>
      {editorError || invalidMix ? (
        <div className="error-banner" role="alert">
          {editorError || invalidMix}
        </div>
      ) : null}
      <div className="scenario-name-row">
        <TextInput
          label="Scenario name"
          aria-label="Scenario name"
          value={name}
          onChange={(e) => {
            remember();
            setName(e.target.value);
          }}
        />
        <Badge tone={dirty ? "warning" : "success"}>
          {dirty ? "Unsaved changes" : "Saved draft"}
        </Badge>
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
              setUndo((a) => [...a, snapshot()]);
              restore(v);
            }}
          >
            Redo
          </button>
        </div>
      </div>

      <div className="simulation-workspace">
        <section
          className="simulation-main-controls"
          aria-label="Main simulation parameters"
        >
          <div className="simulation-control">
            <div className="simulation-control-heading">
              <h3>How long?</h3>
              <span>
                {days} {days === 1 ? "day" : "days"}
              </span>
            </div>
            <SegmentedControl
              aria-label="Simulation duration"
              fullWidth
              value={[7, 14, 30].includes(days) ? String(days) : "custom"}
              disabled={Boolean(ctx.scenario?.end_at)}
              onChange={(value) =>
                value === "custom"
                  ? setMoreParameters(true)
                  : changeHorizon(Number(value), "days")
              }
              data={[
                { value: "7", label: "1 week" },
                { value: "14", label: "2 weeks" },
                { value: "30", label: "30 days" },
                ...(![7, 14, 30].includes(days)
                  ? [{ value: "custom", label: `${days} days` }]
                  : []),
              ]}
            />
            <p>
              {localDate(startAt, { month: "short", day: "numeric", timeZone })}{" "}
              –{" "}
              {localDate(new Date(Date.parse(exclusiveEnd) - 1).toISOString(), {
                month: "short",
                day: "numeric",
                timeZone,
              })}
            </p>
          </div>
          {customArrivalSchedule ? (
            <div
              className="simulation-control custom-arrival-state"
              data-testid="custom-arrival-state"
            >
              <div className="simulation-control-heading">
                <h3>Patient arrivals</h3>
              </div>
              <Badge tone="cyan">Custom daily curve</Badge>
              <p>
                {ctx.canWrite === false
                  ? "Daily arrival levels are shown in the blue curve."
                  : "Drag a blue point to change that day’s arrivals."}
              </p>
            </div>
          ) : (
            <>
              {arrivalPercentControls}
              {arrivalPatternControls}
            </>
          )}
        </section>
        <ArrivalPreview
          key={`arrivals:${ctx.scenario?.id || "new"}:${ctx.scenario?.revision || 0}`}
          conditions={previewConditions}
          stream={stream}
          baselineRate={stream === "ED_MAIN" ? edRate : directRate}
          start={startAt}
          end={exclusiveEnd}
          days={days}
          timeZone={timeZone}
          hourWeights={
            ctx.dataset?.entry_streams?.find(
              (item: Entity) => item.entry_stream_id === stream,
            )?.hour_weights || baseline.hour_weights
          }
          weekdayWeights={
            ctx.dataset?.entry_streams?.find(
              (item: Entity) => item.entry_stream_id === stream,
            )?.weekday_weights || baseline.weekday_weights
          }
          editable={ctx.canWrite !== false && !ctx.busy}
          onEditStart={remember}
          onConditionsChange={(conditions, editedConditionId) => {
            setDraftConditions(conditions);
            const selected =
              conditions.find(
                (condition) => condition.id === editedConditionId,
              ) ||
              conditions.find(
                (condition) =>
                  condition.kind === "arrival_multiplier" &&
                  (condition.entry_stream_id || "ED_MAIN") === stream,
              );
            loadCondition(selected, ctx.scenario, false);
            if (!selected) setStream(stream);
            setArrivalEdited(false);
          }}
        />
        {ctx.dataset ? (
          <HospitalConfigurationControls
            key={`capacity:${ctx.scenario?.id}:${ctx.scenario?.revision}`}
            dataset={ctx.dataset}
            start={startAt}
            value={capacityTargets}
            disabled={ctx.canWrite === false || !!ctx.busy}
            onEditStart={remember}
            onChange={setCapacityTargets}
          />
        ) : null}
      </div>
      <div className="simulation-run-row">
        <div
          role="status"
          className={
            preflight?.valid === false || estimateError || invalidMix
              ? "setup-validation"
              : "simulation-ready"
          }
        >
          {preflight?.valid === false || estimateError || invalidMix ? (
            invalidMix ||
            estimateError ||
            preflight?.errors?.[0]?.message ||
            "Review your parameters before running."
          ) : (
            <>
              <Check size={16} />
              {estimating ? "Checking your settings…" : "Ready to run"}
            </>
          )}
        </div>
        <Button
          primary
          className="setup-run-button"
          onClick={() => save(true)}
          disabled={
            ctx.canWrite === false ||
            !!ctx.busy ||
            estimating ||
            preflight?.valid === false ||
            !!invalidMix
          }
        >
          Run simulation <ArrowRight size={16} />
        </Button>
      </div>
      <details
        className="more-simulation-parameters"
        open={moreParameters}
        onToggle={(event) => setMoreParameters(event.currentTarget.open)}
      >
        <summary>
          More parameters <span>Optional</span>
        </summary>
        <div className="optional-run-settings">
          <label>
            Planning horizon
            <NumberInput
              aria-label="Planning horizon"
              min={1}
              max={
                horizonUnit === "days"
                  ? 365
                  : horizonUnit === "weeks"
                    ? 52
                    : horizonDays(startAt, 12, "months", timeZone) <= 365
                      ? 12
                      : 11
              }
              value={horizonUnit === "days" ? days : horizonAmount}
              disabled={Boolean(ctx.scenario?.end_at)}
              onChange={(value) => changeHorizon(Number(value) || 1)}
            />
          </label>
          <label>
            Horizon unit
            <NativeSelect
              aria-label="Horizon unit"
              value={horizonUnit}
              disabled={Boolean(ctx.scenario?.end_at)}
              onChange={(event) => {
                const unit = event.target.value as HorizonUnit;
                changeHorizon(
                  unit === "days"
                    ? days
                    : Math.max(
                        1,
                        Math.round(days / (unit === "weeks" ? 7 : 30)),
                      ),
                  unit,
                );
              }}
            >
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </NativeSelect>
          </label>
          <label>
            Simulation runs
            <NativeSelect
              aria-label="Simulation runs"
              value={replications}
              onChange={(event) => {
                remember();
                setReplications(+event.target.value);
              }}
            >
              {![10, 100, 500].includes(replications) && (
                <option value={replications}>{replications} runs</option>
              )}
              <option value="10">10 · Faster</option>
              <option value="100">100 · Standard</option>
              <option value="500">500 · More detailed</option>
            </NativeSelect>
          </label>
        </div>
        <Accordion
          multiple
          value={openSections}
          onChange={setOpenSections}
          variant="separated"
          radius="md"
          className="scenario-details"
          transitionDuration={0}
        >
          <Accordion.Item value="demand">
            <Accordion.Control icon={<Wind size={18} />}>
              Arrival details
              <span className="setup-section-description">
                Exact dates, extra arrivals and care needs
              </span>
            </Accordion.Control>
            <Accordion.Panel>
              <div
                className="scenario-inspector form-stack"
                id="scenario-inspector-dock"
              >
                <label>
                  Arrival interval
                  <NativeSelect
                    aria-label="Arrival interval"
                    value={conditionId}
                    onChange={(e) => {
                      const staged = makePatch().conditions;
                      remember();
                      setDraftConditions(staged);
                      loadCondition(
                        staged.find((c) => c.id === e.target.value),
                      );
                      setArrivalEdited(false);
                    }}
                  >
                    <option value="">New/default arrival interval</option>
                    {conditionId &&
                    !draftConditions.some((c) => c.id === conditionId) ? (
                      <option value={conditionId}>
                        New unsaved arrival interval
                      </option>
                    ) : null}
                    {draftConditions
                      .filter((c) => c.kind === "arrival_multiplier")
                      .map((c, i) => (
                        <option key={c.id || i} value={c.id}>
                          {c.name ||
                            (c.entry_stream_id === "DIRECT_WARD_MAIN"
                              ? "Direct admissions"
                              : "Emergency arrivals")}{" "}
                          · interval {i + 1}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
                {customArrivalSchedule ? (
                  <div
                    className="arrival-window-controls"
                    aria-label="Selected arrival interval parameters"
                  >
                    <p>
                      These controls apply only to the arrival interval selected
                      above.
                    </p>
                    {arrivalPercentControls}
                    {arrivalPatternControls}
                  </div>
                ) : null}
                <Button
                  small
                  onClick={() => {
                    const staged = makePatch().conditions;
                    remember();
                    setDraftConditions(staged);
                    loadCondition(undefined);
                    setConditionId(crypto.randomUUID());
                    setArrivalEdited(false);
                  }}
                >
                  Add another arrival interval
                </Button>
                {shape === "custom" && (
                  <fieldset className="care-mix-fields">
                    <legend>Exact arrival control points</legend>
                    {customPoints.map((p, i) => (
                      <div className="custom-arrival-point" key={i}>
                        <ZonedDateTimeInput
                          label={`Point ${i + 1} time`}
                          timeZone={timeZone}
                          value={utcMinute(p.at)}
                          onChange={(value) => {
                            rememberArrival();
                            setCustomPoints((rows) =>
                              rows.map((row, j) =>
                                j === i
                                  ? {
                                      ...row,
                                      at: value
                                        ? new Date(value + "Z").toISOString()
                                        : "",
                                    }
                                  : row,
                              ),
                            );
                          }}
                        />
                        <label>
                          Point {i + 1} multiplier
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={p.multiplier}
                            onChange={(e) => {
                              rememberArrival();
                              setCustomPoints((rows) =>
                                rows.map((row, j) =>
                                  j === i
                                    ? { ...row, multiplier: +e.target.value }
                                    : row,
                                ),
                              );
                            }}
                          />
                        </label>
                        <button
                          aria-label={`Remove control point ${i + 1}`}
                          disabled={customPoints.length <= 2}
                          onClick={() => {
                            rememberArrival();
                            setCustomPoints((rows) =>
                              rows.filter((_, j) => j !== i),
                            );
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <Button
                      small
                      onClick={() => {
                        rememberArrival();
                        const last = customPoints.at(-1)!;
                        setCustomPoints((rows) => [
                          ...rows.slice(0, -1),
                          {
                            at: new Date(
                              (Date.parse(rows.at(-2)!.at) +
                                Date.parse(last.at)) /
                                2,
                            ).toISOString(),
                            multiplier: last.multiplier,
                          },
                          last,
                        ]);
                      }}
                    >
                      Add control point
                    </Button>
                    <small>
                      The first and last point define the interval.{" "}
                      {customInterpolation === "step"
                        ? "Each arrival level holds until the next point."
                        : "Arrival levels change gradually between points."}
                    </small>
                  </fieldset>
                )}
                <div className="two-fields">
                  <label>
                    Starts on day
                    <input
                      type="number"
                      min="1"
                      max={days}
                      value={startDay + 1}
                      onChange={(e) => {
                        rememberArrival();
                        setWindowStartAt(undefined);
                        setStartDay(
                          Math.max(
                            0,
                            Math.min(+e.target.value - 1, endDay - 1),
                          ),
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
                        rememberArrival();
                        setWindowEndAt(undefined);
                        setEndDay(
                          Math.min(
                            days,
                            Math.max(startDay + 1, +e.target.value),
                          ),
                        );
                      }}
                    />
                  </label>
                </div>
                {shape !== "custom" && (
                  <div className="two-fields">
                    <ZonedDateTimeInput
                      label="Arrival starts"
                      timeZone={timeZone}
                      value={utcMinute(
                        windowStartAt ?? atDay(startAt, startDay, 0, timeZone),
                      )}
                      onChange={(value) => {
                        rememberArrival();
                        setWindowStartAt(
                          value ? new Date(value + "Z").toISOString() : "",
                        );
                      }}
                    />
                    <ZonedDateTimeInput
                      label="Arrival ends"
                      timeZone={timeZone}
                      value={utcMinute(
                        windowEndAt ??
                          new Date(
                            Math.min(
                              Date.parse(atDay(startAt, endDay, 0, timeZone)),
                              Date.parse(exclusiveEnd),
                            ),
                          ).toISOString(),
                      )}
                      onChange={(value) => {
                        rememberArrival();
                        setWindowEndAt(
                          value ? new Date(value + "Z").toISOString() : "",
                        );
                      }}
                    />
                  </div>
                )}
                {shape === "wave" ? (
                  <label>
                    Peak on day
                    <input
                      type="number"
                      min={startDay + 2}
                      max={endDay - 1}
                      value={peakDay + 1}
                      onChange={(e) => {
                        rememberArrival();
                        setPeakDay(+e.target.value - 1);
                      }}
                    />
                  </label>
                ) : null}
                <label>
                  Arrival stream
                  <NativeSelect
                    aria-label="Arrival stream"
                    value={stream}
                    onChange={(e) => switchStream(e.target.value)}
                  >
                    {ctx.dataset?.entry_streams
                      ?.filter(
                        (item: Entity) =>
                          !item.facility_id || item.facility_id === "FAC-MAIN",
                      )
                      .map((item: Entity) => (
                        <option
                          key={item.entry_stream_id}
                          value={item.entry_stream_id}
                        >
                          {item.entry_stream_id === "ED_MAIN"
                            ? "Emergency department"
                            : item.entry_stream_id === "DIRECT_WARD_MAIN"
                              ? "Direct hospital admissions"
                              : item.name || "Hospital arrivals"}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
                <fieldset className="care-mix-fields">
                  <legend>Disposition of new arrivals</legend>
                  <label>
                    Care mix
                    <NativeSelect
                      aria-label="Care mix"
                      value={mixMode}
                      onChange={(e) => {
                        rememberArrival();
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
                    </NativeSelect>
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
                              rememberArrival();
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
                    <p>Uses the saved care needs for this arrival group.</p>
                  ) : null}
                  {mixMode !== "default" ? (
                    <small>
                      Total:{" "}
                      {fmt(
                        Object.values(mix).reduce((a, b) => a + b, 0) * 100,
                        1,
                      )}
                      %. Applies only to new arrivals in this condition window.
                    </small>
                  ) : (
                    <small>Uses usual care needs for these arrivals.</small>
                  )}
                </fieldset>
              </div>
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="resources">
            <Accordion.Control icon={<Users size={18} />}>
              Staff, beds & equipment
              <span className="setup-section-description">
                Adjust care capacity and scheduled hospital changes
              </span>
            </Accordion.Control>
            <Accordion.Panel>
              {ctx.dataset && (
                <ScenarioTracks
                  dataset={ctx.dataset}
                  draft={{
                    conditions: draftConditions,
                    interventions: draftInterventions,
                    updates: draftUpdates,
                  }}
                  start={startAt}
                  end={exclusiveEnd}
                  timeZone={timeZone}
                  canWrite={ctx.canWrite !== false}
                  request={planRequest}
                  onRequestHandled={() => setPlanRequest(null)}
                  onChange={(next) => {
                    remember();
                    setDraftConditions(next.conditions);
                    setDraftInterventions(next.interventions);
                    setDraftUpdates(next.updates);
                  }}
                />
              )}
            </Accordion.Panel>
          </Accordion.Item>
          <Accordion.Item value="calculation">
            <Accordion.Control icon={<SlidersHorizontal size={18} />}>
              Calculation details
              <span className="setup-section-description">
                Run settings and input checks
              </span>
            </Accordion.Control>
            <Accordion.Panel>
              <div className="calculation-settings">
                <NumberInput
                  label="Random seed"
                  description="Use the same seed to repeat the same random inputs."
                  min={0}
                  value={seed}
                  onChange={(value) => {
                    remember();
                    setSeed(Number(value) || 0);
                  }}
                />
              </div>
              <div className="compute-estimate" aria-live="polite">
                <span>Execution estimate</span>
                <strong>
                  {estimating
                    ? "Calculating…"
                    : preflight?.compute_estimate
                      ? fmt(
                          preflight.compute_estimate
                            .expected_trajectories_total,
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
                      expected patients ×{" "}
                      {preflight.compute_estimate.replications} simulation runs,
                      including the starting census and corrected reports.
                    </small>
                    <small>
                      Service limit:{" "}
                      {fmt(
                        preflight.compute_estimate.limits.max_run_trajectories,
                      )}{" "}
                      modeled patients. Per simulation:{" "}
                      {fmt(
                        preflight.compute_estimate.limits
                          .max_expected_arrivals_per_replication,
                      )}{" "}
                      arrivals.
                    </small>
                    {preflight.compute_estimate.expected_trajectories_total >
                    1000000 ? (
                      <p className="compute-warning">
                        Large workload. A shorter horizon or fewer simulation
                        runs reduces execution time.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <small>
                    Preview estimate; the server verifies the full draft before
                    execution.
                  </small>
                )}
                {(preflight?.errors || []).map((e: Entity, i: number) => (
                  <p className="compute-warning" key={i}>
                    {e.message}
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
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </details>
      {library ? (
        <Modal title="Scenario library" onClose={() => setLibrary(false)} wide>
          <div className="form-stack">
            <label>
              Search saved scenarios
              <input
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
                placeholder="Search by name"
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={libraryArchived}
                onChange={(e) => setLibraryArchived(e.target.checked)}
              />
              Show archived scenarios
            </label>
          </div>
          {libraryError ? <ErrorBox error={libraryError} /> : null}
          <div className="library-list">
            {scenarios.map((s) => (
              <div className="library-row" key={s.id}>
                <div>
                  <strong>{s.name}</strong>
                  <span>
                    {s.horizon_calendar_days} days · {s.replications} runs ·
                    Revision {s.revision}
                  </span>

                  <small>
                    Created{" "}
                    {localDate(s.created_at, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · Modified{" "}
                    {localDate(s.updated_at, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </small>
                  <small>
                    {(
                      {
                        SUCCEEDED: "Results available",
                        COMPLETED: "Results available",
                        QUEUED: "Simulation queued",
                        RUNNING: "Simulation running",
                        AGGREGATING: "Finishing results",
                        CANCEL_REQUESTED: "Cancelling simulation",
                        CANCELLED: "Simulation cancelled",
                        FAILED: "Simulation failed",
                      } as Record<string, string>
                    )[String(s.latest_run?.status || "").toUpperCase()] ||
                      "No results yet"}
                  </small>
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
                      await loadLibrary();
                    })
                  }
                >
                  <Copy size={13} />
                  Clone
                </Button>
                <Button
                  small
                  aria-label={`Archive ${s.name}`}
                  disabled={ctx.canWrite === false || s.archived}
                  onClick={() =>
                    ctx.action("Archiving scenario", async () => {
                      await post(`/scenarios/${s.id}/archive`);
                      await loadLibrary();
                    })
                  }
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
          {libraryLoading ? <Busy label="Loading saved scenarios" /> : null}
          <p className="small-copy">
            {scenarios.length} of {libraryTotal}{" "}
            {libraryArchived ? "archived" : "saved"} scenarios
          </p>
          {libraryCursor ? (
            <Button
              disabled={libraryLoading}
              onClick={() => void loadLibrary(libraryCursor)}
            >
              Load more saved scenarios
            </Button>
          ) : null}
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
