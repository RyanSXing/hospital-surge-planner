import type { Dataset, Entity } from "../types";
import type { PlanDraft } from "./scenarioPlans";

export const staffRoles = [
  { key: "rn", label: "Registered nurses" },
  { key: "provider", label: "Doctors & providers" },
  { key: "support", label: "Support staff" },
] as const;
export type StaffRole = (typeof staffRoles)[number]["key"];
export interface UnitTarget {
  physical_capacity?: number;
  enabled_capacity?: number;
  staffed_capacity?: number;
  rn?: number;
  provider?: number;
  support?: number;
}
export interface ConfigurationTargets {
  units: Record<string, UnitTarget>;
}
const owner = "main_configuration";
export function configurationTargets(draft: PlanDraft): ConfigurationTargets {
  const result: ConfigurationTargets = { units: {} };
  for (const record of draft.conditions) {
    if (record.kind === "unit_configuration") {
      result.units[record.unit_id] = {
        ...result.units[record.unit_id],
        ...Object.fromEntries(
          ["physical_capacity", "enabled_capacity", "staffed_capacity"]
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, record[key]]),
        ),
        ...record.staff_counts,
      };
    }
  }
  return result;
}
export function mainHospitalUnits(dataset: Dataset) {
  const hospital =
    dataset.facilities.find((f) => f.facility_id === "FAC-MAIN") ||
    dataset.facilities.find((f) => f.kind === "hospital");
  return dataset.units.filter(
    (u) =>
      u.facility_id === hospital?.facility_id &&
      ["ward", "icu", "ed"].includes(u.kind) &&
      u.capacity_mode === "staff_derived" &&
      Number(u.physical_capacity) > 0,
  );
}
export function scheduledStaff(
  dataset: Dataset,
  unit: Entity,
  at: string,
): Record<StaffRole, number> {
  const assignments: Entity[] =
    dataset.staff_assignments || dataset.assignments || [];
  const roster = new Map(dataset.staff.map((s) => [s.staff_id, s]));
  const policy =
    dataset.capacity_policies?.find(
      (p: Entity) => p.capacity_policy_id === unit.capacity_policy_id,
    ) || {};
  const capabilities = {
    rn: policy.nurse_capability || `${unit.kind.toUpperCase()}_NURSING`,
    provider: `${unit.kind.toUpperCase()}_PROVIDER`,
    support: "GENERAL_SUPPORT",
  };
  const active = assignments.filter(
    (a) =>
      a.unit_id === unit.unit_id &&
      a.status !== "unavailable" &&
      Date.parse(a.start_at) <= Date.parse(at) &&
      Date.parse(a.end_at) > Date.parse(at),
  );
  return Object.fromEntries(
    staffRoles.map(({ key }) => [
      key,
      assignments.length
        ? active
            .filter((a) =>
              roster.get(a.staff_id)?.capabilities?.includes(capabilities[key]),
            )
            .reduce((sum, a) => sum + Number(a.allocation_fraction ?? 1), 0)
        : Number(unit.baseline_staff?.[key] || 0),
    ]),
  ) as Record<StaffRole, number>;
}
export function minimumPhysicalBeds(dataset: Dataset, unit: Entity) {
  const slots = dataset.slots.filter((s) => s.unit_id === unit.unit_id);
  const identities = new Set(slots.map((s) => s.slot_id));
  const protectedIds = new Set(
    slots.slice(0, Number(unit.background_occupied || 0)).map((s) => s.slot_id),
  );
  for (const patient of dataset.patients) {
    if (patient.state === "discharged") continue;
    for (const id of [
      patient.slot_id,
      patient.pending_transfer?.destination_slot_id,
    ])
      if (identities.has(id)) protectedIds.add(id);
  }
  return protectedIds.size;
}
export function nurseRatio(dataset: Dataset, unit: Entity) {
  return Number(
    dataset.capacity_policies?.find(
      (p: Entity) => p.capacity_policy_id === unit.capacity_policy_id,
    )?.slots_per_nurse ?? (unit.kind === "icu" ? 2 : 4),
  );
}
export function staffedBedReadback(
  dataset: Dataset,
  unit: Entity,
  target: UnitTarget,
  baseline: Record<StaffRole, number>,
) {
  const policy =
    dataset.capacity_policies?.find(
      (p: Entity) => p.capacity_policy_id === unit.capacity_policy_id,
    ) || {};
  const enabled = target.enabled_capacity ?? Number(unit.enabled_capacity);
  let supported = Math.min(
    enabled,
    target.staffed_capacity ?? Infinity,
    Math.floor((target.rn ?? baseline.rn) * nurseRatio(dataset, unit)),
  );
  const gate =
    (target.provider ?? baseline.provider) >=
      Number(policy.minimum_provider_count ?? (unit.kind === "ed" ? 2 : 1)) &&
    (target.support ?? baseline.support) >=
      Number(policy.minimum_support_count ?? 1);
  const perSlot = new Map<string, number>();
  for (const requirement of policy.per_slot_resources || [])
    perSlot.set(
      requirement.capability_code,
      (perSlot.get(requirement.capability_code) || 0) +
        Number(requirement.quantity),
    );
  for (const [capability, quantity] of perSlot) {
    const available = dataset.equipment_pools
      .filter(
        (p) => p.unit_id === unit.unit_id && p.capability_code === capability,
      )
      .reduce(
        (sum, p) =>
          sum +
          Math.max(
            0,
            Number(p.quantity) - Number(p.unserviceable_quantity || 0),
          ),
        0,
      );
    supported = Math.min(supported, Math.floor(available / quantity));
  }
  return { supported, usable: gate ? supported : 0, gate };
}
export function applyConfigurationInputs(
  dataset: Dataset,
  draft: PlanDraft,
  targets: ConfigurationTargets,
): PlanDraft {
  const next = {
    conditions: [...draft.conditions],
    interventions: [...draft.interventions],
    updates: [...draft.updates],
  };
  for (const unit of mainHospitalUnits(dataset)) {
    const target = targets.units[unit.unit_id];
    if (!target) continue;
    const physical = target.physical_capacity ?? Number(unit.physical_capacity);
    const enabled =
      target.enabled_capacity ??
      Math.min(physical, Number(unit.enabled_capacity));
    if (
      !Number.isInteger(physical) ||
      physical < minimumPhysicalBeds(dataset, unit) ||
      physical > 1000 ||
      !Number.isInteger(enabled) ||
      enabled < 0 ||
      enabled > physical
    )
      throw new Error(
        `${unit.name}: beds must fit the occupied inventory and hospital limits.`,
      );
    if (
      target.staffed_capacity !== undefined &&
      (!Number.isInteger(target.staffed_capacity) ||
        target.staffed_capacity < 0 ||
        target.staffed_capacity > enabled)
    )
      throw new Error(
        `${unit.name}: staffed beds cannot exceed available beds.`,
      );
    const staff = Object.fromEntries(
      staffRoles
        .filter(({ key }) => target[key] !== undefined)
        .map(({ key }) => [key, target[key]]),
    );
    if (
      Object.values(staff).some(
        (count) => !Number.isInteger(count) || count! < 0 || count! > 500,
      )
    )
      throw new Error(`${unit.name}: enter 0–500 people for each staff type.`);
    const existing = draft.conditions.find(
      (c) => c.kind === "unit_configuration" && c.unit_id === unit.unit_id,
    );
    if (
      existing &&
      Object.entries(target).every(([key, value]) =>
        ["rn", "provider", "support"].includes(key)
          ? existing.staff_counts?.[key] === value
          : existing[key] === value,
      )
    )
      continue;
    const record = {
      ...existing,
      id: existing?.id || `configuration-unit-${unit.unit_id}`,
      kind: "unit_configuration",
      unit_id: unit.unit_id,
      ...(target.physical_capacity !== undefined
        ? { physical_capacity: physical }
        : {}),
      ...(target.enabled_capacity !== undefined
        ? { enabled_capacity: enabled }
        : {}),
      ...(target.staffed_capacity !== undefined
        ? { staffed_capacity: target.staffed_capacity }
        : {}),
      ...(Object.keys(staff).length ? { staff_counts: staff } : {}),
      source: existing?.source || "user_assumption",
      configuration_control: { owner },
    };
    const index = next.conditions.findIndex((c) => c === existing);
    if (index >= 0) next.conditions[index] = record;
    else next.conditions.push(record);
  }
  return next;
}
