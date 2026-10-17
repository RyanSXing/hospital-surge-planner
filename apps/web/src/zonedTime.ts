const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, value);
  }
  return value;
}
/** Editor values are UTC minutes, without a suffix, for the existing save contract. */
export function utcMinute(value: string) {
  if (!value) return "";
  const timestamp = Date.parse(
    /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : value + "Z",
  );
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 16)
    : "";
}
export function utcToWall(value: string, timeZone: string) {
  const utc = utcMinute(value);
  if (!utc) return "";
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(utc + "Z"))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** A wall minute can resolve to zero (DST gap), one, or two (DST fold) instants. */
export function wallTimeCandidates(wall: string, timeZone: string): string[] {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(wall)) return [];
  const naive = Date.parse(wall + "Z");
  if (
    !Number.isFinite(naive) ||
    new Date(naive).toISOString().slice(0, 16) !== wall
  )
    return [];
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = naive + hours * 3_600_000;
    const local = utcToWall(new Date(sample).toISOString(), timeZone);
    offsets.add(Date.parse(local + "Z") - sample);
  }
  return [...offsets]
    .map((offset) => new Date(naive - offset).toISOString().slice(0, 16))
    .filter((candidate) => utcToWall(candidate, timeZone) === wall)
    .sort();
}
export function occurrenceLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
    hourCycle: "h23",
  }).format(new Date(utcMinute(value) + "Z"));
}
