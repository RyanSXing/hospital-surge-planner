import type { Entity } from "../types";
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
export function replayZone(p: Entity) {
  const prior = p.pending_transfer?.prior_state || p.prior_state;
  if (p.state === "in_transit") return "transport";
  if (["discharged", "departed", "transfer_out"].includes(p.state))
    return "exit";
  if (
    ["inpatient", "transfer_reserved"].includes(p.state) &&
    p.facility_type === "ward_overflow"
  )
    return "overflow";
  return p.state === "ed_waiting"
    ? "arrivals"
    : p.state === "ed_assessment" ||
        p.state === "ed_boarding" ||
        (p.state === "transfer_reserved" && prior === "ed_boarding")
      ? "ed"
      : p.state === "direct_waiting" ||
          (p.state === "transfer_reserved" && prior === "direct_waiting")
        ? "queue"
        : p.state === "clinic_assessment"
          ? "clinic"
          : p.state === "inpatient" || p.state === "transfer_reserved"
            ? p.care_level === "icu"
              ? "icu"
              : "ward"
            : "queue";
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
