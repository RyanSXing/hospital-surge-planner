import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt, items, localDate, num } from "../api";
import { Badge, Busy, Button, ErrorBox, Modal } from "./ui";
import { selectedRunNumber } from "../model";

const rows: [string, string, string][] = [
  ["arrivals", "Arrivals", "patients"],
  ["discharges", "Discharges", "patients"],
  ["peak_inpatient_queue", "Peak inpatient placement queue", "patients"],
  [
    "inpatient_waiting_patient_hours",
    "Inpatient placement waiting",
    "patient-hours",
  ],
  ["ed_waiting_patient_hours", "ED assessment waiting", "patient-hours"],
  ["capacity_shortfall_hours", "Time with unmet placement demand", "hours"],
  ["ward_peak_occupied", "Peak ward occupancy", "beds"],
  ["ward_end_occupied", "End-of-day ward occupancy", "beds"],
  ["icu_peak_occupied", "Peak ICU occupancy", "beds"],
  ["icu_end_occupied", "End-of-day ICU occupancy", "beds"],
  ["ward_occupied", "Time-weighted ward occupancy", "beds"],
  ["icu_occupied", "Time-weighted ICU occupancy", "beds"],
];
function metric(value: unknown, stat = "p50") {
  const v =
    typeof value === "number"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[stat]
        : null;
  return typeof v === "number" ? fmt(v, 1) : "Unavailable";
}
export default function DayDetailDialog({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const timeZone =
    (ctx.resultScenario || ctx.scenario)?.timezone ||
    ctx.dataset?.timezone ||
    "America/Chicago";
  const dateLabel = (
    at: string,
    options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
  ) => localDate(at, { ...options, timeZone });
  const day = ctx.metrics?.daily?.[ctx.selectedDay],
    rep = ctx.activeReplicationId || ctx.run?.selected_replication_id;
  const [state, setState] = useState<Entity | null>(null),
    [events, setEvents] = useState<Entity[]>([]),
    [requests, setRequests] = useState<Entity[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    if (!rep || !day) {
      setLoading(false);
      return;
    }
    Promise.all([
      api(`/runs/${rep}/state?at=${encodeURIComponent(ctx.selectedTime)}`),
      api(
        `/runs/${rep}/events?start_at=${encodeURIComponent(day.start_at)}&end_at=${encodeURIComponent(day.end_at)}&limit=100`,
      ),
      api(
        `/runs/${rep}/patients?at=${encodeURIComponent(ctx.selectedTime)}&facility_id=${encodeURIComponent(ctx.selectedFacility)}&admission_pending=true&limit=8`,
      ),
    ])
      .then(([s, e, p]) => {
        if (!ignore) {
          setState(s);
          setRequests(items(p));
          setEvents(items(e));
          setTotal(e.total);
        }
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [rep, day?.start_at, day?.end_at, ctx.selectedTime, ctx.selectedFacility]);
  const units = (state?.units || []).filter(
      (u: Entity) => u.facility_id === ctx.selectedFacility,
    ),
    patients = requests,
    blockers = new Map<string, number>(
      Object.entries(state?.blocker_summary?.[ctx.selectedFacility] || {}),
    );
  if (!blockers.size)
    for (const p of patients)
      for (const reason of p.blockers || [])
        blockers.set(reason, (blockers.get(reason) || 0) + 1);
  return (
    <Modal
      title={`Day ${ctx.selectedDay + 1} · ${dateLabel(day?.start_at || ctx.selectedTime, { month: "long", day: "numeric", year: "numeric" })}`}
      wide
      onClose={onClose}
    >
      <div className="form-stack">
        {!day ? (
          <ErrorBox error="A completed daily forecast is required to inspect this interval." />
        ) : (
          <>
            <div className="info-note">
              Daily summaries are forecasts across{" "}
              {day.replication_count || ctx.run?.replications_completed} runs.
              Unit state and events below belong to the explicitly selected
              example run. A daily peak is separate from the selected instant.
            </div>
            <div className="spread small-copy muted">
              <span>
                {dateLabel(day.start_at, {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}{" "}
                to{" "}
                {dateLabel(day.end_at, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </span>
              <span>
                {fmt(
                  (Date.parse(day.end_at) - Date.parse(day.start_at)) / 3600000,
                )}{" "}
                elapsed hours
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">
                  Exact daily forecast metrics and uncertainty
                </caption>
                <thead>
                  <tr>
                    <th>Daily metric</th>
                    <th>Unit</th>
                    <th>Median</th>
                    <th>P10–P90</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([key, label, unit]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{unit}</td>
                      <td>{metric(day[key])}</td>
                      <td>
                        {day[key] === undefined
                          ? "Unavailable"
                          : `${metric(day[key], "p10")}–${metric(day[key], "p90")}`}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Runs with any inpatient queue</th>
                    <td>percent of runs</td>
                    <td colSpan={2}>
                      {day.queue_probability === undefined
                        ? "Unavailable"
                        : `${fmt(day.queue_probability * 100, 1)}%`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
        {error ? (
          <ErrorBox error={error} />
        ) : loading ? (
          <Busy label="Loading exact unit state and bounded event window" />
        ) : state ? (
          <>
            <div className="spread">
              <h3>
                Selected instant · example run {selectedRunNumber(ctx) || ""}
              </h3>
              <Badge>
                {dateLabel(ctx.selectedTime, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </Badge>
            </div>
            <p className="muted small-copy">
              {rep} · Facility {ctx.selectedFacility}. Ready physical places
              still require a compatible staffing and equipment bundle.
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Physical</th>
                    <th>Staffed</th>
                    <th>Occupied</th>
                    <th>Reserved</th>
                    <th>Turnover</th>
                    <th>Ready</th>
                    <th>Available</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u: Entity) => (
                    <tr key={u.unit_id}>
                      <th scope="row">
                        {ctx.dataset?.units.find((v) => v.unit_id === u.unit_id)
                          ?.name || u.unit_id}
                      </th>
                      {[
                        "physical",
                        "staffed",
                        "occupied",
                        "reserved",
                        "cleaning",
                        "ready",
                        "available",
                      ].map((k) => (
                        <td key={k}>{u[k] ?? "Unavailable"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Simultaneous placement constraints</h3>
            {blockers.size ? (
              <div className="day-blockers">
                {Array.from(blockers).map(([reason, count]) => (
                  <div key={reason}>
                    <strong>{reason.replaceAll("_", " ")}</strong>
                    <span>{count} waiting patients</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small-copy">
                {patients.length
                  ? "Individual placement requests can be inspected below."
                  : "No unresolved inpatient requests at this facility at the selected instant."}
              </p>
            )}
            {patients.slice(0, 8).map((p: Entity) => (
              <Button
                key={p.patient_id}
                small
                onClick={async () => {
                  const at = ctx.selectedTime;
                  if (ctx.run?.id) await ctx.openRun(ctx.run.id, "patients");
                  ctx.setReplication(rep || "");
                  ctx.setTime(at);
                  ctx.setPatient(p);
                  onClose();
                }}
              >
                {p.patient_id} · {p.target_unit_kind || p.care_level}{" "}
                <ArrowRight size={12} />
              </Button>
            ))}
            <h3>System-wide recorded events in this day</h3>
            <p className="small-copy muted">
              Showing the first {events.length} of {fmt(total)} events. Open
              replay for sequence navigation and additional windows.
            </p>
            <div className="day-event-list">
              {events.map((e) => (
                <button
                  key={e.event_id || e.sequence_number}
                  onClick={async () => {
                    if (ctx.run?.id) await ctx.openRun(ctx.run.id, "replay");
                    ctx.setReplication(rep || "");
                    ctx.setTime(e.occurred_at);
                    onClose();
                  }}
                >
                  <span>
                    {dateLabel(e.occurred_at, {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })}
                  </span>
                  <strong>{e.event_type?.replaceAll("_", " ")}</strong>
                  <span>
                    {e.patient_id ||
                      e.to_unit_id ||
                      e.reason_code ||
                      "Resource event"}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
