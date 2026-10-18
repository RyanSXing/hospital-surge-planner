import type { Entity } from "../types";
import { humanLabel } from "../presentation";

export type SearchKind =
  "unit" | "facility" | "staff" | "equipment_pool" | "vehicle" | "slot";

const idFields: Record<SearchKind, string[]> = {
  unit: ["unit_id", "id"],
  facility: ["facility_id", "id"],
  staff: ["staff_id", "id"],
  equipment_pool: ["equipment_pool_id", "id"],
  vehicle: ["vehicle_id", "id"],
  slot: ["slot_id", "id"],
};

export function searchEntityId(kind: SearchKind, row: Entity) {
  return String(idFields[kind].map((field) => row[field]).find(Boolean) || "");
}

/** Overlay recorded selected-time state without replacing the immutable snapshot row. */
export function actualInventory(
  kind: SearchKind,
  snapshot: Entity[] = [],
  selectedState: Entity[] = [],
) {
  const current = new Map(
    selectedState
      .map((row) => [searchEntityId(kind, row), row] as const)
      .filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();
  const frozen = snapshot.map((row): Entity => {
    const id = searchEntityId(kind, row);
    seen.add(id);
    const selected = current.get(id);
    return {
      ...row,
      ...(selected || {}),
      search_kind: kind,
      search_source: selected ? "recorded_overlay" : "snapshot",
      current: Boolean(selected),
    };
  });
  const generated = selectedState.flatMap((row): Entity[] => {
    const id = searchEntityId(kind, row);
    if (!id || seen.has(id)) return [];
    return [
      {
        ...row,
        search_kind: kind,
        search_source: "selected_time_state",
        current: true,
      },
    ];
  });
  return [...frozen, ...generated];
}

export function resourceSearchRows(
  dataset: Entity | null | undefined,
  state: Entity | null | undefined,
  term: string,
) {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return [];
  const source = [
    ...actualInventory("unit", dataset?.units, state?.units),
    ...actualInventory("facility", dataset?.facilities),
    ...actualInventory("staff", dataset?.staff, state?.staff),
    ...actualInventory(
      "equipment_pool",
      dataset?.equipment_pools,
      state?.equipment_pools,
    ),
    ...actualInventory("vehicle", dataset?.vehicles, state?.vehicles),
    ...actualInventory("slot", dataset?.slots, state?.slots),
  ];
  return source.filter((row) => {
    const kind = row.search_kind as SearchKind;
    return `${row.name || row.display_label || ""} ${searchEntityId(kind, row)} ${row.role || ""} ${row.capability_code || ""} ${row.role ? humanLabel(row.role) : ""} ${row.capability_code ? humanLabel(row.capability_code) : ""}`
      .toLowerCase()
      .includes(normalized);
  });
}

export function searchKindLabel(kind: SearchKind) {
  return (
    {
      unit: "Unit",
      facility: "Facility",
      staff: "Staff",
      equipment_pool: "Equipment pool",
      vehicle: "Vehicle",
      slot: "Bed or treatment slot",
    } as const
  )[kind];
}

export function searchProvenanceLabel(row: Entity) {
  return (
    (
      {
        snapshot: "Snapshot",
        recorded_overlay: "Recorded selected time",
        selected_time_state: "Created in trajectory",
      } as Record<string, string>
    )[String(row.search_source)] || "Snapshot"
  );
}
