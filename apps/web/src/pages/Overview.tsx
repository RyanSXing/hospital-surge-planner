import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Clock3,
  Hospital,
  Info,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { PlanningContext } from "../types";
import CampusMap from "../components/CampusMap";
import {
  Badge,
  BedGrid,
  BedLegend,
  Button,
  CapacityBar,
  LinkButton,
  Stat,
} from "../components/ui";
import { Timeline } from "../components/Charts";
import { fmt, localDate, num } from "../api";
import {
  nameOf,
  patientsOf,
  queueStats,
  selectedRunNumber,
  statsFor,
} from "../model";
export default function Overview({
  ctx,
  onUpdate,
}: {
  ctx: PlanningContext;
  onUpdate: () => void;
}) {
  const ward = statsFor(ctx, "ward"),
    icu = statsFor(ctx, "icu"),
    ed = statsFor(ctx, "ed"),
    q = queueStats(ctx);
  const facility = ctx.dataset?.facilities?.find(
    (f) => (f.id || f.facility_id) === ctx.selectedFacility,
  );
  const metric = ctx.metrics?.scalar_metrics || {};
  const wardIds = new Set(ward.units.map((u) => u.unit_id || u.id)),
    wardSlots = (ctx.state?.slots || ctx.dataset?.slots || [])
      .filter(
        (s: any) =>
          wardIds.has(s.unit_id) && s.installation_status === "installed",
      )
      .map((s: any) => ({
        ...s,
        patient_id:
          s.patient_id ||
          patientsOf(ctx).find((p) => p.slot_id === s.slot_id)?.patient_id,
        status:
          s.status ||
          (patientsOf(ctx).some((p) => p.slot_id === s.slot_id)
            ? "occupied"
            : s.enabled
              ? "ready"
              : "disabled"),
      }));
  const main = ctx.selectedFacility === "FAC-MAIN";
  return (
    <div className="overview-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            OPERATIONS WORKSPACE <span className="eyebrow-divider">/</span>{" "}
            CAPACITY PLANNING
          </div>
          <h1>Command overview</h1>
          <p>Understand pressure. Explore your next response.</p>
        </div>
        <div className="heading-actions">
          <span className="as-of">
            <Clock3 size={13} />{" "}
            {ctx.run?.status === "SUCCEEDED"
              ? "Selected simulated state"
              : "Dataset as of"}{" "}
            <strong>
              {localDate(ctx.selectedTime, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </strong>
          </span>
          <Button disabled={ctx.canWrite === false} onClick={onUpdate}>
            <span>+</span> Record update
          </Button>
        </div>
      </div>
      <div className="kpi-strip">
        <Stat
          label="Ward occupancy"
          value={ward.unavailable ? "—" : `${ward.occupied} / ${ward.staffed}`}
          unit="beds"
          change={`${ward.physical} physical · ${ward.physical - ward.staffed} unstaffed`}
          tone="cyan"
        />
        <Stat
          label="ICU occupancy"
          value={icu.unavailable ? "—" : `${icu.occupied} / ${icu.staffed}`}
          unit="beds"
          change={
            icu.occupied >= icu.staffed && icu.staffed
              ? "At staffing-supported capacity"
              : `${icu.available} available suitable places`
          }
          tone={icu.occupied >= icu.staffed ? "red" : ""}
        />
        <Stat
          label="Awaiting inpatient placement"
          value={q.unavailable ? "—" : q.total}
          unit="patients"
          change={`${q.ward} awaiting ward · ${q.icu} awaiting ICU`}
          tone={q.total ? "amber" : ""}
        />
        <Stat
          label="System-wide waiting burden"
          value={
            ctx.metrics ? fmt(num(metric.inpatient_waiting_patient_hours)) : "—"
          }
          unit="patient-hours"
          change={
            ctx.metrics
              ? ctx.scenario?.measurement_start_at
                ? "From update cutoff · Median across runs"
                : "Full horizon · Median across runs"
              : "Run a scenario to calculate"
          }
        />
      </div>
      <div className="overview-workspace">
        <div className="overview-center">
          <CampusMap ctx={ctx} />
          <div className="map-caption">
            <span>
              <ShieldCheck size={13} /> Source:{" "}
              {ctx.state
                ? "selected simulation run"
                : "synthetic planning dataset"}
            </span>
            <span>
              {ctx.run?.status === "SUCCEEDED"
                ? `Example run ${selectedRunNumber(ctx) || "—"}`
                : "Initial census"}{" "}
              <b>·</b> {ctx.dataset?.fixture?.replaceAll("_", " ")}
            </span>
          </div>
        </div>
        <aside className="inspector">
          <div className="inspector-header">
            <div className="inspector-icon">
              <Hospital size={21} />
            </div>
            <div>
              <span className="eyebrow">SELECTED FACILITY</span>
              <h2>{nameOf(facility || {}) || "Central Hospital"}</h2>
            </div>
            <Badge tone={main ? "success" : "neutral"}>
              {main ? "Active" : facility?.status || "Planning"}
            </Badge>
          </div>
          <div className="inspector-section">
            <div className="spread">
              <h3>Ward bed availability</h3>
              <span className="numeric muted">{ward.physical} places</span>
            </div>
            <BedGrid
              physical={ward.physical}
              staffed={ward.staffed}
              occupied={ward.occupied}
              cleaning={ward.cleaning}
              slots={wardSlots}
              onSelectSlot={(slot) => {
                ctx.setPatient(
                  patientsOf(ctx).find((p) => p.slot_id === slot.slot_id) ||
                    (slot.patient_id ? { patient_id: slot.patient_id } : null),
                );
                ctx.setPage("patients");
              }}
            />
            <BedLegend />
            {ward.physical > ward.staffed ? (
              <div className="constraint-callout">
                <Info size={15} />
                <div>
                  <strong>
                    {ward.physical - ward.staffed} beds need staffing
                  </strong>
                  <p>
                    Physical space is available. Qualified staff determine
                    usable capacity.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
          <div className="inspector-section">
            <div className="spread">
              <h3>Operational capacity</h3>
              <span className="micro-label">
                {ctx.state ? "SELECTED RUN" : "INITIAL STATE"}
              </span>
            </div>
            <CapacityBar
              label="General ward"
              {...ward}
              capacity={ward.staffed}
            />
            <CapacityBar
              label="Intensive care"
              {...icu}
              capacity={icu.staffed}
              color={icu.occupied >= icu.staffed ? "red" : "cyan"}
            />
            {main ? (
              <CapacityBar
                label="Emergency department"
                {...ed}
                capacity={ed.staffed}
                color="green"
              />
            ) : null}
          </div>
          <div className="inspector-section bottleneck-section">
            <div className="spread">
              <h3>Placement constraints</h3>
              <Badge tone={q.total ? "warning" : "success"}>
                {q.unavailable
                  ? "State loading"
                  : q.total
                    ? "Unmet demand"
                    : "Within capacity"}
              </Badge>
            </div>
            {q.unavailable ? (
              <p className="small-copy muted">
                Loading the exact patient and resource state for the selected
                time.
              </p>
            ) : q.total ? (
              <>
                <button
                  className="bottleneck-row"
                  onClick={() => ctx.setPage("patients")}
                >
                  <span className="amber-dot" />
                  <span>Ward placement</span>
                  <strong>{q.ward} waiting</strong>
                  <ChevronRight size={15} />
                </button>
                <button
                  className="bottleneck-row"
                  onClick={() => ctx.setPage("patients")}
                >
                  <span className="red-dot" />
                  <span>ICU placement</span>
                  <strong>{q.icu} waiting</strong>
                  <ChevronRight size={15} />
                </button>
              </>
            ) : (
              <div className="no-pressure">
                <ShieldCheck size={19} />
                <p>
                  No inpatient queue at this time.
                  <small>
                    Future pressure depends on the selected scenario.
                  </small>
                </p>
              </div>
            )}
            <Button
              primary
              className="full-width"
              onClick={() => ctx.setPage("compare")}
            >
              Compare responses <ArrowUpRight size={16} />
            </Button>
            <LinkButton onClick={() => ctx.setPage("patients")}>
              Inspect patients and units
            </LinkButton>
          </div>
          <div className="inspector-foot">
            <span className="tiny-square" /> Planning outputs · Proposed actions
          </div>
        </aside>
      </div>
      <Timeline ctx={ctx} />
    </div>
  );
}
