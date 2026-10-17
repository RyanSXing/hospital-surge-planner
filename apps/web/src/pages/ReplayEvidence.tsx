import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import { api, fmt, localDate, patientId, unitId } from "../api";
import type { Entity, PlanningContext } from "../types";
import { Badge, BedGrid, BedLegend, Button, ErrorBox } from "../components/ui";
import { unitsOf, stateUnavailable } from "../model";
import { plannedReplayInterval } from "./patientProjection";
import {
  conditionReplayInterval,
  updateReplayInterval,
} from "./replayAnnotations";

const stamp = (at: string) =>
  localDate(at, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
const eventName = (value?: string) =>
  value?.replaceAll("_", " ") || "Recorded event";

export function ReplayEventWindow({
  rep,
  at,
  patient,
  cursor,
  onSelect,
}: {
  rep: string;
  at: string;
  patient: Entity | null;
  cursor: Entity | null;
  onSelect: (event: Entity) => void;
}) {
  const [type, setType] = useState("");
  const [onlyPatient, setOnlyPatient] = useState(false);
  const [pagination, setPagination] = useState({ scope: "", page: 0 });
  const selectedId = onlyPatient && patient ? patientId(patient) : "";
  const scope = JSON.stringify([rep, at, type, selectedId]);
  const page = pagination.scope === scope ? pagination.page : 0;
  const query = useQuery({
    queryKey: ["replay-event-window", rep, at, type, selectedId, page],
    enabled: Boolean(rep && at),
    queryFn: () => {
      const params = new URLSearchParams({
        at,
        limit: "20",
        cursor: String(page * 20),
      });
      if (type) params.set("event_type", type);
      if (selectedId) params.set("patient_id", selectedId);
      return api(`/runs/${rep}/events?${params}`);
    },
    staleTime: Infinity,
  });
  const events: Entity[] = query.data?.items || [];
  const types: string[] = query.data?.event_types || [];
  return (
    <div className="inspector-section event-feed" aria-busy={query.isFetching}>
      <div className="spread">
        <h3>Event window</h3>
        <Badge>{fmt(query.data?.total || 0)} matching</Badge>
      </div>
      {cursor && Date.parse(cursor.occurred_at) === Date.parse(at) ? (
        <div className="info-note">
          <strong>
            Event {cursor.sequence_number}: {eventName(cursor.event_type)}
          </strong>
          <p>
            Sequence controls include events sharing this timestamp. The state
            shown reflects all events at this instant.
          </p>
        </div>
      ) : null}
      <p className="small-copy muted">
        One hour before and after the selected timestamp. Every matching
        recorded event is available through the pages below.
      </p>
      <label className="replay-evidence-label">
        Event type
        <select
          aria-label="Replay event type filter"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All event types</option>
          {type && !types.includes(type) ? (
            <option value={type}>{eventName(type)} · no matches</option>
          ) : null}
          {types.map((value) => (
            <option key={value} value={value}>
              {eventName(value)} ({query.data?.event_type_counts?.[value] || 0})
            </option>
          ))}
        </select>
      </label>
      <label className="replay-patient-only">
        <input
          type="checkbox"
          checked={onlyPatient}
          disabled={!patient}
          onChange={(e) => setOnlyPatient(e.target.checked)}
        />
        Selected patient only
      </label>
      {query.error ? (
        <>
          <ErrorBox error={query.error.message} />
          <Button small onClick={() => void query.refetch()}>
            Retry event window
          </Button>
        </>
      ) : null}
      {query.isPending ? (
        <p role="status" className="small-copy muted">
          Loading recorded events…
        </p>
      ) : null}
      <div className="replay-event-list">
        {events.map((event) => (
          <button
            key={event.event_id || event.sequence_number}
            onClick={() => onSelect(event)}
          >
            <span className="event-time">
              {localDate(event.occurred_at, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <div>
              <strong>{eventName(event.event_type)}</strong>
              <small>
                #{event.sequence_number} ·{" "}
                {event.patient_id ||
                  event.reason_code ||
                  event.to_unit_id ||
                  "Resource state change"}
              </small>
            </div>
          </button>
        ))}
      </div>
      {!query.isPending && !events.length ? (
        <p className="small-copy muted">
          No matching events in this window. Change the filter or step to a
          recorded event.
        </p>
      ) : null}
      <div className="replay-event-pages">
        <span>
          {events.length ? page * 20 + 1 : 0}–{page * 20 + events.length} of{" "}
          {fmt(query.data?.total || 0)}
        </span>
        <div>
          <Button
            small
            aria-label="Previous replay event page"
            disabled={!page || query.isFetching}
            onClick={() => setPagination({ scope, page: page - 1 })}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button
            small
            aria-label="Next replay event page"
            disabled={!query.data?.next_cursor || query.isFetching}
            onClick={() => setPagination({ scope, page: page + 1 })}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ReplayPatientHistory({
  patient,
  at,
  cursor,
  onSelect,
}: {
  patient: Entity;
  at: string;
  cursor: Entity | null;
  onSelect: (event: Entity) => void;
}) {
  const ordered: Entity[] = useMemo(
    () =>
      [...(patient.events || [])].sort(
        (a, b) => a.sequence_number - b.sequence_number,
      ),
    [patient.events],
  );
  const instant = Date.parse(at);
  const selectedSequence =
    cursor?.patient_id === patientId(patient) &&
    Date.parse(cursor.occurred_at) === instant
      ? cursor.sequence_number
      : Infinity;
  const previous = ordered
    .filter(
      (event) =>
        Date.parse(event.occurred_at) < instant ||
        (Date.parse(event.occurred_at) === instant &&
          event.sequence_number <= selectedSequence),
    )
    .at(-1);
  const next = ordered.find(
    (event) =>
      Date.parse(event.occurred_at) > instant ||
      (Date.parse(event.occurred_at) === instant &&
        event.sequence_number > selectedSequence),
  );
  const notArrived = Date.parse(patient.arrival_at) > instant;
  const departed =
    patient.departure_at && Date.parse(patient.departure_at) <= instant;
  return (
    <div className="replay-patient-history">
      {notArrived || departed ? (
        <div className="info-note">
          {notArrived
            ? `Not yet arrived · ${stamp(patient.arrival_at)}`
            : `Discharged at ${stamp(patient.departure_at)}`}
        </div>
      ) : null}
      <h4>Recorded patient path</h4>
      <div className="replay-neighbor-events">
        {[
          ["Preceding event", previous],
          ["Next known event", next],
        ].map(([label, value]) => {
          const event = value as Entity | undefined;
          return (
            <div key={String(label)}>
              <span className="micro-label">{String(label)}</span>
              {event ? (
                <button className="link-button" onClick={() => onSelect(event)}>
                  {eventName(event.event_type)}
                  <small>
                    {stamp(event.occurred_at)} · #{event.sequence_number}
                  </small>
                </button>
              ) : (
                <p className="small-copy muted">
                  {label === "Preceding event"
                    ? "No earlier recorded event"
                    : "None recorded before the run horizon"}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <details>
        <summary>{ordered.length} recorded patient events</summary>
        <ol className="replay-care-path">
          {ordered.map((event) => (
            <li
              key={event.event_id || event.sequence_number}
              className={
                Date.parse(event.occurred_at) <= instant ? "recorded" : "future"
              }
            >
              <button className="link-button" onClick={() => onSelect(event)}>
                {eventName(event.event_type)}
                <small>
                  {stamp(event.occurred_at)} ·{" "}
                  {event.to_unit_id ||
                    event.from_unit_id ||
                    "System entry / exit"}
                </small>
              </button>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

export function ReplayRecordedCapacity({ ctx }: { ctx: PlanningContext }) {
  const [chosenUnit, setChosenUnit] = useState("");
  const [chosenSlot, setChosenSlot] = useState("");
  const [chosenEquipment, setChosenEquipment] = useState("");
  const [chosenVehicle, setChosenVehicle] = useState("");
  const units = unitsOf(ctx);
  const unit =
    units.find((value) => unitId(value) === chosenUnit) ||
    units.find((value) => unitId(value) === ctx.selectedPatient?.unit_id) ||
    units.find(
      (value) => value.kind === "ward" && value.facility_id === "FAC-MAIN",
    ) ||
    units[0];
  const slots: Entity[] = (ctx.state?.slots || []).filter(
    (value: Entity) =>
      value.unit_id === unitId(unit || {}) &&
      value.installation_status === "installed",
  );
  const slot = slots.find((value) => value.slot_id === chosenSlot);
  const policy = ctx.dataset?.capacity_policies?.find(
    (value: Entity) => value.capacity_policy_id === unit?.capacity_policy_id,
  );
  const equipment = Object.entries(unit?.equipment || {}) as [string, Entity][];
  const equipmentChoice =
    equipment.find(([capability]) => capability === chosenEquipment) ||
    equipment[0];
  const vehicles: Entity[] = ctx.state?.vehicles || [];
  const vehicle =
    vehicles.find((value) => value.vehicle_id === chosenVehicle) || vehicles[0];
  const vehicleMetadata = ctx.dataset?.vehicles?.find(
    (value: Entity) => value.vehicle_id === vehicle?.vehicle_id,
  );
  const recorded = (value: unknown) =>
    value === null || value === undefined ? "Not recorded" : fmt(Number(value));
  if (stateUnavailable(ctx) || !unit) return null;
  return (
    <div className="inspector-section replay-recorded-capacity">
      <h3>Recorded unit resources</h3>
      <label className="replay-evidence-label">
        Unit
        <select
          aria-label="Replay resource unit"
          value={unitId(unit)}
          onChange={(e) => {
            setChosenUnit(e.target.value);
            setChosenSlot("");
            setChosenEquipment("");
          }}
        >
          {units.map((value) => (
            <option key={unitId(value)} value={unitId(value)}>
              {value.name || value.unit_name || unitId(value)}
            </option>
          ))}
        </select>
      </label>
      <div className="spread small-copy">
        <span>Occupied / supported / physical</span>
        <strong>
          {unit.occupied} / {unit.staffed} / {unit.physical}
        </strong>
      </div>
      <div role="group" aria-label="Recorded unit capacity">
        {[
          ["Ready physical places", unit.ready],
          ["Available suitable places", unit.available],
          ["Reserved places", unit.reserved],
          ["Turnover / cleaning", unit.cleaning],
          ["Capacity deficit", unit.capacity_deficit],
        ].map(([label, value]) => (
          <div className="spread small-copy" key={String(label)}>
            <span>{label}</span>
            <strong>{recorded(value)}</strong>
          </div>
        ))}
      </div>
      <BedGrid
        compact
        physical={unit.physical}
        staffed={unit.staffed}
        occupied={unit.occupied}
        slots={slots}
        selectedSlot={chosenSlot}
        onSelectSlot={(value) => {
          setChosenSlot(value.slot_id);
          if (value.patient_id)
            ctx.setPatient({ patient_id: value.patient_id });
        }}
      />
      <BedLegend />
      {slot ? (
        <p className="small-copy">
          {slot.slot_id} · {eventName(slot.status)}
          {slot.cleaning_end_at
            ? ` · ready ${stamp(slot.cleaning_end_at)}`
            : ""}
          {slot.reservation_id ? ` · reserved for ${slot.reservation_id}` : ""}
        </p>
      ) : null}
      <div className="replay-assignment-counts">
        <Users size={15} aria-hidden="true" />
        <span>
          Assigned now:{" "}
          {Object.entries(unit.staff_by_role || {})
            .map(([role, count]) => `${count} ${role.replaceAll("_", " ")}`)
            .join(" · ") || "No active assignments"}
        </span>
      </div>
      <div className="spread small-copy">
        <span>Admission prerequisite gate</span>
        <Badge tone={unit.admission_gate ? "success" : "warning"}>
          {unit.admission_gate === undefined
            ? "Not recorded"
            : unit.admission_gate
              ? "Open"
              : "Closed"}
        </Badge>
      </div>
      {unit.active === false ? (
        <p className="small-copy">
          This unit is not active at the selected timestamp.
        </p>
      ) : null}
      {unit.capacity_mode === "advertised_aggregate" ? (
        <p className="small-copy muted">
          This partner unit uses its recorded published staffing capacity.
        </p>
      ) : policy ? (
        <p className="small-copy muted">
          Minimum team: {recorded(policy.minimum_provider_count)} qualified
          provider(s) · {recorded(policy.minimum_support_count)} support staff.
          {policy.slots_per_nurse !== undefined
            ? ` Up to ${policy.slots_per_nurse} places per qualified nurse.`
            : ""}
        </p>
      ) : (
        <p className="small-copy muted">
          Minimum team policy is not recorded for this unit.
        </p>
      )}
      <p className="small-copy muted">
        An open prerequisite gate still requires compatible nursing, equipment
        and ready places. Counts are from the selected recorded state.
      </p>
      {equipmentChoice ? (
        <>
          <label className="replay-evidence-label">
            Equipment capability
            <select
              aria-label="Replay equipment capability"
              value={equipmentChoice[0]}
              onChange={(event) => setChosenEquipment(event.target.value)}
            >
              {equipment.map(([capability]) => (
                <option key={capability} value={capability}>
                  {eventName(capability)}
                </option>
              ))}
            </select>
          </label>
          <div role="group" aria-label="Selected equipment inventory">
            {[
              ["Total quantity", equipmentChoice[1].quantity],
              ["In use", equipmentChoice[1].in_use],
              ["Reserved", equipmentChoice[1].reserved],
              ["Available", equipmentChoice[1].available],
              ["Deficit", equipmentChoice[1].deficit],
            ].map(([label, value]) => (
              <div className="spread small-copy" key={String(label)}>
                <span>{label}</span>
                <strong>{recorded(value)}</strong>
              </div>
            ))}
          </div>
          <p className="small-copy muted">
            Combined inventory for this capability in the selected unit.
            Individual pool identities are not part of this state snapshot.
          </p>
        </>
      ) : (
        <p className="small-copy muted">
          No equipment inventory is recorded for this unit.
        </p>
      )}
      {vehicle ? (
        <>
          <label className="replay-evidence-label">
            Transport resource
            <select
              aria-label="Replay transport vehicle"
              value={vehicle.vehicle_id}
              onChange={(event) => setChosenVehicle(event.target.value)}
            >
              {vehicles.map((value) => (
                <option key={value.vehicle_id} value={value.vehicle_id}>
                  {value.vehicle_id}
                </option>
              ))}
            </select>
          </label>
          <div
            role="group"
            aria-label="Selected transport resource"
            className="small-copy"
          >
            <p>
              <strong>
                {vehicle.mission
                  ? "Assigned"
                  : !vehicle.available_at
                    ? "Availability not recorded"
                    : Date.parse(vehicle.available_at) <=
                        Date.parse(ctx.state?.at || ctx.selectedTime)
                      ? "Available"
                      : "Awaiting availability"}
              </strong>
            </p>
            <p>
              Location:{" "}
              {ctx.dataset?.facilities?.find(
                (value) => value.facility_id === vehicle.location,
              )?.name ||
                vehicle.location ||
                "Not recorded"}
            </p>
            <p>
              Available at:{" "}
              {vehicle.available_at
                ? stamp(vehicle.available_at)
                : "Not recorded"}
            </p>
            {vehicleMetadata?.capabilities ? (
              <p>
                Capabilities:{" "}
                {vehicleMetadata.capabilities.map(eventName).join(" · ")}
              </p>
            ) : null}
            {vehicle.mission ? (
              <Button
                small
                onClick={() => ctx.setPatient({ patient_id: vehicle.mission })}
              >
                Inspect assigned patient {vehicle.mission}
              </Button>
            ) : (
              <p>No patient mission at this timestamp.</p>
            )}
          </div>
        </>
      ) : (
        <p className="small-copy muted">
          No transport resources are recorded in this state.
        </p>
      )}
    </div>
  );
}

export function ReplayAnnotations({
  rep,
  start,
  end,
  at,
  onSeek,
}: {
  rep: string;
  start: string;
  end: string;
  at: string;
  onSeek: (at: string) => void;
}) {
  const query = useQuery({
    queryKey: ["replay-annotations", rep],
    enabled: Boolean(rep),
    queryFn: () => api(`/runs/${rep}/annotations`),
    staleTime: Infinity,
  });
  const duration = Date.parse(end) - Date.parse(start);
  const base = Date.parse(start);
  const rows: { label: string; kind: string; intervals: Entity[] }[] = [
    {
      label: "Demand / care conditions",
      kind: "arrival",
      intervals: (query.data?.conditions || [])
        .filter(
          (value: Entity) =>
            !["staff_unavailability", "staff_absence"].includes(value.kind),
        )
        .map((value: Entity) => ({
          ...conditionReplayInterval(value, start, end),
          label: `${value.name || eventName(value.kind)}${value.kind === "arrival_batch" ? " · synthetic planned batch" : ""}`,
          planned: true,
        })),
    },
    {
      label: "Staffing changes",
      kind: "staff",
      intervals: (query.data?.conditions || [])
        .filter((value: Entity) =>
          ["staff_unavailability", "staff_absence"].includes(value.kind),
        )
        .map((value: Entity) => ({
          ...value,
          label: value.name || "Staff unavailable",
          planned: true,
        })),
    },
    {
      label: "Plans / reported updates",
      kind: "intervention",
      intervals: [
        ...(query.data?.planned_interventions || [])
          .filter((value: Entity) => value.enabled !== false)
          .map((value: Entity, index: number) =>
            plannedReplayInterval(value, index, start, end),
          ),
        ...(query.data?.intervention_results || []).map((value: Entity) => ({
          ...value,
          id: `recorded-${value.id || value.kind}`,
          start_at: value.ready_at || value.at,
          end_at: value.ready_at || value.at,
          label: `${eventName(value.kind)} · ${value.status || "recorded"}`,
        })),
        ...(query.data?.updates || []).map(updateReplayInterval),
      ],
    },
    {
      label: "Unmet inpatient demand",
      kind: "shortage",
      intervals: (query.data?.shortage_periods || []).map((value: Entity) => ({
        ...value,
        label: "Recorded inpatient placement queue",
      })),
    },
  ];
  return (
    <section
      className="replay-annotations"
      aria-label="Recorded replay timeline annotations"
    >
      <div className="spread">
        <h3>Run context and recorded pressure</h3>
        <span className="small-copy muted">
          Frozen revision · selected trajectory
        </span>
      </div>
      {query.error ? (
        <>
          <ErrorBox error={query.error.message} />
          <Button small onClick={() => void query.refetch()}>
            Retry run context
          </Button>
        </>
      ) : null}
      {query.isPending ? (
        <p role="status">Loading immutable run context…</p>
      ) : (
        rows.map((row) => (
          <div className="replay-annotation-row" key={row.kind}>
            <span className="small-copy">{row.label}</span>
            <div className={`replay-annotation-track ${row.kind}`}>
              <i
                className="replay-annotation-cursor"
                style={{
                  left: `${Math.max(0, Math.min(100, ((Date.parse(at) - base) / duration) * 100))}%`,
                }}
              />
              {row.intervals
                .filter(
                  (value) =>
                    Number.isFinite(Date.parse(value.start_at)) &&
                    Date.parse(value.end_at || value.start_at) >= base &&
                    Date.parse(value.start_at) <= Date.parse(end),
                )
                .map((value, index) => {
                  const from = Math.max(base, Date.parse(value.start_at));
                  const to = Math.min(
                    Date.parse(end),
                    Date.parse(value.end_at || value.start_at),
                  );
                  return (
                    <button
                      key={value.id || value.update_id || index}
                      className={value.planned ? "planned" : "recorded"}
                      style={{
                        left: `${((from - base) / duration) * 100}%`,
                        width: `${Math.max(0, ((to - from) / duration) * 100)}%`,
                      }}
                      title={`${value.label} · ${stamp(value.start_at)}${to > from ? ` to ${stamp(value.end_at)}` : ""}`}
                      aria-label={`${row.label}: ${value.label}, ${stamp(value.start_at)}`}
                      onClick={() => onSeek(new Date(from).toISOString())}
                    />
                  );
                })}
              {!row.intervals.length ? <small>None in this run</small> : null}
            </div>
          </div>
        ))
      )}
      <p className="small-copy muted">
        Dashed bands distinguish frozen planned assumptions from reported
        updates. Solid bands and markers show recorded outcomes. Select a band
        to inspect its start.
      </p>
      {(query.data?.intervention_results || [])
        .filter((value: Entity) => value.status === "infeasible")
        .map((value: Entity, index: number) => (
          <div className="info-note" key={value.id || index}>
            <strong>{eventName(value.kind)} · unmet prerequisites</strong>
            <p>
              {value.reason || "The required resources were unavailable."}
              {!value.ready_at && !value.at
                ? " No unique failure timestamp is recorded."
                : ""}
            </p>
          </div>
        ))}
    </section>
  );
}
