import type { Entity } from "../types";
import { humanLabel } from "../presentation";

export type FloorBedStatus =
  | "occupied"
  | "ready"
  | "reserved"
  | "cleaning"
  | "unstaffed"
  | "blocked"
  | "planned"
  | "unknown";
export interface FloorBed {
  id: string;
  unitId: string;
  label: string;
  status: FloorBedStatus;
  patientId: string | null;
  patient: Entity | null;
  record: Entity;
  description: string;
}
export interface FloorUnit {
  id: string;
  name: string;
  kind: string;
  record: Entity;
  beds: FloorBed[];
  occupied: number | null;
  staffed: number | null;
  physical: number | null;
  available: number | null;
  unsupported: number | null;
  utilization: number | null;
  pressure: number | null;
  pressureText: string;
  reasons: string[];
}
export interface FloorPlan {
  at: string | null;
  replicationId: string | null;
  units: FloorUnit[];
  total: number | null;
  edWaiting: number | null;
  bedWaiting: number | null;
  discharges: number | null;
  mainFacility: string;
}
export const floorStatusLabel: Record<FloorBedStatus, string> = {
  occupied: "Occupied",
  ready: "Ready",
  reserved: "Reserved",
  cleaning: "Cleaning",
  unstaffed: "Unstaffed",
  blocked: "Unavailable",
  planned: "Planned",
  unknown: "Status unavailable",
};
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const rows = (value: unknown): Entity[] => (Array.isArray(value) ? value : []);
const identity = (row: Entity) => row.unit_id || row.id;

/** Slot identities/states come from the exact replay, never inferred from a patient sample. */
export function buildReplayFloorPlan(
  dataset: Entity | null | undefined,
  state: Entity | null | undefined,
): FloorPlan {
  const definitions = rows(dataset?.units),
    recorded = rows(state?.units);
  const main =
    recorded.find((u) => u.kind === "ed")?.facility_id ||
    rows(dataset?.entry_streams).find((s) => s.destination_facility_id)
      ?.destination_facility_id ||
    "FAC-MAIN";
  const live = new Map(recorded.map((unit) => [identity(unit), unit]));
  const units = new Map(definitions.map((unit) => [identity(unit), unit]));
  recorded.forEach((unit) =>
    units.set(identity(unit), { ...units.get(identity(unit)), ...unit }),
  );
  const hasSlots = Array.isArray(state?.slots),
    slots = hasSlots ? rows(state?.slots) : [];
  const patients = rows(state?.patients),
    patientById = new Map(patients.map((p) => [p.patient_id || p.id, p]));
  const availableGroups = Array.isArray(state?.patient_groups)
    ? rows(state?.patient_groups).filter((group) => group.facility_id === main)
    : null;
  const partial =
    Array.isArray(state?.partial_collections) &&
    state.partial_collections.includes("patients");
  const groupedCount = (predicate: (p: Entity) => boolean): number | null => {
    if (availableGroups) {
      const values = availableGroups
        .filter(predicate)
        .map((p) => count(p.count));
      return values.some((v) => v === null)
        ? null
        : values.reduce<number>((a, b) => a + b!, 0);
    }
    return state && Array.isArray(state.patients) && !partial
      ? patients.filter((p) => p.facility_id === main && predicate(p)).length
      : null;
  };
  const queue = state?.queue_counts?.[main];
  const floorUnits: FloorUnit[] = [...units.values()]
    .filter(
      (u) =>
        u.facility_id === main &&
        ["ward", "icu", "ed", "clinic"].includes(u.kind),
    )
    .map((unit) => {
      const id = identity(unit),
        exact = live.get(id),
        occupied = count(exact?.occupied),
        staffed = count(exact?.staffed),
        physical = count(exact?.physical),
        available = count(exact?.available);
      const recordedBlockers = state?.blocker_counts_by_unit;
      const reasons = new Set<string>(
        recordedBlockers
          ? Object.entries(recordedBlockers[id] || {})
              .filter(([, value]) => (count(value) ?? 0) > 0)
              .map(([reason]) => reason)
          : [],
      );
      if (!recordedBlockers)
        patients.forEach((p) => {
          if (p.unit_id === id)
            (Array.isArray(p.care_pause_reasons)
              ? p.care_pause_reasons
              : []
            ).forEach((reason: string) => reasons.add(reason));
          rows(p.blocker_units)
            .filter((detail) => detail.unit_id === id)
            .forEach((detail) =>
              (detail.reasons || []).forEach((reason: string) =>
                reasons.add(reason),
              ),
            );
        });
      const beds: FloorBed[] = slots
        .filter(
          (slot) =>
            slot.unit_id === id &&
            slot.installation_status !== "removed" &&
            (slot.installation_status !== "planned" ||
              slot.status === "occupied" ||
              slot.patient_id ||
              slot.background_occupied === true),
        )
        .map((slot) => {
          const patientId =
            typeof slot.patient_id === "string" ? slot.patient_id : null;
          let status: FloorBedStatus = "unknown";
          if (hasSlots) {
            if (
              slot.status === "occupied" ||
              patientId ||
              slot.background_occupied === true
            )
              status = "occupied";
            else if (slot.status === "reserved" || slot.reservation_id)
              status = "reserved";
            else if (slot.status === "cleaning") status = "cleaning";
            else if (slot.installation_status === "planned") status = "planned";
            else if (
              slot.enabled === false ||
              slot.status === "disabled" ||
              exact?.active === false ||
              exact?.admission_gate === false
            )
              status = "blocked";
            else if (
              slot.staffed === false ||
              (exact?.staffed === 0 && exact?.qualified_staff_by_role?.rn === 0)
            )
              status = "unstaffed";
            else if (slot.status === "ready") status = "ready";
          }
          const label =
            (slot.display_label
              ? /^\d+$/.test(slot.display_label)
                ? `Bed ${slot.display_label}`
                : slot.display_label
              : null) ||
            `Bed ${
              String(slot.slot_id || slot.id)
                .match(/(\d+)$/)?.[1]
                ?.replace(/^0+(?=\d)/, "") || "record"
            }`;
          const description = [
            floorStatusLabel[status],
            slot.background_occupied ? "starting background occupancy" : null,
            status === "ready"
              ? "Staffing and equipment are shared across this unit"
              : null,
          ]
            .filter(Boolean)
            .join(". ");
          return {
            id: slot.slot_id || slot.id,
            unitId: id,
            label,
            status,
            patientId,
            patient: patientId ? patientById.get(patientId) || null : null,
            record: slot,
            description,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      const ratio =
        occupied !== null && staffed !== null
          ? staffed > 0
            ? occupied / staffed
            : occupied > 0
              ? 1
              : 0
          : null;
      const shortage = reasons.size > 0;
      const pressure = shortage
        ? 1
        : ratio === null
          ? null
          : Math.max(0, Math.min(1, (ratio - 0.65) / 0.35));
      const pressureText = shortage
        ? `Recorded constraint: ${[...reasons].map(humanLabel).join(", ")}`
        : ratio !== null
          ? `${Math.round(ratio * 100)}% of supported capacity occupied`
          : "Pressure evidence unavailable";
      return {
        id,
        name:
          (unit.kind === "ed" && /^ed$/i.test(unit.name)
            ? "Emergency department"
            : unit.kind === "icu" && /^icu$/i.test(unit.name)
              ? "ICU"
              : unit.name) ||
          unit.display_name ||
          (
            {
              ed: "Emergency department",
              icu: "Intensive care",
              ward: "Hospital ward",
              clinic: "Outpatient care",
            } as Record<string, string>
          )[unit.kind],
        kind: unit.kind,
        record: { ...unit, ...exact },
        beds,
        occupied,
        staffed,
        physical,
        available,
        unsupported:
          count(exact?.enabled) !== null && staffed !== null
            ? Math.max(0, exact!.enabled - staffed)
            : null,
        utilization: ratio,
        pressure,
        pressureText,
        reasons: [...reasons],
      };
    })
    .sort(
      (a, b) =>
        ((({ ward: 0, ed: 1, icu: 2, clinic: 3 }) as Record<string, number>)[
          a.kind
        ] ?? 4) -
          (({ ward: 0, ed: 1, icu: 2, clinic: 3 } as Record<string, number>)[
            b.kind
          ] ?? 4) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  return {
    at: typeof state?.at === "string" ? state.at : null,
    replicationId:
      state?.replication_id || state?.context?.replication_id || null,
    mainFacility: main,
    units: floorUnits,
    total:
      count(state?.patient_counts?.by_facility?.[main]) ??
      groupedCount(() => true),
    edWaiting:
      count(queue?.ed) ?? groupedCount((p) => p.state === "ed_waiting"),
    bedWaiting:
      count(queue?.total) ?? groupedCount((p) => p.admission_pending === true),
    discharges: count(state?.flow_counts?.[main]?.discharges),
  };
}

export function dischargeHistoryPath(
  replication: string,
  at: string,
  cursor = "0",
): string {
  const params = new URLSearchParams({
    at,
    direction: "before",
    before_sequence: "9007199254740991",
    event_type: "discharge",
    limit: "200",
    cursor,
  });
  return `/runs/${encodeURIComponent(replication)}/events?${params}`;
}
