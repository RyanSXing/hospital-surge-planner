import { useEffect, useMemo, useRef, useState } from "react";
import "./patients.css";
import { usePatientPage } from "./usePatientPage";
import UnitEvidence from "../components/UnitEvidence";
import { ZonedDateTimeInput } from "../components/ZonedDateTimeInput";
import {
  PlanningPanelControls,
  PlanningTimelineDock,
  usePlanningPanels,
} from "../components/PlanningPanels";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Hospital,
  Search,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { Entity, PlanningContext, UpdateTarget } from "../types";
import { api, fmt, localDate, patientId, unitId } from "../api";
import { Badge, BedGrid, BedLegend, Button, ErrorBox } from "../components/ui";
import {
  nameOf,
  patientsOf,
  queueStats,
  statsFor,
  unitsOf,
  stateUnavailable,
} from "../model";
const labels: Record<string, string> = {
  ed_boarding: "Awaiting inpatient placement",
  direct_waiting: "Awaiting ward placement",
  ed_assessment: "ED assessment",
  ed_waiting: "Awaiting assessment",
  inpatient: "Inpatient",
  clinic_assessment: "Clinic assessment",
  in_transit: "In transport",
  transfer_reserved: "Transfer reserved",
};
const stateLabel = (p: Entity) =>
  labels[p.state] || p.state?.replaceAll("_", " ") || "Unknown";
const time = (value?: string) =>
  value
    ? localDate(value, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "Not applicable";
const elapsed = (p: Entity, at: string) => {
  const start =
    p.current_stage_started_at ||
    p.unit_entered_at ||
    p.start_at ||
    p.state_entered_at ||
    p.arrival_at;
  return start
    ? Math.max(0, (Date.parse(at) - Date.parse(start)) / 3600000)
    : null;
};
function slotRows(ctx: PlanningContext, id: string): Entity[] {
  const source = ctx.state?.slots || ctx.dataset?.slots || [];
  const patients = patientsOf(ctx);
  const u = unitsOf(ctx).find((u) => unitId(u) === id);
  const sorted = source
    .filter(
      (s: Entity) => s.unit_id === id && s.installation_status === "installed",
    )
    .sort((a: Entity, b: Entity) => a.slot_id.localeCompare(b.slot_id));
  return sorted.map((s: Entity, i: number) => {
    const p = patients.find((p) => p.slot_id === s.slot_id);
    const background = !ctx.state && i < Number(u?.background_occupied || 0);
    return {
      ...s,
      patient_id: s.patient_id || p?.patient_id,
      background_occupied: s.background_occupied || background,
      status:
        s.status ||
        (p || background ? "occupied" : s.enabled ? "ready" : "disabled"),
    };
  });
}
function UnitDetails({ unit }: { unit: Entity }) {
  const equipment = unit.equipment || {};
  return (
    <>
      <h3>{nameOf(unit)}</h3>
      <dl className="detail-list">
        <div>
          <dt>Physical / enabled</dt>
          <dd>
            {unit.physical ?? unit.physical_capacity} /{" "}
            {unit.enabled ?? unit.enabled_capacity}
          </dd>
        </div>
        <div>
          <dt>Staffed / occupied</dt>
          <dd>
            {unit.staffed ?? unit.staffed_capacity} / {unit.occupied ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Reserved / turnover</dt>
          <dd>
            {unit.reserved ?? 0} / {unit.cleaning ?? 0}
          </dd>
        </div>
        <div>
          <dt>Ready / available</dt>
          <dd>
            {unit.ready ?? "—"} / {unit.available ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Admission gate</dt>
          <dd>
            {unit.admission_gate === false
              ? "Minimum team missing"
              : "Open when resources fit"}
          </dd>
        </div>
        {Object.entries(unit.staff_by_role || unit.baseline_staff || {}).map(
          ([role, count]) => (
            <div key={role}>
              <dt>{role === "rn" ? "Qualified nurses" : role}</dt>
              <dd>{String(count)}</dd>
            </div>
          ),
        )}
      </dl>
      {Object.keys(equipment).length ? (
        <>
          <h3>Equipment ledger</h3>
          {Object.entries(equipment).map(([cap, v]) => {
            const e = v as Entity;
            return (
              <div className="eligibility-row" key={cap}>
                <strong>{cap.replaceAll("_", " ")}</strong>
                <span>
                  {e.in_use} in use · {e.reserved} reserved · {e.available} free
                  {e.deficit ? ` · ${e.deficit} deficit` : ""}
                </span>
              </div>
            );
          })}
        </>
      ) : null}
    </>
  );
}
export default function Patients({
  ctx,
  onUpdate,
}: {
  ctx: PlanningContext;
  onUpdate: (target?: UpdateTarget) => void;
}) {
  const panels = usePlanningPanels(180);
  const placementRequest = useRef(0);
  const inspectorRef = useRef<HTMLElement>(null);
  const [schematicExpanded, setSchematicExpanded] = useState(
    () => window.innerWidth >= 768,
  );
  const unit = ctx.selectedUnit,
    setUnit = ctx.setUnit;
  const [tab, setTab] = useState("patients"),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [care, setCare] = useState(""),
    [reason, setReason] = useState(""),
    [arrivedFrom, setArrivedFrom] = useState(""),
    [arrivedUntil, setArrivedUntil] = useState(""),
    [remainingMin, setRemainingMin] = useState(""),
    [remainingMax, setRemainingMax] = useState(""),
    [transfer, setTransfer] = useState(""),
    [detail, setDetail] = useState<Entity | null>(null),
    [eligibility, setEligibility] = useState<Entity[]>([]),
    [detailError, setDetailError] = useState(""),
    [selectedSlot, setSelectedSlot] = useState<Entity | null>(null);
  const allPatients = patientsOf(ctx),
    patients = allPatients.filter(
      (p) => p.facility_id === ctx.selectedFacility,
    ),
    allUnits = unitsOf(ctx),
    units = allUnits.filter((u) => u.facility_id === ctx.selectedFacility);
  const selected = ctx.selectedPatient,
    rep = ctx.activeReplicationId || ctx.run?.selected_replication_id,
    censusAt = rep
      ? ctx.selectedTime
      : ctx.dataset?.snapshot_at || ctx.selectedTime,
    q = queueStats(ctx),
    unavailable = stateUnavailable(ctx);
  const timeZone =
    (ctx.resultScenario || ctx.scenario)?.timezone ||
    ctx.dataset?.timezone ||
    "America/Chicago";
  const filtered = useMemo(
    () =>
      patients.filter(
        (p) =>
          (!unit || p.unit_id === unit) &&
          (!search ||
            patientId(p).toLowerCase().includes(search.toLowerCase())) &&
          (filter === "all" ||
            (filter === "waiting" &&
              (p.admission_pending ||
                ["ed_boarding", "direct_waiting", "ed_waiting"].includes(
                  p.state,
                ))) ||
            filter === p.state),
      ),
    [patients, unit, search, filter],
  );
  const census = usePatientPage(
      rep,
      ctx.selectedTime,
      {
        facility_id: ctx.selectedFacility,
        unit_id: unit || undefined,
        search: search || undefined,
        state: filter === "all" ? undefined : filter,
        care_level: care || undefined,
        waiting_reason: reason || undefined,
        arrival_from: arrivedFrom ? `${arrivedFrom}:00Z` : undefined,
        arrival_until: arrivedUntil ? `${arrivedUntil}:00Z` : undefined,
        remaining_min_hours: remainingMin || undefined,
        remaining_max_hours: remainingMax || undefined,
        transfer_eligible: transfer || undefined,
      },
      30,
      filtered,
      ctx.dataset?.id,
    ),
    { page, setPage } = census;
  const facilityTotal = Number(
    ctx.state?.patient_counts?.by_facility?.[ctx.selectedFacility] ??
      patients.length,
  );
  useEffect(() => {
    setSelectedSlot(null);
  }, [ctx.selectedFacility]);
  useEffect(() => {
    if (ctx.selectedUnit || ctx.selectedPatient?.patient_id)
      panels.setInspectorHidden(false);
  }, [ctx.selectedUnit, ctx.selectedPatient?.patient_id]);
  useEffect(() => {
    let ignore = false;
    placementRequest.current++;
    setDetail(null);
    setEligibility([]);
    setDetailError("");
    if (selected && rep)
      api(
        `/runs/${rep}/patients/${patientId(selected)}?at=${encodeURIComponent(ctx.selectedTime)}`,
      )
        .then((value) => {
          if (!ignore) setDetail(value);
        })
        .catch((e) => {
          if (!ignore) setDetailError(e.message);
        });
    return () => {
      ignore = true;
    };
  }, [selected?.patient_id, selected?.id, ctx.selectedTime, rep]);
  function select(p: Entity) {
    ctx.setPatient(p);
    setSelectedSlot(null);
    panels.setInspectorHidden(false);
    if (window.innerWidth < 1024)
      requestAnimationFrame(() => inspectorRef.current?.focus());
  }
  function inspectSlot(slot: Entity) {
    setSelectedSlot(slot);
    setUnit(slot.unit_id);
    const p = allPatients.find((p) => patientId(p) === slot.patient_id);
    ctx.setPatient(p || null);
    if (!p && slot.patient_id && rep)
      api(
        `/runs/${rep}/patients/${encodeURIComponent(slot.patient_id)}?at=${encodeURIComponent(ctx.selectedTime)}`,
      )
        .then(ctx.setPatient)
        .catch((e) => setDetailError(e.message));
  }
  const sourcePatient = ctx.dataset?.patients.find(
    (p) => patientId(p) === patientId(selected || {}),
  );
  const current = selected
    ? { ...sourcePatient, ...selected, ...detail }
    : null;
  const wards = units.filter((u) => u.kind === "ward"),
    icu = statsFor(ctx, "icu"),
    chosenUnit = allUnits.find((u) => unitId(u) === unit),
    currentUnit = allUnits.find((u) => unitId(u) === current?.unit_id);
  const remaining = current?.expected_stage_end_at
    ? Math.max(
        0,
        (Date.parse(current.expected_stage_end_at) -
          Date.parse(ctx.selectedTime)) /
          3600000,
      )
    : null;
  const spec = current?.remaining_stage_spec;
  const template = ctx.dataset?.los_templates?.find(
    (t: Entity) =>
      t.template_id === spec?.distribution_id ||
      t.template_id === current?.remaining_stay_template_id,
  );
  const placementRequirements =
    (current?.admission_pending
      ? current.inpatient_resource_requirements
      : current?.resource_requirements) || [];
  const currentState = selected
    ? allPatients.find((p) => patientId(p) === patientId(selected)) ||
      census.rows.find((p) => patientId(p) === patientId(selected)) ||
      (detail && !["discharged", "departed"].includes(detail.state)
        ? detail
        : null)
    : null;
  const currentPath =
    current?.entry_type === "direct_ward"
      ? ["Direct admission", current?.care_level || "Ward", "Discharge"]
      : current?.state === "clinic_assessment"
        ? ["Eligible new arrival", "Clinic", "Discharge"]
        : [
            "ED assessment",
            current?.care_level === "ambulatory"
              ? "Disposition after assessment"
              : current?.care_level || "Inpatient",
            "Discharge",
          ];
  return (
    <div className="patients-page planning-panel-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PATIENTS & UNITS</div>
          <h1>Hospital capacity</h1>
          <p>Follow each patient. Understand every placement constraint.</p>
        </div>
        <div className="heading-actions">
          <PlanningPanelControls panels={panels} name="patients" />
          <Badge>
            {ctx.state ? "Selected simulation trajectory" : "Source snapshot"}
          </Badge>
          <div className="segmented">
            <button
              className={tab === "patients" ? "active" : ""}
              onClick={() => setTab("patients")}
            >
              <Users size={14} />
              Patients
            </button>
            <button
              className={tab === "units" ? "active" : ""}
              onClick={() => setTab("units")}
            >
              <Hospital size={14} />
              Units
            </button>
          </div>
        </div>
      </div>
      {unavailable ? (
        <ErrorBox
          error={ctx.stateError || "Reconstructing the selected timestamp…"}
        />
      ) : null}
      <div className="patient-workspace">
        <div className="patient-main">
          <section className="hospital-schematic">
            <div className="schematic-caption">
              <span className="eyebrow">SCHEMATIC UNIT LAYOUT</span>
              <span>
                {facilityTotal} active at this facility · {q.total} awaiting
                inpatient placement at this facility
              </span>
              <button
                className="schematic-toggle"
                aria-expanded={schematicExpanded}
                aria-controls="patients-unit-schematic"
                onClick={() => setSchematicExpanded((value) => !value)}
              >
                {schematicExpanded ? "Hide layout" : "Show layout"}
                <ChevronRight size={14} />
              </button>
            </div>
            <div
              id="patients-unit-schematic"
              className="schematic-body"
              hidden={!schematicExpanded}
            >
              <div className="unit-layout">
                {units
                  .filter((u) => u.kind === "ed")
                  .map((u) => {
                    const id = unitId(u);
                    const boardersHere = ctx.state?.patient_groups
                      ? ctx.state.patient_groups
                          .filter(
                            (g: Entity) =>
                              g.unit_id === id && g.state === "ed_boarding",
                          )
                          .reduce((n: number, g: Entity) => n + g.count, 0)
                      : patients.filter(
                          (p) => p.unit_id === id && p.state === "ed_boarding",
                        ).length;
                    return (
                      <div
                        key={id}
                        className={`ed-zone schematic-zone ${unit === id ? "selected" : ""}`}
                      >
                        <button
                          className="spread unit-label"
                          onClick={() => setUnit(unit === id ? "" : id)}
                        >
                          <strong>{nameOf(u)}</strong>
                          <Badge tone="warning">
                            {u.occupied ??
                              patients.filter((p) => p.unit_id === id).length}
                            /{u.staffed ?? u.staffed_capacity}
                          </Badge>
                        </button>
                        <span className="zone-subtitle">
                          Assessment & inpatient boarding
                        </span>
                        <div className="queue-dot-grid">
                          {patients
                            .filter((p) => p.unit_id === id)
                            .map((p) => (
                              <button
                                key={patientId(p)}
                                className={`patient-token ${p.state === "ed_boarding" ? "waiting" : ""} ${patientId(selected || {}) === patientId(p) ? "selected" : ""}`}
                                title={`${patientId(p)}: ${stateLabel(p)}`}
                                aria-label={`Inspect ${patientId(p)}: ${stateLabel(p)}`}
                                onClick={() => select(p)}
                              />
                            ))}
                        </div>
                        <div className="zone-bottom">
                          <strong className="amber">
                            {boardersHere} boarding in ED
                          </strong>
                          <small>ED boarders retain treatment places</small>
                        </div>
                      </div>
                    );
                  })}
                <div className="schematic-corridor">
                  <span>CARE PATHWAY</span>
                  <ArrowRight size={17} />
                </div>
                <div className="ward-zones">
                  <div className="spread">
                    <h3>Ward units</h3>
                    <span className="muted">
                      {statsFor(ctx, "ward").physical} physical beds
                    </span>
                  </div>
                  {wards.map((u) => {
                    const id = unitId(u),
                      slots = slotRows(ctx, id);
                    const n = Number(
                        u.occupied ??
                          patients.filter((p) => p.unit_id === id).length,
                      ),
                      physical = Number(u.physical ?? u.physical_capacity),
                      staffed = Number(u.staffed ?? u.staffed_capacity);
                    return (
                      <div
                        className={`ward-unit ${unit === id ? "selected" : ""}`}
                        key={id}
                      >
                        <button
                          className="spread unit-label"
                          onClick={() => {
                            setUnit(unit === id ? "" : id);
                            ctx.setPatient(null);
                          }}
                        >
                          <strong>{nameOf(u)}</strong>
                          <span>
                            {n}/{staffed} staffed
                          </span>
                        </button>
                        <BedGrid
                          physical={physical}
                          staffed={staffed}
                          occupied={n}
                          slots={slots}
                          selectedSlot={
                            selected?.slot_id || selectedSlot?.slot_id
                          }
                          onSelectSlot={inspectSlot}
                        />
                        <small className="muted">
                          {u.reserved ?? 0} reserved · {u.cleaning ?? 0}{" "}
                          turnover · {u.available ?? Math.max(0, staffed - n)}{" "}
                          usable before profile checks
                        </small>
                      </div>
                    );
                  })}
                </div>
                {units
                  .filter((u) => u.kind === "icu")
                  .map((u) => (
                    <div key={unitId(u)} className="icu-zone schematic-zone">
                      <button
                        className="spread unit-label"
                        onClick={() => {
                          setUnit(unitId(u));
                          ctx.setPatient(null);
                        }}
                      >
                        <strong>{nameOf(u)}</strong>
                        <Badge
                          tone={
                            icu.occupied >= icu.staffed ? "danger" : "neutral"
                          }
                        >
                          {icu.occupied}/{icu.staffed}
                        </Badge>
                      </button>
                      <span className="zone-subtitle">ICU-capable care</span>
                      <BedGrid
                        physical={Number(u.physical ?? u.physical_capacity)}
                        staffed={Number(u.staffed ?? u.staffed_capacity)}
                        occupied={Number(
                          u.occupied ??
                            patients.filter((p) => p.unit_id === unitId(u))
                              .length,
                        )}
                        slots={slotRows(ctx, unitId(u))}
                        selectedSlot={
                          selected?.slot_id || selectedSlot?.slot_id
                        }
                        onSelectSlot={inspectSlot}
                      />
                      <div className="zone-bottom">
                        <strong>
                          {u.available ?? icu.available} available
                        </strong>
                        <small>Monitor and equipment checks apply</small>
                      </div>
                    </div>
                  ))}
                {units
                  .filter((u) => ["clinic", "shelter"].includes(u.kind))
                  .map((u) => (
                    <div className="schematic-zone" key={unitId(u)}>
                      <button
                        className="unit-label"
                        onClick={() => {
                          setUnit(unitId(u));
                          ctx.setPatient(null);
                        }}
                      >
                        <strong>{nameOf(u)}</strong>
                      </button>
                      <p className="small-copy muted">
                        {u.kind === "clinic"
                          ? "Ambulatory treatment spaces; no inpatient capacity"
                          : "Nonclinical shelter; no hospital care"}
                      </p>
                      <BedGrid
                        physical={Number(u.physical ?? u.physical_capacity)}
                        staffed={Number(u.staffed ?? u.staffed_capacity)}
                        occupied={Number(u.occupied ?? 0)}
                        slots={slotRows(ctx, unitId(u))}
                        onSelectSlot={inspectSlot}
                      />
                    </div>
                  ))}
              </div>
              <BedLegend />
            </div>
          </section>
          <section className="patient-census">
            <div className="census-toolbar">
              <div>
                <h3>
                  {tab === "patients" ? "Patient census" : "Unit inventory"}{" "}
                  <span className="muted">
                    {tab === "patients" ? census.total : units.length}
                  </span>
                </h3>
                <span className="micro-label">{time(censusAt)}</span>
              </div>
              <div className="table-tools">
                <label className="search-input">
                  <Search size={14} />
                  <input
                    aria-label="Search patient ID"
                    placeholder="Find patient ID"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Patient state filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All states</option>
                  <option value="waiting">Awaiting placement</option>
                  <option value="inpatient">Inpatients</option>
                  <option value="ed_assessment">ED assessment</option>
                  <option value="in_transit">In transport</option>
                </select>
                {unit ? (
                  <Button small onClick={() => setUnit("")}>
                    Clear unit <X size={12} />
                  </Button>
                ) : null}
              </div>
            </div>
            {tab === "patients" ? (
              <details className="patient-filter-panel">
                <summary>
                  Care, waiting, arrival and remaining-stay filters
                </summary>
                <div className="patient-filter-grid">
                  <label>
                    Required care
                    <select
                      value={care}
                      onChange={(e) => setCare(e.target.value)}
                    >
                      <option value="">All care levels</option>
                      <option value="ward">Ward</option>
                      <option value="icu">ICU</option>
                      <option value="ambulatory">Ambulatory</option>
                    </select>
                  </label>
                  <label>
                    Current unit
                    <select
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                    >
                      <option value="">All units</option>
                      {units.map((u) => (
                        <option key={unitId(u)} value={unitId(u)}>
                          {nameOf(u)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Waiting reason
                    <select
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      disabled={!rep}
                    >
                      <option value="">All reasons</option>
                      {[
                        "nursing_capacity",
                        "minimum_operating_team",
                        "required_equipment_unavailable",
                        "no_matching_physical_place",
                        "place_turnover",
                        "destination_inactive",
                        "unsupported_care_capability",
                        "incoming_reservation",
                        "awaiting_transport_pickup",
                        "in_transit",
                        ...Object.keys(
                          ctx.state?.blocker_summary?.[ctx.selectedFacility] ||
                            {},
                        ),
                      ]
                        .filter(
                          (value, index, values) =>
                            values.indexOf(value) === index,
                        )
                        .map((value) => (
                          <option key={value} value={value}>
                            {value.replaceAll("_", " ")}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Transfer eligibility
                    <select
                      value={transfer}
                      onChange={(e) => setTransfer(e.target.value)}
                    >
                      <option value="">All declarations</option>
                      <option value="true">Declared eligible</option>
                      <option value="false">Declared ineligible</option>
                    </select>
                  </label>
                  <ZonedDateTimeInput
                    label="Arrived from"
                    timeZone={timeZone}
                    value={arrivedFrom}
                    onChange={setArrivedFrom}
                  />
                  <ZonedDateTimeInput
                    label="Arrived before"
                    timeZone={timeZone}
                    value={arrivedUntil}
                    onChange={setArrivedUntil}
                  />
                  <label>
                    Minimum remaining hours
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.1"
                      value={remainingMin}
                      onChange={(e) => setRemainingMin(e.target.value)}
                    />
                  </label>
                  <label>
                    Maximum remaining hours
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.1"
                      value={remainingMax}
                      onChange={(e) => setRemainingMax(e.target.value)}
                    />
                  </label>
                </div>
                <p className="small-copy muted">
                  Remaining filters use the retained stage sample for a
                  simulation or the supplied residual/template mean for a source
                  snapshot. Unknown or not-started stages do not match a numeric
                  range. Transfer eligibility is a patient declaration;
                  placement still requires destination and transport checks.
                  Waiting reasons are available after a simulation.
                </p>
                <Button
                  small
                  onClick={() => {
                    setCare("");
                    setReason("");
                    setArrivedFrom("");
                    setArrivedUntil("");
                    setRemainingMin("");
                    setRemainingMax("");
                    setTransfer("");
                    setUnit("");
                    setFilter("all");
                    setSearch("");
                  }}
                >
                  Clear census filters
                </Button>
              </details>
            ) : null}
            {census.error ? <ErrorBox error={census.error} /> : null}
            {census.loading && tab === "patients" ? (
              <div className="info-note" role="status">
                Loading this census page…
              </div>
            ) : null}
            <div className="table-scroll">
              {tab === "patients" ? (
                <table className="data-table patient-table">
                  <thead>
                    <tr>
                      <th>Patient ID</th>
                      <th>Current location</th>
                      <th>Required care</th>
                      <th>Elapsed stage</th>
                      <th>Remaining modeled stage</th>
                      <th>Time waiting</th>
                      <th>Required resources</th>
                      <th>Status</th>
                      <th>
                        <span className="muted">Inspect</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {census.rows.map((p) => (
                      <tr
                        key={patientId(p)}
                        className={
                          patientId(selected || {}) === patientId(p)
                            ? "selected"
                            : ""
                        }
                      >
                        <td className="patient-identity-cell">
                          <span className="patient-identity">
                            <span
                              className={`table-dot ${p.admission_pending || p.state === "ed_waiting" ? "amber-dot" : "cyan-dot"}`}
                            />
                            <button
                              className="link-button"
                              onClick={() => select(p)}
                            >
                              {patientId(p)}
                            </button>
                          </span>
                        </td>
                        <td data-label="Location">
                          {nameOf(
                            allUnits.find((u) => unitId(u) === p.unit_id) || {},
                          ) ||
                            p.state?.replaceAll("_", " ") ||
                            "—"}
                        </td>
                        <td data-label="Required care">
                          {p.target_unit_kind || p.care_level || "ambulatory"}
                        </td>
                        <td className="numeric" data-label="Elapsed stage">
                          {elapsed(p, censusAt) === null
                            ? "—"
                            : `${fmt(elapsed(p, censusAt), 1)} h`}
                        </td>
                        <td data-label="Remaining stage">
                          {p.remaining_summary?.hours == null ? (
                            <span className="muted">
                              {p.remaining_summary?.label || "Unavailable"}
                            </span>
                          ) : (
                            <>
                              <strong>
                                {fmt(p.remaining_summary.hours, 1)} h
                              </strong>
                              <small className="patient-cell-note">
                                {p.remaining_summary.label}
                              </small>
                            </>
                          )}
                        </td>
                        <td data-label="Time waiting">
                          {p.waiting_hours == null
                            ? "Unknown"
                            : `${fmt(p.waiting_hours, 1)} h`}
                        </td>
                        <td data-label="Resources">
                          {(p.placement_resource_requirements || []).length
                            ? p.placement_resource_requirements
                                .map((r: Entity | string) =>
                                  typeof r === "string"
                                    ? r.replaceAll("_", " ")
                                    : `${r.quantity || 1} × ${(r.capability_code || r.resource_profile_id || "resource").replaceAll("_", " ")}`,
                                )
                                .join(", ")
                            : "Standard care bundle"}
                        </td>
                        <td className="patient-status-cell" data-label="Status">
                          <span
                            className={p.admission_pending ? "amber" : "muted"}
                          >
                            {stateLabel(p)}
                          </span>
                        </td>
                        <td className="patient-inspect-cell">
                          <button
                            aria-label={`Inspect ${patientId(p)}`}
                            aria-controls="patients-inspector-dock"
                            onClick={() => select(p)}
                          >
                            <ChevronRight size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Unit</th>
                      <th>Type</th>
                      <th>Physical</th>
                      <th>Staffed</th>
                      <th>Occupied</th>
                      <th>Reserved / turnover</th>
                      <th>Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((u) => (
                      <tr key={unitId(u)}>
                        <td>
                          <button
                            className="link-button"
                            onClick={() => {
                              setUnit(unitId(u));
                              ctx.setPatient(null);
                            }}
                          >
                            {nameOf(u)}
                          </button>
                        </td>
                        <td>{u.kind}</td>
                        <td>{u.physical ?? u.physical_capacity}</td>
                        <td>{u.staffed ?? u.staffed_capacity}</td>
                        <td>
                          {u.occupied ??
                            patients.filter((p) => p.unit_id === unitId(u))
                              .length}
                        </td>
                        <td>
                          {u.reserved ?? 0} / {u.cleaning ?? 0}
                        </td>
                        <td>{u.available ?? "Profile checks apply"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="table-footer">
              <span>
                {tab === "patients"
                  ? `${Math.min(page * 30 + 1, census.total)}–${Math.min((page + 1) * 30, census.total)} of ${census.total} patients`
                  : `${units.length} units`}
              </span>
              {tab === "patients" ? (
                <div>
                  <button
                    disabled={!page || census.loading}
                    onClick={() => setPage((p) => p - 1)}
                    aria-label="Previous patient page"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    disabled={!census.hasNext || census.loading}
                    onClick={() => setPage((p) => p + 1)}
                    aria-label="Next patient page"
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        </div>
        <aside
          className="inspector patient-inspector"
          ref={inspectorRef}
          tabIndex={-1}
          aria-label="Patient and unit inspector"
          id="patients-inspector-dock"
          hidden={panels.inspectorHidden}
        >
          {detailError ? <ErrorBox error={detailError} /> : null}
          {current ? (
            <>
              <div className="inspector-header">
                <div className="inspector-icon">
                  <UserRound size={20} />
                </div>
                <div>
                  <span className="eyebrow">SELECTED PATIENT</span>
                  <h2>{patientId(current)}</h2>
                </div>
                <button
                  onClick={() => ctx.setPatient(null)}
                  aria-label="Close patient"
                >
                  <X size={17} />
                </button>
              </div>
              <div className="inspector-section">
                <Badge tone={current.admission_pending ? "warning" : "neutral"}>
                  {ctx.state && !currentState
                    ? "No longer active at selected time"
                    : stateLabel(current)}
                </Badge>
                <dl className="detail-list">
                  <div>
                    <dt>Current location</dt>
                    <dd>
                      {nameOf(currentUnit || {}) || "Transit / holding queue"}
                    </dd>
                  </div>
                  <div>
                    <dt>Actual slot</dt>
                    <dd>{current.slot_id || "No treatment slot"}</dd>
                  </div>
                  <div>
                    <dt>Required care</dt>
                    <dd>{current.target_unit_kind || current.care_level}</dd>
                  </div>
                  <div>
                    <dt>Arrival</dt>
                    <dd>{time(current.arrival_at)}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>
                      {current.arrival_origin === "synthetic_incident" ||
                      current.source_type === "synthetic_incident"
                        ? "Synthetic planned incident"
                        : (current.source_type || "initial_census").replaceAll(
                            "_",
                            " ",
                          )}
                    </dd>
                  </div>
                  <div>
                    <dt>Entry pathway</dt>
                    <dd>
                      {current.entry_type === "direct_ward"
                        ? "Direct ward admission"
                        : "Emergency department"}
                    </dd>
                  </div>
                  <div>
                    <dt>Model priority</dt>
                    <dd>{current.acuity_rank ?? "—"} · synthetic input</dd>
                  </div>
                </dl>
              </div>
              <div className="inspector-section">
                <h3>Remaining service</h3>
                {remaining !== null ? (
                  <p>
                    <strong>{fmt(remaining, 1)} hours</strong> remaining in this
                    selected trajectory.
                  </p>
                ) : spec?.kind === "fixed_minutes" ? (
                  <p>{fmt(spec.minutes / 60, 1)} hours supplied at snapshot.</p>
                ) : template ? (
                  <p>
                    Gamma(shape {template.shape}, scale {template.scale_hours}{" "}
                    h); mean {fmt(template.shape * template.scale_hours)} h
                    remaining at snapshot.
                  </p>
                ) : spec?.kind === "expected_end" ? (
                  <p>Expected end: {time(spec.expected_end_at)}</p>
                ) : (
                  <p className="small-copy muted">
                    {current.admission_pending
                      ? "Inpatient service begins only after suitable placement."
                      : "Remaining duration is defined by the current stage template."}
                  </p>
                )}
                <p className="small-copy muted">
                  {ctx.state
                    ? "Sampled operational service duration; not a clinical prognosis."
                    : "Snapshot residual stays are separate from new-admission stay templates."}
                </p>
              </div>
              <div className="inspector-section">
                <h3>Care pathway</h3>
                <div className="care-path">
                  {currentPath.map((label, i) => (
                    <div key={i} className={i === 0 ? "complete" : ""}>
                      <i />
                      {label}
                      {i < currentPath.length - 1 ? (
                        <ArrowRight size={14} />
                      ) : null}
                    </div>
                  ))}
                </div>
                {current.pending_transfer ? (
                  <p className="small-copy">
                    Transfer {current.pending_transfer.status}:{" "}
                    {current.pending_transfer.destination_unit_id}; arrival{" "}
                    {time(current.pending_transfer.planned_arrival_at)}. Source
                    resources remain occupied until actual departure.
                  </p>
                ) : null}
              </div>
              <div className="inspector-section">
                <h3>Placement requirements</h3>
                {current.blockers?.length ? (
                  <div className="constraint-callout">
                    <strong className="amber">
                      Current simultaneous blockers
                    </strong>
                    <ul>
                      {current.blockers.map((reason: string) => (
                        <li key={reason}>{reason.replaceAll("_", " ")}</li>
                      ))}
                    </ul>
                    <p>
                      These reasons come from the same resource ledger used for
                      admission. They can overlap.
                    </p>
                  </div>
                ) : null}
                <ul className="requirements-list">
                  <li>
                    Compatible {current.target_unit_kind || current.care_level}{" "}
                    place
                  </li>
                  <li>Qualified nursing and operating team</li>
                  {placementRequirements.map(
                    (x: Entity | string, i: number) => (
                      <li key={i}>
                        {(typeof x === "string"
                          ? x
                          : x.capability_code
                        )?.replaceAll("_", " ")}{" "}
                        × {typeof x === "string" ? 1 : x.quantity}
                      </li>
                    ),
                  )}
                </ul>
                {current.admission_pending ||
                current.state === "ed_boarding" ? (
                  <div className="constraint-callout">
                    <strong className="amber">
                      Awaiting suitable inpatient capacity
                    </strong>
                    <p>
                      {current.state === "ed_boarding"
                        ? "Retains the ED slot while awaiting compatible placement."
                        : "Waiting accrues until actual admission, including reserved transfer and travel."}
                    </p>
                  </div>
                ) : null}
                <Button
                  className="full-width"
                  disabled={!ctx.scenario}
                  onClick={() =>
                    ctx.action("Checking placement options", async () => {
                      const request = ++placementRequest.current;
                      const results = await Promise.all(
                        (ctx.dataset?.facilities || [])
                          .filter((f) => f.facility_id !== current.facility_id)
                          .map((f) =>
                            api(
                              `/sites/${f.facility_id}/eligibility?${rep && ctx.run?.scenario_revision_id ? `scenario_revision_id=${ctx.run.scenario_revision_id}` : `scenario_id=${ctx.scenario?.id}`}&patient_id=${patientId(current)}&care_level=${current.target_unit_kind || current.care_level}&replication_id=${rep || ""}&at=${encodeURIComponent(ctx.selectedTime)}`,
                            ),
                          ),
                      );
                      if (request === placementRequest.current)
                        setEligibility(results);
                    })
                  }
                >
                  Find placement options <ArrowUpRight size={15} />
                </Button>
                {eligibility.map((e, i) => (
                  <div className="eligibility-row" key={i}>
                    <strong>
                      {e.site?.name || e.site_id || "Destination"}
                    </strong>
                    <span className={e.eligible ? "green" : "amber"}>
                      {e.eligible
                        ? "Eligible"
                        : (e.reasons || e.rejection_reasons || []).join(
                            " · ",
                          ) || "Constraints apply"}
                    </span>
                  </div>
                ))}
              </div>
              {currentUnit ? (
                <div className="inspector-section">
                  <UnitDetails unit={currentUnit} />
                  <UnitEvidence ctx={ctx} unit={currentUnit} />
                </div>
              ) : null}
              <div className="inspector-section">
                <Button
                  className="full-width"
                  disabled={
                    ctx.canWrite === false ||
                    !!ctx.stateLoading ||
                    !!ctx.stateError
                  }
                  onClick={() =>
                    onUpdate({ kind: "patient", id: patientId(current) })
                  }
                >
                  Record change
                </Button>
              </div>
            </>
          ) : chosenUnit ? (
            <>
              <div className="inspector-header">
                <Hospital size={20} />
                <span className="eyebrow">UNIT AND PLACE DETAILS</span>
              </div>
              {selectedSlot ? (
                <div className="inspector-section">
                  <h3>{selectedSlot.slot_id}</h3>
                  <Badge>{selectedSlot.status}</Badge>
                  <p className="small-copy muted">
                    {selectedSlot.background_occupied
                      ? "Aggregate partner background occupancy; no individual patient record."
                      : selectedSlot.reservation_id
                        ? `Reserved for ${selectedSlot.reservation_id}`
                        : selectedSlot.cleaning_end_at
                          ? `Turnover ends ${time(selectedSlot.cleaning_end_at)}`
                          : "Physical readiness is separate from staffing and equipment availability."}
                  </p>
                </div>
              ) : null}
              <div className="inspector-section">
                <UnitDetails unit={chosenUnit} />
                <UnitEvidence ctx={ctx} unit={chosenUnit} />
                <Button
                  className="full-width"
                  disabled={
                    ctx.canWrite === false ||
                    !!ctx.stateLoading ||
                    !!ctx.stateError
                  }
                  onClick={() =>
                    onUpdate({
                      kind: selectedSlot ? "slot" : "unit",
                      id: selectedSlot?.slot_id || unitId(chosenUnit),
                    })
                  }
                >
                  Record change
                </Button>
              </div>
            </>
          ) : (
            <div className="patient-inspector-summary">
              <div className="inspector-header">
                <Hospital size={20} />
                <div>
                  <span className="eyebrow">SELECTED FACILITY</span>
                  <h2>Patient & unit census</h2>
                </div>
              </div>
              <div className="inspector-section">
                <div className="patient-summary-counts">
                  <div>
                    <strong>{facilityTotal}</strong>
                    <span>active patients</span>
                  </div>
                  <div>
                    <strong className={q.total ? "amber" : ""}>
                      {q.total}
                    </strong>
                    <span>awaiting placement</span>
                  </div>
                </div>
                <p className="small-copy muted">
                  Select a patient or physical place to see its current care,
                  remaining service and placement requirements.
                </p>
              </div>
              <div className="inspector-section">
                <h3>Explore units</h3>
                <div className="patient-unit-shortcuts">
                  {units.map((u) => (
                    <button key={unitId(u)} onClick={() => setUnit(unitId(u))}>
                      <span>
                        <strong>{nameOf(u)}</strong>
                        <small>{u.kind?.toUpperCase()}</small>
                      </span>
                      <span>
                        {u.occupied ??
                          patients.filter((p) => p.unit_id === unitId(u))
                            .length}{" "}
                        / {u.staffed ?? u.staffed_capacity}
                        <small>occupied / staffed</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
      <PlanningTimelineDock panels={panels} name="patients" ctx={ctx} />
    </div>
  );
}
