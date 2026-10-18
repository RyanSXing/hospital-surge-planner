import type { ReactNode } from "react";
import { ArrowRight, Clock3, Database, Hospital, Layers } from "lucide-react";
import type { PlanningContext } from "../types";
import { fmt, localDate, unitId } from "../api";
import { isActive, nameOf, queueStats, statsFor } from "../model";
import { Button } from "../components/ui";
import "./planningOverview.css";

export interface PlanningOverviewProps {
  /** The editable scenario's source dataset, independent of result context. */
  ctx: PlanningContext;
  /** Keep the existing editor mounted here to retain all setup and draft state. */
  configuration: ReactNode;
  onInspectBaseline: () => void;
  onOpenAnalysis?: () => void;
}

export default function PlanningOverview({
  ctx,
  configuration,
  onInspectBaseline,
  onOpenAnalysis,
}: PlanningOverviewProps) {
  const dataset = ctx.dataset;
  const hospitals = (dataset?.facilities || []).filter(
    (facility) => facility.kind === "hospital",
  );
  const hospital =
    hospitals.find(
      (facility) =>
        (facility.facility_id || facility.id) === ctx.selectedFacility,
    ) ||
    hospitals[0] ||
    dataset?.facilities?.[0];
  const facilityId = hospital?.facility_id || hospital?.id || "";
  // Overview is the source census, even after a completed run or an Analysis
  // time/replication selection. No simulated state enters these calculations.
  const baseline: PlanningContext = {
    ...ctx,
    dataset,
    run: null,
    resultScenario: null,
    state: null,
    stateLoading: false,
    stateError: null,
    metrics: null,
    selectedFacility: facilityId,
    selectedTime: dataset?.snapshot_at || "",
  };
  const ward = statsFor(baseline, "ward"),
    icu = statsFor(baseline, "icu"),
    ed = statsFor(baseline, "ed"),
    queue = queueStats(baseline);
  const units = (dataset?.units || []).filter(
    (unit) => unit.facility_id === facilityId,
  );
  const unitIds = new Set(units.map(unitId));
  const census = (dataset?.patients || []).filter(
    (patient) =>
      isActive(patient) &&
      (patient.facility_id === facilityId ||
        (!patient.facility_id && unitIds.has(patient.unit_id))),
  );
  const background = units.reduce(
    (total, unit) => total + Number(unit.background_occupied || 0),
    0,
  );
  const timeZone = dataset?.timezone || "America/Chicago";
  const at = dataset?.snapshot_at
    ? localDate(dataset.snapshot_at, {
        timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "Source timestamp unavailable";
  const run = ctx.run;

  return (
    <div className="planning-overview-page">
      <header className="page-heading planning-overview-heading">
        <div>
          <h1>Hospital overview</h1>
        </div>
        <div className="heading-actions">
          <Button onClick={onInspectBaseline} disabled={!dataset}>
            <Database size={15} /> Inspect baseline data
          </Button>
          {onOpenAnalysis && run?.status === "SUCCEEDED" ? (
            <Button onClick={onOpenAnalysis}>
              View analysis <ArrowRight size={15} />
            </Button>
          ) : null}
        </div>
      </header>

      <section
        className="planning-baseline"
        aria-labelledby="planning-baseline-title"
        data-baseline-dataset={dataset?.id || dataset?.dataset_version_id}
        data-baseline-at={dataset?.snapshot_at}
      >
        <div className="planning-baseline-heading">
          <div className="planning-baseline-identity">
            <Hospital size={22} aria-hidden="true" />
            <div>
              <h2 id="planning-baseline-title">
                {hospital
                  ? nameOf(hospital).replace(/^Demo /, "")
                  : "Hospital baseline"}
              </h2>
              <span>
                {fmt(census.length)} patients
                {background ? ` · ${fmt(background)} background occupants` : ""}
              </span>
            </div>
          </div>
          <div className="planning-baseline-source">
            <span className="planning-baseline-asof">
              <Clock3 size={13} aria-hidden="true" /> As of {at}
            </span>
          </div>
        </div>

        <div className="planning-baseline-metrics">
          <div
            className="baseline-capacity-chart"
            aria-label="Hospital baseline occupancy"
          >
            <div className="baseline-chart-heading">
              <h3>Capacity at a glance</h3>
              <div className="baseline-chart-legend">
                <span>
                  <i />
                  Occupied
                </span>
                <span>
                  <i />
                  Staffed capacity
                </span>
              </div>
            </div>
            {[
              { label: "Ward", value: ward, unit: "beds" },
              { label: "ICU", value: icu, unit: "beds" },
              { label: "Emergency department", value: ed, unit: "places" },
            ].map(({ label, value, unit }) => (
              <div className="baseline-capacity-row" key={label}>
                <div className="baseline-capacity-label">
                  <strong>{label}</strong>
                  <span>
                    {fmt(value.occupied)} / {fmt(value.staffed)}{" "}
                    <small>{unit}</small>
                  </span>
                </div>
                <div
                  className="baseline-capacity-bar"
                  role="meter"
                  aria-label={`${label} occupied places`}
                  aria-valuemin={0}
                  aria-valuemax={Math.max(1, value.staffed, value.occupied)}
                  aria-valuenow={value.occupied}
                  aria-valuetext={`${fmt(value.occupied)} occupied of ${fmt(value.staffed)} staffed ${unit}`}
                >
                  <span
                    style={{
                      width: `${value.staffed > 0 ? Math.min(100, (100 * value.occupied) / value.staffed) : value.occupied ? 100 : 0}%`,
                    }}
                    className={
                      value.occupied > value.staffed
                        ? "capacity-above-staffing"
                        : undefined
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="baseline-queue-summary">
            <div className="planning-baseline-metric">
              <span>Patients awaiting a bed</span>
              <strong className={queue.total ? "baseline-pressure" : ""}>
                {fmt(queue.total)}
              </strong>
              <span>
                {fmt(queue.ward)} ward · {fmt(queue.icu)} ICU
              </span>
            </div>
            <div className="baseline-assessment">
              <span>Awaiting ED assessment</span>
              <strong>{fmt(queue.ed)}</strong>
            </div>
          </div>
        </div>

        <div className="planning-baseline-footer">
          <details className="planning-baseline-units">
            <summary>
              <Layers size={14} aria-hidden="true" /> Baseline unit inventory
              <span>{units.length} units</span>
            </summary>
            <div className="table-scroll">
              <table className="data-table">
                <caption>
                  Source inventory at {at}. Occupancy includes declared
                  background occupants.
                </caption>
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Care type</th>
                    <th>Occupied</th>
                    <th>Staffed</th>
                    <th>Installed</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((unit) => {
                    const context = {
                      ...baseline,
                      dataset: dataset ? { ...dataset, units: [unit] } : null,
                    };
                    const counts = statsFor(context, unit.kind);
                    return (
                      <tr key={unitId(unit)}>
                        <th scope="row">{nameOf(unit)}</th>
                        <td>
                          {unit.kind === "shelter"
                            ? "Nonclinical shelter"
                            : unit.kind?.toUpperCase()}
                        </td>
                        <td>{fmt(counts.occupied)}</td>
                        <td>{fmt(counts.staffed)}</td>
                        <td>{fmt(counts.physical)}</td>
                        <td>{fmt(counts.enabled)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>

      <section
        className="planning-overview-configuration"
        aria-label="Simulation configuration"
      >
        {configuration}
      </section>
    </div>
  );
}
