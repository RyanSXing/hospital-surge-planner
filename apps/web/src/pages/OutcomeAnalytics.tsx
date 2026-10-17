import { useState } from "react";
import { Activity, ArrowRight, BarChart3, Info } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { fmt, localDate } from "../api";
import { Badge, Button } from "../components/ui";
import { ForecastChart } from "../components/Charts";
import {
  clampOutcomeTime,
  isMeasurementScalar,
  outcomeRowIndex,
  outcomeWindow,
  projectOutcomePeriods,
  projectOutcomeSamples,
  scaleOutcomeStatistics,
} from "./outcomeProjection";
import "./outcomeAnalytics.css";

type MetricField = {
  key: string;
  label: string;
  unit: string;
  percent?: boolean;
};
const scalarFields: MetricField[] = [
  { key: "arrivals", label: "New arrivals", unit: "patients" },
  {
    key: "expected_arrivals",
    label: "Expected exogenous arrivals",
    unit: "patients",
  },
  {
    key: "initial_patients",
    label: "Patients at measurement start",
    unit: "patients",
  },
  {
    key: "active_at_horizon",
    label: "Patients still present at end",
    unit: "patients",
  },
  { key: "discharges", label: "Completed discharges", unit: "patients" },
  {
    key: "completed_admissions",
    label: "Completed inpatient admissions",
    unit: "patients",
  },
  {
    key: "patients_transferred",
    label: "Interfacility transfers",
    unit: "patients",
  },
  {
    key: "temporary_site_patients_served",
    label: "Temporary-site services completed",
    unit: "patients",
  },
  {
    key: "inpatient_waiting_patient_hours",
    label: "Inpatient placement waiting",
    unit: "patient-hours",
  },
  {
    key: "ed_waiting_patient_hours",
    label: "ED assessment waiting",
    unit: "patient-hours",
  },
  {
    key: "transfer_waiting_hours",
    label: "Transfer waiting",
    unit: "patient-hours",
  },
  {
    key: "peak_inpatient_queue",
    label: "Peak inpatient queue",
    unit: "patients",
  },
  {
    key: "time_to_first_shortage_hours",
    label: "First unmet placement demand",
    unit: "hours after measurement start",
  },
  {
    key: "hours_with_unmet_placement_demand",
    label: "Duration with unmet placement demand",
    unit: "hours",
  },
  {
    key: "completed_wait_median_hours",
    label: "Median completed admission wait within each run",
    unit: "hours",
  },
  {
    key: "completed_wait_p90_hours",
    label: "P90 completed admission wait within each run",
    unit: "hours",
  },
  {
    key: "unserved_at_horizon",
    label: "Unresolved inpatient requests at end",
    unit: "patients",
  },
  {
    key: "ed_unserved_at_horizon",
    label: "Unresolved ED assessment requests at end",
    unit: "patients",
  },
  {
    key: "over_capacity_patient_hours",
    label: "Occupancy above staffing-supported capacity",
    unit: "patient-hours",
  },
  {
    key: "staff_deficit_hours",
    label: "Staffing coverage deficit",
    unit: "place-hours",
  },
  {
    key: "equipment_deficit_hours",
    label: "Committed equipment coverage deficit",
    unit: "equipment-unit-hours",
  },
  {
    key: "additional_staff_hours",
    label: "Additional staff assignments",
    unit: "staff-hours",
  },
  ...(["ward", "icu", "ed"] as const).map((care) => ({
    key: `${care}_utilization`,
    label: `${care === "ward" ? "Ward" : care.toUpperCase()} staffed-capacity utilization`,
    unit: "percent of staffed place-hours",
    percent: true,
  })),
];

const plots = {
  demand: {
    title: "Demand & throughput",
    keys: ["arrivals", "discharges"],
    labels: ["Arrivals", "Discharges"],
    unit: "Patients per interval",
    basis: "Totals within each local calendar interval.",
  },
  ward: {
    title: "Ward occupancy & capacity",
    keys: ["ward_occupied", "ward_staffed"],
    labels: ["Ward occupied", "Ward staffed"],
    unit: "Beds · time-weighted average",
    basis: "Time-weighted occupancy and staffed capacity within each interval.",
  },
  icu: {
    title: "ICU occupancy & capacity",
    keys: ["icu_occupied", "icu_staffed"],
    labels: ["ICU occupied", "ICU staffed"],
    unit: "Beds · time-weighted average",
    basis: "Time-weighted occupancy and staffed capacity within each interval.",
  },
  ed: {
    title: "ED occupancy & capacity",
    keys: ["ed_occupied", "ed_staffed"],
    labels: ["ED occupied", "ED staffed"],
    unit: "Treatment places · time-weighted average",
    basis: "Time-weighted occupancy and staffed capacity within each interval.",
  },
  queues: {
    title: "Queues",
    keys: ["peak_inpatient_queue"],
    labels: ["Peak inpatient queue"],
    unit: "Patients · interval peak",
    basis:
      "Peak inpatient queue within each interval, calculated per run before percentiles.",
  },
  waiting: {
    title: "Waiting burden",
    keys: ["inpatient_waiting_patient_hours", "ed_waiting_patient_hours"],
    labels: ["Inpatient placement waiting", "ED assessment waiting"],
    unit: "Patient-hours per interval",
    basis: "Integrated waiting burden within each interval.",
  },
  utilization: {
    title: "Peak staffed-capacity utilization",
    keys: ["peak_staffed_utilization"],
    labels: ["Peak clinical staffed-capacity utilization"],
    unit: "Percent · interval peak",
    basis:
      "Highest instantaneous occupied-to-staffed ratio among main-hospital ward, ICU and ED units. Units with zero staffed capacity have no ratio; missing utilization is undefined, not zero.",
  },
  staffing: {
    title: "Staffing coverage deficit",
    keys: ["staff_deficit_hours"],
    labels: ["Staffing coverage deficit"],
    unit: "Place-hours per interval",
    basis:
      "Occupied places above staffing-supported capacity, integrated over time.",
  },
  equipment: {
    title: "Equipment coverage deficit",
    keys: ["equipment_deficit_hours"],
    labels: ["Equipment coverage deficit"],
    unit: "Equipment-unit-hours per interval",
    basis:
      "Committed equipment demand above serviceable inventory, integrated over time.",
  },
};
type Plot = keyof typeof plots;

function percentile(
  value: unknown,
  stat: "p10" | "p50" | "p90",
): number | null {
  const result =
    typeof value === "number"
      ? value
      : value && typeof value === "object"
        ? (value as Entity)[stat]
        : null;
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}
function display(value: unknown, stat: "p10" | "p50" | "p90", percent = false) {
  const result = percentile(value, stat);
  return result === null
    ? "—"
    : `${fmt(result * (percent ? 100 : 1), 1)}${percent ? "%" : ""}`;
}
export default function OutcomeAnalytics({ ctx }: { ctx: PlanningContext }) {
  const [plot, setPlot] = useState<Plot>("demand");
  const [band, setBand] = useState(true);
  const metrics = ctx.metrics;
  const scenario = ctx.resultScenario || ctx.scenario;
  const window = outcomeWindow(metrics || {}, scenario || {});
  const hasWindow =
    Number.isFinite(window.start) && Number.isFinite(window.end);
  const measuredAfterStart = hasWindow && window.start > window.fullStart;
  const selectedTime = hasWindow
    ? clampOutcomeTime(ctx.selectedTime, window)
    : ctx.selectedTime;
  const selectTime = (at: string) => ctx.setTime(clampOutcomeTime(at, window));
  const dailyRows = projectOutcomePeriods(metrics?.daily || [], window);
  const sampledRows = projectOutcomeSamples(metrics?.series || [], window);
  const periodRows = projectOutcomePeriods(metrics?.data || [], window);
  const selectedDailyIndex = outcomeRowIndex(dailyRows, selectedTime);
  const selectedDaily = dailyRows[selectedDailyIndex];
  const hourOptions: string[] = [];
  if (selectedDaily) {
    for (
      let at = Date.parse(selectedDaily.start_at);
      at < Date.parse(selectedDaily.end_at);
      at += 3_600_000
    )
      hourOptions.push(new Date(at).toISOString());
    if (!hourOptions.includes(selectedTime)) hourOptions.push(selectedTime);
    hourOptions.sort();
  }
  const hourlyQueues = ctx.grain === "day" && plot === "queues";
  const definition = hourlyQueues
    ? {
        title: "Queues",
        keys: ["inpatient_queue", "ward_queue", "icu_queue", "ed_queue"],
        labels: [
          "All inpatient requests",
          "Ward requests",
          "ICU requests",
          "ED assessment queue",
        ],
        unit: "Patients at sampled time",
        basis:
          "Recorded hourly queue samples; inpatient requests and ED assessment waiting are separate.",
      }
    : plots[plot];
  const originalRows: Entity[] = hourlyQueues
    ? sampledRows
    : ctx.grain === "day"
      ? dailyRows
      : periodRows;
  const rows: Entity[] =
    plot === "utilization"
      ? originalRows.map((row) => ({
          ...row,
          peak_staffed_utilization: scaleOutcomeStatistics(
            row.peak_staffed_utilization,
            100,
          ),
        }))
      : originalRows;
  const selectedIndex = outcomeRowIndex(rows, selectedTime);
  const scalar = metrics?.scalar_metrics || {};
  const knownKeys = new Set(scalarFields.map((field) => field.key));
  const fields = [
    ...scalarFields.filter((field) => isMeasurementScalar(field.key, window)),
    ...Object.keys(scalar)
      .filter((key) => !knownKeys.has(key))
      .map((key) => ({
        key,
        label: key.replaceAll("_", " "),
        unit: "Unit not declared in output",
      })),
  ];
  const completed =
    ctx.run?.replications_completed || metrics?.replications_completed || 0;
  const measurementStart = hasWindow
    ? new Date(window.start).toISOString()
    : metrics?.start_at;
  const end = metrics?.end_at || ctx.run?.end_at;
  const timeZone =
    scenario?.timezone || metrics?.timezone || ctx.dataset?.timezone;
  const dateText = (value: string) =>
    localDate(value, {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });

  return (
    <div className="outcome-analytics" data-testid="outcome-analytics">
      <header className="page-heading">
        <div>
          <div className="eyebrow">ANALYSIS · OUTCOMES</div>
          <h1>Simulation outcomes</h1>
          <p>Understand demand, waiting, throughput, and resource pressure.</p>
        </div>
        {metrics ? (
          <Badge>{completed} simulation runs · ensemble forecast</Badge>
        ) : null}
      </header>
      {!metrics ? (
        <div className="outcome-empty">
          <BarChart3 size={30} aria-hidden="true" />
          <h2>
            {ctx.run?.status === "SUCCEEDED"
              ? "Loading completed outcomes"
              : "Complete a simulation to explore outcomes"}
          </h2>
          <p>
            Configure the hospital scenario in Overview. Completed results
            appear here with their recorded inputs and uncertainty.
          </p>
          <Button onClick={() => ctx.setPage("overview")}>
            Open Overview <ArrowRight size={15} />
          </Button>
        </div>
      ) : (
        <>
          <div className="outcome-context">
            <strong>
              {scenario?.name ||
                ctx.run?.scenario_name ||
                "Completed simulation"}
            </strong>
            <span>
              {dateText(measurementStart || "")} — {dateText(end || "")}{" "}
              (exclusive end)
            </span>
            <span>
              {measuredAfterStart
                ? "Measured from update cutoff"
                : "Full simulation horizon"}{" "}
              · System-wide outcomes
            </span>
          </div>
          <div className="outcome-highlights">
            {[
              { key: "arrivals", label: "New arrivals", unit: "patients" },
              {
                key: "discharges",
                label: "Completed discharges",
                unit: "patients",
              },
              {
                key: "inpatient_waiting_patient_hours",
                label: "Placement waiting",
                unit: "patient-hours",
              },
              {
                key: "ward_utilization",
                label: "Ward utilization",
                unit: "staffed place-hours",
                percent: true,
              },
            ].map((field) => (
              <div key={field.key}>
                <span>{field.label}</span>
                <strong>
                  {display(scalar[field.key], "p50", field.percent)}
                </strong>
                <span>
                  {field.percent ? "% of " : ""}
                  {field.unit} · median
                </span>
                <small>
                  P10–P90 {display(scalar[field.key], "p10", field.percent)}–
                  {display(scalar[field.key], "p90", field.percent)}
                </small>
              </div>
            ))}
          </div>
          <section className="outcome-chart" aria-label="Outcome forecast">
            <div className="outcome-chart-controls">
              <label>
                Outcome metric
                <select
                  value={plot}
                  onChange={(event) => setPlot(event.target.value as Plot)}
                >
                  {Object.entries(plots).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="outcome-band">
                <input
                  type="checkbox"
                  checked={band}
                  onChange={(event) => setBand(event.target.checked)}
                />
                P10–P90 band for {definition.labels[0]}
              </label>
            </div>
            <p>
              {definition.basis} Lines show the median across {completed} runs.{" "}
              Calendar intervals are limited to the measurement window; averages
              use the actual elapsed hours within that window.
            </p>
            <ForecastChart
              rows={rows}
              keys={definition.keys}
              labels={definition.labels}
              height={220}
              selected={selectedIndex}
              onSelect={(index) =>
                selectTime(rows[index].at || rows[index].start_at)
              }
              showBand={band}
              bandKey={definition.keys[0]}
              yLabel={definition.unit}
            />
            <p className="outcome-note">
              <Info size={14} aria-hidden="true" />
              {plot === "utilization"
                ? "Peak utilization covers individual main-hospital clinical units."
                : "Occupancy and staffed capacity cover clinical units with staffing-derived capacity, including activated overflow. Advertised partner capacity and nonclinical shelter places are excluded."}{" "}
              Queues, throughput and resource deficits are system-wide.
            </p>
          </section>
          <section
            className="outcome-time-controls"
            aria-label="Outcome interval controls"
          >
            <div className="segmented" aria-label="Outcome aggregation grain">
              {(["day", "week", "month"] as const).map((grain) => (
                <button
                  type="button"
                  key={grain}
                  className={ctx.grain === grain ? "active" : ""}
                  aria-pressed={ctx.grain === grain}
                  onClick={() => ctx.setGrain(grain)}
                >
                  {grain[0].toUpperCase() + grain.slice(1)}
                </button>
              ))}
            </div>
            <label>
              Selected outcome day
              <select
                value={selectedDailyIndex}
                onChange={(event) =>
                  selectTime(dailyRows[Number(event.target.value)].start_at)
                }
                disabled={!dailyRows.length}
              >
                {dailyRows.map((row, index) => (
                  <option key={row.start_at} value={index}>
                    Day {row.source_index + 1} ·{" "}
                    {localDate(row.start_at, {
                      timeZone,
                      month: "short",
                      day: "numeric",
                    })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Selected outcome time
              <select
                value={selectedTime}
                onChange={(event) => selectTime(event.target.value)}
                disabled={!hourOptions.length}
              >
                {hourOptions.map((at) => (
                  <option key={at} value={at}>
                    {localDate(at, {
                      timeZone,
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Selection is shared with Summary, Replay and patient/resource
              inspection. Only times within this result’s measurement window are
              offered.
            </p>
          </section>
          <section
            className="outcome-scalars"
            aria-labelledby="outcome-scalars-title"
          >
            <div className="outcome-scalars-heading">
              <Activity size={18} aria-hidden="true" />
              <div>
                <h2 id="outcome-scalars-title">
                  Measurement-interval outcomes
                </h2>
                <p>
                  Per-run metrics summarized across the ensemble. Changing the
                  chart grain or selected day does not change these totals.
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <caption>
                  Median and simulation range across {completed} completed runs.
                  P10 and P90 are simulation percentiles, not confidence bounds.
                </caption>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Unit</th>
                    <th>P10</th>
                    <th>Median · P50</th>
                    <th>P90</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field) => (
                    <tr key={field.key}>
                      <th scope="row">{field.label}</th>
                      <td>{field.unit}</td>
                      {(["p10", "p50", "p90"] as const).map((stat) => (
                        <td key={stat}>
                          {display(
                            scalar[field.key],
                            stat,
                            "percent" in field && field.percent === true,
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {measuredAfterStart && scalar.expected_arrivals ? (
              <p className="outcome-note">
                Input context outside the measurement totals: expected exogenous
                arrivals over the full simulation horizon (
                {dateText(metrics.start_at)} — {dateText(end || "")}) are{" "}
                {display(scalar.expected_arrivals, "p50")} patients, median.
                This expectation includes time before the update cutoff.
              </p>
            ) : null}
            <p className="outcome-note">
              — means unavailable or undefined; zero remains 0. First-shortage
              and completed-wait percentiles include only runs where that
              outcome was observed. Completed admission waits count only waiting
              after the measurement start. Utilization is occupied place-hours
              divided by staffed place-hours, displayed as a percentage; zero
              staffed hours is undefined.
            </p>
            <p className="outcome-note">
              These charts summarize multiple simulations. Patients &amp; units,
              Resources, and Replay display one selected trajectory; its patient
              counts need not equal the ensemble median.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
