import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Clock3,
  Hospital,
  Info,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
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
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false),
    [timelineCollapsed, setTimelineCollapsed] = useState(false),
    [timelineHeight, setTimelineHeight] = useState(260);
  const timelineDrag = useRef<{ y: number; height: number } | null>(null);
  const resizeTimeline = (height: number) =>
    setTimelineHeight(Math.max(180, Math.min(420, height)));
  const ward = statsFor(ctx, "ward"),
    icu = statsFor(ctx, "icu"),
    ed = statsFor(ctx, "ed"),
    q = queueStats(ctx);
  const facility = ctx.dataset?.facilities?.find(
    (f) => (f.id || f.facility_id) === ctx.selectedFacility,
  );
  const metric = ctx.metrics?.scalar_metrics || {};
  const peakQueue = metric.peak_inpatient_queue;
  const firstShortage = metric.time_to_first_shortage_hours;
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
    <div
      className={`overview-page${inspectorCollapsed ? " inspector-collapsed" : ""}${timelineCollapsed ? " timeline-collapsed" : ""}`}
      style={
        {
          "--overview-timeline-height": `${timelineCollapsed ? 0 : timelineHeight}px`,
        } as CSSProperties
      }
    >
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
          <button
            className="icon-button overview-layout-control"
            onClick={() => setInspectorCollapsed(!inspectorCollapsed)}
            aria-label={
              inspectorCollapsed
                ? "Show facility inspector"
                : "Hide facility inspector"
            }
            aria-expanded={!inspectorCollapsed}
            aria-controls="overview-facility-inspector"
            title={
              inspectorCollapsed
                ? "Show facility inspector"
                : "Hide facility inspector"
            }
          >
            {inspectorCollapsed ? (
              <PanelRightOpen size={18} />
            ) : (
              <PanelRightClose size={18} />
            )}
          </button>
          <button
            className="icon-button overview-layout-control"
            onClick={() => setTimelineCollapsed(!timelineCollapsed)}
            aria-label={
              timelineCollapsed
                ? "Show forecast timeline"
                : "Hide forecast timeline"
            }
            aria-expanded={!timelineCollapsed}
            aria-controls="overview-timeline-dock"
            title={
              timelineCollapsed
                ? "Show forecast timeline"
                : "Hide forecast timeline"
            }
          >
            {timelineCollapsed ? (
              <PanelBottomOpen size={18} />
            ) : (
              <PanelBottomClose size={18} />
            )}
          </button>
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
              ? (ctx.resultScenario || ctx.scenario)?.measurement_start_at
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
        <aside
          className="inspector"
          id="overview-facility-inspector"
          hidden={inspectorCollapsed}
        >
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
            <p className="capacity-ledger-summary">
              {ward.unavailable
                ? "Selected-time state unavailable"
                : `${ward.ready} ready · ${ward.reserved} reserved · ${ward.cleaning} in turnover · ${ward.available} suitable available`}
            </p>
            <CapacityBar
              label="Intensive care"
              {...icu}
              capacity={icu.staffed}
              color={icu.occupied >= icu.staffed ? "red" : "cyan"}
            />
            <p className="capacity-ledger-summary">
              {icu.unavailable
                ? "Selected-time state unavailable"
                : `${icu.ready} ready · ${icu.reserved} reserved · ${icu.cleaning} in turnover · ${icu.available} suitable available`}
            </p>
            {main ? (
              <CapacityBar
                label="Emergency department"
                {...ed}
                capacity={ed.staffed}
                color="green"
              />
            ) : null}
          </div>
          <div className="inspector-section forecast-outlook">
            <div className="spread">
              <h3>Forecast outlook</h3>
              <span className="micro-label">SYSTEM-WIDE</span>
            </div>
            <dl>
              <div>
                <dt>Peak inpatient queue · P10–P90</dt>
                <dd>
                  {peakQueue?.p10 != null
                    ? `${fmt(peakQueue.p10, 1)}–${fmt(peakQueue.p90, 1)} patients`
                    : "Awaiting simulation"}
                </dd>
              </div>
              <div>
                <dt>First unmet demand · median</dt>
                <dd>
                  {firstShortage?.p50 != null
                    ? `${fmt(firstShortage.p50, 1)} hours`
                    : ctx.metrics
                      ? "None in completed runs"
                      : "Awaiting simulation"}
                </dd>
              </div>
            </dl>
            <p>
              Full forecast interval. First-unmet time is measured from the
              forecast start or update cutoff, among runs with unmet demand.
            </p>
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
      <div
        className="overview-timeline-dock"
        id="overview-timeline-dock"
        hidden={timelineCollapsed}
      >
        <div
          className="timeline-resize-handle"
          role="separator"
          aria-label="Resize forecast timeline"
          aria-orientation="horizontal"
          aria-valuemin={180}
          aria-valuemax={420}
          aria-valuenow={timelineHeight}
          aria-valuetext={`${timelineHeight} pixels high`}
          title="Drag to resize timeline. Arrow keys resize by 10 pixels."
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            timelineDrag.current = { y: event.clientY, height: timelineHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = timelineDrag.current;
            if (drag) resizeTimeline(drag.height + drag.y - event.clientY);
          }}
          onPointerUp={(event) => {
            timelineDrag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            timelineDrag.current = null;
          }}
          onKeyDown={(event) => {
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              resizeTimeline(
                event.key === "Home"
                  ? 180
                  : event.key === "End"
                    ? 420
                    : timelineHeight + (event.key === "ArrowUp" ? 10 : -10),
              );
            }
          }}
        >
          <span />
        </div>
        <Timeline ctx={ctx} />
      </div>
    </div>
  );
}
