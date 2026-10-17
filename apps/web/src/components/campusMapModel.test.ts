import { describe, expect, it } from "vitest";
import { mapLayerData, selectedSiteStatus, type Site } from "./campusMapModel";

const sites: Site[] = [
  {
    id: "FAC-A",
    facility: { kind: "hospital", status: "active" },
    position: [-86.8, 36.1],
    status: "active",
  },
  {
    id: "FAC-B",
    facility: { kind: "clinic", status: "candidate" },
    position: [-86.7, 36.2],
    status: "active",
  },
];

describe("campus map layers", () => {
  it("treats a selected-time active unit as active even when its frozen site is candidate", () => {
    expect(
      selectedSiteStatus({ status: "candidate" }, [
        { unit_id: "UNIT-CLINIC", active: true },
      ]),
    ).toBe("active");
  });

  it("uses complete selected-time patient groups instead of the bounded patient page", () => {
    const data = mapLayerData({
      sites,
      routes: [],
      capacity: new Map([
        ["FAC-A", { occupied: 8, staffed: 10, available: 2 }],
      ]),
      patients: [
        {
          patient_id: "P1",
          facility_id: "FAC-A",
          cohort_template_id: "COHORT-ED",
        },
      ],
      patientGroups: [
        {
          facility_id: "FAC-A",
          care_level: "ward",
          state: "inpatient",
          count: 1250,
        },
      ],
      unavailable: false,
      selectedTime: "2026-10-16T10:00:00Z",
    });
    expect(data.capacity.features).toHaveLength(1);
    expect(data.cohorts.features[0].properties).toMatchObject({
      count: 1250,
      cohort: "ward",
    });
    expect(data.candidates.features).toHaveLength(0);
  });

  it("uses real location-bearing arrival batch reports and excludes future reports", () => {
    const data = mapLayerData({
      sites,
      routes: [],
      capacity: new Map([["FAC-A", { occupied: 8 }]]),
      patients: [{ facility_id: "FAC-A" }],
      unavailable: false,
      selectedTime: "2026-10-16T10:00:00Z",
      reports: {
        updates: [
          {
            type: "arrival_batch",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { facility_id: "FAC-A", count: 20, care_mix: { ward: 1 } },
          },
          {
            type: "capacity_change",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { unit_id: "UNIT-A" },
          },
          {
            type: "site_ready",
            effective_at: "2026-10-16T12:00:00Z",
            payload: { facility_id: "FAC-B" },
          },
        ],
      },
      unitFacilities: new Map([["UNIT-A", "FAC-A"]]),
    });
    expect(data.incidents.features).toHaveLength(2);
    expect(
      data.incidents.features.map((feature) => feature.properties),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          facility_id: "FAC-A",
          label: "Arrival batch · 20 · Recorded update",
          report_source: "Recorded update",
        }),
        expect.objectContaining({
          facility_id: "FAC-A",
          label: "capacity change · Recorded update",
        }),
      ]),
    );
  });

  it("distinguishes planned resource assumptions from recorded update documents", () => {
    const data = mapLayerData({
      sites,
      routes: [],
      capacity: new Map(),
      patients: [],
      unavailable: false,
      selectedTime: "2026-10-16T10:00:00Z",
      reports: {
        updates: [
          {
            type: "capacity_change",
            input_kind: "planned_assumption",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { facility_id: "FAC-A" },
          },
          {
            type: "arrival_batch",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { facility_id: "FAC-A", count: 3 },
          },
        ],
      },
    });
    expect(
      data.incidents.features.map((value) => value.properties.report_source),
    ).toEqual(["Planned assumption", "Recorded update"]);
  });

  it("locates a planned arrival batch through its declared entry stream", () => {
    const data = mapLayerData({
      sites,
      routes: [],
      capacity: new Map(),
      patients: [],
      unavailable: false,
      selectedTime: "2026-10-16T10:00:00Z",
      entryFacilities: new Map([["ED_MAIN", "FAC-A"]]),
      reports: {
        conditions: [
          {
            kind: "arrival_batch",
            at: "2026-10-16T09:00:00Z",
            entry_stream_id: "ED_MAIN",
            count: 24,
            source: "planned_batch",
          },
        ],
      },
    });
    expect(data.incidents.features).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          facility_id: "FAC-A",
          label: "Arrival batch · 24 · Planned batch",
          report_source: "Planned batch",
        }),
      }),
    ]);
  });

  it("resolves canonical staff, equipment, and route references without inventing a site", () => {
    const data = mapLayerData({
      sites,
      routes: [
        {
          route_id: "ROUTE-A-B",
          from_facility_id: "FAC-A",
          to_facility_id: "FAC-B",
        },
      ],
      capacity: new Map(),
      patients: [],
      unavailable: false,
      selectedTime: "2026-10-16T10:00:00Z",
      staffFacilities: new Map([["STAFF-CURRENT", "FAC-B"]]),
      equipmentFacilities: new Map([["EQ-CURRENT", "FAC-A"]]),
      reports: {
        updates: [
          {
            type: "staff_unavailability",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { staff_ids: ["STAFF-CURRENT"] },
          },
          {
            type: "equipment_change",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { equipment_pool_id: "EQ-CURRENT", operation: "fail" },
          },
          {
            type: "route_change",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { route_id: "ROUTE-A-B", unavailable: true },
          },
          {
            type: "staff_unavailable",
            effective_at: "2026-10-16T09:00:00Z",
            payload: { staff_ids: ["UNKNOWN"] },
          },
        ],
      },
    });
    expect(data.incidents.features).toHaveLength(3);
    expect(data.incidents.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            facility_id: "FAC-B",
            label: "staff unavailability · Recorded update",
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            facility_id: "FAC-A",
            label: "equipment change · Recorded update",
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            route_id: "ROUTE-A-B",
            label: "route change · Recorded update",
          }),
          geometry: expect.objectContaining({ type: "LineString" }),
        }),
      ]),
    );
  });

  it("uses the exact selected-time transfer aggregate before the bounded patient list", () => {
    const data = mapLayerData({
      sites,
      routes: [],
      capacity: new Map(),
      patients: [],
      patientGroups: [],
      transferPaths: [
        {
          from_facility_id: "FAC-A",
          to_facility_id: "FAC-B",
          count: 731,
          status_counts: { departed: 731 },
        },
      ],
      unavailable: false,
      selectedTime: "2026-10-16T10:00:00Z",
    });
    expect(data.transfers.features).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          route_type: "recorded",
          transfer_count: 731,
          status_counts: { departed: 731 },
        }),
      }),
    ]);
  });
});
