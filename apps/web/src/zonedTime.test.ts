import { describe, expect, it } from "vitest";
import { utcMinute, utcToWall, wallTimeCandidates } from "./zonedTime";
describe("selected timezone editor conversion", () => {
  const zone = "America/Chicago";
  it("round trips both offsets across the scenario DST transition", () => {
    expect(utcToWall("2026-10-16T05:00", zone)).toBe("2026-10-16T00:00");
    expect(wallTimeCandidates("2026-10-16T00:00", zone)).toEqual([
      "2026-10-16T05:00",
    ]);
    expect(wallTimeCandidates("2026-11-15T00:00", zone)).toEqual([
      "2026-11-15T06:00",
    ]);
  });
  it("preserves either occurrence of the repeated hour", () => {
    const values = wallTimeCandidates("2026-11-01T01:30", zone);
    expect(values).toEqual(["2026-11-01T06:30", "2026-11-01T07:30"]);
    for (const value of values)
      expect(utcToWall(value, zone)).toBe("2026-11-01T01:30");
  });
  it("rejects skipped local minutes and invalid calendar dates", () => {
    expect(wallTimeCandidates("2026-03-08T02:30", zone)).toEqual([]);
    expect(wallTimeCandidates("2026-02-30T12:00", zone)).toEqual([]);
  });
  it("supports non-hour offsets and explicit UTC suffixes", () => {
    expect(wallTimeCandidates("2026-10-16T09:45", "Asia/Kathmandu")).toEqual([
      "2026-10-16T04:00",
    ]);
    expect(utcMinute("2026-10-16T00:00:00-05:00")).toBe("2026-10-16T05:00");
  });
});
