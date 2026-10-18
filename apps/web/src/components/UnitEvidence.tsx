import { humanLabel } from "../presentation";
import { useEffect, useState } from "react";
import { api, localDate } from "../api";
import type { Entity, PlanningContext } from "../types";
import { ForecastChart } from "./Charts";
import { Badge, Button, ErrorBox } from "./ui";

export default function UnitEvidence({
  ctx,
  unit,
}: {
  ctx: PlanningContext;
  unit: Entity;
}) {
  const [schedule, setSchedule] = useState<Entity | null>(null),
    [timeline, setTimeline] = useState<Entity | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [rosterPage, setRosterPage] = useState(0),
    [changesPage, setChangesPage] = useState(0);
  const replication =
    ctx.activeReplicationId || ctx.run?.selected_replication_id;
  const identity = unit.unit_id || unit.id;
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    setSchedule(null);
    setTimeline(null);
    setRosterPage(0);
    setChangesPage(0);
    const query = `at=${encodeURIComponent(ctx.selectedTime)}`;
    Promise.all([
      api(`/datasets/${ctx.dataset?.id}/units/${identity}/schedule?${query}`),
      replication
        ? api(
            `/runs/${replication}/units/${identity}/timeline?${query}&max_points=400`,
          )
        : Promise.resolve(null),
    ])
      .then(([source, actual]) => {
        if (!ignore) {
          setSchedule(source);
          setTimeline(actual);
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
  }, [ctx.dataset?.id, identity, ctx.selectedTime, replication]);
  const format = (at: string) =>
    localDate(at, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  const actualIds = timeline?.current?.active_staff_ids as string[] | undefined;
  const staff = (ctx.dataset?.staff || []).filter((person: Entity) =>
    actualIds?.includes(person.staff_id),
  );
  const rows = timeline?.series || [];
  const assignments = schedule?.assignments || [];
  const changes = timeline?.capacity_schedule || [];
  return (
    <div className="unit-evidence">
      <h3>Staffing and capacity over time</h3>
      {loading ? <p role="status">Loading unit evidence…</p> : null}
      {error ? <ErrorBox error={error} /> : null}
      {actualIds ? (
        <>
          <Badge>
            {actualIds.length} actual assigned staff at selected time
          </Badge>
          <p className="small-copy">
            {staff.length
              ? staff
                  .map(
                    (person: Entity) =>
                      `${person.staff_id} (${humanLabel(person.role)})`,
                  )
                  .join(", ")
              : actualIds.length
                ? actualIds.join(", ")
                : "No staff assigned in this trajectory."}
          </p>
        </>
      ) : replication ? (
        <p className="small-copy muted">
          This retained trace exposes exact role counts above; individual
          assignment IDs are unavailable in this older trace. The schedule below
          is the declared source schedule.
        </p>
      ) : null}
      <h4>Declared shift roster</h4>
      <p className="small-copy muted">
        Source dataset assignments, including future shifts. Scenario absences
        and reserve deployments can change the actual roster.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Staff / role</th>
              <th>Shift</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {assignments
              .slice(rosterPage * 10, (rosterPage + 1) * 10)
              .map((a: Entity) => (
                <tr key={a.assignment_id}>
                  <td>
                    {a.staff_id}
                    <small className="patient-cell-note">
                      {humanLabel(a.role)}
                    </small>
                  </td>
                  <td>
                    {format(a.start_at)}
                    <small className="patient-cell-note">
                      to {format(a.end_at)}
                    </small>
                  </td>
                  <td>{humanLabel(a.status)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {assignments.length ? (
        <div className="spread">
          <Button
            small
            disabled={!rosterPage}
            onClick={() => setRosterPage((x) => x - 1)}
          >
            Previous shifts
          </Button>
          <span className="small-copy">
            {rosterPage * 10 + 1}–
            {Math.min(assignments.length, (rosterPage + 1) * 10)} of{" "}
            {assignments.length}
            {schedule?.total > assignments.length
              ? ` (${schedule?.total} declared; next 100 shown)`
              : ""}
          </span>
          <Button
            small
            disabled={(rosterPage + 1) * 10 >= assignments.length}
            onClick={() => setRosterPage((x) => x + 1)}
          >
            Next shifts
          </Button>
        </div>
      ) : (
        <p className="small-copy muted">
          No remaining source assignments for this unit.
        </p>
      )}
      {timeline ? (
        <>
          <h4>Actual selected-run occupancy and staffing</h4>
          <ForecastChart
            rows={rows}
            keys={["occupied", "staffed"]}
            labels={["Occupied", "Staffed capacity"]}
            showBand={false}
            height={150}
            yLabel="Patients / places"
            onSelect={(i) => ctx.setTime(rows[i].at)}
          />
          {timeline.queue_scope ? (
            <>
              <p className="small-copy muted">
                {timeline.queue_scope}. These requests are not assigned
                exclusively to this unit.
              </p>
              <ForecastChart
                rows={rows}
                keys={["shared_care_queue"]}
                labels={["Shared care queue"]}
                showBand={false}
                height={130}
                yLabel="Patients waiting"
                onSelect={(i) => ctx.setTime(rows[i].at)}
              />
            </>
          ) : null}
          <h4>Future simulated capacity changes</h4>
          <p className="small-copy muted">
            Recorded later in this completed trajectory, not future
            observations.
          </p>
          {changes.length ? (
            <>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Physical / enabled / staffed</th>
                      <th>Admissions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes
                      .slice(changesPage * 10, (changesPage + 1) * 10)
                      .map((change: Entity, index: number) => (
                        <tr key={`${change.at}-${index}`}>
                          <td>
                            <button
                              className="link-button"
                              onClick={() => ctx.setTime(change.at)}
                            >
                              {format(change.at)}
                            </button>
                          </td>
                          <td>
                            {change.physical} / {change.enabled} /{" "}
                            {change.staffed}
                          </td>
                          <td>
                            {change.active && change.admission_gate
                              ? "Team ready"
                              : "Constrained"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="spread">
                <Button
                  small
                  disabled={!changesPage}
                  onClick={() => setChangesPage((x) => x - 1)}
                >
                  Earlier changes
                </Button>
                <span className="small-copy">
                  {changesPage * 10 + 1}–
                  {Math.min(changes.length, (changesPage + 1) * 10)} of{" "}
                  {timeline.capacity_schedule_total}
                  {timeline.capacity_schedule_total > changes.length
                    ? "; next 50 shown"
                    : ""}
                </span>
                <Button
                  small
                  disabled={(changesPage + 1) * 10 >= changes.length}
                  onClick={() => setChangesPage((x) => x + 1)}
                >
                  Later changes
                </Button>
              </div>
            </>
          ) : (
            <p className="small-copy muted">
              No later capacity changes in this selected trajectory.
            </p>
          )}
        </>
      ) : !loading ? (
        <p className="small-copy muted">
          Run this scenario to inspect unit occupancy, shared waiting demand and
          actual capacity changes.
        </p>
      ) : null}
    </div>
  );
}
