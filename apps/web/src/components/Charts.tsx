import { NativeSelect } from "@mantine/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { area, line, scaleLinear } from "d3";
import { Activity, ChevronLeft, ChevronRight, Info } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { fmt, localDate, num } from "../api";
import { Badge, EmptyState } from "./ui";
import DayDetailDialog from "./DayDetailDialog";
import { forecastXDomain, isolatedForecastIndexes } from "./forecastGeometry";
const COLORS = ["#2684cc", "#ce5266", "#a87614", "#1a9b87"];
export function ForecastChart({
  rows,
  keys = ["ward_occupied", "ward_staffed", "icu_occupied", "icu_staffed"],
  labels = ["Ward occupied", "Ward staffed", "ICU occupied", "ICU staffed"],
  height = 152,
  selected = 0,
  onSelect,
  showBand = true,
  yLabel = "Patients / beds",
  colors,
  bandKey,
  lineDashes,
  timeZone,
}: {
  rows: Entity[];
  keys?: string[];
  labels?: string[];
  height?: number;
  selected?: number;
  onSelect?: (i: number) => void;
  showBand?: boolean;
  yLabel?: string;
  colors?: string[];
  bandKey?: string;
  lineDashes?: (string | undefined)[];
  timeZone?: string;
}) {
  const dateLabel = (
    at: string,
    options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
  ) => localDate(at, { ...options, ...(timeZone ? { timeZone } : {}) });
  const fillId = `chart-fill-${useId().replaceAll(":", "")}`;
  const valid = (v: any) =>
    typeof v === "number"
      ? Number.isFinite(v)
      : v?.p50 !== null && v?.p50 !== undefined && Number.isFinite(v.p50);
  const wrapper = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(1000);
  useEffect(() => {
    if (!wrapper.current) return;
    const o = new ResizeObserver((entries) =>
      setWidth(Math.round(entries[0].contentRect.width)),
    );
    o.observe(wrapper.current);
    return () => o.disconnect();
  }, []);
  const colorFor = (k: string, i: number) =>
    colors?.[i] ||
    (k.startsWith("ward_")
      ? "#2684cc"
      : k.startsWith("icu_")
        ? "#ce5266"
        : k.startsWith("ed_")
          ? "#1a9b87"
          : COLORS[i % 4]);
  const [tableOpen, setTableOpen] = useState(false),
    [hover, setHover] = useState<number | null>(null);
  const W = Math.max(280, width),
    H = height,
    pad = { left: 42, right: 32, top: 18, bottom: 28 };
  const tickCount = Math.min(
    rows.length,
    Math.max(2, Math.min(8, Math.floor((W - pad.left - pad.right) / 90) + 1)),
  );
  const firstAt = rows[0]?.at || rows[0]?.start_at,
    lastAt = rows.at(-1)?.at || rows.at(-1)?.start_at,
    intraday =
      rows.length > 1 &&
      firstAt &&
      lastAt &&
      Math.abs(Date.parse(lastAt) - Date.parse(firstAt)) <= 36 * 3600000;
  const x = scaleLinear()
    .domain(forecastXDomain(rows.length))
    .range([pad.left, W - pad.right]);
  const max = Math.max(
    5,
    ...rows.flatMap((r) =>
      keys.map((k) => Math.max(num(r[k]), num(r[k], "p90"))),
    ),
  );
  const y = scaleLinear()
    .domain([0, max * 1.15])
    .nice()
    .range([H - pad.bottom, pad.top]);
  const ticks = y.ticks(4);
  return (
    <div className="chart-wrap" ref={wrapper}>
      <div className="chart-meta">
        <span>{yLabel}</span>
        <div className="chart-legend">
          {keys.map((k, i) => (
            <span key={k}>
              <i
                style={{
                  background: colorFor(k, i),
                  opacity: k.includes("staffed") ? 0.5 : 1,
                }}
              />
              {labels[i] || k}
            </span>
          ))}
        </div>
      </div>
      {rows.length ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${labels.join(", ")} over the planning horizon`}
          preserveAspectRatio="none"
          style={{ height: `${height}px` }}
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0"
                stopColor={colorFor(keys[0], 0)}
                stopOpacity=".16"
              />
              <stop
                offset="1"
                stopColor={colorFor(keys[0], 0)}
                stopOpacity="0"
              />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left}
                x2={W - pad.right}
                y1={y(t)}
                y2={y(t)}
                stroke="#e2e8f0"
                strokeDasharray="2 4"
              />
              <text x={pad.left - 10} y={y(t) + 4} textAnchor="end">
                {fmt(t)}
              </text>
            </g>
          ))}
          {keys.map((k, i) => {
            const dashed = k.includes("staffed");
            const path =
              line<Entity>()
                .defined((d) => valid(d[k]))
                .x((_, j) => x(j))
                .y((d) => y(num(d[k])))(rows) || "";
            const band =
              area<Entity>()
                .defined((d) => valid(d[k]))
                .x((_, j) => x(j))
                .y0((d) => y(num(d[k], "p10")))
                .y1((d) => y(num(d[k], "p90")))(rows) || "";
            return (
              <g key={k}>
                {showBand && !dashed && (bandKey ? k === bandKey : i === 0) ? (
                  <path d={band} fill={colorFor(k, i)} opacity=".09" />
                ) : null}
                {i === 0 ? (
                  <path
                    d={
                      area<Entity>()
                        .defined((d) => valid(d[k]))
                        .x((_, j) => x(j))
                        .y0(H - pad.bottom)
                        .y1((d) => y(num(d[k])))(rows) || ""
                    }
                    fill={`url(#${fillId})`}
                  />
                ) : null}
                <path
                  d={path}
                  fill="none"
                  stroke={colorFor(k, i)}
                  strokeWidth={dashed ? 1.2 : 2.2}
                  strokeDasharray={
                    lineDashes?.[i] ?? (dashed ? "6 5" : undefined)
                  }
                  opacity={dashed ? 0.6 : 1}
                />
                {isolatedForecastIndexes(rows, (row) => valid(row?.[k])).map(
                  (index) => (
                    <g key={index} className="chart-isolated-observation">
                      {showBand &&
                      !dashed &&
                      (bandKey ? k === bandKey : i === 0) &&
                      valid(rows[index][k]?.p10) &&
                      valid(rows[index][k]?.p90) ? (
                        <line
                          x1={x(index)}
                          x2={x(index)}
                          y1={y(num(rows[index][k], "p10"))}
                          y2={y(num(rows[index][k], "p90"))}
                          stroke={colorFor(k, i)}
                          strokeWidth={6}
                          opacity={0.2}
                        />
                      ) : null}
                      <circle
                        cx={x(index)}
                        cy={y(num(rows[index][k]))}
                        r={4}
                        fill={dashed ? "white" : colorFor(k, i)}
                        stroke={colorFor(k, i)}
                        strokeWidth={2}
                      >
                        <title>{`${labels[i]}: ${fmt(num(rows[index][k]), 1)}`}</title>
                      </circle>
                    </g>
                  ),
                )}
              </g>
            );
          })}
          {rows.length > 1 ? (
            <line
              x1={x(Math.min(selected, rows.length - 1))}
              x2={x(Math.min(selected, rows.length - 1))}
              y1={pad.top}
              y2={H - pad.bottom}
              stroke="#1976c9"
              strokeDasharray="4 4"
            />
          ) : null}
          {Array.from({ length: tickCount }, (_, i) =>
            Math.round((i * (rows.length - 1)) / Math.max(1, tickCount - 1)),
          ).map((j, i) => (
            <text key={i} x={x(j)} y={H - 6} textAnchor="middle">
              {rows[j]?.at || rows[j]?.start_at
                ? dateLabel(
                    rows[j].at || rows[j].start_at,
                    intraday
                      ? { hour: "numeric", minute: "2-digit" }
                      : undefined,
                  )
                : rows[j]?.local_date?.slice(5) || `Day ${j + 1}`}
              <title>
                {dateLabel(rows[j]?.at || rows[j]?.start_at, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </title>
            </text>
          ))}
          {onSelect ? (
            <rect
              onMouseMove={(e) => {
                const r =
                  e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                setHover(
                  Math.round(
                    Math.max(
                      0,
                      Math.min(
                        1,
                        (((e.clientX - r.left) / r.width) * W - pad.left) /
                          (W - pad.left - pad.right),
                      ),
                    ) *
                      (rows.length - 1),
                  ),
                );
              }}
              onMouseLeave={() => setHover(null)}
              x={pad.left}
              y={pad.top}
              width={W - pad.left - pad.right}
              height={H - pad.top - pad.bottom}
              fill="transparent"
              className="chart-hit"
              onClick={(e) => {
                const r =
                  e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                onSelect(
                  Math.round(
                    Math.max(
                      0,
                      Math.min(
                        1,
                        (((e.clientX - r.left) / r.width) * W - pad.left) /
                          (W - pad.left - pad.right),
                      ),
                    ) *
                      (rows.length - 1),
                  ),
                );
              }}
            />
          ) : null}
        </svg>
      ) : (
        <div className="chart-empty">
          <Activity size={22} />
          <span>Run this scenario to generate a forecast</span>
          <small>
            Occupancy and waiting are computed by the patient-flow model.
          </small>
        </div>
      )}
      {hover !== null && rows[hover] ? (
        <div className="chart-tooltip">
          <strong>
            {dateLabel(rows[hover].at || rows[hover].start_at, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </strong>
          {keys.map((k, i) => (
            <span key={k}>
              {labels[i]}{" "}
              <b>
                {valid(rows[hover][k])
                  ? fmt(num(rows[hover][k]), 1)
                  : "Unavailable"}
              </b>
            </span>
          ))}
        </div>
      ) : null}
      {rows.length ? (
        <>
          {rows.length === 1 ? (
            <p className="small-copy muted chart-single-period-note">
              One recorded interval
              {rows[0].end_at
                ? ` · ${dateLabel(rows[0].start_at || rows[0].at)}–${dateLabel(rows[0].end_at)}`
                : ""}
              . Points show its exact values; a trend needs more than one
              interval.
            </p>
          ) : null}
          <div className="chart-accessibility-controls">
            {onSelect ? (
              <>
                <button
                  onClick={() => onSelect(Math.max(0, selected - 1))}
                  aria-label="Previous chart interval"
                >
                  ←
                </button>
                <button
                  onClick={() =>
                    onSelect(Math.min(rows.length - 1, selected + 1))
                  }
                  aria-label="Next chart interval"
                >
                  →
                </button>
              </>
            ) : null}
            <button
              className="chart-data-toggle"
              onClick={() => setTableOpen(!tableOpen)}
            >
              {tableOpen ? "Hide" : "View"} chart data table
            </button>
          </div>
          {tableOpen ? (
            <div className="chart-data-table">
              <table className="data-table">
                <caption className="sr-only">
                  Exact plotted values by interval
                </caption>
                <thead>
                  <tr>
                    <th>Interval</th>
                    {keys.map((k, i) => (
                      <th key={k}>{labels[i]} · median</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} onClick={() => onSelect?.(i)}>
                      <td>
                        {dateLabel(r.at || r.start_at, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      {keys.map((k) => (
                        <td key={k}>
                          {valid(r[k]) ? fmt(num(r[k]), 2) : "Unavailable"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
export function Timeline({
  ctx,
  heatmapOnly = false,
  title = "System-wide forecast",
}: {
  ctx: PlanningContext;
  heatmapOnly?: boolean;
  title?: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [metric, setMetric] = ReactUseMetric();
  const daily = ctx.metrics?.daily || [];
  const rows =
    ctx.grain === "day" ? ctx.metrics?.series || [] : ctx.metrics?.data || [];
  const displayedScenario = ctx.resultScenario || ctx.scenario;
  const timeZone =
    displayedScenario?.timezone || ctx.dataset?.timezone || "America/Chicago";
  const dateLabel = (
    at: string,
    options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
  ) => localDate(at, { ...options, timeZone });
  const n = displayedScenario?.horizon_calendar_days || 30;
  const selectedIndex = rows.length
    ? rows.reduce(
        (best: number, row: Entity, index: number) =>
          Math.abs(
            Date.parse(row.at || row.start_at) - Date.parse(ctx.selectedTime),
          ) <
          Math.abs(
            Date.parse(rows[best].at || rows[best].start_at) -
              Date.parse(ctx.selectedTime),
          )
            ? index
            : best,
        0,
      )
    : 0;
  const bucket = daily[ctx.selectedDay],
    selectedIso = Number.isFinite(Date.parse(ctx.selectedTime))
      ? new Date(ctx.selectedTime).toISOString()
      : ctx.selectedTime;
  const hours: string[] = [];
  if (bucket?.start_at && bucket?.end_at) {
    for (
      let t = Date.parse(bucket.start_at);
      t < Date.parse(bucket.end_at);
      t += 3600000
    )
      hours.push(new Date(t).toISOString());
    if (!hours.includes(selectedIso)) hours.push(selectedIso);
  }
  return (
    <section className="timeline-panel" aria-label="Forecast timeline">
      <div className="timeline-header">
        <div className="timeline-heading">
          <Activity size={15} />
          <strong>{title}</strong>
          <button
            className="text-button"
            disabled={!ctx.metrics}
            onClick={() => setDetailOpen(true)}
          >
            Day details
          </button>
          <Badge>
            {ctx.metrics
              ? `${ctx.run?.replications_completed || 0} simulation runs`
              : "Awaiting simulation"}
          </Badge>
        </div>
        <div className="segmented">
          {(["day", "week", "month"] as const).map((g) => (
            <button
              key={g}
              className={ctx.grain === g ? "active" : ""}
              onClick={() => ctx.setGrain(g)}
            >
              {g[0].toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>
        <div className="timeline-selection">
          <button
            onClick={() => ctx.setDay(Math.max(0, ctx.selectedDay - 1))}
            aria-label="Previous day"
          >
            <ChevronLeft size={15} />
          </button>
          <span>
            Day {ctx.selectedDay + 1} <b>·</b> {dateLabel(ctx.selectedTime)}
          </span>
          <NativeSelect
            aria-label="Select hour within day"
            className="hour-select"
            value={selectedIso}
            onChange={(e) => ctx.setTime(e.target.value)}
          >
            {hours.sort().map((at) => (
              <option key={at} value={at}>
                {dateLabel(at, {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </option>
            ))}
            {!ctx.metrics ? (
              <option value={ctx.selectedTime}>00:00</option>
            ) : null}
          </NativeSelect>
          <button
            onClick={() => ctx.setDay(Math.min(n - 1, ctx.selectedDay + 1))}
            aria-label="Next day"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      {ctx.grain !== "day" ? (
        <div className="aggregate-summary">
          <strong>
            {ctx.grain === "week" ? "Selected week" : "Selected month"}
          </strong>
          <span>
            {rows[selectedIndex]
              ? `${dateLabel(rows[selectedIndex].start_at || rows[selectedIndex].at)} · ${fmt(num(rows[selectedIndex].arrivals))} arrivals · ${fmt(num(rows[selectedIndex].discharges))} discharges · ${fmt(num(rows[selectedIndex].inpatient_waiting_patient_hours))} patient-hours waiting`
              : "Select an interval in the forecast"}
          </span>
          <button onClick={() => ctx.setGrain("day")}>
            Drill into days <ChevronRight size={12} />
          </button>
        </div>
      ) : null}
      {!heatmapOnly ? (
        <ForecastChart
          rows={rows}
          timeZone={timeZone}
          selected={selectedIndex}
          onSelect={(i) => {
            if (rows[i]?.at || rows[i]?.start_at)
              ctx.setTime(rows[i].at || rows[i].start_at);
          }}
          height={220}
          yLabel={
            ctx.grain === "day"
              ? "Patients / beds"
              : "Patients / beds · time-weighted interval average"
          }
        />
      ) : null}
      <div className="heatmap-heading">
        <label htmlFor="heatmetric">Calendar view</label>
        <NativeSelect
          id="heatmetric"
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
        >
          <option value="peak_inpatient_queue">Peak inpatient queue</option>
          <option value="inpatient_waiting_patient_hours">
            Waiting patient-hours
          </option>
          <option value="peak_staffed_utilization">
            Peak staffed-bed utilization
          </option>
          <option value="capacity_shortfall_hours">
            Capacity shortfall hours
          </option>
        </NativeSelect>
        <div className="heat-legend">
          {metric === "peak_inpatient_queue" ? (
            <>
              <i className="heat-zero" />0<i className="heat-low" />
              1–5
              <i className="heat-med" />
              6–15
              <i className="heat-high" />
              &gt;15 patients
            </>
          ) : metric === "peak_staffed_utilization" ? (
            <>&lt;85% · 85–&lt;100% · 100% · &gt;100%</>
          ) : metric === "capacity_shortfall_hours" ? (
            <>0 · ≤6 · ≤12 · &gt;12 hours</>
          ) : (
            <>0 · ≤24 · ≤120 · &gt;120 patient-hours</>
          )}
        </div>
      </div>
      <div
        className="heatmap"
        role="grid"
        aria-label="Daily forecast; arrow keys navigate"
      >
        <div className="heatmap-month">
          {ctx.selectedTime
            ? dateLabel(ctx.selectedTime, { month: "short" }).toUpperCase()
            : "OCT"}
        </div>
        {Array.from({ length: Math.min(365, n) }, (_, i) => {
          const d = daily[i],
            entry = d?.[metric],
            value =
              entry === undefined || entry === null || entry?.p50 === null
                ? null
                : num(entry);
          const tone =
            value === null
              ? "missing"
              : metric === "peak_staffed_utilization"
                ? value < 0.85
                  ? "zero"
                  : value < 1
                    ? "low"
                    : value === 1
                      ? "med"
                      : "high"
                : value === 0
                  ? "zero"
                  : value <=
                      (metric === "peak_inpatient_queue"
                        ? 5
                        : metric === "capacity_shortfall_hours"
                          ? 6
                          : 24)
                    ? "low"
                    : value <=
                        (metric === "peak_inpatient_queue"
                          ? 15
                          : metric === "capacity_shortfall_hours"
                            ? 12
                            : 120)
                      ? "med"
                      : "high";
          return (
            <button
              role="gridcell"
              key={i}
              aria-label={`${d?.start_at ? dateLabel(d.start_at, { month: "long", day: "numeric", year: "numeric" }) : `Day ${i + 1}`}: ${metric.replaceAll("_", " ")} ${value === null ? "unavailable" : fmt(metric === "peak_staffed_utilization" ? value * 100 : value, 1)} ${metric === "peak_inpatient_queue" ? "patients" : metric === "peak_staffed_utilization" ? "percent" : metric === "capacity_shortfall_hours" ? "hours" : "patient-hours"}`}
              aria-selected={ctx.selectedDay === i}
              className={`heat-cell heat-${tone} ${ctx.selectedDay === i ? "selected" : ""}`}
              onClick={() => ctx.setDay(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ctx.setDay(i);
                  if (ctx.metrics) setDetailOpen(true);
                }
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const next = Math.max(
                    0,
                    Math.min(n - 1, i + (e.key === "ArrowRight" ? 1 : -1)),
                  );
                  ctx.setDay(next);
                  (
                    e.currentTarget.parentElement?.children[
                      next + 1
                    ] as HTMLElement
                  )?.focus();
                }
              }}
              title={`Day ${i + 1}: ${value === null ? "Unavailable / no denominator" : fmt(metric === "peak_staffed_utilization" ? value * 100 : value, 1) + " " + (metric === "peak_inpatient_queue" ? "patients" : metric === "peak_staffed_utilization" ? "percent" : metric === "capacity_shortfall_hours" ? "hours" : "patient-hours")}`}
            >
              <small>{i + 1}</small>
              <span>
                {value === null
                  ? "·"
                  : metric === "peak_staffed_utilization"
                    ? `${fmt(value * 100)}%`
                    : fmt(value)}
              </span>
            </button>
          );
        })}
      </div>
      {ctx.metrics ? (
        <div className="timeline-note">
          <Info size={11} /> Forecast across runs · P10–P90 simulation range
          under selected assumptions ·{" "}
          {displayedScenario?.timezone ||
            ctx.dataset?.timezone ||
            "America/Chicago"}
        </div>
      ) : null}
      {detailOpen ? (
        <DayDetailDialog ctx={ctx} onClose={() => setDetailOpen(false)} />
      ) : null}
    </section>
  );
}
function ReactUseMetric() {
  return useState("peak_inpatient_queue");
}
