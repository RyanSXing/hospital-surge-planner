import type { Dataset, Entity } from "../types";
export type PlanCollection = "conditions" | "interventions" | "updates";
export type PlanFamily =
  "staff" | "capacity" | "equipment" | "sites" | "incident" | "cohort";
export interface PlanDraft {
  conditions: Entity[];
  interventions: Entity[];
  updates: Entity[];
}
export interface PlanSelection {
  collection: PlanCollection;
  id: string;
  index?: number;
}
export const recordId = (value: Entity) => String(value.id || value.update_id);
export function equipmentBeforeEvent(
  dataset: Dataset,
  updates: Entity[],
  poolId: string,
  at: string,
  selection: PlanSelection | null,
) {
  const source = dataset.equipment_pools.find(
    (p) => p.equipment_pool_id === poolId,
  );
  const state = {
    total: Number(source?.quantity || 0),
    failed: Number(source?.unserviceable_quantity || 0),
  };
  const index =
    selection?.collection === "updates"
      ? (selection.index ??
        updates.findIndex((u) => recordId(u) === selection.id))
      : updates.length;
  updates
    .map((value, i) => ({ value, i }))
    .filter(
      ({ value, i }) =>
        i !== index &&
        value.type === "equipment_change" &&
        (value.status || "active") === "active" &&
        (value.payload?.equipment_pool_id || value.payload?.pool_id) ===
          poolId &&
        (Date.parse(value.effective_at) < Date.parse(at) ||
          (Date.parse(value.effective_at) === Date.parse(at) &&
            i < (index < 0 ? updates.length : index))),
    )
    .sort(
      (a, b) =>
        Date.parse(a.value.effective_at) - Date.parse(b.value.effective_at) ||
        a.i - b.i,
    )
    .forEach(({ value }) => {
      const planned = value.input_kind === "planned_assumption";
      const op =
          value.payload.operation ||
          ((value.payload.quantity_delta ?? 0) >= 0 ? "add" : "decommission"),
        quantity =
          value.payload.quantity ?? Math.abs(value.payload.quantity_delta || 0);
      const limit = equipmentLimit(state, op);
      if (
        !Number.isInteger(quantity) ||
        quantity < 0 ||
        (planned && limit !== undefined && quantity > limit)
      )
        return;
      const applied =
        !planned && limit !== undefined
          ? Math.min(
              quantity,
              op === "decommission"
                ? Math.max(0, state.total - state.failed)
                : limit,
            )
          : quantity;
      if (op === "add") state.total += applied;
      else if (op === "fail") state.failed += applied;
      else if (op === "repair") state.failed -= applied;
      else if (op === "decommission") {
        state.total -= applied;
        if (planned) state.failed -= Math.min(applied, state.failed);
      }
    });
  return state;
}
export function equipmentLimit(
  state: { total: number; failed: number },
  operation: string,
): number | undefined {
  return operation === "fail"
    ? state.total - state.failed
    : operation === "repair"
      ? state.failed
      : operation === "decommission"
        ? state.total
        : undefined;
}
export function inferMixBasis(dataset: Dataset, mix: Record<string, number>) {
  const keys = Object.keys(mix);
  if (keys.every((k) => ["discharge", "ambulatory", "ward", "icu"].includes(k)))
    return "care";
  if (
    keys.every((k) => dataset.cohorts?.some((c: Entity) => c.cohort_id === k))
  )
    return "cohorts";
  if (
    keys.every((k) =>
      dataset.resource_profiles?.some(
        (p: Entity) => p.resource_profile_id === k,
      ),
    )
  )
    return "profiles";
  return "mixed";
}
export function mixForBasis(
  dataset: Dataset,
  stream: string,
  basis: string,
): Record<string, number> {
  const entry = dataset.entry_streams?.find(
      (s: Entity) => s.entry_stream_id === stream,
    ),
    direct = entry?.entry_type === "direct_ward";
  if (basis === "care")
    return direct
      ? { ward: 1 }
      : {
          ...(entry?.disposition_weights || {
            discharge: 0.8,
            ward: 0.16,
            icu: 0.04,
          }),
        };
  return Object.fromEntries(
    (basis === "cohorts"
      ? dataset.cohorts || []
      : dataset.resource_profiles || []
    )
      .filter(
        (v: Entity) =>
          !direct ||
          (basis === "cohorts" ? v.care_level : v.stage_kind) === "ward",
      )
      .map((v: Entity, i: number) => [
        basis === "cohorts" ? v.cohort_id : v.resource_profile_id,
        i ? 0 : 1,
      ]),
  );
}
export function readinessError(start: string, end: string, delay: number) {
  return !Number.isFinite(delay) ||
    delay < 0 ||
    Date.parse(start) + delay * 60000 >= Date.parse(end)
    ? "Readiness must occur before the plan ends. Shorten the setup delay or extend its interval."
    : "";
}
export function familyOf(
  value: Entity,
  collection: PlanCollection,
  dataset?: Pick<Dataset, "units">,
): PlanFamily | null {
  const kind = value.kind || value.template_kind || value.type;
  if (
    [
      "staff_absence",
      "staff_unavailability",
      "staff_unavailable",
      "staff_available",
    ].includes(kind)
  )
    return "staff";
  if (
    [
      "capacity_change",
      "advertised_capacity_change",
      "physical_overflow",
      "staff_existing",
      "staff_existing_beds",
    ].includes(kind)
  )
    return "capacity";
  if (["staffed_overflow", "activate_overflow"].includes(kind)) {
    const unitId = value.unit_id || value.payload?.unit_id;
    const facilityId =
      value.facility_id ||
      value.payload?.facility_id ||
      dataset?.units.find((unit) => unit.unit_id === unitId)?.facility_id;
    return facilityId === "FAC-MAIN" ? "capacity" : "sites";
  }
  if (kind === "equipment_change") return "equipment";
  if (
    [
      "clinic",
      "activate_clinic",
      "partner_transfer",
      "site_ready",
      "route_change",
    ].includes(kind)
  )
    return "sites";
  if (kind === "arrival_batch") return "incident";
  if (collection === "conditions" && kind === "care_mix_override")
    return "cohort";
  return null;
}
export function withPlan(
  draft: PlanDraft,
  selection: PlanSelection | null,
  collection: PlanCollection,
  value: Entity,
): PlanDraft {
  const next = { ...draft };
  if (selection && selection.collection === collection) {
    const index = draft[collection].findIndex((v, i) =>
      selection.id === "undefined"
        ? i === selection.index
        : recordId(v) === selection.id,
    );
    if (index >= 0)
      return {
        ...draft,
        [collection]: draft[collection].map((v, i) =>
          i === index ? value : v,
        ),
      };
  }
  if (selection)
    next[selection.collection] = draft[selection.collection].filter((v, i) =>
      selection.id === "undefined"
        ? i !== selection.index
        : recordId(v) !== selection.id,
    );
  next[collection] = [...next[collection], value];
  return next;
}
export function withoutPlan(
  draft: PlanDraft,
  selection: PlanSelection,
): PlanDraft {
  return {
    ...draft,
    [selection.collection]: draft[selection.collection].filter((v, i) =>
      selection.id === "undefined"
        ? i !== selection.index
        : recordId(v) !== selection.id,
    ),
  };
}
export function planInterval(value: Entity, start: string, end: string) {
  const points =
    value.kind === "arrival_multiplier" && value.control_points?.length >= 2
      ? value.control_points
      : null;
  const a =
    points?.[0].at || value.at || value.effective_at || value.start_at || start;
  const b =
    points?.at(-1).at ||
    value.end_at ||
    value.payload?.until ||
    (value.duration_minutes
      ? new Date(Date.parse(a) + value.duration_minutes * 60000).toISOString()
      : [
            "arrival_batch",
            "capacity_change",
            "equipment_change",
            "advertised_capacity_change",
          ].includes(value.kind || value.type)
        ? a
        : end);
  return { start: a, end: b };
}
export function plannedEvent(
  type: string,
  at: string,
  payload: Entity,
  existing?: Entity,
) {
  return {
    ...existing,
    id: existing?.id || existing?.update_id || crypto.randomUUID(),
    type,
    effective_at: at,
    source: existing?.source || "user_assumption",
    input_kind: "planned_assumption",
    payload,
  };
}
/** Exact IDs make provider/support absence behavior independent of the legacy RN count rule. */
export const shiftKey = (assignment: Entity) =>
  `${assignment.start_at}|${assignment.end_at || ""}`;
export function selectStaff(
  assignments: Entity[],
  roster: Entity[],
  role: string,
  shift: string,
  mode: string,
  amount: number,
) {
  const byId = new Map(roster.map((person) => [person.staff_id, person]));
  const ids = [
    ...new Set(
      assignments
        .filter(
          (a) => shiftKey(a) === shift && byId.get(a.staff_id)?.role === role,
        )
        .map((a) => String(a.staff_id)),
    ),
  ].sort();
  const unavailable =
    mode === "percentage"
      ? Math.ceil((ids.length * amount) / 100)
      : mode === "available"
        ? Math.max(0, ids.length - amount)
        : amount;
  if (
    !Number.isFinite(unavailable) ||
    unavailable < 0 ||
    unavailable > ids.length ||
    !Number.isInteger(unavailable)
  )
    throw new Error(
      "The requested absence must fit the declared shift roster.",
    );
  return ids.slice(0, unavailable);
}
export function capacityFacts(dataset: Dataset, unitId: string) {
  const u = dataset.units.find((v) => v.unit_id === unitId) || {};
  const slots = dataset.slots.filter((v) => v.unit_id === unitId);
  const installed = slots.filter(
    (s) => s.installation_status === "installed",
  ).length;
  const enabled = slots.filter(
    (s) => s.installation_status === "installed" && s.enabled,
  ).length;
  const occupied =
    dataset.patients.filter((p) => p.unit_id === unitId && p.slot_id).length +
    (u.background_occupied || 0);
  const transferReserved = new Set(
    dataset.patients
      .map((p) => p.pending_transfer?.destination_slot_id)
      .filter(Boolean),
  );
  const unavailable = slots.filter(
    (s) =>
      ["cleaning", "reserved"].includes(s.state) ||
      s.reserved_patient_id ||
      transferReserved.has(s.slot_id),
  ).length;
  return {
    installed,
    planned: slots.filter((s) => s.installation_status === "planned").length,
    enabled,
    staffed: u.staffed_capacity || 0,
    ready: Math.max(0, enabled - occupied - unavailable),
    policy:
      (dataset.capacity_policies || []).find(
        (p: Entity) => p.capacity_policy_id === u.capacity_policy_id,
      ) || {},
  };
}

export function movePlan(value: Entity, minutes: number): Entity {
  const shifted = (at: string) =>
    new Date(Date.parse(at) + minutes * 60000).toISOString();
  const next = { ...value };
  for (const field of ["start_at", "end_at", "at", "effective_at"])
    if (next[field]) next[field] = shifted(next[field]);
  if (value.control_points)
    next.control_points = value.control_points.map((p: Entity) => ({
      ...p,
      at: shifted(p.at),
    }));
  if (value.payload?.until)
    next.payload = { ...value.payload, until: shifted(value.payload.until) };
  return next;
}
export function resizePlan(
  value: Entity,
  edge: "start" | "end",
  at: string,
): Entity {
  if (edge === "start")
    return {
      ...value,
      [value.effective_at ? "effective_at" : value.at ? "at" : "start_at"]: at,
    };
  return value.payload?.until
    ? { ...value, payload: { ...value.payload, until: at } }
    : { ...value, end_at: at };
}
