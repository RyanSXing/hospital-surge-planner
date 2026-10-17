import type { Entity, PlanningContext } from "./types";
import { unitId } from "./api";
export const isActive = (p: Entity) =>
  !["discharged", "departed", "transfer_out"].includes(p.state || p.status);
export const stateUnavailable = (ctx: PlanningContext) =>
  Boolean(
    ctx.stateLoading ||
    ctx.stateError ||
    (ctx.run?.status === "SUCCEEDED" && !ctx.state),
  );
export function unitsOf(ctx: PlanningContext): Entity[] {
  if (stateUnavailable(ctx)) return [];
  const source = ctx.state?.units;
  if (ctx.state) {
    const rows = Array.isArray(source)
      ? source
      : source
        ? Object.entries(source).map(([k, v]) => ({
            unit_id: k,
            ...(v as object),
          }))
        : [];
    return rows.map((u) => ({
      ...ctx.dataset?.units?.find((s) => unitId(s) === unitId(u)),
      ...u,
    }));
  }
  return ctx.dataset?.units || [];
}
export function patientsOf(ctx: PlanningContext): Entity[] {
  if (stateUnavailable(ctx)) return [];
  return (
    ctx.state ? ctx.state.patients || [] : ctx.dataset?.patients || []
  ).filter(isActive);
}
export function statsFor(
  ctx: PlanningContext,
  kind = "ward",
  facility = ctx.selectedFacility,
) {
  const units = unitsOf(ctx).filter(
      (u) =>
        u.facility_id === facility &&
        (u.kind || u.unit_type || u.type || "").toLowerCase() === kind,
    ),
    patients = patientsOf(ctx);
  let physical = 0,
    staffed = 0,
    occupied = 0,
    cleaning = 0,
    reserved = 0,
    enabled = 0,
    ready = 0,
    available = 0;
  for (const u of units) {
    const id = unitId(u),
      slots = (
        ctx.state ? ctx.state.slots || [] : ctx.dataset?.slots || []
      ).filter(
        (s: Entity) =>
          s.unit_id === id &&
          s.installation_status !== "planned" &&
          s.installation_status !== "removed",
      );
    const nPhysical = Number(
      u.physical ?? u.physical_capacity ?? u.installed_capacity ?? slots.length,
    );
    const nStaffed = Number(
      u.staffed ??
        u.staffed_capacity ??
        u.staff_supported_places ??
        u.staffed_slots ??
        u.initial_staffed_capacity ??
        0,
    );
    const nOccupied = Number(
      u.occupied ??
        u.occupancy ??
        patients.filter((p) => p.unit_id === id && p.slot_id).length +
          Number(u.background_occupied || 0),
    );
    const nCleaning = Number(
        u.cleaning ??
          slots.filter((s: Entity) => s.status === "cleaning").length,
      ),
      nReserved = Number(
        u.reserved ??
          slots.filter((s: Entity) => s.status === "reserved").length,
      );
    const nEnabled = Number(
      u.enabled ??
        u.enabled_capacity ??
        slots.filter((s: Entity) => s.enabled !== false).length,
    );
    const nReady = Number(
      u.ready ?? Math.max(0, nEnabled - nOccupied - nReserved - nCleaning),
    );
    const active =
      u.active ??
      ctx.dataset?.facilities?.find((f) => (f.facility_id || f.id) === facility)
        ?.status === "active";
    const nAvailable = Number(
      u.available ??
        (active && u.admission_gate !== false
          ? Math.max(0, Math.min(nReady, nStaffed - nOccupied - nReserved))
          : 0),
    );
    physical += nPhysical;
    staffed += nStaffed;
    occupied += nOccupied;
    cleaning += nCleaning;
    reserved += nReserved;
    enabled += nEnabled;
    ready += nReady;
    available += nAvailable;
  }
  return {
    physical,
    staffed,
    occupied,
    cleaning,
    reserved,
    enabled,
    ready,
    available,
    units,
    unavailable: stateUnavailable(ctx),
  };
}
export function queueStats(
  ctx: PlanningContext,
  facility = ctx.selectedFacility,
) {
  if (stateUnavailable(ctx))
    return { total: 0, ward: 0, icu: 0, ed: 0, unavailable: true };
  const all = facility === "all";
  // A bounded state includes only a patient window; aggregate queue counts remain authoritative.
  if (ctx.state?.queue_counts) {
    const counts = ctx.state.queue_counts as Record<
      string,
      Record<string, number>
    >;
    const selected = all ? Object.values(counts) : [counts[facility] || {}];
    const sum = (key: string) =>
      selected.reduce((n, row) => n + Number(row[key] || 0), 0);
    return {
      total: sum("total"),
      ward: sum("ward"),
      icu: sum("icu"),
      ed: sum("ed"),
      ed_boarding: sum("ed_boarding"),
      direct_waiting: sum("direct_waiting"),
      stepdown: sum("stepdown"),
      unavailable: false,
    };
  }
  const units = unitsOf(ctx),
    patients = patientsOf(ctx).filter(
      (p) =>
        all ||
        (p.facility_id ||
          units.find((u) => unitId(u) === p.unit_id)?.facility_id) === facility,
    );
  const queue = patients.filter(
    (p) =>
      p.admission_pending === true ||
      (p.admission_pending === undefined &&
        (["ed_boarding", "direct_waiting"].includes(p.state) ||
          (p.admission_requested_at &&
            ["ward", "icu"].includes(p.target_unit_kind) &&
            !["inpatient", "discharged", "in_transit"].includes(p.state)))),
  );
  return {
    total:
      all && ctx.state
        ? Number(ctx.state.inpatient_queue ?? queue.length)
        : queue.length,
    ward: queue.filter((p) => (p.target_unit_kind || p.care_level) === "ward")
      .length,
    icu: queue.filter((p) => (p.target_unit_kind || p.care_level) === "icu")
      .length,
    ed:
      all && ctx.state
        ? Number(
            ctx.state.ed_queue ??
              patients.filter((p) => p.state === "ed_waiting").length,
          )
        : patients.filter((p) => p.state === "ed_waiting").length,
    unavailable: false,
  };
}
export function nameOf(e: Entity) {
  return (
    e.name ||
    e.display_name ||
    e.label ||
    e.id ||
    e.unit_id ||
    e.facility_id ||
    ""
  );
}

export function selectedRunNumber(
  ctx: Pick<PlanningContext, "activeReplicationId" | "metrics">,
): number | undefined {
  const chosen = ctx.activeReplicationId?.match(/_rep_(\d+)$/);
  return chosen
    ? Number(chosen[1]) + 1
    : ctx.metrics?.selected_replication_index === undefined
      ? undefined
      : Number(ctx.metrics.selected_replication_index) + 1;
}
