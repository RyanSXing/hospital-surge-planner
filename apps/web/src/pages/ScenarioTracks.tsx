import { useEffect, useRef, useState } from "react";
import type { Dataset, Entity } from "../types";
import { api, atDay, fmt } from "../api";
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
  movePlan,
  resizePlan,
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
  [
    "cohort",
    "Arrival cohorts",
    "Change the disposition or resource-profile mix",
  ],
  [
    "staff",
    "Staff availability",
    "Role, unit, declared shift and affected staff",
  ],
  [
    "capacity",
    "Physical, ready & usable capacity",
    "Edit space and staffing drivers separately",
  ],
  [
    "equipment",
    "Equipment availability",
    "Add, fail, repair or retire declared equipment",
  ],
  [
    "sites",
    "Sites & transfers",
    "Activate a site or schedule eligible transfers",
  ],
  [
    "incident",
    "One-time incident batches",
    "Add a specified number of synthetic arrivals",
  ],
];
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
}: {
  dataset: Dataset;
  draft: PlanDraft;
  start: string;
  end: string;
  canWrite: boolean;
  request: PlanEditorRequest | null;
  timeZone?: string;
  onChange: (next: PlanDraft) => void;
}) {
  const [editing, setEditing] = useState<{
    family: PlanFamily;
    selection: PlanSelection | null;
    value?: Entity;
  } | null>(null);
  useEffect(() => {
    if (request) setEditing({ family: request.family, selection: null });
  }, [request]);
  const rows = (Object.keys(draft) as PlanCollection[]).flatMap((collection) =>
    draft[collection].map((value, index) => ({
      collection,
      value,
      index,
      family: familyOf(value, collection),
    })),
  );
  return (
    <div className="scenario-plan-tracks">
      {planFamilies.map(([family, title, description]) => (
        <section
          className="track plan-family-track"
          key={family}
          aria-label={title + " timeline"}
        >
          <div className="track-label">
            <strong title={description}>{title}</strong>
            <span>{description}</span>
            <button
              onClick={() => setEditing({ family, selection: null })}
              disabled={!canWrite}
              aria-label={"Add " + title.toLowerCase()}
            >
              + Add · {rows.filter((row) => row.family === family).length}{" "}
              inputs
            </button>
          </div>
          <div className="plan-family-rail" aria-label={`${title} assumptions`}>
            {rows
              .filter((row) => row.family === family)
              .map(({ collection, value, index }) => {
                const interval = planInterval(value, start, end),
                  total = Date.parse(end) - Date.parse(start);
                const left = Math.max(
                  0,
                  Math.min(
                    98,
                    (100 * (Date.parse(interval.start) - Date.parse(start))) /
                      total,
                  ),
                );
                const width = Math.max(
                  2,
                  Math.min(
                    100 - left,
                    (100 *
                      (Date.parse(interval.end) - Date.parse(interval.start))) /
                      total,
                  ),
                );
                const observed =
                  collection === "updates" &&
                  value.input_kind !== "planned_assumption";
                return (
                  <PlanTimelineBlock
                    key={recordId(value) || `${collection}-${index}`}
                    value={value}
                    left={left}
                    width={width}
                    interval={interval}
                    start={start}
                    end={end}
                    zone={timeZone}
                    canEdit={canWrite && !observed}
                    onEdit={() =>
                      setEditing({
                        family,
                        selection: { collection, id: recordId(value), index },
                        value,
                      })
                    }
                    onChange={(next) =>
                      onChange(
                        withPlan(
                          draft,
                          { collection, id: recordId(value), index },
                          collection,
                          next,
                        ),
                      )
                    }
                  />
                );
              })}
            {!rows.some((row) => row.family === family) && (
              <button
                className="empty-track"
                onClick={() => setEditing({ family, selection: null })}
                disabled={!canWrite}
              >
                + Add {title.toLowerCase()}{" "}
                <span>Exact values and timestamps</span>
              </button>
            )}
          </div>
        </section>
      ))}
      {rows.some((r) => !r.family && r.value.kind !== "arrival_multiplier") && (
        <details className="preserved-assumptions">
          <summary>Other imported assumptions (preserved)</summary>
          {rows
            .filter((r) => !r.family && r.value.kind !== "arrival_multiplier")
            .map((r, i) => (
              <p key={i}>
                {r.value.name || r.value.kind || r.value.type} ·{" "}
                {recordId(r.value) || "imported record"}
              </p>
            ))}
        </details>
      )}
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
        u.kind === (family === "sites" ? "clinic" : "ward") &&
        (family === "sites" || u.capacity_mode === "staff_derived"),
    ) || dataset.units[0];
  const [name, setName] = useState(value?.name || titleFor(family));
  const [kind, setKind] = useState(
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
      }[family],
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
    const target = dataset.units.find((u) =>
      next === "clinic"
        ? u.kind === "clinic"
        : next === "partner_transfer"
          ? u.capacity_mode === "advertised_aggregate" && u.kind === care
          : next === "advertised_capacity_change"
            ? u.capacity_mode === "advertised_aggregate"
            : u.kind === "ward" &&
              (next === "physical_overflow" || next === "staffed_overflow"
                ? u.enabled_capacity === 0
                : u.capacity_mode === "staff_derived"),
    );
    if (target) setUnit(target.unit_id);
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
        ["physical_overflow", "staff_existing"].includes(kind);
      if (
        interval &&
        (!until ||
          Date.parse(until) <= Date.parse(at) ||
          Date.parse(until) > Date.parse(end))
      )
        throw new Error(
          "The end must follow the start and fall within the scenario horizon.",
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
      ["physical_overflow", "staff_existing"].includes(kind) ? (
        <ZonedDateTimeInput
          label="End time (exclusive)"
          timeZone={timeZone}
          value={utcInput(until)}
          onChange={(value) => setUntil(isoInput(value))}
        />
      ) : null}
      <small>
        Fields and timeline use {timeZone}. Repeated daylight-saving hours
        require an explicit occurrence; nonexistent local times cannot be saved.
      </small>
    </>
  );
  const unitField = (
    <label>
      Target unit
      <select
        value={unit}
        onChange={(e) => {
          setUnit(e.target.value);
          setStaffIds([]);
        }}
      >
        {dataset.units
          .filter((u) =>
            kind === "clinic"
              ? u.kind === "clinic"
              : kind === "partner_transfer"
                ? u.kind === care && u.capacity_mode === "advertised_aggregate"
                : kind === "advertised_capacity_change"
                  ? u.capacity_mode === "advertised_aggregate"
                  : true,
          )
          .map((u) => (
            <option key={u.unit_id} value={u.unit_id}>
              {u.name} · {u.unit_id}
            </option>
          ))}
      </select>
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
          <select
            value={mixKind}
            onChange={(e) => {
              setMixKind(e.target.value as typeof mixKind);
              setMix(mixForBasis(dataset, stream, e.target.value));
            }}
          >
            <option value="care">Care level</option>
            <option value="profiles">Declared resource profiles</option>
            <option value="cohorts">Declared cohorts</option>
            {mixKind === "mixed" && (
              <option value="mixed" disabled>
                Imported mixed care/profile/cohort keys
              </option>
            )}
          </select>
        </label>
      )}
      {Object.keys(mix).map((key) => (
        <label key={key}>
          {key} (%)
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
            : "A synthetic planning assumption, saved with this scenario. It does not record an observed event or change a completed run."}
        </p>
        <fieldset disabled={!canWrite || observed} className="plan-form-fields">
          <label>
            Assumption name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {family === "capacity" && (
            <label>
              Capacity driver
              <select value={kind} onChange={(e) => changeKind(e.target.value)}>
                <option value="capacity_change">Enabled physical slots</option>
                <option value="physical_overflow">
                  Install planned physical overflow
                </option>
                <option value="staff_existing">
                  Staff existing enabled beds
                </option>
                <option value="advertised_capacity_change">
                  Advertised partner staffing
                </option>
              </select>
            </label>
          )}
          {family === "sites" && (
            <label>
              Intervention template
              <select value={kind} onChange={(e) => changeKind(e.target.value)}>
                <option value="clinic">Activate clinic</option>
                <option value="staffed_overflow">
                  Activate staffed overflow
                </option>
                <option value="partner_transfer">Partner transfers</option>
                <option value="route_change">
                  Route travel / availability
                </option>
              </select>
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
                <select
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setStaffIds([]);
                  }}
                >
                  <option value="rn">Registered nurse</option>
                  <option value="provider">Provider</option>
                  <option value="support">Support</option>
                </select>
              </label>
              <label>
                Availability input
                <select
                  value={staffMode}
                  onChange={(e) => setStaffMode(e.target.value)}
                >
                  <option value="named">Named unavailable staff</option>
                  <option value="percentage">
                    Absent percentage in a declared shift
                  </option>
                  <option value="count">
                    Absent headcount in a declared shift
                  </option>
                  <option value="available">
                    Available headcount in a declared shift
                  </option>
                </select>
              </label>
              {scheduleLoading ? (
                <p role="status">Loading the declared shift roster…</p>
              ) : scheduleError ? (
                <ErrorBox error={scheduleError} />
              ) : null}
              {staffMode !== "named" ? (
                <>
                  <label>
                    Declared shift
                    <select
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
                    </select>
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
                  <legend>Declared {role} roster</legend>
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
                      {s.staff_id} · {s.team_id}
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="info-note">
                {chosenStaff.length} exact staff IDs will be unavailable.
                Shift-based inputs affect only the chosen shift within the
                specified interval; other assignments stay scheduled.
              </p>
            </>
          )}
          {family === "capacity" && (
            <div className="capacity-concepts">
              <strong>Snapshot capacity calculation</strong>
              <dl>
                <div>
                  <dt>Installed physical</dt>
                  <dd>
                    {facts.installed} (+{facts.planned} declared planned)
                  </dd>
                </div>
                <div>
                  <dt>Enabled physical</dt>
                  <dd>{facts.enabled}</dd>
                </div>
                <div>
                  <dt>Ready physical</dt>
                  <dd>{facts.ready} free enabled spaces at snapshot</dd>
                </div>
                <div>
                  <dt>Staff-supported ceiling</dt>
                  <dd>{facts.staffed}</dd>
                </div>
              </dl>
              <p>
                Usable capacity is computed from enabled ready spaces, qualified
                staffing and minimum team gates, reservations, turnover and
                equipment. These are separate constraints; changing a physical
                count cannot create staff or equipment. Run the scenario to see
                forecast availability.
              </p>
            </div>
          )}
          {family === "capacity" && kind !== "staff_existing" && (
            <label>
              {kind === "advertised_capacity_change"
                ? "Advertised staffed places"
                : kind === "physical_overflow"
                  ? "Physical places to install and enable"
                  : "Enabled physical places"}
              <input
                type="number"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(+e.target.value)}
              />
            </label>
          )}
          {family === "equipment" && (
            <>
              <label>
                Equipment pool
                <select value={pool} onChange={(e) => setPool(e.target.value)}>
                  {dataset.equipment_pools.map((p) => (
                    <option
                      key={p.equipment_pool_id}
                      value={p.equipment_pool_id}
                    >
                      {p.equipment_pool_id} · {p.capability_code} ·{" "}
                      {p.portable ? "portable" : "fixed"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Equipment operation
                <select
                  value={operation}
                  onChange={(e) => setOperation(e.target.value)}
                >
                  <option value="fail">Become unavailable</option>
                  <option value="repair">Return to service</option>
                  <option value="add">Add units to this pool</option>
                  <option value="decommission">Decommission units</option>
                </select>
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
                Incident or cohort entry stream
                <select
                  value={stream}
                  onChange={(e) => {
                    setStream(e.target.value);
                    setMixKind("care");
                    setMix(mixForBasis(dataset, e.target.value, "care"));
                  }}
                >
                  {dataset.entry_streams?.map((s: Entity) => (
                    <option key={s.entry_stream_id} value={s.entry_stream_id}>
                      {s.entry_stream_id} · {s.entry_type}
                    </option>
                  ))}
                </select>
              </label>
              {family === "incident" && (
                <>
                  <label>
                    Incident patient count
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value={quantity}
                      onChange={(e) => setQuantity(+e.target.value)}
                    />
                  </label>
                  <label>
                    Incident spread (minutes)
                    <input
                      type="number"
                      min="0"
                      value={spread}
                      onChange={(e) => setSpread(+e.target.value)}
                    />
                  </label>
                  <p>
                    Added once to baseline arrivals, with synthetic incident
                    provenance. Zero spread means the same arrival instant.
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
                <select
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
                </select>
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
                <select
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
                </select>
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
                    <select
                      value={staffSource}
                      onChange={(e) => {
                        setStaffSource(e.target.value);
                        setStaffIds([]);
                      }}
                    >
                      <option value="rotating">
                        Rotating qualified reserve pool
                      </option>
                      <option value="named">Exact reserve staff IDs</option>
                    </select>
                  </label>
                  {staffSource === "named" ? (
                    <fieldset className="staff-picks">
                      <legend>Declared reserve staff</legend>
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
                            {s.staff_id} · {s.role}
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
                        {p.equipment_pool_id} ({p.capability_code}, {p.quantity}{" "}
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
              Remove assumption
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            primary
            onClick={save}
            disabled={!canWrite || observed || scheduleLoading}
          >
            Apply assumption
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PlanTimelineBlock({
  value,
  left,
  width,
  interval,
  start,
  end,
  zone,
  canEdit,
  onEdit,
  onChange,
}: {
  value: Entity;
  left: number;
  width: number;
  interval: { start: string; end: string };
  start: string;
  end: string;
  zone: string;
  canEdit: boolean;
  onEdit: () => void;
  onChange: (v: Entity) => void;
}) {
  const drag = useRef<{
      x: number;
      mode: "move" | "start" | "end";
      width: number;
    } | null>(null),
    suppressClick = useRef(false);
  const [preview, setPreview] = useState(0);
  const total = Date.parse(end) - Date.parse(start),
    a = Date.parse(interval.start),
    b = Date.parse(interval.end),
    isInterval = b > a;
  function apply(delta: number, mode: "move" | "start" | "end") {
    if (mode === "move")
      return movePlan(
        value,
        Math.max(
          (Date.parse(start) - a) / 60000,
          Math.min(delta, (Date.parse(end) - b - 1) / 60000),
        ),
      );
    const instant =
      mode === "start"
        ? Math.max(Date.parse(start), Math.min(a + delta * 60000, b - 60000))
        : Math.min(Date.parse(end), Math.max(b + delta * 60000, a + 60000));
    return resizePlan(value, mode, new Date(instant).toISOString());
  }
  const begin = (e: React.PointerEvent, mode: "move" | "start" | "end") => {
    if (!canEdit || e.button !== 0) return;
    e.stopPropagation();
    drag.current = {
      x: e.clientX,
      mode,
      width: e.currentTarget
        .closest(".plan-timeline-row")!
        .getBoundingClientRect().width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const pointerMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const delta =
        Math.round(
          (((e.clientX - drag.current.x) / drag.current.width) * total) /
            60000 /
            15,
        ) * 15;
      setPreview(delta);
      if (Math.abs(e.clientX - drag.current.x) > 4)
        suppressClick.current = true;
    }
  };
  const finish = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const mode = drag.current.mode;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (suppressClick.current && preview) onChange(apply(preview, mode));
    setPreview(0);
  };
  const key = (e: React.KeyboardEvent, mode: "move" | "start" | "end") => {
    if (!canEdit || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    onChange(
      apply((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1440 : 60), mode),
    );
  };
  const label = value.name || (value.kind || value.type).replaceAll("_", " ");
  return (
    <div className="plan-timeline-row">
      <div
        className="plan-block-group"
        style={{
          marginLeft: `${left}%`,
          width: `${width}%`,
          transform:
            preview && drag.current?.mode === "move"
              ? `translateX(${((preview * 60000) / total) * drag.current.width}px)`
              : undefined,
        }}
      >
        {isInterval && canEdit && (
          <button
            className="plan-resize-handle"
            aria-label={`Resize start of ${label}`}
            onPointerDown={(e) => begin(e, "start")}
            onPointerMove={pointerMove}
            onPointerUp={finish}
            onPointerCancel={() => {
              drag.current = null;
              setPreview(0);
            }}
            onKeyDown={(e) => key(e, "start")}
          >
            ‹
          </button>
        )}
        <button
          className="plan-timeline-block"
          aria-label={`${label} ${canEdit ? "Planning assumption" : "Recorded input"}`}
          title={`${label}\n${interval.start} — ${interval.end}\nDrag to move; arrow keys move one hour, Shift+arrow one day. Exact values are available by opening this assumption.`}
          onPointerDown={(e) => begin(e, "move")}
          onPointerMove={pointerMove}
          onPointerUp={finish}
          onPointerCancel={() => {
            drag.current = null;
            setPreview(0);
          }}
          onKeyDown={(e) => key(e, "move")}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            onEdit();
          }}
        >
          <span>{label}</span>
          <small>{canEdit ? "Planning assumption" : "Recorded input"}</small>
        </button>
        {isInterval && canEdit && (
          <button
            className="plan-resize-handle"
            aria-label={`Resize end of ${label}`}
            onPointerDown={(e) => begin(e, "end")}
            onPointerMove={pointerMove}
            onPointerUp={finish}
            onPointerCancel={() => {
              drag.current = null;
              setPreview(0);
            }}
            onKeyDown={(e) => key(e, "end")}
          >
            ›
          </button>
        )}
      </div>
      <span className="plan-timeline-time">
        {new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(interval.start))}
        {isInterval ? " · interval" : " · one time"}
        {preview ? ` · ${preview > 0 ? "+" : ""}${preview} min` : ""}
      </span>
    </div>
  );
}
