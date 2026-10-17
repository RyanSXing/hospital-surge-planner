import type { Entity, PlanningContext, UpdateTarget } from "../types";
import type { UpdateCreate } from "../api-contracts";
import { actualInventory } from "./workspaceSearch";

/** Resolve the inspector selection against its frozen snapshot and exact ledger. */
export function updateDefaults(
  ctx: PlanningContext,
  target?: UpdateTarget | null,
) {
  const selected =
    target ||
    (ctx.selectedResource?.kind !== "update"
      ? (ctx.selectedResource as UpdateTarget | null)
      : null) ||
    (ctx.selectedPatient
      ? {
          kind: "patient" as const,
          id: String(ctx.selectedPatient.patient_id || ctx.selectedPatient.id),
        }
      : null) ||
    (ctx.selectedUnit ? { kind: "unit" as const, id: ctx.selectedUnit } : null);
  const state = !ctx.stateLoading && !ctx.stateError ? ctx.state : null;
  const units = actualInventory("unit", ctx.dataset?.units, state?.units);
  const pools = actualInventory(
    "equipment_pool",
    ctx.dataset?.equipment_pools,
    state?.equipment_pools,
  );
  const find = (rows: Entity[] | undefined, field: string, id?: string) =>
    rows?.find((row) => String(row[field] || row.id) === id);
  let unit = find(
    units,
    "unit_id",
    selected?.kind === "unit"
      ? selected.id
      : selected
        ? undefined
        : ctx.selectedUnit,
  );
  let type: UpdateCreate["type"] = "arrival_batch";
  let observedReset = selected?.kind === "vehicle";
  let count = 20;
  let equipment = pools[0]?.equipment_pool_id || "";
  let route = ctx.dataset?.routes?.[0]?.route_id || "";
  let facility =
    ctx.selectedFacility || ctx.dataset?.facilities?.[0]?.facility_id || "";
  let person = String(
    ctx.selectedPatient?.patient_id || ctx.selectedPatient?.id || "",
  );
  const staffIds: string[] = [];
  if (selected?.kind === "slot") {
    const slot = find(
      actualInventory("slot", ctx.dataset?.slots, state?.slots),
      "slot_id",
      selected.id,
    );
    unit = find(units, "unit_id", slot?.unit_id);
  }
  if (selected?.kind === "staff") {
    type = "staff_unavailable";
    count = 1;
    staffIds.push(selected.id);
    const staff = find(ctx.dataset?.staff, "staff_id", selected.id);
    unit =
      units.find((row) => row.active_staff_ids?.includes(selected.id)) ||
      find(units, "unit_id", staff?.home_unit_id);
  } else if (selected?.kind === "equipment_pool") {
    type = "equipment_change";
    count = 1;
    equipment = selected.id;
    const pool = find(pools, "equipment_pool_id", selected.id);
    facility = pool?.facility_id || facility;
    // A generated split pool is not an editable source-snapshot record.
    observedReset = !find(
      ctx.dataset?.equipment_pools,
      "equipment_pool_id",
      selected.id,
    );
  } else if (selected?.kind === "route") {
    type = "route_change";
    route = selected.id;
    count = Number(
      find(ctx.dataset?.routes, "route_id", selected.id)?.travel_minutes ?? 0,
    );
  } else if (selected?.kind === "patient") {
    type = "patient_departure";
    person = selected.id;
  } else if (selected?.kind === "facility") {
    facility = selected.id;
    unit =
      units.find(
        (row) =>
          row.facility_id === facility &&
          row.capacity_mode === "advertised_aggregate",
      ) || units.find((row) => row.facility_id === facility);
  }
  if (selected && ["unit", "slot", "facility"].includes(selected.kind)) {
    type =
      unit?.capacity_mode === "advertised_aggregate"
        ? "advertised_capacity_change"
        : "capacity_change";
    count = Number(
      type === "advertised_capacity_change"
        ? (unit?.advertised_staffed_capacity ??
            unit?.staffed_capacity ??
            unit?.staffed ??
            0)
        : (unit?.enabled_capacity ??
            unit?.physical_capacity ??
            unit?.physical ??
            0),
    );
  }
  const site = find(
    ctx.dataset?.facilities,
    "facility_id",
    selected?.kind === "facility" ? selected.id : undefined,
  );
  if (site && ["clinic", "shelter", "overflow"].includes(site.kind)) {
    type = "site_ready";
    count = Number(unit?.physical_capacity ?? unit?.physical ?? 0);
  }
  facility = unit?.facility_id || facility;
  unit ||= units.find((row) => row.facility_id === facility) || units[0];
  return {
    target: selected,
    type,
    observedReset,
    count,
    equipment,
    route,
    facility,
    unit: unit?.unit_id || "",
    person,
    staffIds,
    effectiveAt:
      ctx.selectedTime ||
      ctx.resultScenario?.start_at ||
      ctx.scenario?.start_at ||
      ctx.dataset?.snapshot_at ||
      "",
  };
}
