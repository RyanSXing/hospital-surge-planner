import type { Entity } from "../types";

export const batchCareStages = {
  discharge: "ed",
  ward: "ward",
  icu: "icu",
} as const;
export type BatchCare = keyof typeof batchCareStages;
export type ArrivalResourceMix = Record<BatchCare, Record<string, number>>;
export const batchCareLabels: Record<BatchCare, string> = {
  discharge: "Discharge after assessment",
  ward: "Ward admission",
  icu: "ICU admission",
};

/** Resolve declared pathway/cohort/profile weights; this is an editable assumption,
 * not a resource reservation or an observation about any individual arrival. */
export function defaultArrivalResourceMix(
  dataset: Entity | null | undefined,
  entry: string,
): ArrivalResourceMix {
  const profiles: Entity[] = dataset?.resource_profiles || [];
  const cohorts: Entity[] = dataset?.cohorts || [];
  const pathway: Entity =
    (dataset?.pathway_profiles || []).find(
      (p: Entity) => p.entry_stream_id === entry,
    ) || {};
  const result: ArrivalResourceMix = { discharge: {}, ward: {}, icu: {} };
  for (const care of Object.keys(batchCareStages) as BatchCare[]) {
    const eligible = profiles.filter(
      (p) => p.stage_kind === batchCareStages[care],
    );
    const values: Record<string, number> = Object.fromEntries(
      eligible.map((p) => [p.resource_profile_id, 0]),
    );
    const careCohorts = cohorts.filter(
      (c) => c.care_level === (care === "discharge" ? "ambulatory" : care),
    );
    const configured: Array<number | Entity> | undefined =
      care === "discharge" ? undefined : pathway[`${care}_cohort_weights`];
    const choices =
      configured?.length && typeof configured[0] === "object"
        ? configured.map((item) => ({
            cohort: cohorts.find(
              (c) =>
                c.cohort_id === (item as Entity).cohort_id ||
                c.cohort_id === (item as Entity).cohort_template_id,
            ),
            weight: Number((item as Entity).weight),
          }))
        : careCohorts.map((cohort, index) => ({
            cohort,
            weight: Number(configured?.[index] ?? cohort.selection_weight),
          }));
    for (const { cohort, weight } of choices) {
      for (const profile of (cohort?.resource_profile_weights ||
        []) as Entity[]) {
        if (profile.resource_profile_id in values)
          values[profile.resource_profile_id] +=
            weight * Number(profile.weight);
      }
    }
    const total = Object.values(values).reduce((a, b) => a + b, 0);
    result[care] =
      total > 0
        ? Object.fromEntries(
            Object.entries(values).map(([id, value]) => [id, value / total]),
          )
        : values;
  }
  return result;
}

export function arrivalResourceMixError(
  dataset: Entity | null | undefined,
  mix: ArrivalResourceMix,
  careMix: Record<string, number>,
): string {
  if (
    Object.values(careMix).some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    Math.abs(Object.values(careMix).reduce((a, b) => a + b, 0) - 1) > 1e-6
  )
    return "Care disposition percentages must be nonnegative and total 100%.";
  const profiles: Entity[] = dataset?.resource_profiles || [];
  for (const care of Object.keys(batchCareStages) as BatchCare[]) {
    if (!(careMix[care] > 0)) continue;
    const values = mix[care];
    if (!values || !Object.keys(values).length)
      return `${batchCareLabels[care]} requires a declared resource profile mixture.`;
    if (
      Object.entries(values).some(
        ([id, value]) =>
          !Number.isFinite(value) ||
          value < 0 ||
          !profiles.some(
            (p) =>
              p.resource_profile_id === id &&
              p.stage_kind === batchCareStages[care],
          ),
      )
    )
      return `${batchCareLabels[care]} must use compatible profiles and nonnegative percentages.`;
    if (Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - 1) > 1e-6)
      return `${batchCareLabels[care]} resource profile percentages must total 100%.`;
  }
  return "";
}

export function activeArrivalResourceMix(
  mix: ArrivalResourceMix,
  careMix: Record<string, number>,
): Partial<ArrivalResourceMix> {
  return Object.fromEntries(
    (Object.keys(batchCareStages) as BatchCare[])
      .filter((care) => careMix[care] > 0)
      .map((care) => [care, { ...mix[care] }]),
  );
}
