import { useEffect, useState } from "react";
import { NativeSelect } from "@mantine/core";
import type { Dataset, Entity } from "../types";
import { api, atDay, fmt, localDate } from "../api";
import { Button, ErrorBox, Modal } from "../components/ui";
import { ZonedDateTimeInput } from "../components/ZonedDateTimeInput";
import {
  familyOf,
  planInterval,
  recordId,
  plannedEvent,
  selectStaff,
  capacityFacts,
  withPlan,
  withoutPlan,
  readinessError,
  inferMixBasis,
  mixForBasis,
  shiftKey,
  equipmentBeforeEvent,
  equipmentLimit,
} from "./scenarioPlans";
import type {
  PlanCollection,
  PlanDraft,
  PlanFamily,
  PlanSelection,
} from "./scenarioPlans";
export const planFamilies: [PlanFamily, string, string][] = [
  ["cohort", "Patient care needs", "Choose the care new patients need"],
  ["staff", "Staff availability", "Adjust staffing for a unit or shift"],
  ["capacity", "Hospital beds", "Change available beds or add nurses"],
  ["equipment", "Equipment", "Adjust equipment availability"],
  [
    "sites",
    "Sites & transfers",
    "Activate a site or schedule eligible transfers",
  ],
  [
    "incident",
    "Extra patient arrivals",
    "Schedule an additional group of patients",
  ],
];
const friendly = (value: string) =>
  ({
    "RP-ED-BASIC": "Emergency care · usual needs",
    "RP-ED-MONITORED": "Emergency care · monitoring",
    "RP-WARD-BASIC": "Ward care · usual needs",
    "RP-WARD-OXYGEN": "Ward care · oxygen",
    "RP-ICU-MONITORED": "Intensive care · monitoring",
    "RP-ICU-VENTILATED": "Intensive care · ventilation",
    "COHORT-WARD-SHORT": "Ward · short stay",
    "COHORT-WARD-STANDARD": "Ward · usual stay",
    "COHORT-WARD-EXTENDED": "Ward · longer stay",
    "COHORT-ICU-STANDARD": "Intensive care · usual stay",
    "COHORT-ICU-EXTENDED": "Intensive care · longer stay",
    "COHORT-ED": "Emergency assessment",
    rn: "Registered nurse",
    provider: "Provider",
    support: "Support staff",
    discharge: "Go home after assessment",
    ward: "Ward admission",
    icu: "Intensive care",
    ambulatory: "Outpatient care",
    OXYGEN: "Oxygen equipment",
    ICU_MONITOR: "ICU monitors",
    VENTILATOR: "Ventilators",
    ED_MONITOR: "Emergency monitors",
    ISOLATION: "Isolation equipment",
    TRANSPORT: "Transport equipment",
  })[value] ||
  value
    .replace(/^(COHORT|PROFILE|EQ|POOL|TEAM)[-_]/i, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toLowerCase()
    .replace(/^./, (x) => x.toUpperCase());
const streamName = (id: string) =>
  id === "ED_MAIN"
    ? "Emergency department"
    : id === "DIRECT_WARD_MAIN"
      ? "Direct hospital admissions"
      : "Hospital arrivals";
const titleFor = (f: PlanFamily) => planFamilies.find((v) => v[0] === f)![1];
const utcInput = (s: string) =>
  s ? new Date(s).toISOString().slice(0, 16) : "";
const isoInput = (s: string) => (s ? new Date(s + "Z").toISOString() : "");
export interface PlanEditorRequest {
  family: PlanFamily;
  nonce: number;
}
export default function ScenarioTracks({
  dataset,
  draft,
  start,
  end,
  canWrite,
  request,
  timeZone = dataset.timezone,
  onChange,
  onRequestHandled,
}: {
  dataset: Dataset;
  draft: PlanDraft;
  start: string;
  end: string;
  canWrite: boolean;
  request: PlanEditorRequest | null;
  timeZone?: string;
  onChange: (next: PlanDraft) => void;
  onRequestHandled?: () => void;
}) {
  const [editing, setEditing] = useState<{
    family: PlanFamily;
    selection: PlanSelection | null;
    value?: Entity;
  } | null>(null);
  useEffect(() => {
    if (request) {
      setEditing({ family: request.family, selection: null });
      onRequestHandled?.();
    }
  }, [request]);
  const rows = (Object.keys(draft) as PlanCollection[]).flatMap((collection) =>
    draft[collection].map((value, index) => ({
      collection,
      value,
      index,
      family: familyOf(value, collection, dataset),
    })),
  );
  return (
    <div className="scenario-plan-tracks">
      {planFamilies
        .filter(([family]) => family !== "sites")
        .map(([family, title, description]) => {
          const selectedRows = rows.filter((row) => row.family === family);
          return (
            <section
              className="optional-change-group"
              key={family}
              aria-label={title}
            >
              <div className="optional-change-heading">
                <div>
                  <h4>{title}</h4>
                  <p>{description}</p>
                </div>
                <Button
                  small
                  disabled={!canWrite}
                  aria-label={"Add " + title.toLowerCase()}
                  onClick={() => setEditing({ family, selection: null })}
                >
                  Add
                </Button>
              </div>
              {selectedRows.length > 0 && (
                <div className="optional-change-list">
                  {selectedRows.map(({ collection, value, index }) => {
                    const interval = planInterval(value, start, end);
                    const observed =
                      collection === "updates" &&
                      value.input_kind !== "planned_assumption";
                    return (
                      <button
                        className="optional-change-row"
                        key={recordId(value) || `${collection}-${index}`}
                        onClick={() =>
                          setEditing({
                            family,
                            selection: {
                              collection,
                              id: recordId(value),
                              index,
                            },
                            value,
                          })
                        }
                        aria-label={`${value.name || title} ${observed ? "Recorded input" : "Planning assumption"}`}
                      >
                        <span>
                          <strong>{value.name || title}</strong>
                          <small>
                            {localDate(interval.start, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone,
                            })}
                            {interval.end !== interval.start
                              ? ` – ${localDate(interval.end, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })}`
                              : ""}
                          </small>
                        </span>
                        <span>{observed ? "View" : "Edit"}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      {editing && (
        <PlanForm
          key={editing.selection?.id || `${editing.family}-${request?.nonce}`}
          {...editing}
          dataset={dataset}
          updates={draft.updates}
          timeZone={timeZone}
          start={start}
          end={end}
          canWrite={canWrite}
          onClose={() => setEditing(null)}
          onSave={(collection, value) => {
            onChange(withPlan(draft, editing.selection, collection, value));
            setEditing(null);
          }}
          onDelete={() => {
            if (editing.selection)
              onChange(withoutPlan(draft, editing.selection));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
function PlanForm({
  family,
  selection,
  value,
  dataset,
  updates,
  timeZone,
  start,
  end,
  canWrite,
  onClose,
  onSave,
  onDelete,
}: {
  family: PlanFamily;
  selection: PlanSelection | null;
  value?: Entity;
  dataset: Dataset;
  updates: Entity[];
  timeZone: string;
  start: string;
  end: string;
  canWrite: boolean;
  onClose: () => void;
  onSave: (collection: PlanCollection, value: Entity) => void;
  onDelete: () => void;
}) {
  const payload = value?.payload || value || {};
  const defaultUnit =
    dataset.units.find(
      (u) =>
        u.facility_id === "FAC-MAIN" &&
        u.kind === (family === "sites" ? "clinic" : "ward") &&
        (family === "sites" || u.capacity_mode === "staff_derived"),
    ) || dataset.units[0];
  const [name, setName] = useState(value?.name || titleFor(family));
  const initialKind =
    value?.kind ||
    value?.template_kind ||
    value?.type ||
    {
      staff: "staff_unavailability",
      capacity: "capacity_change",
      equipment: "equipment_change",
      sites: "clinic",
      incident: "arrival_batch",
      cohort: "care_mix_override",
    }[family];
  const [kind, setKind] = useState(
    initialKind === "activate_overflow" ? "staffed_overflow" : initialKind,
  );
  const [at, setAt] = useState(
    value?.effective_at || value?.at || value?.start_at || start,
  );
  const [until, setUntil] = useState(
    value?.end_at ||
      payload.until ||
      (family === "staff" ? atDay(start, 1, 0, timeZone) : end),
  );
  const [unit, setUnit] = useState(
    payload.unit_id ||
      value?.editor?.unit_id ||
      dataset.staff.find((s) => (payload.staff_ids || []).includes(s.staff_id))
        ?.home_unit_id ||
      value?.destination_unit_id ||
      defaultUnit?.unit_id ||
      "",
  );
  const [role, setRole] = useState(
    value?.editor?.role ||
      dataset.staff.find((s) => (payload.staff_ids || []).includes(s.staff_id))
        ?.role ||
      "rn",
  );
  const [staffMode, setStaffMode] = useState(value?.editor?.mode || "named");
  const [amount, setAmount] = useState(value?.editor?.amount ?? 20);
  const [staffIds, setStaffIds] = useState<string[]>(
    payload.staff_ids || value?.assigned_staff_ids || [],
  );
  const [schedule, setSchedule] = useState<Entity[]>([]),
    [scheduleError, setScheduleError] = useState(""),
    [scheduleLoading, setScheduleLoading] = useState(false),
    [shift, setShift] = useState(value?.editor?.shift || "");
  const [quantity, setQuantity] = useState(
    payload.enabled_capacity ??
      payload.advertised_staffed_capacity ??
      payload.quantity ??
      (family === "equipment" && payload.quantity_delta != null
        ? Math.abs(payload.quantity_delta)
        : undefined) ??
      value?.enabled_slots ??
      (family === "incident"
        ? (payload.count ?? 20)
        : family === "sites"
          ? 8
          : 1),
  );
  const [pool, setPool] = useState(
    payload.equipment_pool_id ||
      payload.pool_id ||
      dataset.equipment_pools[0]?.equipment_pool_id ||
      "",
  );
  const [operation, setOperation] = useState(
    payload.operation ||
      (value
        ? (payload.quantity_delta ?? 0) >= 0
          ? "add"
          : "decommission"
        : "fail"),
  );
  const equipmentBefore = equipmentBeforeEvent(
    dataset,
    updates,
    pool,
    at,
    selection,
  );
  const equipmentMaximum = equipmentLimit(equipmentBefore, operation);
  const [route, setRoute] = useState(
    payload.route_id || dataset.routes?.[0]?.route_id || "",
  );
  const [travel, setTravel] = useState(
    payload.travel_minutes ?? dataset.routes?.[0]?.travel_minutes ?? 30,
  );
  const [routeUnavailable, setRouteUnavailable] = useState(
    !!payload.unavailable,
  );
  const [nurses, setNurses] = useState(value?.nurses ?? 2),
    [providers, setProviders] = useState(value?.providers ?? 1),
    [support, setSupport] = useState(value?.support ?? 1);
  const [staffSource, setStaffSource] = useState(
    value?.assigned_staff_ids ? "named" : "rotating",
  );
  const [delay, setDelay] = useState(
    value?.activation_minutes ?? (family === "sites" ? 360 : 0),
  );
  const [allocations, setAllocations] = useState<Record<string, number>>(
    Object.fromEntries(
      (value?.equipment_allocations || []).map((p: Entity) => [
        p.equipment_pool_id,
        p.quantity,
      ]),
    ),
  );
  const [stream, setStream] = useState(
    payload.entry_stream_id ||
      dataset.entry_streams?.[0]?.entry_stream_id ||
      "ED_MAIN",
  );
  const [spread, setSpread] = useState(payload.spread_minutes || 0);
  const [mix, setMix] = useState<Record<string, number>>(
    payload.care_mix ||
      payload.care_mix_override ||
      payload.weights || { discharge: 0.8, ward: 0.16, icu: 0.04 },
  );
  const [mixKind, setMixKind] = useState(inferMixBasis(dataset, mix));
  const [maxPatients, setMaxPatients] = useState(value?.max_patients ?? 10),
    [care, setCare] = useState(
      value?.patient_eligibility_filter?.care_levels?.[0] || "ward",
    ),
    [includeInpatients, setIncludeInpatients] = useState(
      !!value?.include_inpatients,
    ),
    [expiry, setExpiry] = useState(value?.reservation_expiry_minutes ?? 120);
  const [error, setError] = useState("");
  const observed =
    selection?.collection === "updates" &&
    value?.input_kind !== "planned_assumption";
  const selectedUnit = dataset.units.find((u) => u.unit_id === unit),
    facts = capacityFacts(dataset, unit);
  const matchingStaff = dataset.staff.filter(
    (s) => s.role === role && s.home_unit_id === unit,
  );
  const shifts = [
    ...new Map(
      schedule.map((a) => [
        shiftKey(a),
        { id: shiftKey(a), start: a.start_at, end: a.end_at },
      ]),
    ).values(),
  ];
  const chosenStaff =
    staffMode === "named"
      ? staffIds
      : (() => {
          try {
            return selectStaff(
              schedule,
              dataset.staff,
              role,
              shift,
              staffMode,
              amount,
            );
          } catch {
            return [];
          }
        })();
  useEffect(() => {
    if (family !== "staff" || !unit || !at || !until) return;
    let canceled = false;
    setScheduleLoading(true);
    setScheduleError("");
    (async () => {
      try {
        let cursor: string | null = null,
          rows: Entity[] = [];
        do {
          const params = new URLSearchParams({
            at,
            end_at: until,
            role,
            limit: "500",
          });
          if (cursor) params.set("cursor", cursor);
          const response = await api(
            `/datasets/${dataset.id}/units/${unit}/schedule?${params}`,
          );
          rows.push(...response.assignments);
          cursor = response.next_cursor || null;
        } while (cursor && !canceled);
        if (!canceled) {
          setSchedule(rows);
          setShift((current: string) =>
            rows.some((r) => shiftKey(r) === current)
              ? current
              : rows[0]
                ? shiftKey(rows[0])
                : "",
          );
        }
      } catch (e) {
        if (!canceled) setScheduleError((e as Error).message);
      } finally {
        if (!canceled) setScheduleLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [family, dataset.id, unit, role, at, until]);
  const changeKind = (next: string) => {
    setKind(next);
    const target = dataset.units
      .filter((u) => u.facility_id === "FAC-MAIN")
      .find((u) =>
        next === "clinic"
          ? u.kind === "clinic"
          : next === "partner_transfer"
            ? u.capacity_mode === "advertised_aggregate" && u.kind === care
            : next === "advertised_capacity_change"
              ? u.capacity_mode === "advertised_aggregate"
              : u.kind === "ward" &&
                (next === "physical_overflow" || next === "staffed_overflow"
                  ? dataset.slots.some(
                      (slot) =>
                        slot.unit_id === u.unit_id &&
                        slot.installation_status === "planned",
                    )
                  : u.capacity_mode === "staff_derived"),
      );
    if (target) {
      setUnit(target.unit_id);
      if (next === "physical_overflow" || next === "staffed_overflow")
        setQuantity(
          dataset.slots.filter((slot) => slot.unit_id === target.unit_id)
            .length,
        );
    }
    setDelay(
      next === "clinic"
        ? 360
        : ["physical_overflow", "staffed_overflow"].includes(next)
          ? 720
          : 0,
    );
  };
  function save() {
    try {
      if (
        !at ||
        Date.parse(at) < Date.parse(start) ||
        Date.parse(at) >= Date.parse(end)
      )
        throw new Error(
          "The effective time must lie within the scenario horizon.",
        );
      const interval =
        ["staff", "cohort", "sites"].includes(family) ||
        ["physical_overflow", "staffed_overflow", "staff_existing"].includes(
          kind,
        );
      if (
        interval &&
        (!until ||
          Date.parse(until) <= Date.parse(at) ||
          Date.parse(until) > Date.parse(end))
      )
        throw new Error(
          "The end must follow the start and fall within the scenario horizon.",
        );
      if (
        ["physical_overflow", "staffed_overflow"].includes(kind) &&
        (!Number.isInteger(quantity) ||
          quantity < facts.enabled ||
          quantity >
            dataset.slots.filter((slot) => slot.unit_id === unit).length)
      )
        throw new Error(
          `Choose a total from ${facts.enabled} existing beds to ${dataset.slots.filter((slot) => slot.unit_id === unit).length} including planned beds.`,
        );
      const id = value?.id || value?.update_id || crypto.randomUUID();
      const base = {
        ...value,
        id,
        name,
        source: value?.source || "user_assumption",
      };
      if (kind === "route_change")
        onSave("updates", {
          ...plannedEvent(
            "route_change",
            at,
            {
              route_id: route,
              travel_minutes: travel,
              unavailable: routeUnavailable,
              until,
            },
            value,
          ),
          name,
        });
      else if (family === "staff") {
        const chosen =
          staffMode === "named"
            ? staffIds
            : selectStaff(
                schedule,
                dataset.staff,
                role,
                shift,
                staffMode,
                amount,
              );
        if (!chosen.length)
          throw new Error(
            "Select at least one affected staff member from the declared roster.",
          );
        const selectedShift = shifts.find((s) => s.id === shift),
          shiftEnd = selectedShift?.end;
        if (staffMode !== "named" && !shiftEnd)
          throw new Error("Choose a declared shift.");
        const startAt =
          staffMode === "named"
            ? at
            : new Date(
                Math.max(Date.parse(at), Date.parse(selectedShift!.start)),
              ).toISOString();
        const endAt =
          staffMode === "named"
            ? until
            : new Date(
                Math.min(Date.parse(until), Date.parse(shiftEnd!)),
              ).toISOString();
        const record: Entity = {
          ...base,
          kind: "staff_unavailability",
          staff_ids: chosen,
          start_at: startAt,
          end_at: endAt,
          editor: { role, unit_id: unit, mode: staffMode, amount, shift },
        };
        delete record.unit_id;
        delete record.count;
        delete record.absence_percent;
        if (kind === "staff_available")
          onSave("updates", {
            ...plannedEvent(
              "staff_available",
              at,
              { staff_ids: chosen },
              value,
            ),
            name,
          });
        else onSave("conditions", record);
      } else if (family === "equipment") {
        if (
          !Number.isInteger(quantity) ||
          quantity < 0 ||
          (equipmentMaximum !== undefined && quantity > equipmentMaximum)
        )
          throw new Error(
            equipmentMaximum === undefined
              ? "Planned additions require a whole nonnegative quantity."
              : `Planned ${operation} must be a whole quantity from 0 to ${equipmentMaximum} before this event.`,
          );
        onSave("updates", {
          ...plannedEvent(
            "equipment_change",
            at,
            { equipment_pool_id: pool, operation, quantity },
            value,
          ),
          name,
        });
      } else if (family === "incident" || family === "cohort") {
        if (
          Object.values(mix).some((v) => !Number.isFinite(v) || v < 0) ||
          Math.abs(Object.values(mix).reduce((a, b) => a + b, 0) - 1) > 1e-8
        )
          throw new Error("Mix fractions must be nonnegative and total 100%.");
        onSave(
          "conditions",
          family === "incident"
            ? {
                ...base,
                kind: "arrival_batch",
                at,
                count: quantity,
                spread_minutes: spread,
                entry_stream_id: stream,
                care_mix: mix,
              }
            : {
                ...base,
                kind: "care_mix_override",
                start_at: at,
                end_at: until,
                entry_stream_id: stream,
                care_mix_override: mix,
              },
        );
      } else if (
        ["capacity_change", "advertised_capacity_change"].includes(kind)
      )
        onSave("updates", {
          ...plannedEvent(
            kind,
            at,
            {
              unit_id: unit,
              [kind === "capacity_change"
                ? "enabled_capacity"
                : "advertised_staffed_capacity"]: quantity,
            },
            value,
          ),
          name,
        });
      else {
        const timingError = readinessError(at, until, delay);
        if (timingError) throw new Error(timingError);
        const plan: Entity = {
          ...base,
          kind,
          start_at: at,
          end_at: until,
          activation_minutes: delay,
          enabled: true,
        };
        if (kind === "partner_transfer")
          Object.assign(plan, {
            destination_unit_id: unit,
            patient_eligibility_filter: { care_levels: [care] },
            max_patients: maxPatients,
            include_inpatients: includeInpatients,
            reservation_expiry_minutes: expiry,
          });
        else {
          Object.assign(plan, {
            unit_id: unit,
            facility_id: selectedUnit?.facility_id,
            nurses,
            providers,
            support,
          });
          if (kind !== "staff_existing") plan.enabled_slots = quantity;
          if (staffSource === "named") plan.assigned_staff_ids = staffIds;
          else delete plan.assigned_staff_ids;
          if (kind !== "staff_existing")
            plan.equipment_allocations = Object.entries(allocations)
              .filter(([, n]) => n > 0)
              .map(([equipment_pool_id, quantity]) => ({
                equipment_pool_id,
                quantity,
              }));
        }
        onSave("interventions", plan);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const timeFields = (
    <>
      <ZonedDateTimeInput
        label="Effective time"
        timeZone={timeZone}
        value={utcInput(at)}
        onChange={(value) => setAt(isoInput(value))}
      />
      {["staff", "cohort", "sites"].includes(family) ||
      ["physical_overflow", "staffed_overflow", "staff_existing"].includes(
        kind,
      ) ? (
        <ZonedDateTimeInput
          label="End time (exclusive)"
          timeZone={timeZone}
          value={utcInput(until)}
          onChange={(value) => setUntil(isoInput(value))}
        />
      ) : null}
      <small>
        Times use {timeZone}. Repeated daylight-saving hours require an explicit
        occurrence; nonexistent local times cannot be saved.
      </small>
    </>
  );
  const unitField = (
    <label>
      Target unit
      <NativeSelect
        aria-label="Target unit"
        value={unit}
        onChange={(e) => {
          setUnit(e.target.value);
          setStaffIds([]);
        }}
      >
        {dataset.units
          .filter((u) => u.facility_id === "FAC-MAIN")
          .filter((u) =>
            kind === "clinic"
              ? u.kind === "clinic"
              : kind === "partner_transfer"
                ? u.kind === care && u.capacity_mode === "advertised_aggregate"
                : kind === "advertised_capacity_change"
                  ? u.capacity_mode === "advertised_aggregate"
                  : ["physical_overflow", "staffed_overflow"].includes(kind)
                    ? dataset.slots.some(
                        (slot) =>
                          slot.unit_id === u.unit_id &&
                          slot.installation_status === "planned",
                      )
                    : kind === "staff_existing"
                      ? u.kind === "ward"
                      : true,
          )
          .map((u) => (
            <option key={u.unit_id} value={u.unit_id}>
              {u.kind === "icu"
                ? "Intensive care"
                : u.kind === "ed"
                  ? "Emergency department"
                  : u.name}
            </option>
          ))}
      </NativeSelect>
    </label>
  );
  const mixFields = (
    <fieldset className="care-mix-fields">
      <legend>
        {family === "incident" ? "Incident disposition" : "Arrival cohort mix"}
      </legend>
      {family === "cohort" && (
        <label>
          Mix basis
          <NativeSelect
            aria-label="Mix basis"
            value={mixKind}
            onChange={(e) => {
              setMixKind(e.target.value as typeof mixKind);
              setMix(mixForBasis(dataset, stream, e.target.value));
            }}
          >
            <option value="care">Care level</option>
            <option value="profiles">Equipment and care needs</option>
            <option value="cohorts">Patient groups</option>
            {mixKind === "mixed" && (
              <option value="mixed" disabled>
                Imported mixed care/profile/cohort keys
              </option>
            )}
          </NativeSelect>
        </label>
      )}
      {Object.keys(mix).map((key) => (
        <label key={key}>
          {friendly(key)} (%)
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={Number(((mix[key] || 0) * 100).toFixed(6))}
            onChange={(e) =>
              setMix((m) => ({ ...m, [key]: +e.target.value / 100 }))
            }
          />
        </label>
      ))}
      <small>
        Total {fmt(Object.values(mix).reduce((a, b) => a + b, 0) * 100, 2)}% ·
        new arrivals only
      </small>
    </fieldset>
  );
  return (
    <Modal
      title={`${selection ? "Edit" : "Add"} ${titleFor(family).toLowerCase()}`}
      wide
      onClose={onClose}
    >
      <div className="scenario-plan-form form-stack">
        <p className="info-note">
          {observed
            ? "This is an inherited operational report. It remains unchanged here; use Record update to correct its reported history."
            : "This change applies to future simulations of this scenario."}
        </p>
        <fieldset disabled={!canWrite || observed} className="plan-form-fields">
          <label>
            Change name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {family === "capacity" && (
            <label>
              Bed or staffing change
              <NativeSelect
                aria-label="Bed or staffing change"
                value={kind}
                onChange={(e) => changeKind(e.target.value)}
              >
                <option value="capacity_change">Change available beds</option>
                <option value="physical_overflow">
                  Open planned ward beds
                </option>
                <option value="staffed_overflow">
                  Open and staff planned ward beds
                </option>
                <option value="staff_existing">
                  Add nurses to existing beds
                </option>
              </NativeSelect>
            </label>
          )}
          {family === "sites" && (
            <label>
              Intervention template
              <NativeSelect
                aria-label="Intervention template"
                value={kind}
                onChange={(e) => changeKind(e.target.value)}
              >
                <option value="clinic">Activate clinic</option>
                <option value="staffed_overflow">
                  Activate staffed overflow
                </option>
                <option value="partner_transfer">Partner transfers</option>
                <option value="route_change">
                  Route travel / availability
                </option>
              </NativeSelect>
            </label>
          )}
          {timeFields}
          {["staff", "capacity", "sites"].includes(family) &&
            kind !== "route_change" &&
            unitField}
          {family === "staff" && (
            <>
              <label>
                Staff role
                <NativeSelect
                  aria-label="Staff role"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setStaffIds([]);
                  }}
                >
                  <option value="rn">Registered nurse</option>
                  <option value="provider">Provider</option>
                  <option value="support">Support</option>
                </NativeSelect>
              </label>
              <label>
                Choose staff using
                <NativeSelect
                  aria-label="Choose staff using"
                  value={staffMode}
                  onChange={(e) => setStaffMode(e.target.value)}
                >
                  <option value="named">Individual staff members</option>
                  <option value="percentage">
                    Percentage absent for a shift
                  </option>
                  <option value="count">Number absent for a shift</option>
                  <option value="available">
                    Number available for a shift
                  </option>
                </NativeSelect>
              </label>
              {scheduleLoading ? (
                <p role="status">Loading the declared shift roster…</p>
              ) : scheduleError ? (
                <ErrorBox error={scheduleError} />
              ) : null}
              {staffMode !== "named" ? (
                <>
                  <label>
                    Scheduled shift
                    <NativeSelect
                      aria-label="Scheduled shift"
                      value={shift}
                      onChange={(e) => setShift(e.target.value)}
                    >
                      {shifts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {new Intl.DateTimeFormat("en-US", {
                            timeZone,
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            timeZoneName: "shortOffset",
                          }).format(new Date(s.start))}{" "}
                          —{" "}
                          {new Intl.DateTimeFormat("en-US", {
                            timeZone,
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            timeZoneName: "shortOffset",
                          }).format(new Date(s.end))}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label>
                    {staffMode === "percentage"
                      ? "Absent percentage"
                      : staffMode === "available"
                        ? "Available headcount"
                        : "Absent headcount"}
                    <input
                      type="number"
                      min="0"
                      step="1"
                      max={staffMode === "percentage" ? 100 : undefined}
                      value={amount}
                      onChange={(e) => setAmount(+e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <fieldset className="staff-picks">
                  <legend>{friendly(role)} roster</legend>
                  {matchingStaff.map((s) => (
                    <label key={s.staff_id}>
                      <input
                        type="checkbox"
                        checked={staffIds.includes(s.staff_id)}
                        onChange={(e) =>
                          setStaffIds((ids) =>
                            e.target.checked
                              ? [...ids, s.staff_id]
                              : ids.filter((id) => id !== s.staff_id),
                          )
                        }
                      />
                      {s.name ||
                        `${friendly(s.role)} ${dataset.staff.findIndex((person) => person.staff_id === s.staff_id) + 1}`}
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="info-note">
                {chosenStaff.length} staff members affected. Shift changes apply
                only during the selected shift.
              </p>
            </>
          )}
          {family === "capacity" && (
            <div className="capacity-concepts">
              <strong>Current bed capacity</strong>
              <dl>
                <div>
                  <dt>Installed beds</dt>
                  <dd>
                    {facts.installed} (+{facts.planned} planned)
                  </dd>
                </div>
                <div>
                  <dt>Available beds</dt>
                  <dd>{facts.enabled}</dd>
                </div>
                <div>
                  <dt>Free beds</dt>
                  <dd>{facts.ready} free beds now</dd>
                </div>
                <div>
                  <dt>Beds supported by staff</dt>
                  <dd>{facts.staffed}</dd>
                </div>
              </dl>
              <p>
                Beds need staff and equipment before patients can use them. The
                simulation checks these limits together.
              </p>
            </div>
          )}
          {family === "capacity" && kind !== "staff_existing" && (
            <label>
              {kind === "advertised_capacity_change"
                ? "Advertised staffed places"
                : ["physical_overflow", "staffed_overflow"].includes(kind)
                  ? "Total beds after opening"
                  : "Available beds"}
              <input
                type="number"
                min={
                  ["physical_overflow", "staffed_overflow"].includes(kind)
                    ? facts.enabled
                    : 0
                }
                max={
                  ["physical_overflow", "staffed_overflow"].includes(kind)
                    ? dataset.slots.filter((slot) => slot.unit_id === unit)
                        .length
                    : undefined
                }
                value={quantity}
                onChange={(e) => setQuantity(+e.target.value)}
              />
              {["physical_overflow", "staffed_overflow"].includes(kind) && (
                <small>
                  {facts.enabled} current beds + up to {facts.planned} planned
                  beds.{" "}
                  {kind === "staffed_overflow"
                    ? "Reserve staff below will support these beds."
                    : "Staff are scheduled separately."}
                </small>
              )}
            </label>
          )}
          {family === "equipment" && (
            <>
              <label>
                Equipment
                <NativeSelect
                  aria-label="Equipment"
                  value={pool}
                  onChange={(e) => setPool(e.target.value)}
                >
                  {dataset.equipment_pools.map((p) => (
                    <option
                      key={p.equipment_pool_id}
                      value={p.equipment_pool_id}
                    >
                      {p.name || friendly(p.capability_code)}
                      {p.portable ? " · portable" : ""}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                What changes?
                <NativeSelect
                  aria-label="What changes?"
                  value={operation}
                  onChange={(e) => setOperation(e.target.value)}
                >
                  <option value="fail">Become unavailable</option>
                  <option value="repair">Return to service</option>
                  <option value="add">Add units to this pool</option>
                  <option value="decommission">Decommission units</option>
                </NativeSelect>
              </label>
              <label>
                Equipment quantity
                <input
                  type="number"
                  min="0"
                  max={equipmentMaximum}
                  value={quantity}
                  onChange={(e) => setQuantity(+e.target.value)}
                />
              </label>
              <p className="info-note">
                Before this event: {equipmentBefore.total} total,{" "}
                {equipmentBefore.total - equipmentBefore.failed} serviceable,{" "}
                {equipmentBefore.failed} unserviceable. Earlier equipment
                reports and plans are applied in time order; equal timestamps
                keep their saved order.{" "}
                {equipmentMaximum === undefined
                  ? "Additions are not limited by current inventory."
                  : `Maximum ${operation}: ${equipmentMaximum}.`}{" "}
                This point change persists until another change. Held
                retirements are deferred; if resource allocations make an exact
                planned quantity impossible, the simulation reports an error
                instead of reducing it.
              </p>
            </>
          )}
          {["incident", "cohort"].includes(family) && (
            <>
              <label>
                Where patients arrive
                <NativeSelect
                  aria-label="Where patients arrive"
                  value={stream}
                  onChange={(e) => {
                    setStream(e.target.value);
                    setMixKind("care");
                    setMix(mixForBasis(dataset, e.target.value, "care"));
                  }}
                >
                  {dataset.entry_streams
                    ?.filter(
                      (s: Entity) =>
                        !s.facility_id || s.facility_id === "FAC-MAIN",
                    )
                    .map((s: Entity) => (
                      <option key={s.entry_stream_id} value={s.entry_stream_id}>
                        {streamName(s.entry_stream_id)}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              {family === "incident" && (
                <>
                  <label>
                    Additional patients
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value={quantity}
                      onChange={(e) => setQuantity(+e.target.value)}
                    />
                  </label>
                  <label>
                    Spread arrivals over (minutes)
                    <input
                      type="number"
                      min="0"
                      value={spread}
                      onChange={(e) => setSpread(+e.target.value)}
                    />
                  </label>
                  <p>
                    Added once to usual arrivals. Use 0 minutes to have everyone
                    arrive together.
                  </p>
                </>
              )}
              {mixFields}
            </>
          )}
          {kind === "route_change" && (
            <>
              <label>
                Directed route
                <NativeSelect
                  aria-label="Directed route"
                  value={route}
                  onChange={(e) => {
                    setRoute(e.target.value);
                    setTravel(
                      dataset.routes.find(
                        (r: Entity) => r.route_id === e.target.value,
                      )?.travel_minutes || 0,
                    );
                  }}
                >
                  {dataset.routes.map((r: Entity) => (
                    <option key={r.route_id} value={r.route_id}>
                      {r.route_id} · {r.from_facility_id} → {r.to_facility_id}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label>
                Travel minutes
                <input
                  type="number"
                  min="0"
                  value={travel}
                  onChange={(e) => setTravel(+e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={routeUnavailable}
                  onChange={(e) => setRouteUnavailable(e.target.checked)}
                />
                Route unavailable until end time
              </label>
            </>
          )}
          {kind === "partner_transfer" && (
            <>
              <label>
                Transfer care level
                <NativeSelect
                  aria-label="Transfer care level"
                  value={care}
                  onChange={(e) => {
                    setCare(e.target.value);
                    setUnit(
                      dataset.units.find(
                        (u) =>
                          u.kind === e.target.value &&
                          u.capacity_mode === "advertised_aggregate",
                      )?.unit_id || "",
                    );
                  }}
                >
                  <option value="ward">Ward</option>
                  <option value="icu">ICU</option>
                </NativeSelect>
              </label>
              <label>
                Maximum transferred patients
                <input
                  type="number"
                  min="0"
                  value={maxPatients}
                  onChange={(e) => setMaxPatients(+e.target.value)}
                />
              </label>
              <label>
                Reservation expiry (minutes)
                <input
                  type="number"
                  min="1"
                  value={expiry}
                  onChange={(e) => setExpiry(+e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeInpatients}
                  onChange={(e) => setIncludeInpatients(e.target.checked)}
                />
                Include eligible existing inpatients
              </label>
              <p>
                Transfers require compatible receiving capacity, equipment,
                directed routes and an available qualified vehicle. This policy
                can remain waiting when those prerequisites are unavailable.
              </p>
            </>
          )}
          {[
            "clinic",
            "staffed_overflow",
            "physical_overflow",
            "staff_existing",
          ].includes(kind) && (
            <>
              <label>
                Activation delay (minutes)
                <input
                  type="number"
                  min="0"
                  value={delay}
                  onChange={(e) => setDelay(+e.target.value)}
                />
              </label>
              {kind !== "staff_existing" && family !== "capacity" && (
                <label>
                  Enabled treatment places
                  <input
                    type="number"
                    min="0"
                    value={quantity}
                    onChange={(e) => setQuantity(+e.target.value)}
                  />
                </label>
              )}
              {kind !== "physical_overflow" && (
                <>
                  <label>
                    Staff source
                    <NativeSelect
                      aria-label="Staff source"
                      value={staffSource}
                      onChange={(e) => {
                        setStaffSource(e.target.value);
                        setStaffIds([]);
                      }}
                    >
                      <option value="rotating">
                        Rotating qualified reserve pool
                      </option>
                      <option value="named">
                        Choose individual reserve staff
                      </option>
                    </NativeSelect>
                  </label>
                  {staffSource === "named" ? (
                    <fieldset className="staff-picks">
                      <legend>Available reserve staff</legend>
                      {dataset.staff
                        .filter((s) => s.employment_pool === "reserve")
                        .map((s) => (
                          <label key={s.staff_id}>
                            <input
                              type="checkbox"
                              checked={staffIds.includes(s.staff_id)}
                              onChange={(e) =>
                                setStaffIds((ids) =>
                                  e.target.checked
                                    ? [...ids, s.staff_id]
                                    : ids.filter((id) => id !== s.staff_id),
                                )
                              }
                            />
                            {s.name ||
                              `${friendly(s.role)} ${dataset.staff.findIndex((person) => person.staff_id === s.staff_id) + 1}`}
                          </label>
                        ))}
                    </fieldset>
                  ) : (
                    <div className="two-fields">
                      {(
                        [
                          ["Nurses", nurses, setNurses],
                          ["Providers", providers, setProviders],
                          ["Support staff", support, setSupport],
                        ] as const
                      )
                        .filter(
                          ([label]) =>
                            kind !== "staff_existing" || label === "Nurses",
                        )
                        .map(([label, n, set]) => (
                          <label key={label}>
                            {label}
                            <input
                              type="number"
                              min="0"
                              value={n}
                              onChange={(e) => set(+e.target.value)}
                            />
                          </label>
                        ))}
                    </div>
                  )}
                </>
              )}
              {kind !== "staff_existing" && (
                <fieldset className="care-mix-fields">
                  <legend>Explicit portable equipment allocation</legend>
                  {dataset.equipment_pools
                    .filter((p) => p.portable)
                    .map((p) => (
                      <label key={p.equipment_pool_id}>
                        {p.name || friendly(p.capability_code)} ({p.quantity}{" "}
                        total)
                        <input
                          type="number"
                          min="0"
                          max={p.quantity}
                          value={allocations[p.equipment_pool_id] || 0}
                          onChange={(e) =>
                            setAllocations((a) => ({
                              ...a,
                              [p.equipment_pool_id]: +e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  <small>
                    Already installed equipment remains available. The server
                    checks free portable inventory, coverage and competing
                    allocations.
                  </small>
                </fieldset>
              )}
              <p className="info-note">
                Policy: {facts.policy.slots_per_nurse ?? "—"} places per
                qualified nurse; provider minimum{" "}
                {facts.policy.minimum_provider_count ?? "—"}; support minimum{" "}
                {facts.policy.minimum_support_count ?? "—"}. Activation
                completes after setup delay. Server preflight checks every
                covered shift and shared inventory.
              </p>
            </>
          )}
        </fieldset>
        {error && <ErrorBox error={error} />}
        <div className="modal-actions">
          {selection && !observed && (
            <Button onClick={onDelete} disabled={!canWrite}>
              Remove change
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            primary
            onClick={save}
            disabled={!canWrite || observed || scheduleLoading}
          >
            Apply change
          </Button>
        </div>
      </div>
    </Modal>
  );
}
