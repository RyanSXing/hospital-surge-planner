import { useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarRange,
  ClipboardList,
  Info,
  ShieldCheck,
} from "lucide-react";
import { Accordion, NativeSelect, Tabs } from "@mantine/core";
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
import { finiteStatistic } from "./resultsMetrics";
import {
  formatOutcomeStatistic,
  OutcomeSummaryCards,
} from "./OutcomeSummaryCards";
import "./outcomeAnalytics.css";
import { recordedConstraintMarkers } from "./constraintMarkers";
import { bottleneckLabel } from "./bottleneckEvidence";

type MetricField = {
  key: string;
  label: string;
  unit: string;
  percent?: boolean;
};
const scalarFields: MetricField[] = [
  {
    key: "average_wait_per_patient_hours",
    label: "Average wait per patient",
    unit: "hours per measured arrival",
  },
  {
    key: "medical_supply_average_percent",
    label: "Average medical supplies",
    unit: "percent of maximum stock",
  },
  {
    key: "success_score_percent",
    label: "Patients treated within 24 hours",
    unit: "percent of eligible arrivals",
  },
  { key: "arrivals", label: "New arrivals", unit: "patients" },
  {
    key: "expected_arrivals",
    label: "Expected arrivals",
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
    key: "inpatient_waiting_patient_hours",
    label: "Waiting for a hospital bed",
    unit: "patient-hours",
  },
  {
    key: "ed_waiting_patient_hours",
    label: "Waiting for emergency assessment",
    unit: "patient-hours",
  },
  {
    key: "peak_inpatient_queue",
    label: "Most patients waiting for a bed",
    unit: "patients",
  },
  {
    key: "time_to_first_shortage_hours",
    label: "First care queue (runs with a queue)",
    unit: "hours after measurement start",
  },
  {
    key: "hours_with_unmet_placement_demand",
    label: "Time with patients waiting for a bed",
    unit: "hours",
  },
  {
    key: "completed_wait_median_hours",
    label: "Typical wait before admission",
    unit: "hours",
  },
  {
    key: "completed_wait_p90_hours",
    label: "Longer admission wait (90th percentile)",
    unit: "hours",
  },
  {
    key: "unserved_at_horizon",
    label: "Still waiting for a bed at the end",
    unit: "patients",
  },
  {
    key: "ed_unserved_at_horizon",
    label: "Still waiting for emergency assessment at the end",
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
  supplies: {
    title: "Medical supplies",
    keys: ["medical_supply_average_percent", "medical_supply_min_percent"],
    labels: ["Average supply stock", "Lowest supply stock"],
    unit: "Percent of maximum supply stock",
    basis:
      "General medical supply stock each day, including consumption, scheduled refills, and shortages. Untracked supplies remain unavailable.",
    daily: true,
  },
  demand: {
    title: "Arrivals and discharges",
    keys: ["arrivals", "discharges"],
    labels: ["Arrivals", "Discharges"],
    unit: "Patients per interval",
    basis: "Patients arriving and leaving in each selected period.",
  },
  ward: {
    title: "Ward beds",
    keys: ["ward_occupied", "ward_staffed"],
    labels: ["Ward occupied", "Ward staffed"],
    unit: "Beds · time-weighted average",
    basis: "Average occupied beds compared with staffed beds in each period.",
  },
  icu: {
    title: "Intensive care beds",
    keys: ["icu_occupied", "icu_staffed"],
    labels: ["ICU occupied", "ICU staffed"],
    unit: "Beds · time-weighted average",
    basis: "Average occupied beds compared with staffed beds in each period.",
  },
  ed: {
    title: "Emergency department",
    keys: ["ed_occupied", "ed_staffed"],
    labels: ["ED occupied", "ED staffed"],
    unit: "Treatment places · time-weighted average",
    basis: "Average occupied beds compared with staffed beds in each period.",
  },
  queues: {
    title: "Patients waiting",
    keys: ["peak_inpatient_queue"],
    labels: ["Most patients waiting for a bed"],
    unit: "Patients · interval peak",
    basis: "The largest number of patients waiting for a bed in each period.",
  },
  waiting: {
    title: "Time spent waiting",
    keys: ["inpatient_waiting_patient_hours", "ed_waiting_patient_hours"],
    labels: ["Waiting for a hospital bed", "Waiting for emergency assessment"],
    unit: "Patient-hours per interval",
    basis:
      "Total waiting time added together across all patients in each period.",
  },
  utilization: {
    title: "Busiest hospital unit",
    keys: ["peak_staffed_utilization"],
    labels: ["Peak clinical staffed-capacity utilization"],
    unit: "Percent · interval peak",
    basis:
      "The highest bed-use percentage in a ward, intensive care, or emergency unit.",
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
  queuePressure: {
    title: "Daily peak bed queue",
    keys: ["peak_inpatient_queue"],
    labels: ["Most patients waiting for a bed"],
    unit: "Patients · daily peak",
    basis:
      "The largest bed queue on each day, even when viewing a week or month.",
    daily: true,
  },
  wardCapacity: {
    title: "Daily ward capacity",
    keys: ["ward_occupied", "ward_staffed"],
    labels: ["Ward occupied", "Ward staffed"],
    unit: "Beds · daily time-weighted average",
    basis: "Daily occupied ward beds compared with staffed ward capacity.",
    daily: true,
  },
};
type Plot = keyof typeof plots;

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
        title: "Patients waiting",
        keys: ["inpatient_queue", "ward_queue", "icu_queue", "ed_queue"],
        labels: [
          "All patients waiting for a bed",
          "Waiting for ward care",
          "Waiting for intensive care",
          "Waiting for emergency assessment",
        ],
        unit: "Patients at sampled time",
        basis: "Patients waiting at each hour, grouped by the care they need.",
      }
    : plots[plot];
  const originalRows: Entity[] =
    "daily" in definition && definition.daily
      ? dailyRows
      : hourlyQueues
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
  const recordedMarkers = recordedConstraintMarkers(rows, dailyRows);
  const hasRecordedInterruptions = recordedMarkers.some((marker) =>
    marker.reasons.includes("treatment_disruption"),
  );
  const constraintMarkers = recordedMarkers.flatMap((marker) => {
    const reasons = marker.reasons.filter(
      (reason) => reason !== "treatment_disruption",
    );
    if (!reasons.length) return [];
    const resourceMarker = {
      ...marker,
      reasons,
      label: reasons.map(bottleneckLabel).join(" · "),
      kind: "constraint" as const,
    };
    // Hourly samples inherit recorded daily evidence, not an hourly onset.
    // Keep that source period in the ribbon title instead of implying precision.
    if (rows[marker.index].blocker_patient_hours) return [resourceMarker];
    const recordedDay = dailyRows.find(
      (day) =>
        Date.parse(day.start_at) <= Date.parse(marker.at || "") &&
        Date.parse(marker.at || "") < Date.parse(day.end_at),
    );
    return [
      recordedDay
        ? {
            ...resourceMarker,
            at: recordedDay.start_at,
            endAt: recordedDay.end_at,
          }
        : resourceMarker,
    ];
  });
  const recordedReasons = [
    ...new Set(constraintMarkers.flatMap((marker) => marker.reasons)),
  ];
  const chartAvailable = rows.some((row) =>
    definition.keys.some((key) => finiteStatistic(row[key]) !== null),
  );
  const fields = scalarFields.filter((field) =>
    isMeasurementScalar(field.key, window),
  );
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

  const shortageMedian = finiteStatistic(
    scalar.time_to_first_shortage_hours,
    "p50",
  );
  const wardUtilization = finiteStatistic(scalar.ward_utilization, "p50");
  const noRecordedQueue =
    finiteStatistic(scalar.peak_inpatient_queue, "max") === 0;
  const insight =
    shortageMedian !== null
      ? {
          tone: "warning",
          title: `Patients start waiting for care after about ${fmt(shortageMedian, 1)} hours`,
          body: "Timing includes emergency assessment and inpatient queues. Review Summary’s recorded constraints to see what limited care.",
        }
      : {
          tone: noRecordedQueue ? "success" : "neutral",
          title: noRecordedQueue
            ? "No inpatient bed queue in these results"
            : "Review the queue charts for bed pressure",
          body: noRecordedQueue
            ? "Try higher demand or fewer staff to test the plan's limits."
            : `The first waiting time was not recorded. Ward utilization is ${wardUtilization === null ? "unavailable" : `${fmt(wardUtilization * 100, 1)}%`}. Inspect the charts for pressure.`,
        };

  return (
    <section className="outcome-analytics" data-testid="outcome-analytics">
      <header className="page-heading outcome-heading">
        <div>
          <div className="eyebrow">ANALYSIS / OUTCOMES</div>
          <h1>Simulation outcomes</h1>
          <p>See what changes over time, then open details only when needed.</p>
        </div>
        {metrics ? <Badge>{completed} simulation runs</Badge> : null}
      </header>
      {!metrics ? (
        <div
          className="outcome-empty"
          role={ctx.metricsError ? "alert" : "status"}
        >
          <BarChart3 size={30} aria-hidden="true" />
          <h2>
            {ctx.metricsError
              ? "Forecast results unavailable"
              : ctx.run?.status === "SUCCEEDED"
                ? "Loading completed outcomes"
                : "Complete a simulation to explore outcomes"}
          </h2>
          <p>
            {ctx.metricsError
              ? "The completed simulation is saved, but its outcome data could not be loaded. Retry to retrieve the recorded results."
              : ctx.run?.status === "SUCCEEDED"
                ? "Retrieving recorded outcomes and their possible range."
                : "Set up the hospital in Configuration to see its outcomes."}
          </p>
          {ctx.metricsError && ctx.retryMetrics ? (
            <Button primary onClick={ctx.retryMetrics}>
              Retry results
            </Button>
          ) : null}
          <Button onClick={() => ctx.setPage("overview")}>
            Open Configuration <ArrowRight size={15} />
          </Button>
        </div>
      ) : (
        <>
          <div className="outcome-context">
            <div>
              <span>Scenario</span>
              <strong>
                {scenario?.name ||
                  ctx.run?.scenario_name ||
                  "Completed simulation"}
              </strong>
            </div>
            <div>
              <span>Measured period</span>
              <strong>
                {dateText(measurementStart || "")} — {dateText(end || "")}
              </strong>
            </div>
            <div>
              <span>Scope</span>
              <strong>
                {measuredAfterStart
                  ? "After the recorded update"
                  : "Full simulation"}{" "}
                · Hospital
              </strong>
            </div>
          </div>

          <OutcomeSummaryCards
            ctx={ctx}
            scalar={scalar}
            className="outcome-highlights"
          />

          <section className={`outcome-insight ${insight.tone}`}>
            <span className="outcome-insight-icon">
              {insight.tone === "warning" ? (
                <Activity size={20} />
              ) : insight.tone === "neutral" ? (
                <Info size={20} />
              ) : (
                <ShieldCheck size={20} />
              )}
            </span>
            <div>
              <span>Key finding</span>
              <h2>{insight.title}</h2>
              <p>{insight.body}</p>
            </div>
            <Button
              onClick={() => {
                if (ctx.compareScenarios) ctx.compareScenarios();
                else ctx.setPage("compare");
              }}
            >
              Compare scenarios <ArrowRight size={14} />
            </Button>
          </section>

          <section className="outcome-chart-layout" aria-label="Outcome charts">
            <article className="outcome-chart outcome-primary-chart">
              <Tabs
                className="outcome-chart-bookmarks"
                value={plot}
                onChange={(value) => value && setPlot(value as Plot)}
                variant="pills"
              >
                <Tabs.List aria-label="Choose a forecast chart">
                  {Object.entries(plots).map(([value, item]) => (
                    <Tabs.Tab key={value} value={value}>
                      {item.title}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
                <Tabs.Panel value={plot}>
                  <div className="outcome-chart-heading">
                    <div>
                      <span className="eyebrow">EXPLORE THE FORECAST</span>
                      <h2>{definition.title}</h2>
                    </div>
                  </div>
                  <p>
                    {definition.basis} Lines show the median across {completed}{" "}
                    runs. Calendar intervals use their actual elapsed hours.
                  </p>
                  {chartAvailable ? (
                    <ForecastChart
                      rows={rows}
                      timeZone={timeZone}
                      keys={definition.keys}
                      labels={definition.labels}
                      height={300}
                      selected={selectedIndex}
                      onSelect={(index) =>
                        selectTime(rows[index].at || rows[index].start_at)
                      }
                      showBand={band}
                      bandKey={definition.keys[0]}
                      yLabel={definition.unit}
                      markers={constraintMarkers}
                      markerPresentation="background"
                      yMax={plot === "supplies" ? 100 : undefined}
                    />
                  ) : (
                    <div className="outcome-empty-metric" role="status">
                      {plot === "supplies"
                        ? "Supply tracking was not enabled in these saved results. Enable Track supplies in Configuration and run a simulation to view daily stock."
                        : "This measure was not recorded in the selected results."}
                    </div>
                  )}
                  <div
                    className="outcome-constraint-markers"
                    data-testid="constraint-markers"
                    aria-label="Recorded bottleneck indicators"
                  >
                    {recordedReasons.length ? (
                      <>
                        <div className="outcome-recorded-reasons">
                          {recordedReasons.map((reason) => (
                            <span key={reason}>{bottleneckLabel(reason)}</span>
                          ))}
                        </div>
                        <details>
                          <summary>About these periods</summary>
                          <small>
                            Faint amber shading marks recorded resource
                            constraints in one or more simulations. Adjacent
                            periods join together, and reasons can overlap.
                            Hover for the recorded dates and reasons; shading
                            does not show exact onset or duration. Open Summary
                            to replay the first recorded bottleneck.
                          </small>
                        </details>
                      </>
                    ) : (
                      <small>
                        No positive recorded resource constraint evidence is
                        available for the periods shown.
                      </small>
                    )}
                    {hasRecordedInterruptions ? (
                      <details className="outcome-interruption-details">
                        <summary>Care interruption details</summary>
                        <small>
                          Treatment interruptions were recorded in one or more
                          simulations during the periods shown. Summary and
                          Replay retain the recorded bottleneck timing and
                          patient care details.
                        </small>
                      </details>
                    ) : null}
                  </div>
                  <label className="outcome-band">
                    <input
                      type="checkbox"
                      checked={band}
                      onChange={(event) => setBand(event.target.checked)}
                    />
                    Show possible range for {definition.labels[0]}
                  </label>
                </Tabs.Panel>
              </Tabs>
            </article>
          </section>

          <Accordion
            className="outcome-details"
            variant="separated"
            multiple
            defaultValue={[]}
            aria-label="Outcome details"
          >
            <Accordion.Item value="time">
              <Accordion.Control icon={<CalendarRange size={18} />}>
                Choose an exact outcome interval
              </Accordion.Control>
              <Accordion.Panel>
                <section
                  className="outcome-time-controls"
                  aria-label="Outcome interval controls"
                >
                  <div
                    className="segmented"
                    aria-label="Outcome aggregation grain"
                  >
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
                  <NativeSelect
                    label="Selected outcome day"
                    value={String(selectedDailyIndex)}
                    onChange={(event) =>
                      selectTime(
                        dailyRows[Number(event.currentTarget.value)].start_at,
                      )
                    }
                    disabled={!dailyRows.length}
                    data={dailyRows.map((row, index) => ({
                      value: String(index),
                      label: `Day ${row.source_index + 1} · ${localDate(
                        row.start_at,
                        {
                          timeZone,
                          month: "short",
                          day: "numeric",
                        },
                      )}`,
                    }))}
                  />
                  <NativeSelect
                    label="Selected outcome time"
                    value={selectedTime}
                    onChange={(event) => selectTime(event.currentTarget.value)}
                    disabled={!hourOptions.length}
                    data={hourOptions.map((at) => ({
                      value: at,
                      label: localDate(at, {
                        timeZone,
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZoneName: "short",
                      }),
                    }))}
                  />
                  <p>
                    This time is also used in Summary, Replay, and patient
                    details.
                  </p>
                </section>
              </Accordion.Panel>
            </Accordion.Item>

            <Accordion.Item value="metrics">
              <Accordion.Control icon={<ClipboardList size={18} />}>
                View all outcome metrics and uncertainty
              </Accordion.Control>
              <Accordion.Panel>
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
                        Totals for the full measured period. Choosing a chart
                        interval does not change these totals.
                      </p>
                    </div>
                  </div>
                  <div className="table-scroll">
                    <table className="data-table">
                      <caption>
                        Median and simulation range across {completed} completed
                        runs. P10 and P90 are percentiles, not confidence
                        bounds. First-queue percentiles use observed runs only.
                      </caption>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>Unit</th>
                          <th>Lower · P10</th>
                          <th>Typical · Median</th>
                          <th>Upper · P90</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field) => (
                          <tr key={field.key}>
                            <th scope="row">{field.label}</th>
                            <td>{field.unit}</td>
                            {(["p10", "p50", "p90"] as const).map((stat) => (
                              <td key={stat}>
                                {formatOutcomeStatistic(
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
                      Expected arrivals over the full simulation horizon (
                      {dateText(metrics.start_at)} — {dateText(end || "")}) are{" "}
                      {formatOutcomeStatistic(scalar.expected_arrivals, "p50")}{" "}
                      patients, median. This includes time before the update
                      cutoff.
                    </p>
                  ) : null}
                  <p className="outcome-note">
                    — means unavailable or undefined; zero remains 0.
                    First-shortage and completed-wait percentiles include only
                    runs where that outcome was observed.
                  </p>
                </section>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
    </section>
  );
}
