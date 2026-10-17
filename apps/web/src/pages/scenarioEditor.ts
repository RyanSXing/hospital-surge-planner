import type { Entity, Scenario } from "../types";
import { atDay, localDayIndex } from "../api";
export type MixMode = "default" | "percentages" | "preserve";
export interface EditorValues {
  name: string;
  startAt: string;
  seed: number;
  days: number;
  replications: number;
  stream: string;
  conditionId: string;
  staffConditionId: string;
  percent: number;
  shape: string;
  absence: number;
  startDay: number;
  endDay: number;
  peakDay: number;
  mixMode: MixMode;
  mix: Record<string, number>;
  customPoints?: { at: string; multiplier: number }[];
  windowStartAt?: string;
  windowEndAt?: string;
  editArrival?: boolean;
  editLegacyStaff?: boolean;
}
export function clampWindow(start: number, end: number, days: number) {
  const a = Math.max(0, Math.min(Math.round(start), days - 1));
  return {
    startDay: a,
    endDay: Math.min(days, Math.max(a + 1, Math.round(end))),
  };
}
export function conditionWindow(scenario: Scenario, condition?: Entity) {
  const curve =
    condition?.control_points?.length >= 2 ? condition?.control_points : null;
  const start = curve?.[0]?.at || condition?.start_at;
  const end = curve?.at(-1)?.at || condition?.end_at;
  return clampWindow(
    start ? localDayIndex(scenario.start_at, start, scenario.timezone) : 0,
    end
      ? localDayIndex(scenario.start_at, end, scenario.timezone)
      : scenario.horizon_calendar_days,
    scenario.horizon_calendar_days,
  );
}
export function mixError(mode: MixMode, mix: Record<string, number>) {
  if (mode === "default") return "";
  const values = Object.values(mix);
  return !values.length ||
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-8
    ? "Care fractions must be nonnegative and total 100%."
    : "";
}
export function planningEnd(
  scenario: Scenario | null,
  startAt: string,
  days: number,
) {
  return (
    scenario?.end_at ||
    atDay(startAt, days, 0, scenario?.timezone || "America/Chicago")
  );
}
export function buildScenarioPatch(
  scenario: Scenario | null,
  value: EditorValues,
) {
  const {
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
    mixMode,
    mix,
  } = value;
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error("Horizon must be 1–365 local calendar days.");
  if (!Number.isFinite(percent) || percent < -100)
    throw new Error("Arrival change must be at least −100%.");
  const invalid = mixError(mixMode, mix);
  if (invalid) throw new Error(invalid);
  const { startDay, endDay } = clampWindow(value.startDay, value.endDay, days),
    zone = scenario?.timezone || "America/Chicago";
  const exclusiveEnd = planningEnd(scenario, startAt, days);
  const a = value.windowStartAt ?? atDay(startAt, startDay, 0, zone),
    b =
      value.windowEndAt ??
      new Date(
        Math.min(
          Date.parse(atDay(startAt, endDay, 0, zone)),
          Date.parse(exclusiveEnd),
        ),
      ).toISOString(),
    m = 1 + percent / 100;
  const selected = (scenario?.conditions || []).find(
    (c) =>
      c.kind === "arrival_multiplier" &&
      (conditionId
        ? c.id === conditionId
        : (c.entry_stream_id || "ED_MAIN") === stream),
  );
  if (
    value.editArrival !== false &&
    (!(Date.parse(a) < Date.parse(b)) ||
      Date.parse(a) < Date.parse(startAt) ||
      Date.parse(b) > Date.parse(exclusiveEnd))
  )
    throw new Error(
      "Arrival window must be ordered and lie within the scenario horizon.",
    );
  let peak = Math.max(startDay, Math.min(value.peakDay, endDay));
  const peakAt =
    peak > startDay && peak < endDay
      ? atDay(startAt, peak, 0, zone)
      : new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString();
  const control_points =
    shape === "custom"
      ? (value.customPoints || []).map((p) => ({ ...p }))
      : shape === "wave"
        ? [
            { at: a, multiplier: 1 },
            { at: peakAt, multiplier: m },
            { at: b, multiplier: 1 },
          ]
        : [
            { at: a, multiplier: shape === "ramp" ? 1 : m },
            { at: b, multiplier: m },
          ];
  if (
    value.editArrival !== false &&
    shape === "custom" &&
    (control_points.length < 2 ||
      control_points.some(
        (p, i) =>
          !Number.isFinite(Date.parse(p.at)) ||
          Date.parse(p.at) < Date.parse(startAt) ||
          Date.parse(p.at) > Date.parse(exclusiveEnd) ||
          !Number.isFinite(p.multiplier) ||
          p.multiplier < 0 ||
          (i > 0 && Date.parse(p.at) <= Date.parse(control_points[i - 1].at)),
      ))
  )
    throw new Error(
      "Custom arrival curves need at least two ordered timestamps and nonnegative multipliers.",
    );
  const preserved = (scenario?.conditions || []).filter(
    (c) =>
      (value.editArrival === false || c !== selected) &&
      !(
        value.editLegacyStaff !== false &&
        (staffConditionId
          ? c.id === staffConditionId
          : ["staff_absence", "staff_unavailability"].includes(c.kind) &&
            c.unit_id === "UNIT-WARD-A")
      ),
  );
  const conditions: Entity[] = [];
  if (
    value.editArrival !== false &&
    (percent !== 0 || mixMode !== "default" || shape === "custom")
  ) {
    const edited: Entity = {
      ...selected,
      id: selected?.id || conditionId || `condition-arrivals-${stream}`,
      kind: "arrival_multiplier",
      entry_stream_id: stream,
      shape: ["wave", "ramp", "custom"].includes(shape)
        ? "piecewise_linear"
        : "step",
      surge_percent:
        shape === "custom"
          ? (Math.max(...control_points.map((p) => p.multiplier)) - 1) * 100
          : percent,
      start_at: shape === "custom" ? control_points[0].at : a,
      end_at: shape === "custom" ? control_points.at(-1)!.at : b,
      control_points,
      source: selected?.source || "user_assumption",
    };
    if (mixMode === "default") delete edited.care_mix_override;
    else edited.care_mix_override = { ...mix };
    conditions.push(edited);
  }
  if (absence && value.editLegacyStaff !== false)
    conditions.push({
      id: staffConditionId || "condition-staff",
      kind: "staff_absence",
      unit_id: "UNIT-WARD-A",
      absence_percent: absence,
      start_at: shape === "custom" ? control_points[0].at : a,
      end_at: shape === "custom" ? control_points.at(-1)!.at : b,
      source: "user_assumption",
    });
  // Replacing one input must not change its ordering relative to explicit cohort overrides.
  const ordered = [...preserved];
  for (const edited of conditions) {
    const original = (scenario?.conditions || []).find(
      (c) =>
        c.id === edited.id ||
        (edited.kind === "arrival_multiplier" && c === selected),
    );
    if (original) {
      const index = scenario!.conditions.indexOf(original);
      const before = new Set(scenario!.conditions.slice(0, index));
      const insertion = ordered.reduce(
        (n, c, i) => (before.has(c) ? i + 1 : n),
        0,
      );
      ordered.splice(insertion, 0, edited);
    } else ordered.push(edited);
  }
  return {
    name,
    start_at: startAt,
    base_seed: seed,
    horizon_calendar_days: days,
    replications,
    conditions: ordered,
  };
}
export function inputDifferences(before: Entity, after: Entity) {
  const fields = [
    "name",
    "dataset_version_id",
    "start_at",
    "end_at",
    "timezone",
    "horizon_calendar_days",
    "base_seed",
    "replications",
    "conditions",
    "interventions",
    "updates",
  ];
  return fields
    .filter(
      (field) =>
        JSON.stringify(before[field] ?? null) !==
        JSON.stringify(after[field] ?? null),
    )
    .map((field) => ({
      field: field.replaceAll("_", " "),
      before: before[field] ?? null,
      after: after[field] ?? null,
    }));
}

export type HorizonUnit = "days" | "weeks" | "months";
export function horizonDays(
  start: string,
  amount: number,
  unit: HorizonUnit,
  zone = "America/Chicago",
) {
  if (!Number.isInteger(amount) || amount < 1)
    throw new Error("Enter a positive whole horizon amount.");
  if (unit === "days") return amount;
  if (unit === "weeks") return amount * 7;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })
      .formatToParts(new Date(start))
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year),
    month = Number(parts.month),
    day = Number(parts.day);
  const target = new Date(Date.UTC(year, month - 1 + amount, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const end = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(day, last),
  );
  return (end - Date.UTC(year, month - 1, day)) / 86400000;
}
