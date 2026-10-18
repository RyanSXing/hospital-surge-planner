import type { Entity } from "../types";

/** Keeps an omitted result distinct from a real zero. */
export function finiteStatistic(
  value: unknown,
  stat: "p10" | "p50" | "p90" | "min" | "max" = "p50",
): number | null {
  const result =
    typeof value === "number"
      ? value
      : value && typeof value === "object"
        ? (value as Entity)[stat]
        : null;
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}

/** Absent paired evidence is unavailable, including a missing probability. */
export function comparisonImprovementNumbers(value: Entity | null | undefined) {
  const empty = { median: null, p10: null, p90: null, probability: null };
  if (!value || value.evidence_available === false) return empty;
  const absolute = value.absolute_change || value;
  const probability = finiteStatistic(
    value.probability_of_improvement ?? value.probability_improvement,
  );
  return {
    median: finiteStatistic(absolute),
    p10: finiteStatistic(absolute, "p10"),
    p90: finiteStatistic(absolute, "p90"),
    probability:
      probability !== null && probability >= 0 && probability <= 1
        ? probability
        : null,
  };
}

/** Picks the truthful banner plan when ranking and paired improvement differ. */
export function comparisonResultPlan<
  T extends { kind?: unknown; reference?: boolean },
>(
  plans: T[],
  noPlanImproves: boolean | undefined,
  rankedPlan: T | null,
): T | null {
  if (!noPlanImproves) return rankedPlan;
  return plans.find((plan) => plan.reference === true) || plans[0] || null;
}

const responseNames: Record<string, string> = {
  staff_existing: "Staff more ward beds",
  staff_existing_beds: "Staff more ward beds",
  physical_overflow: "Open extra hospital beds",
  staffed_overflow: "Open and staff extra beds",
  activate_overflow: "Open and staff extra beds",
  clinic: "Outpatient care",
  activate_clinic: "Outpatient care",
  partner_transfer: "Hospital transfers",
};

/** User-facing response names are deliberately independent of model codes. */
export function responseName(response: Entity): string {
  return (
    responseNames[response.name] ||
    response.name ||
    responseNames[response.kind || response.template_kind] ||
    "Hospital response"
  );
}

/** Always sends an explicit hospital ward; engine defaults may point off campus. */
export function hospitalResponse(
  dataset: Entity | null,
  kind: string,
  startAt?: string,
): Entity | null {
  if (
    !["staff_existing", "physical_overflow", "staffed_overflow"].includes(kind)
  )
    return null;
  const main =
    (dataset?.facilities || []).find(
      (facility: Entity) => facility.facility_id === "FAC-MAIN",
    ) ||
    (dataset?.facilities || []).find(
      (facility: Entity) =>
        facility.kind === "hospital" || facility.facility_type === "hospital",
    );
  if (!main) return null;
  const mainId = main.facility_id || main.id;
  const wards = (dataset?.units || []).filter(
    (unit: Entity) =>
      unit.facility_id === mainId &&
      unit.kind === "ward" &&
      unit.capacity_mode !== "advertised_aggregate",
  );
  const slotsFor = (unit: Entity): Entity[] =>
    (dataset?.slots || []).filter(
      (slot: Entity) =>
        slot.unit_id === unit.unit_id &&
        ["installed", "planned"].includes(slot.installation_status),
    );
  const planned = (unit: Entity) =>
    slotsFor(unit).filter((slot) => slot.installation_status === "planned")
      .length;
  const idle = (unit: Entity) =>
    slotsFor(unit).filter((slot) => slot.installation_status === "installed")
      .length - Number(unit.staffed_capacity || 0);
  const target = [...wards].sort((a, b) =>
    kind === "staff_existing" ? idle(b) - idle(a) : planned(b) - planned(a),
  )[0];
  if (
    !target ||
    (kind === "staff_existing" ? idle(target) <= 0 : planned(target) === 0)
  )
    return null;
  const unitId = target.unit_id || target.id;
  const policy = dataset?.capacity_policies?.find(
    (item: Entity) => item.capacity_policy_id === target.capacity_policy_id,
  );
  const addedPlaces =
    kind === "staff_existing"
      ? Math.max(0, idle(target))
      : Math.max(
          0,
          slotsFor(target).length - Number(target.staffed_capacity || 0),
        );
  const nurses = Math.min(
    5,
    Math.max(1, Math.ceil(addedPlaces / Number(policy?.slots_per_nurse || 4))),
  );
  return {
    kind,
    name: responseNames[kind] || "Hospital response",
    facility_id: mainId,
    unit_id: unitId,
    start_at: startAt,
    activation_minutes: kind === "staff_existing" ? 0 : 60,
    ...(kind === "staff_existing"
      ? { nurses }
      : { enabled_slots: slotsFor(target).length }),
    ...(kind === "staffed_overflow"
      ? { nurses, providers: 1, support: 1 }
      : {}),
  };
}
