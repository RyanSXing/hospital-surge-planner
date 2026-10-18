import type {
  HospitalDisruption,
  HospitalOperations,
  HospitalSupplies,
  PatientSeverity,
  SeverityMix,
} from "../types";
import { utcToWall, wallTimeCandidates } from "../zonedTime";

export const severityOrder: PatientSeverity[] = ["low", "medium", "high"];
export const defaultSeverityMix = (): SeverityMix => ({
  low: { percentage: 60, average_stay_hours: 24 },
  medium: { percentage: 30, average_stay_hours: 72 },
  high: { percentage: 10, average_stay_hours: 168 },
});
export const defaultSupplies = (): HospitalSupplies => ({
  initial_percent: 100,
  capacity: 10000,
  usage_per_patient_day: 1,
  refill_every_days: 7,
  refill_percent: 100,
});
const bounded = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

/** Exact hundredths; largest-remainder ties always follow low → medium → high. */
function apportion(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const fractions = weights.map((weight) =>
    sum ? (weight / sum) * total : total / weights.length,
  );
  const result = fractions.map(Math.floor);
  const order = fractions
    .map((fraction, index) => ({ index, remainder: fraction - result[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (
    let left = total - result.reduce((a, b) => a + b, 0), i = 0;
    left > 0;
    left--, i++
  )
    result[order[i % order.length].index]++;
  return result;
}
export function normalizeSeverityMix(mix: SeverityMix): SeverityMix {
  const units = apportion(
    10000,
    severityOrder.map((key) => bounded(mix[key].percentage, 0, 100)),
  );
  return Object.fromEntries(
    severityOrder.map((key, i) => [
      key,
      { ...mix[key], percentage: units[i] / 100 },
    ]),
  ) as SeverityMix;
}
/** Editing one share preserves the relative mix of the other two, totaling 100%. */
export function changeSeverityShare(
  mix: SeverityMix,
  severity: PatientSeverity,
  percentage: number,
): SeverityMix {
  const next = normalizeSeverityMix(mix);
  const edited = Math.round(bounded(percentage, 0, 100) * 100);
  const others = severityOrder.filter((key) => key !== severity);
  const shares = apportion(
    10000 - edited,
    others.map((key) => next[key].percentage),
  );
  next[severity].percentage = edited / 100;
  others.forEach((key, index) => {
    next[key].percentage = shares[index] / 100;
  });
  return next;
}
export function averageSeverityStay(mix: SeverityMix) {
  return severityOrder.reduce(
    (sum, key) =>
      sum + (mix[key].percentage / 100) * mix[key].average_stay_hours,
    0,
  );
}
/** Dragging one pie boundary transfers share only between its adjacent slices. */
export function moveSeverityBoundary(
  mix: SeverityMix,
  boundary: 0 | 1,
  percent: number,
): SeverityMix {
  const next = normalizeSeverityMix(mix);
  if (boundary === 0) {
    const available = next.low.percentage + next.medium.percentage;
    next.low.percentage =
      Math.round(bounded(percent, 0, available) * 100) / 100;
    next.medium.percentage =
      Math.round((available - next.low.percentage) * 100) / 100;
  } else {
    const cumulative =
      Math.round(bounded(percent, next.low.percentage, 100) * 100) / 100;
    next.medium.percentage =
      Math.round((cumulative - next.low.percentage) * 100) / 100;
    next.high.percentage = Math.round((100 - cumulative) * 100) / 100;
  }
  return next;
}
function shiftDate(date: string, offset: number) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date
  )
    throw new Error("Choose a valid disruption date.");
  return new Date(timestamp + offset * 86400000).toISOString().slice(0, 10);
}
export function disruptionForDate(
  date: string,
  timeZone: string,
  id: string,
): HospitalDisruption {
  const next = shiftDate(date, 1);
  const start = wallTimeCandidates(`${date}T00:00`, timeZone);
  const end = wallTimeCandidates(`${next}T00:00`, timeZone);
  if (start.length !== 1 || end.length !== 1)
    throw new Error(
      "This date does not have a unique midnight in the hospital timezone.",
    );
  return {
    id,
    name: "Treatment disruption",
    start_at: `${start[0]}:00.000Z`,
    end_at: `${end[0]}:00.000Z`,
  };
}
export function disruptionWithinHorizon(
  disruption: HospitalDisruption,
  start: string,
  end: string,
) {
  const a = Date.parse(disruption.start_at),
    b = Date.parse(disruption.end_at);
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a >= Date.parse(start) &&
    b <= Date.parse(end) &&
    b > a
  );
}
export function firstDisruptionDate(
  start: string,
  end: string,
  timeZone: string,
  existing: HospitalDisruption[],
) {
  const first = utcToWall(start, timeZone).slice(0, 10);
  for (let day = 0; day <= 365; day++) {
    const date = shiftDate(first, day);
    const disruption = disruptionForDate(date, timeZone, "candidate");
    if (Date.parse(disruption.start_at) >= Date.parse(end)) break;
    if (
      disruptionWithinHorizon(disruption, start, end) &&
      !existing.some((item) => item.start_at === disruption.start_at)
    )
      return date;
  }
  return null;
}
export function withOperation<K extends keyof HospitalOperations>(
  current: HospitalOperations | null | undefined,
  key: K,
  value: HospitalOperations[K] | undefined,
): HospitalOperations | null {
  const next = { ...current };
  if (
    value === undefined ||
    (key === "disruptions" && Array.isArray(value) && !value.length)
  )
    delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : null;
}
export function operationsError(
  value: HospitalOperations | null | undefined,
  start: string,
  end: string,
) {
  if (!value) return "";
  if (value.severity_mix) {
    const mix = value.severity_mix;
    if (
      severityOrder.some(
        (key) =>
          !mix[key] ||
          !Number.isFinite(mix[key].percentage) ||
          mix[key].percentage < 0 ||
          mix[key].percentage > 100 ||
          !Number.isFinite(mix[key].average_stay_hours) ||
          mix[key].average_stay_hours <= 0,
      )
    )
      return "Each patient severity needs a share from 0–100% and a positive average stay.";
    if (
      Math.abs(
        severityOrder.reduce((sum, key) => sum + mix[key].percentage, 0) - 100,
      ) > 1e-6
    )
      return "Patient severity shares must total 100%.";
    if (
      mix.low.average_stay_hours > mix.medium.average_stay_hours ||
      mix.medium.average_stay_hours > mix.high.average_stay_hours
    )
      return "Average stays should increase from low to medium to high severity.";
  }
  if (value.supplies) {
    const s = value.supplies;
    if (
      ![s.initial_percent, s.refill_percent].every(
        (p) => Number.isFinite(p) && p >= 0 && p <= 100,
      ) ||
      !Number.isFinite(s.capacity) ||
      s.capacity <= 0 ||
      !Number.isFinite(s.usage_per_patient_day) ||
      s.usage_per_patient_day < 0 ||
      !Number.isInteger(s.refill_every_days) ||
      s.refill_every_days < 1 ||
      s.refill_every_days > 365
    )
      return "Check supply percentages, positive capacity, usage, and a refill interval from 1–365 days.";
  }
  const seen = new Set<string>();
  for (const disruption of value.disruptions || []) {
    if (!disruption.id || seen.has(disruption.id))
      return "Each disruption needs a unique identifier.";
    seen.add(disruption.id);
    if (!disruptionWithinHorizon(disruption, start, end))
      return "A disruption falls outside this simulation. Change its date or remove it before running.";
  }
  return "";
}
export function hospitalOperationsPatch(
  value: HospitalOperations | null | undefined,
  start: string,
  end: string,
) {
  const error = operationsError(value, start, end);
  if (error) throw new Error(error);
  // Undefined is deliberately omitted so editing another field never enables legacy settings.
  return value === undefined
    ? {}
    : { hospital_operations: value === null ? null : structuredClone(value) };
}
