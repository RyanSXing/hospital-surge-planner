import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Boxes, Building2, Clock3, Users } from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import type { Intervention } from "../api-contracts";
import { api, atDay, fmt, localDate, post } from "../api";
import { Badge, Busy, Button, ErrorBox, Modal } from "./ui";
import { ZonedDateTimeInput } from "./ZonedDateTimeInput";
import { utcMinute } from "../zonedTime";

const fid = (row: Entity) => String(row.facility_id || row.id);
const uid = (row: Entity) => String(row.unit_id || row.id);
const timestamp = (value: string) => new Date(`${value}:00Z`).toISOString();
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));
export default function SiteActivationDialog({
  ctx,
  facility,
  onClose,
  initialSection = "staff",
}: {
  ctx: PlanningContext;
  facility: Entity;
  onClose: () => void;
  initialSection?: string;
}) {
  const [dataset, setDataset] = useState<Entity | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const displayTime = (instant: number | string) =>
    localDate(new Date(instant).toISOString(), {
      timeZone: ctx.scenario?.timezone || "America/Chicago",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  const units = (ctx.dataset?.units || []).filter(
    (u) =>
      u.facility_id === fid(facility) &&
      ["ward", "clinic"].includes(u.kind) &&
      u.capacity_mode !== "advertised_aggregate",
  );
  const [unitId, setUnitId] = useState(units[0] ? uid(units[0]) : "");
  const unit = units.find((u) => uid(u) === unitId) || units[0] || {},
    clinic = unit.kind === "clinic",
    existing = facility.kind === "hospital" && facility.status === "active";
  const [physicalOnly, setPhysicalOnly] = useState(false),
    [section, setSection] = useState(initialSection);
  const kind = existing
    ? "staff_existing"
    : clinic
      ? "clinic"
      : physicalOnly
        ? "physical_overflow"
        : "staffed_overflow";
  const policy =
    (ctx.dataset?.capacity_policies || []).find(
      (p: Entity) => p.capacity_policy_id === unit.capacity_policy_id,
    ) || {};
  const slotCount = (ctx.dataset?.slots || []).filter(
    (s) =>
      s.unit_id === unitId &&
      ["installed", "planned"].includes(s.installation_status),
  ).length;
  const [when, setWhen] = useState(utcMinute(ctx.selectedTime)),
    [delay, setDelay] = useState(
      existing ? 0 : Number(facility.activation_minutes || 0) / 60,
    ),
    [duration, setDuration] = useState(24);
  const [places, setPlaces] = useState(Math.min(slotCount, clinic ? 8 : 20)),
    [nurses, setNurses] = useState(
      Math.ceil(
        Math.min(slotCount, clinic ? 8 : 20) /
          Number(policy.slots_per_nurse || 4),
      ),
    ),
    [providers, setProviders] = useState(
      Number(policy.minimum_provider_count || 0),
    ),
    [support, setSupport] = useState(Number(policy.minimum_support_count || 0));
  const [named, setNamed] = useState(false),
    [staffIds, setStaffIds] = useState<string[]>([]),
    [equipment, setEquipment] = useState<Record<string, number>>({}),
    [preview, setPreview] = useState<Entity | null>(null),
    [previewKey, setPreviewKey] = useState("");
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api(`/datasets/${ctx.dataset?.id}`)
      .then((value) => {
        if (!ignore) setDataset(value);
      })
      .catch((e) => {
        if (!ignore) setError(failure(e));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [ctx.dataset?.id]);
  const start = when ? Date.parse(timestamp(when)) : NaN,
    ready = start + delay * 3600000,
    scenarioEnd =
      ctx.scenario?.end_at ||
      atDay(
        ctx.scenario!.start_at,
        ctx.scenario!.horizon_calendar_days,
        0,
        ctx.scenario!.timezone,
      ),
    end = Math.min(start + duration * 3600000, Date.parse(scenarioEnd));
  const care = clinic ? "CLINIC" : "WARD",
    staff = (dataset?.staff || []) as Entity[],
    assignments = (dataset?.assignments ||
      dataset?.staff_assignments ||
      []) as Entity[];
  const absent = new Set(
    (ctx.scenario?.conditions || [])
      .filter(
        (c) =>
          ["staff_unavailability", "staff_absence"].includes(c.kind) &&
          Date.parse(c.start_at) <= ready &&
          ready < Date.parse(c.end_at),
      )
      .flatMap((c) => c.staff_ids || []),
  );
  const activeReserve = new Set(
    assignments
      .filter(
        (a) =>
          a.reserve_pool_id &&
          a.status !== "unavailable" &&
          Number(a.allocation_fraction ?? 1) >= 1 &&
          Date.parse(a.start_at) <= ready &&
          ready < Date.parse(a.end_at),
      )
      .map((a) => a.staff_id),
  );
  const qualified = staff.filter(
    (s) =>
      activeReserve.has(s.staff_id) &&
      !absent.has(s.staff_id) &&
      (s.capabilities || []).includes(
        s.role === "support"
          ? "GENERAL_SUPPORT"
          : `${care}_${s.role === "rn" ? "NURSING" : "PROVIDER"}`,
      ),
  );
  const overlaps = (ctx.scenario?.interventions || []).filter((p) => {
    if (p.enabled === false) return false;
    const begin =
      Date.parse(p.start_at || ctx.scenario!.start_at) +
      Number(
        p.activation_minutes ??
          (["clinic"].includes(p.kind)
            ? 360
            : ["staffed_overflow", "physical_overflow"].includes(p.kind)
              ? 720
              : 0),
      ) *
        60000;
    const finish = p.end_at
      ? Date.parse(p.end_at)
      : Math.min(
          Date.parse(scenarioEnd),
          Date.parse(p.start_at || ctx.scenario!.start_at) +
            Number(p.duration_minutes ?? 525600) * 60000,
        );
    return begin < end && finish > ready;
  });
  const reserved = (role: string) =>
    overlaps.reduce(
      (n, p) =>
        n +
        (p.assigned_staff_ids
          ? staff.filter(
              (s) =>
                p.assigned_staff_ids.includes(s.staff_id) && s.role === role,
            ).length
          : [
                "clinic",
                "staffed_overflow",
                "staff_existing",
                "activate_clinic",
                "activate_overflow",
                "staff_existing_beds",
              ].includes(p.kind || p.template_kind)
            ? Number(
                p[
                  role === "rn"
                    ? "nurses"
                    : role === "provider"
                      ? "providers"
                      : "support"
                ] ??
                  (role === "rn"
                    ? p.kind === "clinic"
                      ? 2
                      : 5
                    : p.kind === "staff_existing"
                      ? 0
                      : 1),
              )
            : 0),
      0,
    );
  const namedCounts = Object.fromEntries(
    ["rn", "provider", "support"].map((role) => [
      role,
      staff.filter((s) => staffIds.includes(s.staff_id) && s.role === role)
        .length,
    ]),
  );
  const counts = {
    rn: physicalOnly ? 0 : named ? namedCounts.rn : nurses,
    provider:
      physicalOnly || existing ? 0 : named ? namedCounts.provider : providers,
    support:
      physicalOnly || existing ? 0 : named ? namedCounts.support : support,
  };
  const pools = (dataset?.equipment_pools || []).filter(
    (p: Entity) => p.portable && !p.unit_id,
  ) as Entity[];
  const committed = (pool: string) =>
    overlaps.reduce(
      (n, p) =>
        n +
        (p.equipment_allocations || [])
          .filter((a: Entity) => a.equipment_pool_id === pool)
          .reduce((t: number, a: Entity) => t + Number(a.quantity), 0),
      0,
    );
  const localKits = (dataset?.equipment_pools || [])
    .filter(
      (p: Entity) => p.unit_id === unitId && p.capability_code === "CLINIC_KIT",
    )
    .reduce(
      (n: number, p: Entity) =>
        n + Number(p.quantity) - Number(p.unserviceable_quantity || 0),
      0,
    );
  const allocatedKits = pools
    .filter((p) => p.capability_code === "CLINIC_KIT")
    .reduce((n, p) => n + (equipment[p.equipment_pool_id] || 0), 0);
  const gates =
    existing ||
    (counts.provider >= Number(policy.minimum_provider_count || 0) &&
      counts.support >= Number(policy.minimum_support_count || 0));
  const current = Number(unit.staffed_capacity || 0),
    supported = physicalOnly
      ? 0
      : Math.min(
          existing ? Number(unit.physical_capacity) : places,
          (existing ? current : 0) +
            counts.rn * Number(policy.slots_per_nurse || 0),
          gates ? Infinity : 0,
          clinic ? localKits + allocatedKits : Infinity,
        );
  const intervention: Intervention = useMemo(
    () => ({
      id: `response-${unitId}`,
      name: `${existing ? "Staff" : physicalOnly ? "Prepare" : "Activate"} ${facility.name}`,
      kind,
      facility_id: fid(facility),
      unit_id: unitId,
      start_at: Number.isFinite(start)
        ? new Date(start).toISOString()
        : undefined,
      end_at: Number.isFinite(end) ? new Date(end).toISOString() : undefined,
      activation_minutes: delay * 60,
      nurses: counts.rn,
      providers: counts.provider,
      support: counts.support,
      ...(!existing
        ? {
            enabled_slots: places,
            equipment_allocations: Object.entries(equipment)
              .filter(([, quantity]) => quantity > 0)
              .map(([equipment_pool_id, quantity]) => ({
                equipment_pool_id,
                quantity,
              })),
          }
        : {}),
      ...(named && !physicalOnly ? { assigned_staff_ids: staffIds } : {}),
      enabled: true,
    }),
    [
      unitId,
      facility,
      kind,
      start,
      end,
      delay,
      counts.rn,
      counts.provider,
      counts.support,
      places,
      equipment,
      staffIds,
      named,
      physicalOnly,
      existing,
    ],
  );
  const key = JSON.stringify({
      intervention,
      revision: ctx.scenario?.revision,
    }),
    currentPreview = previewKey === key ? preview : null;
  const localError = !unitId
    ? "Select a compatible unit"
    : !Number.isFinite(start) || ready >= end
      ? "Setup must complete before the response ends"
      : start < Date.parse(ctx.scenario!.start_at)
        ? "Start must be within the scenario horizon"
        : clinic && localKits + allocatedKits < places
          ? "Allocate one declared clinic kit for each enabled space"
          : "";
  async function check() {
    if (localError) {
      setError(localError);
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const result = await post(`/scenarios/${ctx.scenario?.id}/feasibility`, {
        interventions: [...(ctx.scenario?.interventions || []), intervention],
      });
      setPreview(result);
      setPreviewKey(key);
      return result;
    } catch (e) {
      setError(failure(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const result = await check();
    if (!result?.valid || !result.feasibility.feasible) return;
    setBusy(true);
    try {
      const saved = await ctx.saveScenario({
        interventions: [
          ...(ctx.scenario?.interventions || []),
          { ...intervention, id: crypto.randomUUID() },
        ],
      });
      if (saved) {
        ctx.notify(
          "Resource response saved with explicit requirements. Run or compare the scenario to evaluate its effects.",
        );
        onClose();
      } else
        setError(
          "The scenario could not be saved. Review the workspace error and retry.",
        );
    } finally {
      setBusy(false);
    }
  }
  const firstRoster = assignments
    .filter(
      (a) =>
        a.reserve_pool_id &&
        Date.parse(a.end_at) > ready &&
        staff.some(
          (s) =>
            s.staff_id === a.staff_id &&
            (s.capabilities || []).includes(`${care}_NURSING`),
        ),
    )
    .map((a) => Math.max(ready, Date.parse(a.start_at)))
    .sort((a, b) => a - b)[0];
  return (
    <Modal title={`Plan resources · ${facility.name}`} wide onClose={onClose}>
      <div className="activation-layout">
        <div className="form-stack">
          {error ? <ErrorBox error={error} /> : null}
          {loading ? (
            <Busy label="Loading complete resource schedules" />
          ) : null}
          <label>
            Receiving unit
            <select
              value={unitId}
              onChange={(e) => {
                setUnitId(e.target.value);
                setStaffIds([]);
                setEquipment({});
              }}
            >
              {units.map((u) => (
                <option value={uid(u)} key={uid(u)}>
                  {u.name} · {u.kind}
                </option>
              ))}
            </select>
          </label>
          {!existing && !clinic ? (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={physicalOnly}
                onChange={(e) => setPhysicalOnly(e.target.checked)}
              />
              Prepare physical places without additional staff
            </label>
          ) : null}
          <div className="two-fields">
            <ZonedDateTimeInput
              label="Setup begins"
              value={when}
              onChange={setWhen}
              timeZone={ctx.scenario?.timezone || "America/Chicago"}
              required
            />
            <label>
              Total duration (hours)
              <input
                type="number"
                min={0.25}
                max={8784}
                step={0.25}
                value={duration}
                onChange={(e) => setDuration(+e.target.value)}
              />
            </label>
          </div>
          <div className="two-fields">
            <label>
              Setup lead time (hours)
              <input
                type="number"
                min={0}
                max={8784}
                step={0.25}
                value={delay}
                onChange={(e) => setDelay(+e.target.value)}
              />
            </label>
            {!existing ? (
              <label>
                Places to enable
                <input
                  type="number"
                  min={0}
                  max={slotCount}
                  value={places}
                  onChange={(e) => setPlaces(+e.target.value)}
                />
              </label>
            ) : (
              <p className="small-copy">
                Existing installed inventory stays {unit.physical_capacity}{" "}
                places.
              </p>
            )}
          </div>
          {!physicalOnly ? (
            <>
              <label>
                Staff allocation
                <select
                  value={named ? "named" : "rotating"}
                  onChange={(e) => {
                    setNamed(e.target.value === "named");
                    setStaffIds([]);
                  }}
                >
                  <option value="rotating">
                    Qualified reserve roster · rotate with shifts
                  </option>
                  <option value="named">
                    Named reserve staff · available throughout interval
                  </option>
                </select>
              </label>
              {named ? (
                <div className="staff-checklist">
                  {qualified.length ? (
                    qualified
                      .filter((s) => !existing || s.role === "rn")
                      .map((s) => (
                        <label className="checkbox-label" key={s.staff_id}>
                          <input
                            type="checkbox"
                            checked={staffIds.includes(s.staff_id)}
                            onChange={(e) =>
                              setStaffIds((rows) =>
                                e.target.checked
                                  ? [...rows, s.staff_id]
                                  : rows.filter((id) => id !== s.staff_id),
                              )
                            }
                          />
                          {s.staff_id} · {s.role} · {s.team_id}
                        </label>
                      ))
                  ) : (
                    <p>
                      No qualified reserve staff are declared at the ready time.
                    </p>
                  )}
                </div>
              ) : (
                <div className="three-fields">
                  <label>
                    Nurses
                    <input
                      type="number"
                      min={0}
                      max={500}
                      value={nurses}
                      onChange={(e) => setNurses(+e.target.value)}
                    />
                  </label>
                  {!existing ? (
                    <>
                      <label>
                        Providers
                        <input
                          type="number"
                          min={0}
                          max={500}
                          value={providers}
                          onChange={(e) => setProviders(+e.target.value)}
                        />
                      </label>
                      <label>
                        Support
                        <input
                          type="number"
                          min={0}
                          max={500}
                          value={support}
                          onChange={(e) => setSupport(+e.target.value)}
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              )}
              <p className="small-copy muted">
                Sources are exclusive reserve assignments. Hospital roster
                allocations stay at their declared units. Named staff must cover
                the full response interval.
              </p>
            </>
          ) : (
            <div className="constraint-callout">
              Physical-only preparation adds no staff. Staffing and receiving
              constraints remain.
            </div>
          )}
          {!existing ? (
            <>
              <h3>Allocate portable equipment</h3>
              {pools.length ? (
                <div className="equipment-inputs">
                  {pools.map((p) => (
                    <label key={p.equipment_pool_id}>
                      {p.capability_code} · {p.equipment_pool_id}
                      <input
                        type="number"
                        min={0}
                        max={Math.max(
                          0,
                          Number(p.quantity) -
                            Number(p.unserviceable_quantity || 0) -
                            committed(p.equipment_pool_id),
                        )}
                        value={equipment[p.equipment_pool_id] || 0}
                        onChange={(e) =>
                          setEquipment((values) => ({
                            ...values,
                            [p.equipment_pool_id]: +e.target.value,
                          }))
                        }
                      />
                      <small>
                        {p.quantity - Number(p.unserviceable_quantity || 0)}{" "}
                        serviceable · {committed(p.equipment_pool_id)} committed
                        by overlapping responses
                      </small>
                    </label>
                  ))}
                </div>
              ) : (
                <p>No unassigned portable equipment is declared.</p>
              )}
            </>
          ) : null}
        </div>
        <div className="activation-preview">
          <Badge>{kind.replaceAll("_", " ")}</Badge>
          <h3>Requirements and conflicts</h3>
          <div className="activation-dependencies">
            {[
              ["staff", Users, "Personnel"],
              ["equipment", Boxes, "Equipment"],
              ["space", Building2, "Space"],
              ["readiness", Clock3, "Readiness"],
            ].map(([value, Icon, label]) => {
              const I = Icon as typeof Users;
              return (
                <button
                  key={String(value)}
                  onClick={() => setSection(String(value))}
                  aria-pressed={section === value}
                >
                  <I size={18} />
                  {String(label)}
                </button>
              );
            })}
          </div>
          {section === "staff" ? (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Required</th>
                    <th>Declared</th>
                    <th>Committed</th>
                  </tr>
                </thead>
                <tbody>
                  {["rn", "provider", "support"].map((role) => (
                    <tr key={role}>
                      <td>{role}</td>
                      <td>{counts[role as keyof typeof counts]}</td>
                      <td>{qualified.filter((s) => s.role === role).length}</td>
                      <td
                        className={
                          reserved(role) + counts[role as keyof typeof counts] >
                          qualified.filter((s) => s.role === role).length
                            ? "amber"
                            : ""
                        }
                      >
                        {reserved(role)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small-copy muted">
                At the ready time. Commitments show any overlapping response;
                validation checks every shift boundary and each person’s
                qualifications.
              </p>
            </>
          ) : section === "equipment" ? (
            <>
              <dl className="detail-list">
                <div>
                  <dt>Clinic kits required</dt>
                  <dd>{clinic ? places : 0}</dd>
                </div>
                <div>
                  <dt>Already at site</dt>
                  <dd>{localKits}</dd>
                </div>
                <div>
                  <dt>New kits allocated</dt>
                  <dd>{allocatedKits}</dd>
                </div>
              </dl>
              <p className="small-copy muted">
                Patient-specific oxygen, monitoring, and transport remain
                checked when the simulation assigns each patient.
              </p>
            </>
          ) : section === "space" ? (
            <dl className="detail-list">
              <div>
                <dt>Declared places</dt>
                <dd>{slotCount}</dd>
              </div>
              <div>
                <dt>Proposed enabled places</dt>
                <dd>{existing ? unit.enabled_capacity : places}</dd>
              </div>
              <div>
                <dt>Places per qualified nurse</dt>
                <dd>{policy.slots_per_nurse ?? "—"}</dd>
              </div>
              <div>
                <dt>Provider / support gates</dt>
                <dd>
                  {policy.minimum_provider_count ?? 0} /{" "}
                  {policy.minimum_support_count ?? 0}
                </dd>
              </div>
            </dl>
          ) : (
            <dl className="detail-list">
              <div>
                <dt>Ready after setup</dt>
                <dd>{Number.isFinite(ready) ? displayTime(ready) : "—"}</dd>
              </div>
              <div>
                <dt>Earliest declared reserve shift</dt>
                <dd>
                  {firstRoster
                    ? displayTime(firstRoster)
                    : "No qualifying roster"}
                </dd>
              </div>
              <div>
                <dt>Closes / begins draining</dt>
                <dd>{Number.isFinite(end) ? displayTime(end) : "—"}</dd>
              </div>
              <div>
                <dt>Required transport</dt>
                <dd>
                  {clinic
                    ? "No diversion transport"
                    : "Patient transfers checked per route"}
                </dd>
              </div>
            </dl>
          )}
          <div className="constraint-callout">
            <strong>
              {fmt(supported)} potential staffing-supported places
            </strong>
            <p>
              Derived from the proposed allocations, enabled inventory and
              policy gates. Current occupancy, turnover, reservations and
              patient equipment may reduce receiving availability.
            </p>
            {clinic ? (
              <strong className="amber">No inpatient / ICU capability</strong>
            ) : null}
          </div>
          {overlaps.length ? (
            <div className="small-copy">
              <h4>Overlapping proposed responses</h4>
              {overlaps.map((p, i) => (
                <p key={p.id || i}>
                  {p.name || p.kind} ·{" "}
                  {p.unit_id || p.facility_id || "hospital capacity"}
                </p>
              ))}
            </div>
          ) : null}
          {localError ? <p className="amber">{localError}</p> : null}
          {currentPreview ? (
            <div className="constraint-callout">
              <Badge
                tone={
                  currentPreview.valid && currentPreview.feasibility.feasible
                    ? "success"
                    : "warning"
                }
              >
                {currentPreview.valid && currentPreview.feasibility.feasible
                  ? "Declared prerequisites fit"
                  : "Unmet prerequisites"}
              </Badge>
              {[
                ...(currentPreview.errors || []).map((e: Entity) => e.message),
                ...(currentPreview.feasibility.reasons || []),
                ...(currentPreview.feasibility.warnings || []),
              ].map((message: string, i: number) => (
                <p key={i}>{message}</p>
              ))}
              <p className="small-copy">{currentPreview.feasibility.basis}</p>
            </div>
          ) : (
            <p className="small-copy muted">
              Validate the complete scenario to check competing resources over
              the full interval.
            </p>
          )}
        </div>
      </div>
      <div className="wizard-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={busy || loading || !!localError} onClick={check}>
          Validate prerequisites
        </Button>
        <Button
          primary
          disabled={
            ctx.canWrite === false ||
            busy ||
            loading ||
            !!localError ||
            !currentPreview?.valid ||
            !currentPreview?.feasibility.feasible
          }
          onClick={save}
        >
          Save proposed response <ArrowRight size={15} />
        </Button>
      </div>
    </Modal>
  );
}
