import type { Entity } from "../types";

export type Site = {
  id: string;
  facility: Entity;
  position: [number, number] | null;
  status: string;
};

type Feature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Polygon"; coordinates: [number, number][][] };
};
export type Features = { type: "FeatureCollection"; features: Feature[] };

const empty = (): Features => ({ type: "FeatureCollection", features: [] });
const atOrBefore = (value: unknown, at: string) => {
  const instant = Date.parse(String(value || ""));
  const selected = Date.parse(at);
  return (
    Number.isFinite(instant) && Number.isFinite(selected) && instant <= selected
  );
};
const targetFacilities = (
  row: Entity,
  unitFacilities: Map<string, string>,
  entryFacilities: Map<string, string>,
  staffFacilities: Map<string, string>,
  equipmentFacilities: Map<string, string>,
) => {
  const direct = String(
    row.payload?.facility_id ||
      row.facility_id ||
      row.target_facility_id ||
      row.site_id ||
      row.destination_facility_id ||
      unitFacilities.get(String(row.payload?.unit_id || row.unit_id || "")) ||
      entryFacilities.get(
        String(row.payload?.entry_stream_id || row.entry_stream_id || ""),
      ) ||
      "",
  );
  if (direct) return [direct];
  const staffIds = row.payload?.staff_ids || row.staff_ids || [];
  const ids = Array.isArray(staffIds) ? staffIds : [];
  const equipmentId = String(
    row.payload?.equipment_pool_id ||
      row.payload?.pool_id ||
      row.equipment_pool_id ||
      row.pool_id ||
      "",
  );
  return Array.from(
    new Set(
      [
        ...ids.map((id) => staffFacilities.get(String(id))),
        equipmentFacilities.get(equipmentId),
      ].filter((facility): facility is string => Boolean(facility)),
    ),
  );
};

const incidentSourceLabel = (row: Entity) => {
  if (row.input_kind === "planned_assumption") return "Planned assumption";
  if (row.__incident_group === "condition") {
    if (row.source === "synthetic_incident") return "Synthetic incident";
    if (row.source === "planned_batch") return "Planned batch";
    return "Planned assumption";
  }
  if (row.source === "reported_batch") return "Reported batch";
  return "Recorded update";
};

export function sitePosition(f: Entity): [number, number] | null {
  const lng = f.longitude ?? f.geometry?.coordinates?.[0];
  const lat = f.latitude ?? f.geometry?.coordinates?.[1];
  return lng !== null &&
    lng !== undefined &&
    lat !== null &&
    lat !== undefined &&
    Number.isFinite(Number(lng)) &&
    Number.isFinite(Number(lat)) &&
    Math.abs(Number(lng)) <= 180 &&
    Math.abs(Number(lat)) <= 90
    ? [Number(lng), Number(lat)]
    : null;
}

/** Runtime unit activity is authoritative over a candidate's frozen seed state. */
export function selectedSiteStatus(facility: Entity, units: Entity[]) {
  const frozen = String(facility.status || "unspecified");
  if (units.some((unit) => unit.active === true)) return "active";
  if (
    units.length > 0 &&
    units.every((unit) => unit.active === false) &&
    !["candidate", "activating"].includes(frozen)
  )
    return "inactive";
  return frozen;
}

export function mapLayerData({
  sites,
  routes,
  capacity,
  patients,
  patientGroups,
  transferPaths,
  unitFacilities = new Map<string, string>(),
  entryFacilities = new Map<string, string>(),
  staffFacilities = new Map<string, string>(),
  equipmentFacilities = new Map<string, string>(),
  unavailable,
  selectedTime,
  reports,
}: {
  sites: Site[];
  routes: Entity[];
  capacity: Map<string, Entity>;
  patients: Entity[];
  patientGroups?: Entity[] | null;
  /** Exact compact selected-time aggregate; patient inspection rows are bounded. */
  transferPaths?: Entity[] | null;
  unitFacilities?: Map<string, string>;
  entryFacilities?: Map<string, string>;
  staffFacilities?: Map<string, string>;
  equipmentFacilities?: Map<string, string>;
  unavailable: boolean;
  selectedTime: string;
  reports?: Entity | null;
}) {
  const located = sites.filter(
    (site): site is Site & { position: [number, number] } =>
      site.position !== null,
  );
  const coordinates = new Map(located.map((site) => [site.id, site.position]));
  const facilities: Features = {
    type: "FeatureCollection",
    features: located.map((site) => {
      const [x, y] = site.position;
      const dx =
        (site.facility.kind === "hospital" ? 0.0008 : 0.0004) /
        Math.cos((y * Math.PI) / 180);
      const dy = site.facility.kind === "hospital" ? 0.0006 : 0.0003;
      return {
        type: "Feature",
        properties: {
          facility_id: site.id,
          kind: site.facility.kind,
          status: site.status,
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x - dx, y - dy],
              [x + dx, y - dy],
              [x + dx, y + dy],
              [x - dx, y + dy],
              [x - dx, y - dy],
            ],
          ],
        },
      };
    }),
  };
  const capacityFeatures = unavailable
    ? empty()
    : {
        type: "FeatureCollection" as const,
        features: located.flatMap((site) => {
          const value = capacity.get(site.id);
          if (!value) return [];
          return [
            {
              type: "Feature" as const,
              properties: {
                facility_id: site.id,
                occupied: Number(value.occupied || 0),
                staffed: Number(value.staffed || 0),
                available: Number(value.available || 0),
              },
              geometry: { type: "Point" as const, coordinates: site.position },
            },
          ];
        }),
      };
  const cohorts = new Map<
    string,
    { facility: string; cohort: string; count: number }
  >();
  if (!unavailable) {
    // `patient_groups` is the complete server aggregate. `patients` is a bounded
    // inspection page, so only use it for older state payloads without groups.
    const source: Entity[] = Array.isArray(patientGroups)
      ? patientGroups
      : patients.map((patient) => ({ ...patient, count: 1 }));
    for (const patient of source) {
      const facility = String(patient.facility_id || "");
      if (!coordinates.has(facility)) continue;
      const cohort = String(
        patient.cohort_template_id ||
          patient.care_level ||
          patient.target_unit_kind ||
          patient.state ||
          "unspecified",
      );
      const key = `${facility}|${cohort}`;
      const group = cohorts.get(key) || { facility, cohort, count: 0 };
      group.count += Number(patient.count ?? 1);
      cohorts.set(key, group);
    }
  }
  const cohortFeatures: Features = {
    type: "FeatureCollection",
    features: [...cohorts.values()].map((group) => ({
      type: "Feature",
      properties: {
        facility_id: group.facility,
        cohort: group.cohort,
        count: group.count,
      },
      geometry: {
        type: "Point",
        coordinates: coordinates.get(group.facility)!,
      },
    })),
  };
  const routeKeys = new Set<string>();
  const transferFeatures: Feature[] = [];
  for (const route of routes) {
    const from = String(route.from_facility_id || "");
    const to = String(route.to_facility_id || "");
    const key = `${from}|${to}`;
    if (!coordinates.has(from) || !coordinates.has(to) || routeKeys.has(key))
      continue;
    routeKeys.add(key);
    transferFeatures.push({
      type: "Feature",
      properties: {
        route_id: route.route_id || key,
        route_type: "defined",
        travel_minutes: route.travel_minutes,
      },
      geometry: {
        type: "LineString",
        coordinates: [coordinates.get(from)!, coordinates.get(to)!],
      },
    });
  }
  if (!unavailable && Array.isArray(transferPaths)) {
    for (const path of transferPaths) {
      const from = String(path.from_facility_id || "");
      const to = String(path.to_facility_id || "");
      if (!coordinates.has(from) || !coordinates.has(to)) continue;
      transferFeatures.push({
        type: "Feature",
        properties: {
          route_id: `recorded:${from}:${to}`,
          route_type: "recorded",
          transfer_count: Number(path.count || 0),
          status_counts: path.status_counts || {},
        },
        geometry: {
          type: "LineString",
          coordinates: [coordinates.get(from)!, coordinates.get(to)!],
        },
      });
    }
  } else if (!unavailable) {
    // Older replay payloads did not include `transfer_paths`. Their patient
    // collection was not necessarily bounded, so this is compatibility only.
    for (const patient of patients) {
      const transfer = patient.pending_transfer || patient.transfer;
      const from = String(patient.facility_id || "");
      const to = String(
        transfer?.destination_facility_id || transfer?.facility_id || "",
      );
      const status = String(transfer?.status || "");
      if (
        !transfer ||
        !["requested", "reserved", "departed"].includes(status) ||
        !coordinates.has(from) ||
        !coordinates.has(to)
      )
        continue;
      transferFeatures.push({
        type: "Feature",
        properties: {
          route_id: transfer.request_id || patient.patient_id,
          route_type: "recorded",
          transfer_status: status,
        },
        geometry: {
          type: "LineString",
          coordinates: [coordinates.get(from)!, coordinates.get(to)!],
        },
      });
    }
  }
  const candidates: Features = {
    type: "FeatureCollection",
    features: located.flatMap((site) =>
      ["candidate", "activating"].includes(site.status)
        ? [
            {
              type: "Feature" as const,
              properties: {
                facility_id: site.id,
                status: site.status,
              },
              geometry: { type: "Point" as const, coordinates: site.position },
            },
          ]
        : [],
    ),
  };
  const reportRows = [
    ...(reports?.conditions || []).map((row: Entity) => ({
      ...row,
      __incident_group: "condition",
    })),
    ...(reports?.updates || []).map((row: Entity) => ({
      ...row,
      __incident_group: "update",
    })),
  ] as Entity[];
  const incidents: Features = {
    type: "FeatureCollection",
    features: reportRows.flatMap<Feature>((row): Feature[] => {
      const kind = String(
        row.kind || row.type || row.category || "",
      ).toLowerCase();
      const reportedAt =
        row.effective_at || row.at || row.start_at || row.recorded_at;
      const facilities = targetFacilities(
        row,
        unitFacilities,
        entryFacilities,
        staffFacilities,
        equipmentFacilities,
      );
      const route = routes.find(
        (candidate) =>
          String(candidate.route_id || candidate.id) ===
          String(row.payload?.route_id || row.route_id || ""),
      );
      if (
        ![
          "arrival_batch",
          "site_ready",
          "capacity_change",
          "advertised_capacity_change",
          "staff_unavailable",
          "staff_unavailability",
          "staff_available",
          "equipment_change",
          "route_change",
          "census_replacement",
        ].includes(kind) ||
        row.status === "retracted" ||
        !atOrBefore(reportedAt, selectedTime)
      )
        return [];
      const label =
        row.label ||
        row.description ||
        (kind === "arrival_batch"
          ? `Arrival batch${row.payload?.count !== undefined || row.count !== undefined ? ` · ${row.payload?.count ?? row.count}` : ""}`
          : kind.replaceAll("_", " "));
      const source = incidentSourceLabel(row);
      if (
        kind === "route_change" &&
        route &&
        coordinates.has(String(route.from_facility_id || "")) &&
        coordinates.has(String(route.to_facility_id || ""))
      ) {
        return [
          {
            type: "Feature" as const,
            properties: {
              route_id: route.route_id || route.id,
              report_id: row.id || row.update_id || "incident",
              label: `${label} · ${source}`,
              report_source: source,
            },
            geometry: {
              type: "LineString" as const,
              coordinates: [
                coordinates.get(String(route.from_facility_id))!,
                coordinates.get(String(route.to_facility_id))!,
              ],
            },
          },
        ];
      }
      return facilities
        .filter((facility) => coordinates.has(facility))
        .map((facility) => ({
          type: "Feature" as const,
          properties: {
            facility_id: facility,
            report_id: row.id || row.update_id || "incident",
            label: `${label} · ${source}`,
            report_source: source,
          },
          geometry: {
            type: "Point" as const,
            coordinates: coordinates.get(facility)!,
          },
        }));
    }),
  };
  return {
    facilities,
    capacity: capacityFeatures,
    cohorts: cohortFeatures,
    transfers: {
      type: "FeatureCollection" as const,
      features: transferFeatures,
    },
    candidates,
    incidents,
  };
}
