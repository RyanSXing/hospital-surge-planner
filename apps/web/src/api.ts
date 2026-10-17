import type { Entity } from "./types";
import {
  clearWriteIdentities,
  confirmWrite,
  writeIdentity,
} from "./writeIdentity";
export class ApiError extends Error {
  code: string;
  details: Entity[];
  status: number;
  constructor(
    message: string,
    code: string,
    details: Entity[],
    status: number,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}
export async function api<T = Entity>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const method = (options.method || "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  const identity =
    mutating && !path.startsWith("/auth/") && !headers.has("Idempotency-Key")
      ? await writeIdentity(path, options, headers)
      : null;
  if (identity) headers.set("Idempotency-Key", identity.key);
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...options,
    headers,
  });
  if (!response.ok) {
    if (
      identity &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    )
      confirmWrite(identity.fingerprint, identity.key);
    let data: Entity = {};
    try {
      data = await response.json();
    } catch {}
    const e = data.error || data.detail || data;
    throw new ApiError(
      typeof e === "string"
        ? e
        : e.message || `Request failed (${response.status})`,
      e.code || "REQUEST_FAILED",
      e.fields || e.details || [],
      response.status,
    );
  }
  const result =
    response.status === 204 ? ({} as T) : ((await response.json()) as T);
  if (identity) confirmWrite(identity.fingerprint, identity.key);
  if (path.startsWith("/auth/") && mutating) clearWriteIdentities();
  return result;
}
export const post = <T = Entity>(
  path: string,
  data: Entity = {},
  revision?: number,
) =>
  api<T>(path, {
    method: "POST",
    body: JSON.stringify(data),
    headers: revision !== undefined ? { "If-Match": String(revision) } : {},
  });
export const patch = <T = Entity>(
  path: string,
  data: Entity,
  revision?: number,
) =>
  api<T>(path, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: revision !== undefined ? { "If-Match": String(revision) } : {},
  });
export const items = (value: any): Entity[] =>
  Array.isArray(value) ? value : value?.items || value?.data || [];
export const idOf = (x: Entity | null | undefined) =>
  String(
    x?.id || x?.run_group_id || x?.dataset_version_id || x?.scenario_id || "",
  );
export function num(value: any, stat = "p50"): number {
  return typeof value === "number"
    ? value
    : Number(value?.[stat] ?? value?.value ?? 0);
}
export const fmt = (n: any, d = 0) =>
  Number.isFinite(Number(n))
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(
        Number(n),
      )
    : "—";
let presentationTimezone = "America/Chicago";
export function setPresentationTimezone(timezone: string) {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  presentationTimezone = timezone;
}
export function localDate(
  t: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  return t && Number.isFinite(Date.parse(t))
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: presentationTimezone,
        ...options,
      }).format(new Date(t))
    : "—";
}
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(t: number, timezone: string) {
  let formatter = zonedFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zonedFormatters.set(timezone, formatter);
  }
  const p = Object.fromEntries(
    formatter
      .formatToParts(t)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  };
}
function wallEpoch(t: number, timezone: string) {
  const p = wallParts(t, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
// Calendar arithmetic preserves local wall time across 23- and 25-hour days.
// A repeated local hour selects its earlier occurrence; a missing hour moves forward by the DST gap.
export function atDay(
  start: string,
  day: number,
  hour = 0,
  timezone = "America/Chicago",
) {
  const instant = Date.parse(start);
  if (!Number.isFinite(instant))
    throw new RangeError("Invalid calendar start time");
  const p = wallParts(instant, timezone),
    target = Date.UTC(
      p.year,
      p.month - 1,
      p.day + day,
      p.hour + hour,
      p.minute,
      p.second,
      new Date(instant).getUTCMilliseconds(),
    );
  const offsets = new Set(
    [-36, -12, 0, 12, 36].map((h) => {
      const t = target + h * 3600000;
      return wallEpoch(t, timezone) - Math.floor(t / 1000) * 1000;
    }),
  );
  const candidates = Array.from(offsets, (offset) => target - offset).sort(
    (a, b) => a - b,
  );
  const exact = candidates.find(
    (t) => wallEpoch(t, timezone) === Math.floor(target / 1000) * 1000,
  );
  const forward = candidates
    .filter((t) => wallEpoch(t, timezone) > target)
    .sort(
      (a, b) =>
        wallEpoch(a, timezone) - target - (wallEpoch(b, timezone) - target),
    )[0];
  return new Date(exact ?? forward ?? candidates[0]).toISOString();
}
export function localDayIndex(
  start: string,
  instant: string,
  timezone = "America/Chicago",
) {
  const ordinal = (t: string) => {
    const p = wallParts(Date.parse(t), timezone);
    return Date.UTC(p.year, p.month - 1, p.day) / 86400000;
  };
  return ordinal(instant) - ordinal(start);
}
export function unitId(u: Entity) {
  return String(u.unit_id || u.id || "");
}
export function patientId(p: Entity) {
  return String(p.patient_id || p.id || "");
}
