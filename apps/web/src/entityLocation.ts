import type { Entity } from "./types";

/** The current ledger takes precedence over declared home inventory. */
export function resourceFacility(
  kind: string,
  id: string,
  row: Entity,
  sourceUnits: Entity[],
  recordedUnits: Entity[] = [],
) {
  const assignment =
    kind === "staff"
      ? recordedUnits.find((unit) => unit.active_staff_ids?.includes(id))
      : null;
  if (assignment?.facility_id) return assignment.facility_id as string;
  if (kind === "vehicle" && row.current && row.location)
    return String(row.location);
  const unit = [...recordedUnits, ...sourceUnits].find(
    (value) => value.unit_id === (row.unit_id || row.home_unit_id),
  );
  return String(
    row.facility_id || unit?.facility_id || row.home_facility_id || "",
  );
}
