import { describe, expect, it } from "vitest";
import {
  activeArrivalResourceMix,
  arrivalResourceMixError,
  defaultArrivalResourceMix,
} from "./arrivalProfileWeights";

const data = {
  resource_profiles: [
    { resource_profile_id: "ED-BASIC", stage_kind: "ed" },
    { resource_profile_id: "WARD-BASIC", stage_kind: "ward" },
    { resource_profile_id: "CUSTOM-OXYGEN", stage_kind: "ward" },
    { resource_profile_id: "ICU-VENT", stage_kind: "icu" },
    { resource_profile_id: "CLINIC-KIT", stage_kind: "clinic" },
  ],
  cohorts: [
    {
      cohort_id: "COHORT-ED",
      care_level: "ambulatory",
      selection_weight: 1,
      resource_profile_weights: [
        { resource_profile_id: "ED-BASIC", weight: 1 },
      ],
    },
    {
      cohort_id: "COHORT-WARD-A",
      care_level: "ward",
      selection_weight: 0.25,
      resource_profile_weights: [
        { resource_profile_id: "WARD-BASIC", weight: 1 },
      ],
    },
    {
      cohort_id: "COHORT-WARD-B",
      care_level: "ward",
      selection_weight: 0.75,
      resource_profile_weights: [
        { resource_profile_id: "CUSTOM-OXYGEN", weight: 1 },
      ],
    },
    {
      cohort_id: "COHORT-ICU",
      care_level: "icu",
      selection_weight: 1,
      resource_profile_weights: [
        { resource_profile_id: "ICU-VENT", weight: 1 },
      ],
    },
  ],
  pathway_profiles: [
    { entry_stream_id: "CUSTOM-ED", ward_cohort_weights: [0.6, 0.4] },
    {
      entry_stream_id: "CUSTOM-DIRECT",
      ward_cohort_weights: [{ cohort_id: "COHORT-WARD-B", weight: 1 }],
    },
  ],
};

describe("reported arrival resource profiles", () => {
  it("resolves each care's declared pathway/cohort mixture using actual profile IDs", () => {
    const mix = defaultArrivalResourceMix(data, "CUSTOM-ED");
    expect(mix).toEqual({
      discharge: { "ED-BASIC": 1 },
      ward: { "WARD-BASIC": 0.6, "CUSTOM-OXYGEN": 0.4 },
      icu: { "ICU-VENT": 1 },
    });
    expect(defaultArrivalResourceMix(data, "CUSTOM-DIRECT").ward).toEqual({
      "WARD-BASIC": 0,
      "CUSTOM-OXYGEN": 1,
    });
    expect(defaultArrivalResourceMix(data, "OTHER").ward).toEqual({
      "WARD-BASIC": 0.25,
      "CUSTOM-OXYGEN": 0.75,
    });
  });
  it("serializes only positive care groups and preserves exact user changes without normalization", () => {
    const mix = defaultArrivalResourceMix(data, "CUSTOM-ED");
    mix.ward = { "WARD-BASIC": 0, "CUSTOM-OXYGEN": 1 };
    const care = { discharge: 0, ward: 1, icu: 0 };
    expect(arrivalResourceMixError(data, mix, care)).toBe("");
    expect(activeArrivalResourceMix(mix, care)).toEqual({
      ward: { "WARD-BASIC": 0, "CUSTOM-OXYGEN": 1 },
    });
    mix.ward["CUSTOM-OXYGEN"] = 0.8;
    expect(arrivalResourceMixError(data, mix, care)).toContain("100%");
  });
  it("rejects invalid percentages and incompatible profile groups", () => {
    const mix = defaultArrivalResourceMix(data, "CUSTOM-ED");
    mix.ward = { "ICU-VENT": 1 };
    expect(arrivalResourceMixError(data, mix, { ward: 1 })).toContain(
      "compatible profiles",
    );
    mix.ward = { "WARD-BASIC": Number.NaN };
    expect(arrivalResourceMixError(data, mix, { ward: 1 })).toContain(
      "nonnegative",
    );
    expect(
      arrivalResourceMixError(data, mix, { ward: -1, discharge: 2 }),
    ).toContain("Care disposition");
  });
});
