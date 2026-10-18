import type { Entity, PlanningContext } from "../types";
import {
  actualInventory,
  type SearchKind,
  searchEntityId,
} from "./workspaceSearch";
import { humanLabel } from "../presentation";
import { localDate } from "../api";
import { Button, Modal } from "./ui";

/** A focused inspection dialog replaces the separate resource workspace. */
export default function HospitalResourceDetails({
  ctx,
  onClose,
  onUpdate,
}: {
  ctx: PlanningContext;
  onClose: () => void;
  onUpdate: () => void;
}) {
  const selected = ctx.selectedResource;
  if (!selected) return null;
  const table = (
    {
      staff: "staff",
      equipment_pool: "equipment_pools",
      slot: "slots",
      vehicle: "vehicles",
    } as Record<string, string>
  )[selected.kind];
  const row = table
    ? actualInventory(
        selected.kind as SearchKind,
        ctx.dataset?.[table],
        ctx.stateLoading || ctx.stateError ? [] : ctx.state?.[table],
      ).find(
        (item) =>
          searchEntityId(selected.kind as SearchKind, item) === selected.id,
      )
    : undefined;
  const unit = ctx.dataset?.units?.find(
    (u: Entity) => u.unit_id === (row?.unit_id || row?.home_unit_id),
  );
  const title =
    row?.name ||
    (row?.display_label && `Bed ${row.display_label}`) ||
    humanLabel(row?.capability_code || row?.role || "Hospital item");
  const fields = [
    [
      "Location",
      unit?.name ||
        (row?.employment_pool === "reserve" || row?.portable
          ? "Hospital reserve"
          : "Hospital"),
    ],
    ["Role", row?.role && humanLabel(row.role)],
    ["Equipment", row?.capability_code && humanLabel(row.capability_code)],
    ["Total", row?.quantity],
    ["In use", row?.in_use],
    ["Available", row?.available],
    ["Status", row?.status && humanLabel(row.status)],
    [
      "Bed enabled",
      row?.enabled === undefined ? undefined : row.enabled ? "Yes" : "No",
    ],
    [
      "Installation",
      row?.installation_status && humanLabel(row.installation_status),
    ],
    ["Skills", row?.capabilities?.map(humanLabel).join(", ")],
  ].filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  return (
    <Modal title={String(title)} onClose={onClose}>
      <p className="small-copy muted">
        {row?.current
          ? `At ${localDate(ctx.selectedTime, { timeZone: ctx.resultScenario?.timezone || ctx.dataset?.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
          : "Starting hospital inventory"}
      </p>
      {ctx.stateLoading ? (
        <p role="status">Updating selected time…</p>
      ) : ctx.stateError ? (
        <p role="alert">
          Current state could not be loaded. The source inventory is shown.
        </p>
      ) : null}
      {row ? (
        <dl className="detail-list">
          {fields.map(([label, value]) => (
            <div key={String(label)}>
              <dt>{label}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>This item is not part of the current hospital inventory.</p>
      )}
      <details>
        <summary>Record details</summary>
        <p className="small-copy mono">{selected.id}</p>
      </details>
      {row && ["staff", "equipment_pool", "slot"].includes(selected.kind) ? (
        <div className="modal-actions">
          <Button
            onClick={onUpdate}
            disabled={!ctx.canWrite || ctx.stateLoading || !!ctx.stateError}
          >
            Record change
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}
