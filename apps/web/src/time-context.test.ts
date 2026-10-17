import { afterEach, describe, expect, it } from "vitest";
import { localDate, setPresentationTimezone } from "./api";
import { selectedRunNumber } from "./model";
import type { Metrics } from "./types";

afterEach(() => setPresentationTimezone("America/Chicago"));
describe("shared display context", () => {
  it("formats the same UTC instant in the imported dataset timezone", () => {
    const options: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    };
    expect(localDate("2026-10-16T05:00:00Z", options)).toBe("00:00");
    setPresentationTimezone("America/New_York");
    expect(localDate("2026-10-16T05:00:00Z", options)).toBe("01:00");
    expect(() => setPresentationTimezone("Invalid/Zone")).toThrow(RangeError);
  });
  it("labels an explicitly selected replication independently of the representative run", () => {
    const metrics: Metrics = {
      scalar_metrics: {},
      series: [],
      daily: [],
      selected_replication_index: 4,
    };
    expect(
      selectedRunNumber({ metrics, activeReplicationId: "run_abc_rep_0007" }),
    ).toBe(8);
    expect(selectedRunNumber({ metrics, activeReplicationId: "" })).toBe(5);
    expect(selectedRunNumber({ metrics: null })).toBeUndefined();
  });
});
