import { useQuery } from "@tanstack/react-query";
import { api, localDate } from "../api";
import { Button, ErrorBox } from "../components/ui";
import type { Entity } from "../types";
import type { FloorPlan } from "./replayFloorPlanModel";
import { dischargeHistoryPath } from "./replayFloorPlanModel";

/** A bounded recent history, filtered to the same hospital as the cumulative tile. */
export default function ReplayDischargeHistory({
  rep,
  plan,
  onSelect,
}: {
  rep: string;
  plan: FloorPlan;
  onSelect: (event: Entity) => void;
}) {
  const unitIds = plan.units.map((unit) => unit.id);
  const query = useQuery({
    queryKey: [
      "floor-plan-discharges",
      rep,
      plan.at,
      plan.mainFacility,
      unitIds,
    ],
    enabled: Boolean(rep && plan.at && plan.discharges !== null),
    staleTime: Infinity,
    queryFn: async () => {
      let cursor: string | null = "0";
      const events: Entity[] = [];
      do {
        const response: Entity = await api(
          dischargeHistoryPath(rep, plan.at!, cursor),
        );
        events.push(
          ...(response.items || []).filter((event: Entity) =>
            event.facility_id
              ? event.facility_id === plan.mainFacility
              : event.from_unit_id
                ? unitIds.includes(event.from_unit_id)
                : true,
          ),
        );
        cursor = response.next_cursor || null;
      } while (cursor && events.length < 20);
      return events.slice(0, 20);
    },
  });
  return (
    <div className="inspector-section replay-discharge-history">
      <h3>Discharged so far</h3>
      <p className="small-copy muted">
        {plan.discharges === null
          ? "Discharge total unavailable."
          : `${plan.discharges.toLocaleString()} patients discharged since this run began.`}{" "}
        The latest recorded departures appear below. This area has no modeled
        beds or waiting time.
      </p>
      {query.isFetching ? (
        <p role="status" className="small-copy muted">
          Loading recorded discharges…
        </p>
      ) : null}
      {query.error ? (
        <>
          <ErrorBox error={query.error.message} />
          <Button small onClick={() => void query.refetch()}>
            Retry discharge history
          </Button>
        </>
      ) : null}
      <div className="replay-event-list">
        {(query.data || []).map((event: Entity) => (
          <button
            key={event.event_id || event.sequence_number}
            onClick={() => onSelect(event)}
          >
            <span className="event-time">
              {localDate(event.occurred_at, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <div>
              <strong>Patient discharged</strong>
              <small>
                Patient{" "}
                {String(event.patient_id || "").match(/(\d+)$/)?.[1] ||
                  String(event.patient_id || "").slice(-6)}{" "}
                · View care history
              </small>
            </div>
          </button>
        ))}
      </div>
      {plan.discharges === null ? (
        <p className="small-copy muted">
          Recorded discharge history is unavailable.
        </p>
      ) : !query.isPending && !query.error && !query.data?.length ? (
        <p className="small-copy muted">
          No recorded discharges by this moment.
        </p>
      ) : null}
    </div>
  );
}
