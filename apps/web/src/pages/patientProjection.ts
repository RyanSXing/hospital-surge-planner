import type { Entity } from "../types";

export function replayClinicalInventory(
  units: Entity[],
  facilityTypes: Record<string, string>,
) {
  const values: Record<
    string,
    {
      occupied: number;
      staffed: number;
      physical: number;
      assigned: number;
      background: number;
    }
  > = {};
  for (const unit of units) {
    const zone =
      unit.kind === "ed" || unit.kind === "clinic" || unit.kind === "icu"
        ? unit.kind
        : unit.kind === "ward"
          ? facilityTypes[unit.facility_id] === "ward_overflow"
            ? "overflow"
            : "ward"
          : null;
    if (!zone) continue;
    const value = (values[zone] ||= {
      occupied: 0,
      staffed: 0,
      physical: 0,
      assigned: 0,
      background: 0,
    });
    value.occupied += Number(unit.occupied || 0);
    value.staffed += Number(unit.staffed || 0);
    value.physical += Number(unit.physical || 0);
    value.background += Number(unit.background_occupied || 0);
    value.assigned += Object.values(unit.staff_by_role || {}).reduce<number>(
      (total, count) => total + Number(count),
      0,
    );
  }
  return values;
}

export function plannedReplayInterval(
  plan: Entity,
  index: number,
  start: string,
  end: string,
) {
  const kind =
    (
      {
        activate_clinic: "clinic",
        activate_overflow: "staffed_overflow",
        staff_existing_beds: "staff_existing",
      } as Record<string, string>
    )[plan.kind || plan.template_kind] ||
    plan.kind ||
    plan.template_kind;
  const startMs = Date.parse(start);
  const proposed = Date.parse(plan.start_at || start);
  const delay =
    Number(
      plan.activation_minutes ??
        (
          {
            clinic: 360,
            staffed_overflow: 720,
            physical_overflow: 720,
          } as Record<string, number>
        )[kind] ??
        0,
    ) * 60000;
  return {
    ...plan,
    id: `planned-${plan.intervention_id || plan.id || `PLAN-${index}`}`,
    start_at: new Date(Math.max(startMs, proposed + delay)).toISOString(),
    end_at:
      plan.end_at ||
      new Date(
        Math.min(
          Date.parse(end),
          proposed +
            Number(
              plan.duration_minutes ?? (Date.parse(end) - startMs) / 60000,
            ) *
              60000,
        ),
      ).toISOString(),
    label: `${String(kind || "Intervention").replaceAll("_", " ")} · planned availability`,
    planned: true,
  };
}
export function replayPresence(patient: Entity, at: string) {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) return "unknown";
  if (Date.parse(patient.arrival_at) > instant) return "not_arrived";
  if (patient.departure_at && Date.parse(patient.departure_at) <= instant)
    return "departed";
  if (!patient.state) return "unknown";
  return ["discharged", "departed", "transfer_out"].includes(patient.state)
    ? "departed"
    : "active";
}
export function replayZone(p: Entity, unitKinds: Record<string, string> = {}) {
  const prior = p.pending_transfer?.prior_state || p.prior_state;
  if (p.state === "in_transit") return "transport";
  if (["discharged", "departed", "transfer_out"].includes(p.state))
    return "exit";
  const sourceState = p.state === "transfer_reserved" ? prior : p.state;
  if (sourceState === "ed_waiting") return "arrivals";
  if (sourceState === "direct_waiting") return "queue";
  if (sourceState === "ed_assessment" || sourceState === "ed_boarding")
    return "ed";
  if (sourceState === "clinic_assessment") return "clinic";
  if (p.state === "inpatient" || p.state === "transfer_reserved") {
    // A stepdown request changes required care before releasing its source
    // bed. Join the recorded unit, never a reserved destination or target care.
    // Legacy records without a known unit retain their care-level fallback.
    const kind = unitKinds[p.unit_id] ?? p.care_level;
    if (kind === "icu" || kind === "ed" || kind === "clinic") return kind;
    if (kind === "ward")
      return p.facility_type === "ward_overflow" ? "overflow" : "ward";
  }
  return "queue";
}
export function replayCounts(
  patientGroups: Entity[] | undefined,
  patients: Entity[],
  visible: Entity[],
  unitKinds: Record<string, string> = {},
) {
  const totals: Record<string, number> = {};
  for (const p of patientGroups || patients) {
    const zone = replayZone(p, unitKinds);
    totals[zone] = (totals[zone] || 0) + (patientGroups ? Number(p.count) : 1);
  }
  const grouped = { ...totals };
  for (const p of visible) {
    const zone = replayZone(p, unitKinds);
    grouped[zone] = Math.max(0, (grouped[zone] || 0) - 1);
  }
  return { totals, grouped };
}
