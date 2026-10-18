import type { Entity } from "../types";
import { humanLabel } from "../presentation";
import {
  batchCareLabels,
  batchCareStages,
  type ArrivalResourceMix,
  type BatchCare,
} from "./arrivalProfileWeights";

export function ArrivalResourceMixEditor({
  dataset,
  mix,
  careMix,
  onChange,
}: {
  dataset: Entity | null | undefined;
  mix: ArrivalResourceMix;
  careMix: Record<string, number>;
  onChange: (care: BatchCare, profileId: string, weight: number) => void;
}) {
  return (
    <section className="form-stack" aria-label="Arrival resource profiles">
      <h3>Patient care needs</h3>
      <p className="small-copy muted">
        Each group totals 100%. These declared profile mixtures describe this
        reported batch; capacity and equipment are allocated only when a patient
        can be placed. Ward and ICU profiles apply at inpatient admission.
      </p>
      {(Object.keys(batchCareStages) as BatchCare[])
        .filter((care) => careMix[care] > 0)
        .map((care) => {
          const profiles: Entity[] = (dataset?.resource_profiles || []).filter(
            (p: Entity) => p.stage_kind === batchCareStages[care],
          );
          const total =
            Object.values(mix[care]).reduce((a, b) => a + b, 0) * 100;
          return (
            <fieldset
              key={care}
              className="form-stack"
              style={{
                border: "1px solid var(--border)",
                padding: 12,
                borderRadius: 8,
              }}
            >
              <legend>
                {batchCareLabels[care]} · {Number(total.toFixed(6))}%
              </legend>
              {profiles.map((profile) => (
                <label key={profile.resource_profile_id}>
                  {humanLabel(profile.name)} (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    aria-label={`${batchCareLabels[care]} — ${humanLabel(profile.name)} (%)`}
                    value={Number(
                      (
                        (mix[care][profile.resource_profile_id] || 0) * 100
                      ).toFixed(6),
                    )}
                    onChange={(event) =>
                      onChange(
                        care,
                        profile.resource_profile_id,
                        Number(event.target.value) / 100,
                      )
                    }
                  />
                  <small className="muted">
                    {(profile.required_equipment || [])
                      .map(
                        (r: Entity) =>
                          `${humanLabel(r.capability_code)} ×${r.quantity}`,
                      )
                      .join(", ") || "No additional equipment"}
                  </small>
                </label>
              ))}
              {!profiles.length ? (
                <p role="alert">
                  No compatible declared profiles are available.
                </p>
              ) : null}
            </fieldset>
          );
        })}
    </section>
  );
}
