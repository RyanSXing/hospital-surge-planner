import { describe, expect, it } from "vitest";
import {
  actualInventory,
  resourceSearchRows,
  searchEntityId,
  searchProvenanceLabel,
} from "./workspaceSearch";

describe("workspace resource search", () => {
  it("finds staff and equipment by the names shown in the interface", () => {
    const dataset = {
      staff: [{ staff_id: "STAFF-1", role: "rn" }],
      equipment_pools: [
        { equipment_pool_id: "EQ-1", capability_code: "ICU_MONITOR" },
      ],
    };
    expect(
      resourceSearchRows(dataset, null, "registered nurse")[0]?.staff_id,
    ).toBe("STAFF-1");
    expect(
      resourceSearchRows(dataset, null, "intensive care monitor")[0]
        ?.equipment_pool_id,
    ).toBe("EQ-1");
  });
  it("indexes every frozen inventory kind by its canonical ID", () => {
    const rows = resourceSearchRows(
      {
        units: [{ unit_id: "UNIT-ED", name: "Emergency" }],
        facilities: [{ facility_id: "FAC-MAIN", name: "Main" }],
        staff: [{ staff_id: "STAFF-17", role: "rn" }],
        equipment_pools: [
          { equipment_pool_id: "EQ-O2", capability_code: "oxygen" },
        ],
        vehicles: [{ vehicle_id: "VEH-1", name: "Transfer van" }],
        slots: [{ slot_id: "SLOT-ED-001", display_label: "ED 1" }],
      },
      null,
      "",
    );
    expect(rows).toHaveLength(0);
    expect(
      resourceSearchRows(
        {
          staff: [{ staff_id: "STAFF-17", role: "rn" }],
          equipment_pools: [
            { equipment_pool_id: "EQ-O2", capability_code: "oxygen" },
          ],
          vehicles: [{ vehicle_id: "VEH-1" }],
          slots: [{ slot_id: "SLOT-ED-001" }],
        },
        null,
        "staff-17",
      )[0],
    ).toMatchObject({ search_kind: "staff", staff_id: "STAFF-17" });
    expect(searchEntityId("slot", { slot_id: "SLOT-ED-001" })).toBe(
      "SLOT-ED-001",
    );
  });

  it("keeps immutable inventory identity while showing selected-time state", () => {
    const [vehicle] = resourceSearchRows(
      {
        vehicles: [{ vehicle_id: "VEH-1", name: "Van", location: "FAC-MAIN" }],
      },
      {
        vehicles: [
          {
            vehicle_id: "VEH-1",
            location: "FAC-EAST",
            available_at: "2026-10-16T12:00:00Z",
          },
        ],
      },
      "veh-1",
    );
    expect(vehicle).toMatchObject({
      vehicle_id: "VEH-1",
      name: "Van",
      location: "FAC-EAST",
      search_kind: "vehicle",
      search_source: "recorded_overlay",
      current: true,
    });
  });

  it("unions selected-time generated slots and vehicles with source metadata", () => {
    expect(
      actualInventory("vehicle", [{ vehicle_id: "VEH-SOURCE" }], []),
    ).toEqual([
      expect.objectContaining({
        vehicle_id: "VEH-SOURCE",
        search_source: "snapshot",
        current: false,
      }),
    ]);
    expect(
      actualInventory(
        "slot",
        [{ slot_id: "SLOT-ED-001" }],
        [{ slot_id: "SLOT-GENERATED-001", unit_id: "UNIT-OVERFLOW" }],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot_id: "SLOT-GENERATED-001",
          search_source: "selected_time_state",
          current: true,
        }),
      ]),
    );
    expect(
      resourceSearchRows(
        { vehicles: [] },
        {
          vehicles: [{ vehicle_id: "VEH-GENERATED-01", location: "FAC-MAIN" }],
        },
        "generated",
      ),
    ).toEqual([
      expect.objectContaining({
        vehicle_id: "VEH-GENERATED-01",
        search_source: "selected_time_state",
        current: true,
      }),
    ]);
  });

  it("overlays source equipment and indexes a trajectory-created split pool", () => {
    const pools = actualInventory(
      "equipment_pool",
      [{ equipment_pool_id: "EQ-CLINIC-KIT", quantity: 8 }],
      [
        { equipment_pool_id: "EQ-CLINIC-KIT", quantity: 4, available: 4 },
        {
          equipment_pool_id: "EQ-CLINIC-KIT-UNIT-CLINIC-NORTH",
          source_equipment_pool_id: "EQ-CLINIC-KIT",
          created_in_trajectory: true,
          quantity: 4,
          available: 3,
        },
      ],
    );
    expect(pools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          equipment_pool_id: "EQ-CLINIC-KIT",
          quantity: 4,
          search_source: "recorded_overlay",
        }),
        expect.objectContaining({
          equipment_pool_id: "EQ-CLINIC-KIT-UNIT-CLINIC-NORTH",
          source_equipment_pool_id: "EQ-CLINIC-KIT",
          created_in_trajectory: true,
          search_source: "selected_time_state",
        }),
      ]),
    );
  });

  it("makes frozen, recorded, and trajectory-created provenance explicit", () => {
    expect(searchProvenanceLabel({ search_source: "snapshot" })).toBe(
      "Snapshot",
    );
    expect(searchProvenanceLabel({ search_source: "recorded_overlay" })).toBe(
      "Recorded selected time",
    );
    expect(
      searchProvenanceLabel({ search_source: "selected_time_state" }),
    ).toBe("Created in trajectory");
  });
});
