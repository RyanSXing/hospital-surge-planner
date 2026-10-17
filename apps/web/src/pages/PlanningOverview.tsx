import type { ReactNode } from "react";
import { ArrowRight, Clock3, Database, Hospital, Layers } from "lucide-react";
import type { PlanningContext } from "../types";
import { fmt, localDate, unitId } from "../api";
import { isActive, nameOf, queueStats, statsFor } from "../model";
import { Badge, Button } from "../components/ui";
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
  const runStatus = run?.status?.replaceAll("_", " ").toLowerCase();
  const running =
    run &&
    [
      "VALIDATING",
      "QUEUED",
      "RUNNING",
      "AGGREGATING",
      "CANCEL_REQUESTED",
    ].includes(run.status);

  return (
    <div className="planning-overview-page">
      <header className="page-heading planning-overview-heading">
        <div>
          <div className="eyebrow">OVERVIEW · BASELINE &amp; SIMULATION</div>
          <h1>Hospital overview</h1>
          <p>Review the starting hospital, then configure your simulation.</p>
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
                {hospital ? nameOf(hospital) : "Hospital baseline"}
              </h2>
              <span>
                {fmt(census.length)} modeled patients
                {background ? ` · ${fmt(background)} background occupants` : ""}
                {" · "}Source census
              </span>
            </div>
          </div>
          <div className="planning-baseline-source">
            <span className="planning-baseline-asof">
              <Clock3 size={13} aria-hidden="true" /> As of {at}
            </span>
            <Badge tone={dataset?.synthetic ? "amber" : "neutral"}>
              {dataset?.synthetic ? "Synthetic baseline" : "Dataset baseline"}
            </Badge>
          </div>
        </div>

        <div className="planning-baseline-metrics">
          {[
            { label: "Ward", value: ward, unit: "beds" },
            { label: "ICU", value: icu, unit: "beds" },
            { label: "Emergency department", value: ed, unit: "places" },
          ].map(({ label, value, unit }) => (
            <div className="planning-baseline-metric" key={label}>
              <span>{label} occupied / staffed</span>
              <strong>
                {fmt(value.occupied)} <span>/ {fmt(value.staffed)}</span>
                <small>{unit}</small>
              </strong>
              <span>
                {fmt(value.physical)} installed · {fmt(value.enabled)} enabled
              </span>
            </div>
          ))}
          <div className="planning-baseline-metric">
            <span>Awaiting inpatient placement</span>
            <strong className={queue.total ? "amber" : ""}>
              {fmt(queue.total)} <small>patients</small>
            </strong>
            <span>
              {fmt(queue.ward)} ward · {fmt(queue.icu)} ICU · {fmt(queue.ed)}{" "}
              awaiting ED assessment
            </span>
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
          <p>
            {dataset?.name ||
              dataset?.label ||
              dataset?.fixture?.replaceAll("_", " ") ||
              "Planning dataset"}
            {" · "}Baseline stays fixed while you explore simulation results.
          </p>
        </div>
      </section>

      {run ? (
        <div className="planning-overview-result" role="status">
          <span>
            Selected simulation:{" "}
            <strong>
              {run.scenario_name || ctx.scenario?.name || "Planning scenario"}
            </strong>
            {" · "}
            {runStatus}
            {running
              ? ` · ${fmt(run.replications_completed)} of ${fmt(run.replications_requested)} runs completed`
              : run.status === "SUCCEEDED"
                ? ` · ${fmt(run.replications_completed)} completed runs`
                : ""}
          </span>
          <span>
            Configure inputs below. Explore completed results in Analysis.
          </span>
        </div>
      ) : null}

      <section
        className="planning-overview-configuration"
        aria-label="Simulation configuration"
      >
        {configuration}
      </section>
    </div>
  );
}
