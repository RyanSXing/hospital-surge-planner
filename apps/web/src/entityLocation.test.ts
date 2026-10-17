import { describe, expect, it } from "vitest";
import { resourceFacility } from "./entityLocation";

describe("selected-time resource location", () => {
  const units = [
    { unit_id: "home", facility_id: "FAC-MAIN" },
    { unit_id: "receiving", facility_id: "FAC-EAST" },
  ];
  it("opens a moved vehicle at its recorded location", () => {
    expect(
      resourceFacility(
        "vehicle",
        "V1",
        {
          current: true,
          location: "FAC-EAST",
          home_facility_id: "FAC-MAIN",
        },
        units,
      ),
    ).toBe("FAC-EAST");
    expect(
      resourceFacility(
        "vehicle",
        "V1",
        {
          location: "FAC-EAST",
          home_facility_id: "FAC-MAIN",
        },
        units,
      ),
    ).toBe("FAC-MAIN");
  });
  it("opens staff at the recorded assignment before the declared home unit", () => {
    const staff = { home_unit_id: "home", home_facility_id: "FAC-MAIN" };
    expect(
      resourceFacility("staff", "S1", staff, units, [
        { ...units[1], active_staff_ids: ["S1"] },
      ]),
    ).toBe("FAC-EAST");
    expect(resourceFacility("staff", "S1", staff, units)).toBe("FAC-MAIN");
  });
});
