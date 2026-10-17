import { useEffect, useState } from "react";
import { ArrowRight, Check, History, Save } from "lucide-react";
import type { Dataset, Entity, PlanningContext, UpdateTarget } from "../types";
import type {
  BranchSource,
  ResetReconciliation,
  UpdateCreate,
} from "../api-contracts";
import { createUpdate, applyUpdate } from "../commands";
import { api, ApiError, fmt, items, localDate, patientId, post } from "../api";
import { Badge, Button, Busy, ErrorBox, Modal } from "./ui";
import { ZonedDateTimeInput } from "./ZonedDateTimeInput";
import { utcMinute } from "../zonedTime";
import { updateDefaults } from "./updateContext";
import { ArrivalResourceMixEditor } from "./ArrivalResourceMixEditor";
import {
  activeArrivalResourceMix,
  arrivalResourceMixError,
  defaultArrivalResourceMix,
} from "./arrivalProfileWeights";

type SourceMode = "selected_replication" | "paired_ensemble" | "observed_reset";
const updateKinds = [
  ["arrival_batch", "Additional arrival batch"],
  ["staff_unavailable", "Staff availability loss"],
  ["advertised_capacity_change", "Advertised receiving capacity"],
  ["capacity_change", "Enabled physical places"],
  ["site_ready", "Site readiness"],
  ["equipment_change", "Equipment inventory"],
  ["route_change", "Travel route"],
  ["patient_departure", "Patient departure"],
] as const;
function errorText(error: unknown) {
  return error instanceof ApiError
    ? `${error.message}${error.details.length ? " — " + error.details.map((d) => `${d.field || ""}: ${d.message || ""}`).join("; ") : ""}`
    : error instanceof Error
      ? error.message
      : String(error);
}
function isoMinute(value: string) {
  const date = new Date(`${value}:00Z`);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Choose a valid effective timestamp.");
  return date.toISOString();
}

export default function UpdateDialog({
  ctx,
  onClose,
  target,
}: {
  ctx: PlanningContext;
  onClose: () => void;
  target?: UpdateTarget | null;
}) {
  const [initial] = useState(() => updateDefaults(ctx, target));
  const [tab, setTab] = useState<"record" | "history">("record"),
    [type, setType] = useState<UpdateCreate["type"]>(initial.type),
    [sourceMode, setSourceMode] = useState<SourceMode>(
      initial.observedReset ? "observed_reset" : "selected_replication",
    ),
    [when, setWhen] = useState(utcMinute(initial.effectiveAt)),
    [timeEdited, setTimeEdited] = useState(false);
  const [count, setCount] = useState(initial.count),
    [spread, setSpread] = useState(60),
    [hours, setHours] = useState(12),
    [wardPercent, setWardPercent] = useState(16),
    [icuPercent, setIcuPercent] = useState(4),
    [entry, setEntry] = useState(
      () =>
        (ctx.dataset?.entry_streams || []).find(
          (s: Entity) =>
            s.enabled &&
            s.destination_facility_id === initial.facility &&
            s.entry_type === "ed",
        )?.entry_stream_id ||
        (ctx.dataset?.entry_streams || []).find(
          (s: Entity) => s.destination_facility_id === initial.facility,
        )?.entry_stream_id ||
        "",
    ),
    [note, setNote] = useState(""),
    [enqueue, setEnqueue] = useState(true),
    [replications, setReplications] = useState(
      ctx.resultScenario?.replications || ctx.scenario?.replications || 100,
    );
  const [resourceMix, setResourceMix] = useState(() =>
    defaultArrivalResourceMix(ctx.dataset, entry),
  );
  const entryStream = (ctx.dataset?.entry_streams || []).find(
    (s: Entity) => s.entry_stream_id === entry,
  );
  const careMix: Record<string, number> =
    entryStream?.entry_type === "direct_ward"
      ? { ward: 1 }
      : {
          discharge: Math.max(0, 100 - wardPercent - icuPercent) / 100,
          ward: wardPercent / 100,
          icu: icuPercent / 100,
        };
  const [facility, setFacility] = useState(initial.facility),
    [unit, setUnit] = useState(initial.unit),
    [equipment, setEquipment] = useState(initial.equipment),
    [operation, setOperation] = useState("add"),
    [route, setRoute] = useState(initial.route),
    [routeUnavailable, setRouteUnavailable] = useState(false),
    [person, setPerson] = useState(initial.person),
    [staffIds, setStaffIds] = useState<string[]>(initial.staffIds),
    [allocations, setAllocations] = useState("[]");
  const [replicas, setReplicas] = useState<Entity[]>([]),
    [selectedReplica, setSelectedReplica] = useState(
      ctx.activeReplicationId || ctx.run?.selected_replication_id || "",
    ),
    [datasets, setDatasets] = useState<Entity[]>([]),
    [observedId, setObservedId] = useState(""),
    [observed, setObserved] = useState<Dataset | null>(null),
    [reconciliation, setReconciliation] = useState<Entity | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [history, setHistory] = useState<Entity[]>([]),
    [correction, setCorrection] = useState<Entity | null>(null),
    [correctionJson, setCorrectionJson] = useState(""),
    [correctionReason, setCorrectionReason] = useState("");
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [savedEvent, setSavedEvent] = useState<Entity | null>(null),
    [previewBusy, setPreviewBusy] = useState(false);
  const canWrite =
    (ctx as PlanningContext & { canWrite?: boolean }).canWrite !== false;
  const complete = ctx.run?.status === "SUCCEEDED",
    units = ctx.dataset?.units || [],
    sites = ctx.dataset?.facilities || [],
    staff = ctx.dataset?.staff || [],
    patients = [
      ...(ctx.selectedPatient ? [ctx.selectedPatient] : []),
      ...(ctx.state?.patients || ctx.dataset?.patients || []),
    ].filter(
      (patient, index, rows) =>
        rows.findIndex((row) => patientId(row) === patientId(patient)) ===
        index,
    );
  useEffect(() => {
    let ignore = false;
    async function allPages(path: string) {
      const collected: Entity[] = [];
      let cursor: string | null = null;
      do {
        const result: Entity = await api(
          `${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        collected.push(...items(result));
        cursor = result.next_cursor || null;
      } while (cursor);
      return collected;
    }
    Promise.all([
      allPages("/datasets"),
      allPages(
        `/updates?scenario_id=${encodeURIComponent(ctx.scenario?.id || "")}`,
      ),
      ctx.run
        ? allPages(`/run-groups/${ctx.run.id}/replications`)
        : Promise.resolve([]),
    ])
      .then(([versions, updates, runs]) => {
        if (ignore) return;
        setDatasets(items(versions));
        setHistory(items(updates));
        setReplicas(items(runs));
      })
      .catch((e) => {
        if (!ignore) setError(errorText(e));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [ctx.run?.id, ctx.scenario?.id]);
  useEffect(() => {
    setObserved(null);
    setReconciliation(null);
    setConfirmed(false);
    if (!observedId) return;
    let ignore = false;
    api<Dataset>(`/datasets/${observedId}`)
      .then((data) => {
        if (!ignore) {
          setObserved(data);
          setWhen(utcMinute(data.snapshot_at));
        }
      })
      .catch((e) => {
        if (!ignore) setError(errorText(e));
      });
    return () => {
      ignore = true;
    };
  }, [observedId]);
  const effective =
    sourceMode === "observed_reset" && observed
      ? observed.snapshot_at
      : !timeEdited && initial.effectiveAt
        ? initial.effectiveAt
        : when
          ? `${when}:00Z`
          : "";
  let payload: Entity = {};
  let payloadError = "";
  try {
    const until = new Date(
      Date.parse(effective) + hours * 3600000,
    ).toISOString();
    if (sourceMode === "observed_reset")
      payload = {
        observed_dataset_version_id: observedId,
        effective_at: effective,
      };
    else if (type === "arrival_batch") {
      payload = {
        facility_id: facility,
        entry_stream_id: entry,
        count,
        spread_minutes: spread,
        care_mix: careMix,
        resource_profile_mix: activeArrivalResourceMix(resourceMix, careMix),
      };
      payloadError =
        !entryStream || entryStream.destination_facility_id !== facility
          ? "This facility has no selected matching arrival stream. Choose its declared entry pathway or another facility."
          : arrivalResourceMixError(ctx.dataset, resourceMix, careMix);
    } else if (type === "staff_unavailable")
      payload = {
        unit_id: unit,
        count,
        staff_ids: staffIds.length ? staffIds : undefined,
        until,
      };
    else if (type === "advertised_capacity_change")
      payload = {
        unit_id: unit,
        advertised_staffed_capacity: count,
        reason: note,
      };
    else if (type === "capacity_change")
      payload = { unit_id: unit, enabled_capacity: count, reason: note };
    else if (type === "site_ready")
      payload = {
        facility_id: facility,
        enabled_slots: count,
        assigned_staff_ids: staffIds,
        equipment_allocations: JSON.parse(allocations),
      };
    else if (type === "equipment_change")
      payload = {
        pool_id: equipment,
        equipment_pool_id: equipment,
        quantity_delta: operation === "decommission" ? -Math.abs(count) : count,
        quantity: count,
        operation,
        reason: note,
      };
    else if (type === "route_change")
      payload = {
        route_id: route,
        travel_minutes: count,
        unavailable: routeUnavailable,
        until,
      };
    else payload = { patient_id: person, destination_kind: "discharge" };
  } catch {
    payloadError =
      "Review the effective timestamp and equipment allocation JSON.";
  }
  async function previewReset() {
    if (!observed || !ctx.scenario) return;
    setPreviewBusy(true);
    setError("");
    try {
      const request: ResetReconciliation = {
        observed_dataset_version_id: observed.id,
        effective_at: observed.snapshot_at,
        parent_scenario_revision_id: complete
          ? ctx.run?.scenario_revision_id
          : undefined,
        parent_run_group_id: complete ? ctx.run?.id : undefined,
        reference_replication_id: complete
          ? ctx.activeReplicationId || ctx.run?.selected_replication_id
          : undefined,
      };
      setReconciliation(
        await post(
          `/scenarios/${ctx.scenario.id}/reset-reconciliation`,
          request,
        ),
      );
      setConfirmed(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPreviewBusy(false);
    }
  }
  async function save() {
    if (!ctx.scenario || !canWrite) return;
    setSaving(true);
    setError("");
    try {
      if (payloadError && !savedEvent) throw new Error(payloadError);
      if (
        type === "arrival_batch" &&
        entryStream?.entry_type === "ed" &&
        wardPercent + icuPercent > 100
      )
        throw new Error(
          "Ward and ICU percentages cannot add up to more than 100%.",
        );
      if (
        sourceMode === "observed_reset" &&
        (!observed || !confirmed || !reconciliation)
      )
        throw new Error(
          "Select and validate a complete observed snapshot, then confirm its reconciliation.",
        );
      if (enqueue && sourceMode !== "observed_reset" && !complete)
        throw new Error(
          "Complete a parent simulation first, or save this planning input without a forecast.",
        );
      const time =
          savedEvent?.effective_at ||
          (sourceMode === "observed_reset" && observed
            ? observed.snapshot_at
            : !timeEdited && initial.effectiveAt
              ? initial.effectiveAt
              : isoMinute(when)),
        origin =
          sourceMode === "observed_reset"
            ? "observed_reset"
            : "simulation_branch";
      const record: Entity =
        savedEvent ??
        (await createUpdate({
          scenario_id: ctx.scenario.id,
          type: sourceMode === "observed_reset" ? "census_replacement" : type,
          effective_at: time,
          state_origin: origin,
          payload,
          source: initial.target
            ? `inspector:${initial.target.kind}:${initial.target.id}`
            : "user_planning_input",
          note,
          replication_id:
            sourceMode === "selected_replication" ? selectedReplica : undefined,
          parent_run_group_id:
            sourceMode !== "observed_reset" && complete
              ? ctx.run?.id
              : undefined,
        }));
      setSavedEvent(record);
      if (!enqueue) {
        ctx.notify(
          "Immutable planning input saved. No forecast has been submitted.",
        );
        setHistory((v) => [record, ...v.filter((x) => x.id !== record.id)]);
        setTab("history");
        return;
      }
      const source: BranchSource =
        sourceMode === "observed_reset"
          ? {
              observed_dataset_version_id: observedId,
              reconciliation_policy: "replace_complete_snapshot",
              parent_run_group_id: reconciliation?.basis.run_group_id,
              reference_replication_id: reconciliation?.basis.replication_id,
              reconciliation_hash: reconciliation?.reconciliation_hash,
            }
          : {
              parent_run_group_id: ctx.run!.id,
              branch_strategy: sourceMode,
              source_replication_id:
                sourceMode === "selected_replication"
                  ? selectedReplica
                  : undefined,
            };
      const result = await applyUpdate(
        record.id,
        {
          parent_scenario_revision_id:
            sourceMode === "observed_reset"
              ? reconciliation?.basis.scenario_revision_id
              : ctx.run?.scenario_revision_id,
          effective_at: time,
          state_origin: origin,
          update_ids: [record.id],
          source,
          replications:
            sourceMode === "paired_ensemble"
              ? ctx.run!.replications_requested
              : replications,
          enqueue: true,
        },
        ctx.scenario.revision,
      );
      await ctx.refresh();
      ctx.notify(
        `New forecast queued. Previous results remain available. ${result.scenario?.conditional_label || ""}`,
      );
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function applyRecorded(event: Entity) {
    if (!ctx.scenario) return;
    setSaving(true);
    setError("");
    try {
      if (event.scenario_id !== ctx.scenario.id)
        throw new Error(
          "Open the source scenario from the scenario library to reforecast this recorded input.",
        );
      const observed = event.state_origin === "observed_reset";
      if (observed) {
        setSourceMode("observed_reset");
        setObservedId(event.payload.observed_dataset_version_id);
        setReconciliation(null);
        setConfirmed(false);
        setSavedEvent(event);
        setEnqueue(true);
        setTab("record");
        return;
      }
      if (!observed && !complete)
        throw new Error(
          "Complete a parent run of this scenario before applying the recorded input.",
        );
      const source: BranchSource = observed
        ? {
            observed_dataset_version_id:
              event.payload.observed_dataset_version_id,
            reconciliation_policy: "replace_complete_snapshot",
          }
        : {
            parent_run_group_id: ctx.run!.id,
            branch_strategy: "selected_replication",
            source_replication_id:
              ctx.activeReplicationId || ctx.run!.selected_replication_id,
          };
      await applyUpdate(
        event.id,
        {
          parent_scenario_revision_id: ctx.run?.scenario_revision_id,
          effective_at: event.effective_at,
          state_origin: event.state_origin,
          update_ids: [event.id],
          source,
          replications: ctx.scenario.replications,
          enqueue: true,
        },
        ctx.scenario.revision,
      );
      await ctx.refresh();
      ctx.notify(
        "A new forecast has been queued from the recorded input and selected history.",
      );
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function saveCorrection() {
    if (!correction) return;
    setSaving(true);
    setError("");
    try {
      const value = JSON.parse(correctionJson);
      if (!correctionReason.trim())
        throw new Error("Explain why this report is being corrected.");
      const amended = await post(`/updates/${correction.id}/correct`, {
        payload: value,
        reason: correctionReason,
      });
      setHistory((v) => [amended, ...v]);
      setCorrection(null);
      ctx.notify(
        "Correction recorded as a new immutable input. The original report and its forecasts remain preserved.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  function changeSource(value: SourceMode) {
    setSourceMode(value);
    setSavedEvent(null);
    setError("");
    setConfirmed(false);
  }
  const historyForContext = history.filter(
    (e) =>
      e.scenario_id === ctx.scenario?.id ||
      (ctx.scenario?.updates || []).some((u: Entity) => u.update_id === e.id),
  );
  return (
    <Modal title="Timestamped planning updates" wide onClose={onClose}>
      <div className="form-stack">
        <div className="segmented" aria-label="Update section">
          <button
            className={tab === "record" ? "active" : ""}
            onClick={() => setTab("record")}
          >
            New update
          </button>
          <button
            className={tab === "history" ? "active" : ""}
            onClick={() => setTab("history")}
          >
            <History size={14} />
            Recorded history
          </button>
        </div>
        {error ? <ErrorBox error={error} /> : null}
        {loading ? (
          <Busy label="Loading update context" />
        ) : tab === "history" ? (
          <>
            <p className="muted">
              Corrections create new records. Applied updates retain their
              source scenario and prior forecast.
            </p>
            {historyForContext.length ? (
              historyForContext.map((event) => (
                <div className="assumption-row" key={event.id}>
                  <div>
                    <strong>{event.type.replaceAll("_", " ")}</strong>{" "}
                    <Badge>
                      {event.applied_scenario_id ? "Applied" : "Recorded"}
                    </Badge>
                    <p>
                      {localDate(event.effective_at, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      · {event.source}
                    </p>
                    <small className="mono muted">{event.id}</small>
                    <details>
                      <summary>Inspect payload and lineage</summary>
                      <pre style={{ whiteSpace: "pre-wrap" }}>
                        {JSON.stringify(
                          {
                            payload: event.payload,
                            scenario_id: event.scenario_id,
                            applied_scenario_id: event.applied_scenario_id,
                            supersedes_update_id: event.supersedes_update_id,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                  <div className="form-stack">
                    {!event.applied_scenario_id &&
                    event.scenario_id === ctx.scenario?.id ? (
                      <Button
                        small
                        disabled={
                          !canWrite ||
                          saving ||
                          (!complete && event.state_origin !== "observed_reset")
                        }
                        onClick={() => applyRecorded(event)}
                      >
                        Reforecast from this input
                      </Button>
                    ) : null}
                    <Button
                      small
                      disabled={!canWrite || saving}
                      onClick={() => {
                        setCorrection(event);
                        setCorrectionJson(
                          JSON.stringify(event.payload, null, 2),
                        );
                        setCorrectionReason("");
                      }}
                    >
                      Record correction
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <p>No inputs have been recorded for this scenario.</p>
            )}
            {correction ? (
              <section className="form-stack">
                <h3>Correction to {correction.type.replaceAll("_", " ")}</h3>
                <label>
                  Replacement payload
                  <textarea
                    className="json-editor"
                    value={correctionJson}
                    onChange={(e) => setCorrectionJson(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label>
                  Reason
                  <textarea
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                  />
                </label>
                <div className="info-note">
                  This records a new input against its original scenario. A
                  revised forecast is a separate branch; existing results remain
                  unchanged.
                </div>
                <Button
                  primary
                  disabled={saving || !canWrite}
                  onClick={saveCorrection}
                >
                  <Save size={15} />
                  Save correction
                </Button>
              </section>
            ) : null}
          </>
        ) : (
          <>
            {initial.target ? (
              <div className="info-note" data-testid="update-source-context">
                <strong>
                  Selected {initial.target.kind.replaceAll("_", " ")}:{" "}
                  {initial.target.id}
                </strong>
                <p>
                  Dataset {ctx.dataset?.id} ·{" "}
                  {complete
                    ? `saved revision ${ctx.run?.scenario_revision_id} · replication ${initial.observedReset ? ctx.activeReplicationId || ctx.run?.selected_replication_id : selectedReplica}`
                    : "source snapshot"}
                  .
                </p>
                <p>
                  Selected instant:{" "}
                  {localDate(initial.effectiveAt, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    fractionalSecondDigits: 3,
                    timeZoneName: "short",
                  })}
                  . This records a new input; the selected result remains
                  preserved.
                </p>
                {initial.observedReset ? (
                  <p>
                    This resource needs a complete observed snapshot to replace
                    its state. Import that snapshot in Data & setup, then choose
                    it below.
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="info-note">
              Choose the history being inherited, then describe a measured
              observation or hypothetical operational change. New arrival
              batches add demand; absolute census counts require a complete
              replacement snapshot.
            </div>
            <fieldset
              className="form-stack"
              disabled={!!savedEvent}
              style={{ border: 0, padding: 0, margin: 0 }}
            >
              <label>
                Starting state
                <select
                  value={sourceMode}
                  onChange={(e) => changeSource(e.target.value as SourceMode)}
                  disabled={!!savedEvent}
                >
                  <option value="selected_replication">
                    One actual simulated history → new conditional futures
                  </option>
                  <option value="paired_ensemble">
                    Each parent simulation → matched future ensemble
                  </option>
                  <option value="observed_reset">
                    Complete census/resource snapshot → observed-state reset
                  </option>
                </select>
              </label>
              {sourceMode === "selected_replication" ? (
                <label>
                  Parent simulation
                  <select
                    aria-label="Parent simulation"
                    value={selectedReplica}
                    onChange={(e) => setSelectedReplica(e.target.value)}
                    disabled={!!savedEvent}
                  >
                    <option value="">Select a completed simulation</option>
                    {replicas.map((r) => (
                      <option key={r.id} value={r.id}>
                        Replication {r.replication_index} · seed {r.seed}
                        {r.id === ctx.run?.selected_replication_id
                          ? " · representative"
                          : ""}
                      </option>
                    ))}
                  </select>
                  <small className="muted">
                    Every future shares this exact inherited history and samples
                    independent uncertainty after the cutoff.
                  </small>
                </label>
              ) : sourceMode === "paired_ensemble" ? (
                <p className="muted">
                  Inherits each of the {ctx.run?.replications_requested || 0}{" "}
                  completed parent histories with matched random streams.
                </p>
              ) : (
                <>
                  <label>
                    Complete replacement snapshot
                    <select
                      value={observedId}
                      onChange={(e) => setObservedId(e.target.value)}
                      disabled={!!savedEvent}
                    >
                      <option value="">
                        Select a validated committed dataset
                      </option>
                      {datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name || d.label || d.fixture} · {d.snapshot_at}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted">
                    Import a complete snapshot through Data & setup if the
                    required observation is not listed. Its timestamp must equal
                    the reset cutoff. Synthetic fixtures retain their synthetic
                    label.
                  </p>
                </>
              )}
              <ZonedDateTimeInput
                label="Effective time"
                value={when}
                timeZone={
                  (ctx.resultScenario || ctx.scenario)?.timezone ||
                  "America/Chicago"
                }
                onChange={(value) => {
                  setWhen(value);
                  setTimeEdited(true);
                  setConfirmed(false);
                  setReconciliation(null);
                }}
                disabled={!!savedEvent || sourceMode === "observed_reset"}
                required
              />
              {sourceMode === "observed_reset" ? (
                <>
                  {observed ? (
                    <p className="small-copy">
                      Exact snapshot cutoff:{" "}
                      {localDate(observed.snapshot_at, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        fractionalSecondDigits: 3,
                        timeZoneName: "short",
                      })}
                      . The complete snapshot retains this exact instant.
                    </p>
                  ) : null}
                  <Button
                    disabled={!observed || previewBusy}
                    onClick={previewReset}
                  >
                    <Check size={14} />
                    {previewBusy
                      ? "Checking snapshot…"
                      : "Validate & preview reconciliation"}
                  </Button>
                  {reconciliation ? (
                    <>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(3,1fr)",
                          gap: 12,
                        }}
                      >
                        {[
                          ["matched", "Matched patients"],
                          ["absent", "Absent from snapshot"],
                          ["new", "Newly observed"],
                        ].map(([key, label]) => (
                          <div className="stat" key={key}>
                            <span className="eyebrow">{label}</span>
                            <strong>{fmt(reconciliation[key].length)}</strong>
                          </div>
                        ))}
                      </div>
                      <p className="muted">
                        Absent is a reconciliation outcome, not a discharge
                        event. The new snapshot supplies all census, resources
                        and schedules. Previously included arrival reports must
                        not be added a second time.
                      </p>
                      <details>
                        <summary>
                          Patient ID changes and update reconciliation
                        </summary>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            maxHeight: 180,
                            overflow: "auto",
                          }}
                        >
                          {JSON.stringify(
                            {
                              matched: reconciliation.matched,
                              absent: reconciliation.absent,
                              new: reconciliation.new,
                              basis: reconciliation.basis,
                              update_disposition:
                                reconciliation.update_disposition,
                              included_update_ids:
                                reconciliation.included_update_ids,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      <label
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(e) => setConfirmed(e.target.checked)}
                        />
                        I reviewed the complete replacement and these
                        reconciliation outcomes.
                      </label>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <label>
                    Change to record
                    <select
                      value={type}
                      onChange={(e) => {
                        setType(e.target.value as UpdateCreate["type"]);
                        setSavedEvent(null);
                        if (
                          e.target.value === "advertised_capacity_change" &&
                          !units.some(
                            (u) =>
                              u.unit_id === unit &&
                              u.capacity_mode === "advertised_aggregate",
                          )
                        )
                          setUnit(
                            units.find(
                              (u) => u.capacity_mode === "advertised_aggregate",
                            )?.unit_id || "",
                          );
                      }}
                      disabled={!!savedEvent}
                    >
                      {updateKinds.map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {["arrival_batch", "site_ready"].includes(type) ? (
                    <label>
                      Facility
                      <select
                        value={facility}
                        onChange={(e) => {
                          const id = e.target.value;
                          setFacility(id);
                          if (type === "arrival_batch") {
                            const stream = (
                              ctx.dataset?.entry_streams || []
                            ).find(
                              (item: Entity) =>
                                item.destination_facility_id === id,
                            );
                            const selected = stream?.entry_stream_id || "";
                            setEntry(selected);
                            setResourceMix(
                              defaultArrivalResourceMix(ctx.dataset, selected),
                            );
                          }
                        }}
                      >
                        {sites.map((f) => (
                          <option key={f.facility_id} value={f.facility_id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {[
                    "staff_unavailable",
                    "advertised_capacity_change",
                    "capacity_change",
                  ].includes(type) ? (
                    <label>
                      Unit
                      <select
                        value={unit}
                        onChange={(e) => setUnit(e.target.value)}
                      >
                        {units
                          .filter(
                            (u) =>
                              type !== "advertised_capacity_change" ||
                              u.capacity_mode === "advertised_aggregate",
                          )
                          .map((u) => (
                            <option key={u.unit_id} value={u.unit_id}>
                              {u.name} · {u.facility_id}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : null}
                  {type === "arrival_batch" ? (
                    <>
                      <label>
                        Entry pathway
                        <select
                          value={entry}
                          onChange={(e) => {
                            const id = e.target.value;
                            setEntry(id);
                            setResourceMix(
                              defaultArrivalResourceMix(ctx.dataset, id),
                            );
                            const stream = (
                              ctx.dataset?.entry_streams || []
                            ).find(
                              (item: Entity) => item.entry_stream_id === id,
                            );
                            if (stream?.destination_facility_id)
                              setFacility(stream.destination_facility_id);
                          }}
                        >
                          <option value="">
                            Choose a declared entry pathway
                          </option>
                          {(ctx.dataset?.entry_streams || []).map(
                            (stream: Entity) => (
                              <option
                                key={stream.entry_stream_id}
                                value={stream.entry_stream_id}
                              >
                                {stream.entry_stream_id} ·{" "}
                                {stream.entry_type === "direct_ward"
                                  ? "Direct ward admission"
                                  : "Emergency department assessment"}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(2,1fr)",
                          gap: 12,
                        }}
                      >
                        <label>
                          Additional patients
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            value={count}
                            onChange={(e) => setCount(+e.target.value)}
                          />
                        </label>
                        <label>
                          Spread over minutes
                          <input
                            type="number"
                            min={0}
                            max={10080}
                            value={spread}
                            onChange={(e) => setSpread(+e.target.value)}
                          />
                        </label>
                        {entryStream?.entry_type === "ed" ? (
                          <>
                            <label>
                              Ward disposition (%)
                              <input
                                type="number"
                                min={0}
                                max={100}
                                value={wardPercent}
                                onChange={(e) =>
                                  setWardPercent(+e.target.value)
                                }
                              />
                            </label>
                            <label>
                              ICU disposition (%)
                              <input
                                type="number"
                                min={0}
                                max={100}
                                value={icuPercent}
                                onChange={(e) => setIcuPercent(+e.target.value)}
                              />
                            </label>
                          </>
                        ) : null}
                      </div>
                      <small className="muted">
                        {entryStream?.entry_type === "ed"
                          ? `${Math.max(0, 100 - wardPercent - icuPercent)}% discharge after assessment.`
                          : "All patients request ward placement."}{" "}
                        This batch is additional to the forecast arrival
                        process.
                      </small>
                      <ArrivalResourceMixEditor
                        dataset={ctx.dataset}
                        mix={resourceMix}
                        careMix={careMix}
                        onChange={(care, profileId, weight) =>
                          setResourceMix((previous) => ({
                            ...previous,
                            [care]: { ...previous[care], [profileId]: weight },
                          }))
                        }
                      />
                      {payloadError ? (
                        <p role="alert" className="muted">
                          {payloadError}
                        </p>
                      ) : null}
                    </>
                  ) : type === "patient_departure" ? (
                    <label>
                      Patient
                      <select
                        value={person}
                        onChange={(e) => setPerson(e.target.value)}
                      >
                        <option value="">
                          Select a patient in this context
                        </option>
                        {patients.map((p: Entity) => (
                          <option key={patientId(p)} value={patientId(p)}>
                            {patientId(p)} · {p.unit_id || p.state}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label>
                      {type === "advertised_capacity_change"
                        ? "Total advertised staffed places"
                        : type === "capacity_change"
                          ? "Total enabled physical places"
                          : type === "staff_unavailable"
                            ? "Number of staff unavailable"
                            : type === "route_change"
                              ? "Directed travel time (minutes)"
                              : type === "site_ready"
                                ? "Enabled treatment places"
                                : "Equipment quantity"}
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        value={count}
                        onChange={(e) => setCount(+e.target.value)}
                      />
                    </label>
                  )}
                  {["staff_unavailable", "route_change"].includes(type) ? (
                    <label>
                      Duration (elapsed hours)
                      <input
                        type="number"
                        min={1}
                        max={8760}
                        value={hours}
                        onChange={(e) => setHours(+e.target.value)}
                      />
                    </label>
                  ) : null}
                  {type === "equipment_change" ? (
                    <>
                      <label>
                        Equipment pool
                        <select
                          value={equipment}
                          onChange={(e) => setEquipment(e.target.value)}
                        >
                          {ctx.dataset?.equipment_pools?.map((p: Entity) => (
                            <option
                              key={p.equipment_pool_id}
                              value={p.equipment_pool_id}
                            >
                              {p.equipment_pool_id} · {p.capability_code}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Operation
                        <select
                          value={operation}
                          onChange={(e) => setOperation(e.target.value)}
                        >
                          <option value="add">Add inventory</option>
                          <option value="decommission">
                            Decommission after current use
                          </option>
                          <option value="fail">Record equipment failure</option>
                          <option value="repair">
                            Repair failed equipment
                          </option>
                        </select>
                      </label>
                    </>
                  ) : null}
                  {type === "route_change" ? (
                    <>
                      <label>
                        Directed route
                        <select
                          value={route}
                          onChange={(e) => setRoute(e.target.value)}
                        >
                          {ctx.dataset?.routes?.map((r: Entity) => (
                            <option key={r.route_id} value={r.route_id}>
                              {r.from_facility_id || r.origin_facility_id} →{" "}
                              {r.to_facility_id || r.destination_facility_id} ·{" "}
                              {r.route_id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "flex", gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={routeUnavailable}
                          onChange={(e) =>
                            setRouteUnavailable(e.target.checked)
                          }
                        />
                        Route unavailable for the specified interval
                      </label>
                    </>
                  ) : null}
                  {["site_ready", "staff_unavailable"].includes(type) ? (
                    <label>
                      {type === "site_ready"
                        ? "Assigned qualified staff"
                        : "Specific staff (optional; otherwise use unit/count)"}
                      <select
                        multiple
                        aria-label={
                          type === "site_ready"
                            ? "Assigned qualified staff"
                            : "Specific staff (optional; otherwise use unit/count)"
                        }
                        size={5}
                        value={staffIds}
                        onChange={(e) =>
                          setStaffIds(
                            Array.from(
                              e.target.selectedOptions,
                              (o) => o.value,
                            ),
                          )
                        }
                      >
                        {staff
                          .filter(
                            (s) =>
                              type !== "site_ready" ||
                              s.employment_pool === "reserve",
                          )
                          .map((s) => (
                            <option key={s.staff_id} value={s.staff_id}>
                              {s.staff_id} · {s.role}
                            </option>
                          ))}
                      </select>
                      <small className="muted">
                        Use Command/Ctrl to select multiple staff. Assignments
                        are rechecked at execution time.
                      </small>
                    </label>
                  ) : null}
                  {type === "site_ready" ? (
                    <label>
                      Equipment allocations
                      <textarea
                        value={allocations}
                        onChange={(e) => setAllocations(e.target.value)}
                        spellCheck={false}
                        aria-label="Equipment allocations JSON"
                      />
                      <small className="muted">
                        JSON array of declared pool/quantity allocations.
                        Readiness requires conserved staff and compatible
                        equipment.
                      </small>
                    </label>
                  ) : null}
                </>
              )}
              <label>
                Source and explanation
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Record the observation or planning assumption and its source."
                  disabled={!!savedEvent}
                />
              </label>
              <details>
                <summary>Review exact input change</summary>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(savedEvent?.payload || payload, null, 2)}
                </pre>
              </details>
              <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={enqueue}
                  onChange={(e) => setEnqueue(e.target.checked)}
                />
                Create a new forecast branch after saving
              </label>
              {enqueue ? (
                <label>
                  Future repetitions
                  <select
                    value={
                      sourceMode === "paired_ensemble"
                        ? ctx.run?.replications_requested || 10
                        : replications
                    }
                    disabled={sourceMode === "paired_ensemble"}
                    onChange={(e) => setReplications(+e.target.value)}
                  >
                    {[
                      1,
                      10,
                      100,
                      500,
                      ...(sourceMode === "paired_ensemble"
                        ? [ctx.run?.replications_requested || 10]
                        : []),
                    ]
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .sort((a, b) => a - b)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n}
                          {n === 1
                            ? " · single trajectory"
                            : n === 10
                              ? " · preview"
                              : ""}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
            </fieldset>
            {savedEvent ? (
              <div className="info-note">
                Input {savedEvent.id} is saved. If forecasting failed, retrying
                uses the same record without adding duplicate demand.
                <Button small onClick={() => setSavedEvent(null)}>
                  Start another input
                </Button>
              </div>
            ) : null}
            <Button
              primary
              disabled={
                saving ||
                !canWrite ||
                previewBusy ||
                (type === "arrival_batch" &&
                  sourceMode !== "observed_reset" &&
                  !!payloadError &&
                  !savedEvent)
              }
              onClick={save}
            >
              {saving ? (
                <Busy label="Saving planning revision" />
              ) : (
                <>
                  <Save size={15} />
                  {enqueue ? "Save & reforecast" : "Save input"}
                  <ArrowRight size={15} />
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
