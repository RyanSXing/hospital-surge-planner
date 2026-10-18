import { describe, expect, it } from "vitest";
import {
  averageSeverityStay,
  changeSeverityShare,
  defaultSeverityMix,
  defaultSupplies,
  disruptionForDate,
  disruptionWithinHorizon,
  firstDisruptionDate,
  hospitalOperationsPatch,
  moveSeverityBoundary,
  normalizeSeverityMix,
  operationsError,
  severityOrder,
  withOperation,
} from "./hospitalOperationsModel";
import type { HospitalOperations } from "../types";

const start = "2026-10-16T05:00:00Z",
  end = "2026-11-15T06:00:00Z",
  zone = "America/Chicago";
const total = (mix: ReturnType<typeof defaultSeverityMix>) =>
  severityOrder.reduce((sum, key) => sum + mix[key].percentage, 0);
describe("daily disruption probability configuration", () => {
  it("does not enable an operations model when a zero chance is selected", () => {
    expect(withOperation(undefined, "disruption_chance_percent", 0)).toBeNull();
    expect(withOperation(undefined, "disruption_chance_percent", 27.5)).toEqual(
      {
        disruption_chance_percent: 27.5,
      },
    );
  });
  it("preserves exact saved schedules and unrelated settings when changing chance", () => {
    const original: HospitalOperations = {
      disruptions: [disruptionForDate("2026-10-20", zone, "legacy")],
      supplies: defaultSupplies(),
    };
    const next = withOperation(original, "disruption_chance_percent", 35);
    expect(hospitalOperationsPatch(next, start, end)).toEqual({
      hospital_operations: { ...original, disruption_chance_percent: 35 },
    });
    expect(withOperation(next, "disruption_chance_percent", 0)).toEqual(
      original,
    );
    expect(original).not.toHaveProperty("disruption_chance_percent");
  });
  it.each([-1, 101, NaN, Infinity, -Infinity])(
    "rejects an invalid chance %s",
    (chance) => {
      expect(() =>
        hospitalOperationsPatch(
          { disruption_chance_percent: chance },
          start,
          end,
        ),
      ).toThrow("between 0% and 100%");
    },
  );
});
describe("editable patient severity mix", () => {
  it("redistributes unedited shares proportionally, without mutating the saved mix", () => {
    const before = defaultSeverityMix();
    const next = changeSeverityShare(before, "low", 80);
    expect(next.low.percentage).toBe(80);
    expect(next.medium.percentage).toBe(15);
    expect(next.high.percentage).toBe(5);
    expect(total(next)).toBe(100);
    expect(before).toEqual(defaultSeverityMix());
    expect(next.medium.average_stay_hours).toBe(72);
  });
  it("supports 0–100 endpoints and recovers proportionally from the other two being zero", () => {
    const full = changeSeverityShare(defaultSeverityMix(), "high", 100);
    expect([
      full.low.percentage,
      full.medium.percentage,
      full.high.percentage,
    ]).toEqual([0, 0, 100]);
    const next = changeSeverityShare(full, "high", 0);
    expect([
      next.low.percentage,
      next.medium.percentage,
      next.high.percentage,
    ]).toEqual([50, 50, 0]);
    expect(total(changeSeverityShare(next, "low", -20))).toBe(100);
    expect(changeSeverityShare(next, "low", 200).low.percentage).toBe(100);
  });
  it("normalizes zero and invalid weights deterministically and exactly to hundredths", () => {
    const empty = defaultSeverityMix();
    empty.low.percentage = 0;
    empty.medium.percentage = NaN;
    empty.high.percentage = -1;
    const normalized = normalizeSeverityMix(empty);
    expect([
      normalized.low.percentage,
      normalized.medium.percentage,
      normalized.high.percentage,
    ]).toEqual([33.34, 33.33, 33.33]);
    expect(total(normalized)).toBe(100);
    expect(total(changeSeverityShare(normalized, "low", 22.22))).toBeCloseTo(
      100,
      10,
    );
  });
  it("moves a pie boundary only between adjacent severities, without crossing another boundary", () => {
    const first = moveSeverityBoundary(defaultSeverityMix(), 0, 80);
    expect([
      first.low.percentage,
      first.medium.percentage,
      first.high.percentage,
    ]).toEqual([80, 10, 10]);
    const second = moveSeverityBoundary(first, 1, 85);
    expect([
      second.low.percentage,
      second.medium.percentage,
      second.high.percentage,
    ]).toEqual([80, 5, 15]);
    expect(moveSeverityBoundary(second, 0, 200).low.percentage).toBe(85);
    expect(moveSeverityBoundary(second, 1, -20).medium.percentage).toBe(0);
  });
  it("calculates a weighted stay, and rejects nonpositive or descending severity stays", () => {
    expect(averageSeverityStay(defaultSeverityMix())).toBeCloseTo(52.8);
    const mix = defaultSeverityMix();
    mix.low.average_stay_hours = 0;
    expect(operationsError({ severity_mix: mix }, start, end)).toContain(
      "positive average stay",
    );
    mix.low.average_stay_hours = 100;
    expect(operationsError({ severity_mix: mix }, start, end)).toContain(
      "increase",
    );
  });
});
describe("local calendar disruption days", () => {
  it("keeps a full disruption day through autumn and spring daylight-saving changes", () => {
    const autumn = disruptionForDate("2026-11-01", zone, "fall");
    expect(autumn.start_at).toBe("2026-11-01T05:00:00.000Z");
    expect(autumn.end_at).toBe("2026-11-02T06:00:00.000Z");
    expect(
      (Date.parse(autumn.end_at) - Date.parse(autumn.start_at)) / 3600000,
    ).toBe(25);
    const spring = disruptionForDate("2026-03-08", zone, "spring");
    expect(
      (Date.parse(spring.end_at) - Date.parse(spring.start_at)) / 3600000,
    ).toBe(23);
    expect(() => disruptionForDate("2026-02-30", zone, "bad")).toThrow(
      "valid disruption date",
    );
  });
  it("finds the first whole unused date, without extending a short or partial horizon", () => {
    const first = disruptionForDate("2026-10-16", zone, "first");
    expect(firstDisruptionDate(start, end, zone, [first])).toBe("2026-10-17");
    expect(
      firstDisruptionDate(
        "2026-10-16T12:00:00Z",
        "2026-10-17T04:00:00Z",
        zone,
        [],
      ),
    ).toBeNull();
    expect(
      firstDisruptionDate(
        "2026-10-16T12:00:00Z",
        "2026-10-18T05:00:00Z",
        zone,
        [],
      ),
    ).toBe("2026-10-17");
    expect(disruptionWithinHorizon(first, start, "2026-10-17T05:00:00Z")).toBe(
      true,
    );
    expect(disruptionWithinHorizon(first, "2026-10-16T06:00:00Z", end)).toBe(
      false,
    );
  });
  it("does not silently drop a saved disruption when the horizon shrinks", () => {
    const disruption = disruptionForDate("2026-11-01", zone, "D");
    const value = { disruptions: [disruption] };
    expect(() =>
      hospitalOperationsPatch(value, start, "2026-10-23T05:00:00Z"),
    ).toThrow("outside this simulation");
    expect(value.disruptions).toEqual([disruption]);
  });
});
describe("operations draft/save contract", () => {
  it("keeps absent legacy configuration absent, and allows explicit clearing", () => {
    expect(hospitalOperationsPatch(undefined, start, end)).toEqual({});
    expect(hospitalOperationsPatch(null, start, end)).toEqual({
      hospital_operations: null,
    });
    const saved = { supplies: defaultSupplies() };
    expect(withOperation(saved, "supplies", undefined)).toBeNull();
    expect(saved).toEqual({ supplies: defaultSupplies() });
  });
  it("adding a disruption does not enable severity or inventory, and preserves unrelated settings", () => {
    const disruption = disruptionForDate("2026-10-20", zone, "D");
    expect(withOperation(undefined, "disruptions", [disruption])).toEqual({
      disruptions: [disruption],
    });
    const prior: HospitalOperations = {
      severity_mix: defaultSeverityMix(),
      disruptions: [disruption],
    };
    const next = withOperation(prior, "supplies", defaultSupplies());
    expect(next).toEqual({ ...prior, supplies: defaultSupplies() });
    expect(withOperation(next, "disruptions", [])).toEqual({
      severity_mix: prior.severity_mix,
      supplies: defaultSupplies(),
    });
  });
  it("round trips severity, supplies, and exact disruption intervals through the saved/run patch", () => {
    const settings: HospitalOperations = {
      severity_mix: changeSeverityShare(defaultSeverityMix(), "high", 20),
      supplies: { ...defaultSupplies(), initial_percent: 0 },
      disruptions: [disruptionForDate("2026-11-01", zone, "D")],
    };
    const patch = hospitalOperationsPatch(settings, start, end);
    expect(JSON.parse(JSON.stringify(patch)).hospital_operations).toEqual(
      settings,
    );
    expect(patch.hospital_operations).not.toBe(settings);
    patch.hospital_operations!.supplies!.initial_percent = 90;
    expect(settings.supplies!.initial_percent).toBe(0);
  });
  it("rejects invalid supply values, preserving zero stock, zero usage, and zero refill as meaningful choices", () => {
    expect(
      operationsError(
        {
          supplies: {
            ...defaultSupplies(),
            initial_percent: 0,
            usage_per_patient_day: 0,
            refill_percent: 0,
          },
        },
        start,
        end,
      ),
    ).toBe("");
    for (const bad of [
      { capacity: 0 },
      { usage_per_patient_day: -1 },
      { refill_every_days: 1.5 },
      { initial_percent: 101 },
    ]) {
      expect(
        operationsError(
          { supplies: { ...defaultSupplies(), ...bad } },
          start,
          end,
        ),
      ).toContain("Check supply");
    }
  });
});
