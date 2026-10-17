import type { Entity } from "../types";
export function replayZone(p: Entity) {
  const prior = p.pending_transfer?.prior_state || p.prior_state;
  return p.state === "ed_waiting"
    ? "arrivals"
    : p.state === "ed_assessment" ||
        p.state === "ed_boarding" ||
        (p.state === "transfer_reserved" && prior === "ed_boarding")
      ? "ed"
      : p.state === "direct_waiting" ||
          p.state === "in_transit" ||
          (p.state === "transfer_reserved" && prior === "direct_waiting")
        ? "queue"
        : p.state === "clinic_assessment"
          ? "clinic"
          : p.state === "inpatient" || p.state === "transfer_reserved"
            ? p.care_level === "icu"
              ? "icu"
              : "ward"
            : "exit";
}
export function replayCounts(
  patientGroups: Entity[] | undefined,
  patients: Entity[],
  visible: Entity[],
) {
  const totals: Record<string, number> = {};
  for (const p of patientGroups || patients) {
    const zone = replayZone(p);
    totals[zone] = (totals[zone] || 0) + (patientGroups ? Number(p.count) : 1);
  }
  const grouped = { ...totals };
  for (const p of visible) {
    const zone = replayZone(p);
    grouped[zone] = Math.max(0, (grouped[zone] || 0) - 1);
  }
  return { totals, grouped };
}
