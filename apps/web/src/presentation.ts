/** UI vocabulary. Identifiers and source fields remain available in version details. */
const names: Record<string, string> = {
  "WARD-BASIC": "Standard ward care",
  "WARD-OXYGEN": "Ward care with oxygen",
  "ICU-MONITORED": "Intensive care with monitoring",
  "ICU-VENTILATED": "Intensive care with a ventilator",
  "ED-BASIC": "Standard emergency assessment",
  "ED-MONITORED": "Emergency assessment with monitoring",
  nursing_capacity: "Not enough nurses",
  minimum_operating_team: "More medical or support staff needed",
  required_equipment_unavailable: "Required equipment unavailable",
  no_matching_physical_place: "No suitable bed",
  place_turnover: "Bed being cleaned",
  destination_inactive: "Unit not open",
  unsupported_care_capability: "Required care unavailable",
  incoming_reservation: "Bed reserved for an incoming patient",
  awaiting_transport_pickup: "Waiting for transport",
  in_transit: "In transport",
  rn: "Registered nurse",
  provider: "Medical provider",
  support: "Support staff",
  ward: "Ward",
  icu: "Intensive care",
  ed: "Emergency department",
  ambulatory: "Outpatient care",
  direct_ward: "Direct admission",
  initial_census: "Starting hospital census",
  generated_arrival: "Expected arrival",
  synthetic_incident: "Planned incident",
  WARD_OXYGEN: "Oxygen support",
  ICU_MONITOR: "Intensive care monitor",
  ED_MONITOR: "Emergency department monitor",
  VENTILATOR: "Ventilator",
  GENERAL_SUPPORT: "General support",
  WARD_NURSING: "Ward nursing",
  ICU_NURSING: "Intensive care nursing",
  ED_NURSING: "Emergency nursing",
  WARD_PROVIDER: "Ward medical care",
  ICU_PROVIDER: "Intensive care medical care",
  ED_PROVIDER: "Emergency medical care",
  physical_capacity: "Installed beds",
  staffed_capacity: "Beds supported by staff",
  equipment: "Equipment unavailable",
  staffing: "Not enough staff",
  no_physical_capacity: "No suitable bed",
  physical: "No installed bed",
  staff: "Not enough staff",
  readiness: "Bed not ready",
  no_compatible_slot: "No suitable bed",
  no_staffed_capacity: "Not enough staff",
  no_equipment: "Required equipment unavailable",
  no_ready_capacity: "Bed not ready",
  ed_boarding: "Waiting for an inpatient bed",
  ed_assessment: "Emergency assessment",
  direct_waiting: "Waiting for a ward bed",
  ed_waiting: "Waiting for assessment",
  inpatient: "Admitted",
  discharged: "Discharged",
  departed: "Left hospital",
};
export function humanLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  return (
    names[text] ||
    text
      .replaceAll("_", " ")
      .replace(/\bicu\b/gi, "ICU")
      .replace(/\bed\b/gi, "ED")
      .replace(/^\w/, (c) => c.toUpperCase())
  );
}
