import { useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BedDouble,
  Building2,
  CalendarRange,
  Clock3,
  Info,
  ShieldCheck,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import {
  Badge,
  BedGrid,
  BedLegend,
  Button,
  CapacityBar,
} from "../components/ui";
import { ForecastChart, Timeline } from "../components/Charts";
import { fmt, localDate } from "../api";
import {
  nameOf,
  patientsOf,
  queueStats,
  selectedRunNumber,
  stateUnavailable,
  statsFor,
} from "../model";
import { finiteStatistic } from "./resultsMetrics";
import "./summaryDashboard.css";

function selectedRow(rows: Entity[], at: string) {
  if (!rows.length) return 0;
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return 0;
  let closest = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const current = Date.parse(rows[index].at || rows[index].start_at);
    const prior = Date.parse(rows[closest].at || rows[closest].start_at);
    if (Math.abs(current - target) < Math.abs(prior - target)) closest = index;
  }
  return closest;
}

export default function Overview({
  ctx,
  onUpdate,
}: {
  ctx: PlanningContext;
  onUpdate: () => void;
}) {
  const [operationsOpen, setOperationsOpen] = useState(false);
  const ward = statsFor(ctx, "ward");
  const icu = statsFor(ctx, "icu");
  const ed = statsFor(ctx, "ed");
  const queue = queueStats(ctx);
  const selectedStateUnavailable = stateUnavailable(ctx);
  const metric = ctx.metrics?.scalar_metrics || {};
  const rows: Entity[] = ctx.metrics?.series || ctx.metrics?.daily || [];
  const rowIndex = selectedRow(rows, ctx.selectedTime);
  const firstShortage = metric.time_to_first_shortage_hours;
  const peakQueue = metric.peak_inpatient_queue;
  const predictedShortage = finiteStatistic(firstShortage);
  const noRecordedQueue = finiteStatistic(peakQueue, "max") === 0;
  const admissionWait = finiteStatistic(metric.completed_wait_median_hours);
  const hasPressure = !queue.unavailable && queue.total > 0;
  const facility = ctx.dataset?.facilities?.find(
    (item) => (item.id || item.facility_id) === ctx.selectedFacility,
  );
  const wardIds = new Set(ward.units.map((unit) => unit.unit_id || unit.id));
  const patients = patientsOf(ctx);
  const wardSlots = (
    selectedStateUnavailable ? [] : ctx.state?.slots || ctx.dataset?.slots || []
  )
    .filter(
      (slot: Entity) =>
        wardIds.has(slot.unit_id) && slot.installation_status === "installed",
    )
    .map((slot: Entity) => {
      const patient = patients.find((item) => item.slot_id === slot.slot_id);
      return {
        ...slot,
        patient_id: slot.patient_id || patient?.patient_id,
        status:
          slot.status ||
          (patient ? "occupied" : slot.enabled ? "ready" : "disabled"),
      };
    });
  const insight = hasPressure
    ? {
        tone: "warning" as const,
        title: `${queue.total} patients are waiting for a bed`,
        body: `${queue.ward} need ward care and ${queue.icu} need intensive care. Review patients first, then compare response options.`,
      }
    : predictedShortage !== null
      ? {
          tone: "warning" as const,
          title: `Patients may start waiting for beds after ${fmt(predictedShortage, 1)} hours`,
          body: "Timing includes only runs with a bed queue. Compare staffing and extra hospital beds.",
        }
      : {
          tone: noRecordedQueue ? ("success" as const) : ("neutral" as const),
          title: noRecordedQueue
            ? "No inpatient bed queue in these results"
            : "Review the queue charts for bed pressure",
          body: noRecordedQueue
            ? "Try higher demand or fewer staff to test the plan's limits."
            : "The first waiting time was not recorded. Inspect the queue and capacity charts before choosing a response.",
        };

  return (
    <div className="summary-dashboard">
      <header className="page-heading summary-heading">
        <div>
          <h1>Results summary</h1>
          <p>
            A clear view of occupancy, waiting, and where action may be needed.
          </p>
        </div>
        <div className="heading-actions">
          <span className="summary-as-of">
            <Clock3 size={15} aria-hidden="true" />
            <span>
              Selected time
              <strong>
                {localDate(ctx.selectedTime, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </strong>
            </span>
          </span>
          <Button disabled={ctx.canWrite === false} onClick={onUpdate}>
            Record update
          </Button>
        </div>
      </header>

      <section className="summary-metrics" aria-label="Hospital summary">
        <article className="stat">
          <span>Ward occupancy</span>
          <strong>
            {ward.unavailable ? "—" : `${ward.occupied} / ${ward.staffed}`}
          </strong>
          <small>
            {selectedStateUnavailable
              ? "Selected-time state unavailable"
              : `${ward.available} suitable places available now`}
          </small>
        </article>
        <article className="stat">
          <span>ICU occupancy</span>
          <strong>
            {icu.unavailable ? "—" : `${icu.occupied} / ${icu.staffed}`}
          </strong>
          <small>
            {selectedStateUnavailable
              ? "Selected-time state unavailable"
              : `${icu.available} suitable places available now`}
          </small>
        </article>
        <article className={`stat${hasPressure ? " needs-attention" : ""}`}>
          <span>Patients waiting for a bed</span>
          <strong>{queue.unavailable ? "—" : queue.total}</strong>
          <small>
            {selectedStateUnavailable
              ? "Selected-time state unavailable"
              : `${queue.ward} ward · ${queue.icu} ICU`}
          </small>
        </article>
        <article className="stat">
          <span>Typical admission wait</span>
          <strong>
            {ctx.metrics && admissionWait !== null
              ? `${fmt(admissionWait, 1)} h`
              : "—"}
          </strong>
          <small>completed admissions · median across runs</small>
        </article>
      </section>

      <section className={`summary-insight ${insight.tone}`}>
        <div className="summary-insight-icon">
          {insight.tone === "warning" ? (
            <Activity size={22} aria-hidden="true" />
          ) : insight.tone === "success" ? (
            <ShieldCheck size={22} aria-hidden="true" />
          ) : (
            <Info size={22} aria-hidden="true" />
          )}
        </div>
        <div>
          <span>What needs attention</span>
          <h2>{insight.title}</h2>
          <p>{insight.body}</p>
        </div>
        <div className="summary-insight-actions">
          {hasPressure ? (
            <Button onClick={() => ctx.setPage("patients")}>
              Review patients <ArrowRight size={14} />
            </Button>
          ) : null}
          <Button
            primary
            onClick={() =>
              ctx.setPage(noRecordedQueue ? "overview" : "compare")
            }
          >
            {noRecordedQueue ? "Test another scenario" : "Compare responses"}{" "}
            <ArrowUpRight size={14} />
          </Button>
        </div>
      </section>

      <section className="summary-chart-grid" aria-label="Forecast charts">
        <article className="summary-chart-card summary-chart-card-wide">
          <div className="summary-card-heading">
            <div>
              <span className="eyebrow">OCCUPANCY FORECAST</span>
              <h2>Occupied and staffed beds</h2>
            </div>
            <Badge>{ctx.metrics ? "Median forecast" : "Awaiting run"}</Badge>
          </div>
          <ForecastChart
            rows={rows}
            keys={[
              "ward_occupied",
              "ward_staffed",
              "icu_occupied",
              "icu_staffed",
            ]}
            labels={[
              "Ward occupied",
              "Ward staffed",
              "ICU occupied",
              "ICU staffed",
            ]}
            height={220}
            selected={rowIndex}
            onSelect={(index) =>
              ctx.setTime(rows[index].at || rows[index].start_at)
            }
            yLabel="Patients and staffed beds"
          />
          <p>
            Solid lines show occupied beds. Dashed lines show staffing-supported
            capacity. Select any point to update the rest of the workspace.
          </p>
        </article>
        <article className="summary-chart-card">
          <div className="summary-card-heading">
            <div>
              <span className="eyebrow">WAITING PRESSURE</span>
              <h2>Patients waiting</h2>
            </div>
          </div>
          <ForecastChart
            rows={rows}
            keys={["inpatient_queue", "ed_queue"]}
            labels={["Waiting for a bed", "Waiting for emergency assessment"]}
            height={220}
            selected={rowIndex}
            onSelect={(index) =>
              ctx.setTime(rows[index].at || rows[index].start_at)
            }
            showBand={false}
            yLabel="Patients waiting"
          />
          <p>
            See the people waiting for a bed and those waiting for emergency
            assessment.
          </p>
        </article>
      </section>

      <details
        className="summary-details"
        open={operationsOpen}
        onToggle={(event) => setOperationsOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="summary-details-icon">
            <Building2 size={18} />
          </span>
          <span>
            <strong>Hospital and bed details</strong>
            <small>Ward beds, available capacity, and patient details</small>
          </span>
          <span>{operationsOpen ? "Hide" : "Show"}</span>
        </summary>
        {operationsOpen ? (
          selectedStateUnavailable ? (
            <div className="summary-state-unavailable" role="status">
              <Info size={18} aria-hidden="true" />
              <div>
                <strong>Selected-time details are unavailable</strong>
                <span>
                  {ctx.stateLoading
                    ? "Loading the recorded simulation state for this time…"
                    : "The recorded simulation state could not be loaded. Choose another time or try again."}
                </span>
              </div>
            </div>
          ) : (
            <>
              <section
                className="summary-current-state"
                aria-labelledby="current-state-title"
              >
                <div className="summary-section-heading">
                  <div>
                    <span className="eyebrow">AT THE SELECTED TIME</span>
                    <h2 id="current-state-title">Capacity at a glance</h2>
                  </div>
                  <span>
                    {ctx.run?.status === "SUCCEEDED"
                      ? `Example run ${selectedRunNumber(ctx) || "—"}`
                      : "Initial census"}
                  </span>
                </div>
                <div className="summary-capacity-grid">
                  <CapacityBar
                    label="General ward"
                    {...ward}
                    capacity={ward.staffed}
                  />
                  <CapacityBar
                    label="Intensive care"
                    {...icu}
                    capacity={icu.staffed}
                    color="red"
                  />
                  <CapacityBar
                    label="Emergency department"
                    {...ed}
                    capacity={ed.staffed}
                    color="green"
                  />
                </div>
              </section>
              <div className="summary-operations-grid">
                <section className="summary-bed-panel">
                  <div className="summary-card-heading">
                    <div>
                      <span className="eyebrow">HOSPITAL WARD</span>
                      <h2>{nameOf(facility || {}) || "Central Hospital"}</h2>
                    </div>
                  </div>
                  <div className="summary-bed-heading">
                    <span>
                      <BedDouble size={16} /> Ward places
                    </span>
                    <strong>
                      {ward.physical} physical · {ward.staffed} staffed
                    </strong>
                  </div>
                  <BedGrid
                    physical={ward.physical}
                    staffed={ward.staffed}
                    occupied={ward.occupied}
                    cleaning={ward.cleaning}
                    slots={wardSlots}
                    onSelectSlot={(slot) => {
                      ctx.setPatient(
                        patients.find(
                          (patient) => patient.slot_id === slot.slot_id,
                        ) ||
                          (slot.patient_id
                            ? { patient_id: slot.patient_id }
                            : null),
                      );
                      ctx.setPage("patients");
                    }}
                  />
                  <BedLegend />
                  {ward.physical > ward.staffed ? (
                    <div className="summary-detail-note">
                      <Info size={15} />
                      <span>
                        {ward.physical - ward.staffed} physical places do not
                        have enough qualified staff to count as usable capacity.
                      </span>
                    </div>
                  ) : null}
                </section>
              </div>
            </>
          )
        ) : null}
      </details>

      <details className="summary-details summary-timeline-details">
        <summary>
          <span className="summary-details-icon">
            <CalendarRange size={18} />
          </span>
          <span>
            <strong>Open exact forecast timeline</strong>
            <small>
              Review interventions, updates, and choose a precise time
            </small>
          </span>
          <span>Show</span>
        </summary>
        <Timeline ctx={ctx} />
      </details>
    </div>
  );
}
