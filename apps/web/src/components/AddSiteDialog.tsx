import { NativeSelect } from "@mantine/core";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { ApiError, api, patch, post } from "../api";
import { Button, ErrorBox, Modal } from "./ui";
import { planningEnd } from "../pages/scenarioEditor";
export default function AddSiteDialog({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const [name, setName] = useState(""),
    [type, setType] = useState("clinic"),
    [capacity, setCapacity] = useState(12),
    [delay, setDelay] = useState(6),
    [latitude, setLatitude] = useState(36.148),
    [longitude, setLongitude] = useState(-86.806),
    [travel, setTravel] = useState(15),
    [ratio, setRatio] = useState(4),
    [providers, setProviders] = useState(1),
    [support, setSupport] = useState(1),
    [source, setSource] = useState(
      "User-declared fictional planning candidate",
    ),
    [notes, setNotes] = useState(""),
    [error, setError] = useState(""),
    [fields, setFields] = useState<Entity[]>([]),
    [saving, setSaving] = useState(false),
    [draft, setDraft] = useState<Entity | null>(null),
    [siteId] = useState(`FAC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  async function save() {
    setSaving(true);
    setError("");
    setFields([]);
    try {
      let current: Entity =
        draft ||
        (await post<Entity>("/dataset-drafts", {
          source_dataset_version_id: ctx.dataset?.id,
          name: `${ctx.dataset?.fixture || "Dataset"} + ${name}`,
        }));
      setDraft(current);
      const unit = `UNIT-${siteId}`,
        policy = `POL-${siteId}`,
        capability =
          type === "shelter" ? "SHELTER_ONLY" : `${type.toUpperCase()}_CARE`,
        basePolicy =
          (ctx.dataset?.capacity_policies || []).find(
            (p: Entity) => p.unit_kind === type,
          ) || {};
      const declarations = {
        staffing: {
          slots_per_nurse: ratio,
          minimum_provider_count: type === "shelter" ? 0 : providers,
          minimum_support_count: type === "shelter" ? 0 : support,
        },
        equipment:
          type === "clinic"
            ? [{ capability_code: "CLINIC_KIT", quantity_per_place: 1 }]
            : [],
        notes,
      };
      const entities: Entity[] = [
        {
          collection: "facilities",
          entity: {
            id: siteId,
            facility_id: siteId,
            organization_id:
              ctx.dataset?.organization_id ||
              ctx.dataset?.facilities[0]?.organization_id,
            name,
            kind: type === "ward" ? "ward_overflow" : type,
            synthetic: true,
            status: "candidate",
            latitude,
            longitude,
            location_quality: "synthetic_approximate",
            activation_minutes: delay * 60,
            acceptance_mode: "internal",
            capabilities: [capability],
            resource_requirements: declarations,
            source,
            provenance: {
              source_type: "user_planning_assumption",
              description: source,
              notes,
              recorded_at: new Date().toISOString(),
            },
          },
        },
        {
          collection: "capacity_policies",
          entity: {
            ...basePolicy,
            capacity_policy_id: policy,
            unit_kind: type,
            nurse_capability: `${type.toUpperCase()}_NURSING`,
            slots_per_nurse: ratio,
            minimum_provider_count: type === "shelter" ? 0 : providers,
            minimum_support_count: type === "shelter" ? 0 : support,
            is_demonstration_assumption: true,
            source,
          },
        },
        {
          collection: "units",
          entity: {
            id: unit,
            unit_id: unit,
            facility_id: siteId,
            name: `${name} ${type}`,
            kind: type,
            physical_capacity: type === "ward" ? 0 : capacity,
            staffed_capacity: 0,
            enabled_capacity: 0,
            capacity_policy_id: policy,
            capabilities: [capability],
            background_occupied: 0,
            capacity_mode: "staff_derived",
            advertised_staffed_capacity: null,
            turnover_minutes: type === "clinic" ? 10 : type === "ward" ? 30 : 0,
            baseline_staff: { rn: 0, provider: 0, support: 0 },
          },
        },
        {
          collection: "geometry",
          entity: {
            unit_id: unit,
            facility_id: siteId,
            x: 0.2,
            y: 0.2,
            width: 0.6,
            height: 0.6,
            label: name,
          },
        },
      ];
      // On retry, replace the draft's prior candidate slots so reducing capacity
      // cannot leave hidden old inventory behind.
      if (draft) {
        const saved = await api(`/dataset-drafts/${draft.id}`),
          data = saved.dataset || saved;
        for (const slot of data.slots || [])
          if (slot.unit_id === unit)
            entities.push({
              collection: "slots",
              action: "delete",
              id: slot.slot_id,
            });
      }
      for (let i = 0; i < capacity; i++)
        entities.push({
          collection: "slots",
          entity: {
            slot_id: `SLOT-${siteId}-${i}`,
            unit_id: unit,
            slot_kind:
              type === "clinic"
                ? "clinic_space"
                : type === "shelter"
                  ? "shelter_space"
                  : "ward_bed",
            installation_status: type === "ward" ? "planned" : "installed",
            enabled: false,
            capabilities: [capability],
            display_label: String(i + 1),
            layout_x: ((i % 10) + 1) / 11,
            layout_y: (Math.floor(i / 10) + 1) / (Math.ceil(capacity / 10) + 1),
          },
        });
      for (const other of ctx.dataset?.facilities || []) {
        const target = other.facility_id || other.id;
        for (const [from, to] of [
          [siteId, target],
          [target, siteId],
        ])
          entities.push({
            collection: "routes",
            entity: {
              route_id: `ROUTE-${from}-${to}`,
              from_facility_id: from,
              to_facility_id: to,
              travel_minutes: travel,
              loading_minutes: 10,
              unloading_minutes: 10,
              estimate_source: "manual",
              source,
              effective_at: ctx.dataset?.snapshot_at,
            },
          });
      }
      if (type === "clinic") {
        const service =
          (ctx.dataset?.los_templates || []).find(
            (t: Entity) => t.template_id === "CLINIC-SERVICE",
          ) ||
          (ctx.dataset?.los_templates || []).find(
            (t: Entity) => t.stage_kind === "clinic_service",
          );
        if (!service)
          throw new Error(
            "The dataset needs a declared clinic service-duration template before adding this clinic.",
          );
        entities.push({
          collection: "clinic_policies",
          entity: {
            clinic_policy_id: `POLICY-${siteId}`,
            site_id: siteId,
            service_template_id: service.template_id,
            eligibility_tag: "eligible_for_clinic_diversion",
            routing_mode: "new_arrivals_only",
            hospital_fallback: true,
            transport_required: false,
            admission_start_at: ctx.dataset?.snapshot_at,
            admission_end_at: planningEnd(
              ctx.scenario,
              ctx.scenario?.start_at || ctx.dataset?.snapshot_at || "",
              ctx.scenario?.horizon_calendar_days || 30,
            ),
            drain_after_close: true,
          },
        });
      }
      for (let i = 0; i < entities.length; i += 400) {
        current = await patch(
          `/dataset-drafts/${current.id}/entities`,
          {
            operations: entities
              .slice(i, i + 400)
              .map((e) => ({ action: "upsert", ...e })),
          },
          current.revision,
        );
        setDraft(current);
      }
      const validation = await post(`/dataset-drafts/${current.id}/validate`);
      if (!validation.valid) {
        setFields(validation.errors || []);
        throw new Error(
          "Candidate validation found issues. The draft is preserved for repair.",
        );
      }
      const committed = await post(
        `/dataset-drafts/${current.id}/commit`,
        {},
        current.revision,
      );
      await ctx.loadDataset(committed.id);
      ctx.setFacility(siteId);
      ctx.notify(
        "Candidate inventory saved with its requirements and source. Schedule resource activation separately.",
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError) setFields(e.details);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Add a candidate site" wide onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error ? <ErrorBox error={error} /> : null}
        {fields.length ? (
          <div className="constraint-callout">
            {fields.map((e, i) => (
              <p key={i}>
                <strong>{e.field || e.path || e.column}</strong> {e.message}
              </p>
            ))}
          </div>
        ) : null}
        <div className="two-fields">
          <label>
            Site name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Capability
            <NativeSelect aria-label="Capability"
              disabled={!!draft}
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="clinic">Outpatient clinic</option>
              <option value="ward">Inpatient ward overflow</option>
              <option value="shelter">Nonclinical shelter</option>
            </NativeSelect>
          </label>
        </div>
        <div className="two-fields">
          <label>
            {type === "ward"
              ? "Planned beds"
              : "Installed treatment / shelter places"}
            <input
              required
              type="number"
              min={1}
              max={500}
              value={capacity}
              onChange={(e) => setCapacity(+e.target.value)}
            />
          </label>
          <label>
            Setup lead time (hours)
            <input
              required
              type="number"
              min={0}
              max={8784}
              step={0.25}
              value={delay}
              onChange={(e) => setDelay(+e.target.value)}
            />
          </label>
        </div>
        {type !== "shelter" ? (
          <>
            <h3>Staffing policy and requirements</h3>
            <div className="three-fields">
              <label>
                Places per qualified nurse
                <input
                  required
                  type="number"
                  min={1}
                  max={50}
                  value={ratio}
                  onChange={(e) => setRatio(+e.target.value)}
                />
              </label>
              <label>
                Minimum provider gate
                <input
                  required
                  type="number"
                  min={0}
                  max={100}
                  value={providers}
                  onChange={(e) => setProviders(+e.target.value)}
                />
              </label>
              <label>
                Minimum support gate
                <input
                  required
                  type="number"
                  min={0}
                  max={100}
                  value={support}
                  onChange={(e) => setSupport(+e.target.value)}
                />
              </label>
            </div>
            <p className="small-copy muted">
              The provider and support minimums are admission gates. They do not
              change the nurse-to-place ratio.{" "}
              {type === "clinic"
                ? "Each enabled clinic place also requires one allocated clinic kit; no inpatient or ICU care is offered."
                : "Ward placements still require their individual equipment profiles."}
            </p>
          </>
        ) : (
          <p className="info-note">
            Shelter capacity is nonclinical and cannot replace inpatient or ICU
            capacity.
          </p>
        )}
        <div className="two-fields">
          <label>
            Latitude
            <input
              required
              type="number"
              min={-90}
              max={90}
              step="any"
              value={latitude}
              onChange={(e) => setLatitude(+e.target.value)}
            />
          </label>
          <label>
            Longitude
            <input
              required
              type="number"
              min={-180}
              max={180}
              step="any"
              value={longitude}
              onChange={(e) => setLongitude(+e.target.value)}
            />
          </label>
        </div>
        <label>
          Assumed directed travel to / from other sites (minutes)
          <input
            required
            type="number"
            min={1}
            max={1440}
            value={travel}
            onChange={(e) => setTravel(+e.target.value)}
          />
        </label>
        <label>
          Source / provenance
          <input
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
        <label>
          Requirements and uncertainty notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Supply, readiness or travel assumptions that need verification"
          />
        </label>
        <div className="info-note">
          Creates a fictional candidate and a dedicated capacity policy in a new
          immutable dataset version. Resource inventory is allocated only when a
          response is separately planned.
        </div>
        {draft ? (
          <p className="small-copy muted">
            Working draft: {draft.id} · revision {draft.revision}
          </p>
        ) : null}
        <div className="wizard-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            primary
            type="submit"
            disabled={ctx.canWrite === false || saving}
          >
            {saving ? "Validating and saving…" : "Save candidate inventory"}
            <ArrowRight size={15} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
