import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  MapPin,
  Route,
  Truck,
  Users,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt } from "../api";
import { patientsOf } from "../model";
import { Badge, Button, Modal } from "./ui";
export default function TransferPlanner({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const [care, setCare] = useState("ward"),
    [destination, setDestination] = useState(() =>
      ctx.selectedFacility !== "FAC-MAIN" ? ctx.selectedFacility : "FAC-EAST",
    ),
    [limit, setLimit] = useState(4),
    [when, setWhen] = useState(ctx.selectedTime.slice(0, 16)),
    [expiry, setExpiry] = useState(120),
    [includeInpatients, setIncludeInpatients] = useState(false),
    [eligibility, setEligibility] = useState<Entity | null>(null),
    [error, setError] = useState("");
  const units = (ctx.dataset?.units || []).filter(
      (u) => u.facility_id === destination && u.kind === care,
    ),
    route = (ctx.dataset?.routes || []).find(
      (r: Entity) =>
        r.from_facility_id === "FAC-MAIN" && r.to_facility_id === destination,
    ),
    vehicles = ctx.state?.vehicles || ctx.dataset?.vehicles || [];
  const groupMatches = (patient: Entity) =>
    patient.facility_id === "FAC-MAIN" &&
    (patient.target_unit_kind || patient.care_level) === care &&
    patient.eligible_for_transfer !== false &&
    !["transfer_reserved", "in_transit", "discharged"].includes(
      patient.state,
    ) &&
    (patient.admission_pending ||
      ["ed_boarding", "direct_waiting"].includes(patient.state) ||
      (includeInpatients && patient.state === "inpatient"));
  const groupSize = ctx.state?.patient_groups
    ? ctx.state.patient_groups
        .filter(groupMatches)
        .reduce((total: number, group: Entity) => total + group.count, 0)
    : patientsOf(ctx).filter(groupMatches).length;
  const replicationId =
    ctx.activeReplicationId || ctx.run?.selected_replication_id;
  useEffect(() => {
    setEligibility(null);
    setError("");
    api(
      `/sites/${destination}/eligibility?scenario_id=${ctx.scenario?.id}&care_level=${care}&at=${encodeURIComponent(`${when}:00Z`)}${replicationId ? `&replication_id=${encodeURIComponent(replicationId)}` : ""}`,
    )
      .then(setEligibility)
      .catch((e) => setError(e.message));
  }, [care, destination, when, replicationId, ctx.scenario?.id]);
  return (
    <Modal title="Plan a bounded partner transfer" wide onClose={onClose}>
      <div className="transfer-layout">
        <div className="form-stack">
          <div className="info-note">
            A proposed transfer acquires a receiving reservation and compatible
            transport. Source resources remain occupied until pickup.
          </div>
          <label>
            Patient group
            <select value={care} onChange={(e) => setCare(e.target.value)}>
              <option value="ward">Ward-level placement requests</option>
              <option value="icu">ICU-level placement requests</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeInpatients}
              onChange={(e) => setIncludeInpatients(e.target.checked)}
            />
            Also consider already admitted patients
          </label>
          <label>
            Receiving facility
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              {(ctx.dataset?.facilities || [])
                .filter((f) => (f.facility_id || f.id) !== "FAC-MAIN")
                .map((f) => (
                  <option
                    key={f.facility_id || f.id}
                    value={f.facility_id || f.id}
                  >
                    {f.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="two-fields">
            <label>
              Maximum patients
              <input
                type="number"
                min="1"
                max="100"
                value={limit}
                onChange={(e) => setLimit(+e.target.value)}
              />
            </label>
            <label>
              Reservation expiry (min)
              <input
                type="number"
                min="10"
                max="1440"
                value={expiry}
                onChange={(e) => setExpiry(+e.target.value)}
              />
            </label>
          </div>
          <label>
            Earliest request time (UTC)
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
        </div>
        <div className="transfer-preview">
          <span className="eyebrow">DECLARED CAPABILITY CHECK</span>
          <h3>{eligibility?.site?.name || "Checking destination"}</h3>
          {eligibility ? (
            <Badge tone={eligibility.eligible ? "success" : "warning"}>
              {eligibility.eligible
                ? "Prerequisites declared"
                : "Constraints require attention"}
            </Badge>
          ) : null}
          {eligibility?.reasons?.map((r: string) => (
            <p key={r} className="amber small-copy">
              {r}
            </p>
          ))}
          {error ? <p className="red small-copy">{error}</p> : null}
          <dl className="detail-list">
            <div>
              <dt>Group at displayed replay time</dt>
              <dd>{groupSize} patients</dd>
            </div>
            <div>
              <dt>Directed travel</dt>
              <dd>
                {route
                  ? `${route.travel_minutes} minutes`
                  : "Route unavailable"}
              </dd>
            </div>
            <div>
              <dt>Loading / unloading</dt>
              <dd>
                {route?.loading_minutes ?? "—"} /{" "}
                {route?.unloading_minutes ?? "—"} min
              </dd>
            </div>
            <div>
              <dt>Transport inventory</dt>
              <dd>{vehicles.length} vehicles</dd>
            </div>
            <div>
              <dt>Receiving unit</dt>
              <dd>{units[0]?.name || "Incompatible"}</dd>
            </div>
          </dl>
          <div className="constraint-callout">
            <Clock3 size={15} />
            <div>
              <strong>Repositioning and turnaround count</strong>
              <p>
                Vehicle location, incoming reservations, patient requirements,
                and availability are checked again by the simulation.
              </p>
            </div>
          </div>
          <p className="small-copy muted">
            Travel and partner capabilities are assumptions from the synthetic
            dataset. No dispatch is performed by saving this plan.
          </p>
        </div>
      </div>
      <div className="wizard-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          primary
          disabled={
            ctx.canWrite === false ||
            !!ctx.busy ||
            !route ||
            !units.length ||
            !eligibility?.eligible
          }
          onClick={() =>
            ctx.action("Saving proposed transfer plan", async () => {
              const plan = {
                id: crypto.randomUUID(),
                kind: "partner_transfer",
                name: `${care.toUpperCase()} transfers to ${eligibility?.site?.name}`,
                destination_unit_id: units[0].unit_id,
                start_at: new Date(`${when}:00Z`).toISOString(),
                max_patients: limit,
                reservation_expiry_minutes: expiry,
                patient_eligibility_filter: { care_levels: [care] },
                include_inpatients: includeInpatients,
              };
              const s = await ctx.saveScenario({
                interventions: [...(ctx.scenario?.interventions || []), plan],
              });
              if (s) {
                ctx.notify(
                  "Transfer plan saved. Run the scenario to evaluate reservations and movement.",
                );
                onClose();
              }
            })
          }
        >
          Save proposed transfer plan <ArrowRight size={14} />
        </Button>
      </div>
    </Modal>
  );
}
