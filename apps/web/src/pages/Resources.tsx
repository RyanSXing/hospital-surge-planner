import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  Building2,
  ChevronRight,
  Clock3,
  Hospital,
  MapPin,
  Plus,
  ShieldCheck,
  Truck,
  Users,
  X,
} from "lucide-react";
import type { Entity, PlanningContext, UpdateTarget } from "../types";
import { api, fmt, items, localDate } from "../api";
import {
  Badge,
  Button,
  CapacityBar,
  ErrorBox,
  PanelTitle,
} from "../components/ui";
import CampusMap from "../components/CampusMap";
import TransferPlanner from "../components/TransferPlanner";
import SiteActivationDialog from "../components/SiteActivationDialog";
import AddSiteDialog from "../components/AddSiteDialog";
import {
  PlanningPanelControls,
  PlanningTimelineDock,
  usePlanningPanels,
} from "../components/PlanningPanels";
import {
  actualInventory,
  searchEntityId,
  type SearchKind,
} from "../components/workspaceSearch";
import { nameOf, statsFor, unitsOf } from "../model";
import "./resources.css";

const facilityId = (f: Entity) => String(f.facility_id || f.id);
export default function Resources({
  ctx,
  onUpdate,
}: {
  ctx: PlanningContext;
  onUpdate: (target?: UpdateTarget) => void;
}) {
  const panels = usePlanningPanels(180);
  const [transfer, setTransfer] = useState(false),
    [tab, setTab] = useState("sites"),
    [addSite, setAddSite] = useState(false),
    [activation, setActivation] = useState<string | null>(null),
    [updates, setUpdates] = useState<Entity[]>([]),
    [updateError, setUpdateError] = useState("");
  const [typeFilter, setTypeFilter] = useState("all"),
    [capabilityFilter, setCapabilityFilter] = useState("all"),
    [readinessFilter, setReadinessFilter] = useState("all"),
    [availabilityFilter, setAvailabilityFilter] = useState("all");
  useEffect(() => {
    if (ctx.selectedResource)
      setTab(
        (
          {
            staff: "staff",
            equipment_pool: "equipment",
            vehicle: "transport",
            slot: "sites",
            route: "transport",
            update: "updates",
          } as Record<string, string>
        )[ctx.selectedResource.kind] || "sites",
      );
  }, [ctx.selectedResource?.kind, ctx.selectedResource?.id]);
  useEffect(() => {
    panels.setInspectorHidden(false);
  }, [
    ctx.selectedFacility,
    ctx.selectedResource?.kind,
    ctx.selectedResource?.id,
  ]);
  const facilities = ctx.dataset?.facilities || [],
    facility =
      facilities.find((f) => facilityId(f) === ctx.selectedFacility) ||
      facilities[0] ||
      {},
    id = facilityId(facility),
    type = facility.kind || "hospital";
  const clinic = type === "clinic",
    shelter = type === "shelter",
    selectedUnits = (ctx.dataset?.units || []).filter(
      (u) => u.facility_id === id,
    ),
    partner =
      selectedUnits.length > 0 &&
      selectedUnits.every((u) => u.capacity_mode === "advertised_aggregate");
  const currentUnits = unitsOf(ctx),
    ward = statsFor(ctx, "ward"),
    icu = statsFor(ctx, "icu"),
    outpatient = statsFor(ctx, "clinic");
  const active = (f: Entity) =>
    currentUnits.some(
      (u) =>
        u.facility_id === facilityId(f) && (u.active ?? f.status === "active"),
    );
  const capacityAt = (f: Entity) =>
    currentUnits
      .filter((u) => u.facility_id === facilityId(f))
      .reduce(
        (n, u) =>
          n +
          Number(
            u.available ??
              ((u.active ?? f.status === "active")
                ? Math.max(
                    0,
                    Number(u.staffed ?? u.staffed_capacity ?? 0) -
                      Number(u.occupied ?? 0) -
                      Number(u.reserved ?? 0),
                  )
                : 0),
          ),
        0,
      );
  const filtered = facilities.filter(
    (f) =>
      (typeFilter === "all" || f.kind === typeFilter) &&
      (capabilityFilter === "all" ||
        (f.capabilities || []).includes(capabilityFilter)) &&
      (readinessFilter === "all" ||
        (readinessFilter === "active" ? active(f) : !active(f))) &&
      (availabilityFilter === "all" ||
        (availabilityFilter === "receiving"
          ? capacityAt(f) > 0
          : capacityAt(f) === 0)),
  );
  const policies = selectedUnits.map((u) => ({
    unit: u,
    policy:
      (ctx.dataset?.capacity_policies || []).find(
        (p: Entity) => p.capacity_policy_id === u.capacity_policy_id,
      ) || {},
  }));
  const recorded = ctx.stateLoading || ctx.stateError ? null : ctx.state;
  const planned = (
    (ctx.resultScenario || ctx.scenario)?.interventions || []
  ).filter(
    (p) =>
      p.enabled !== false &&
      (p.facility_id === id ||
        selectedUnits.some(
          (u) => u.unit_id === (p.unit_id || p.destination_unit_id),
        )),
  );
  const selectedCurrentUnits = currentUnits.filter((u) => u.facility_id === id),
    selectedUnitIds = new Set(selectedUnits.map((u) => String(u.unit_id))),
    assignedStaff = new Set(
      selectedCurrentUnits.flatMap((u) =>
        Array.isArray(u.active_staff_ids) ? u.active_staff_ids : [],
      ),
    ),
    siteEquipment = actualInventory(
      "equipment_pool",
      ctx.dataset?.equipment_pools,
      recorded?.equipment_pools,
    ).filter(
      (p) =>
        selectedUnitIds.has(String(p.unit_id || "")) || p.facility_id === id,
    ),
    siteSlots = (ctx.dataset?.slots || []).filter((slot) =>
      selectedUnitIds.has(String(slot.unit_id)),
    ),
    installedPlaces = siteSlots.filter(
      (slot) => slot.installation_status === "installed",
    ).length,
    plannedPlaces = siteSlots.filter(
      (slot) => slot.installation_status === "planned",
    ).length;
  const routes = (ctx.dataset?.routes || []).filter(
    (r: Entity) => r.to_facility_id === id,
  );
  const relevantUpdates = updates.filter(
    (u) => !u.scenario_id || u.scenario_id === ctx.scenario?.id,
  );
  useEffect(() => {
    let ignore = false;
    setUpdateError("");
    api(
      `/updates?scenario_id=${encodeURIComponent(ctx.scenario?.id || "")}&limit=200`,
    )
      .then((value) => {
        if (!ignore) setUpdates(items(value));
      })
      .catch((e) => {
        if (!ignore) setUpdateError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [ctx.scenario?.id, ctx.busy]);
  function plan(section = "staff") {
    if (partner) setTransfer(true);
    else if (!shelter) setActivation(section);
  }
  const staff = actualInventory("staff", ctx.dataset?.staff, recorded?.staff),
    equipment = actualInventory(
      "equipment_pool",
      ctx.dataset?.equipment_pools,
      recorded?.equipment_pools,
    ),
    vehicles = actualInventory(
      "vehicle",
      ctx.dataset?.vehicles,
      recorded?.vehicles,
    ),
    reserve = staff.filter((s) => s.employment_pool === "reserve"),
    hospital = staff.filter((s) => s.employment_pool === "hospital");
  return (
    <div className="resources-page planning-panel-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">REGIONAL RESOURCES</div>
          <h1>Resource planning</h1>
          <p>Connect available space, people, and capabilities.</p>
        </div>
        <div className="heading-actions">
          <PlanningPanelControls panels={panels} name="resources" />
          <Button
            disabled={ctx.canWrite === false}
            onClick={() => setTransfer(true)}
          >
            <Truck size={15} />
            Plan transfer
          </Button>
          <Button
            disabled={ctx.canWrite === false}
            onClick={() => setAddSite(true)}
          >
            <Plus size={15} />
            Add candidate site
          </Button>
          <Button
            primary
            disabled={ctx.canWrite === false}
            onClick={() => onUpdate()}
          >
            <Plus size={15} />
            Record update
          </Button>
        </div>
      </div>
      <div className="resource-tabs">
        {[
          ["sites", Building2, "Sites"],
          ["staff", Users, "Staff"],
          ["equipment", Boxes, "Equipment"],
          ["transport", Truck, "Transport"],
          ["updates", Clock3, "Updates"],
        ].map(([key, Icon, label]) => {
          const I = Icon as typeof Users;
          return (
            <button
              className={tab === key ? "active" : ""}
              key={String(key)}
              onClick={() => {
                ctx.clearResource();
                setTab(String(key));
              }}
            >
              <I size={15} />
              {String(label)}
              <span>
                {key === "sites"
                  ? facilities.length
                  : key === "staff"
                    ? staff.length
                    : key === "equipment"
                      ? equipment.length
                      : key === "transport"
                        ? vehicles.length
                        : relevantUpdates.length}
              </span>
            </button>
          );
        })}
      </div>
      {tab === "sites" ? (
        <>
          <div className="resource-filters">
            <label>
              Site type
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                {Array.from(new Set(facilities.map((f) => f.kind))).map(
                  (kind) => (
                    <option key={kind} value={kind}>
                      {String(kind).replaceAll("_", " ")}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              Capability
              <select
                value={capabilityFilter}
                onChange={(e) => setCapabilityFilter(e.target.value)}
              >
                <option value="all">All capabilities</option>
                {Array.from(
                  new Set(facilities.flatMap((f) => f.capabilities || [])),
                ).map((cap) => (
                  <option key={String(cap)} value={String(cap)}>
                    {String(cap).replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Readiness
              <select
                value={readinessFilter}
                onChange={(e) => setReadinessFilter(e.target.value)}
              >
                <option value="all">All readiness</option>
                <option value="active">Active in selected state</option>
                <option value="candidate">Inactive / candidate</option>
              </select>
            </label>
            <label>
              Receiving availability
              <select
                value={availabilityFilter}
                onChange={(e) => setAvailabilityFilter(e.target.value)}
              >
                <option value="all">All availability</option>
                <option value="receiving">Headroom available</option>
                <option value="unavailable">No current headroom</option>
              </select>
            </label>
            <span className="small-copy muted">
              {ctx.state
                ? "Selected replication at current time"
                : "Declared baseline snapshot"}
            </span>
          </div>
          <div className="resources-workspace">
            <aside className="site-list">
              <div className="site-list-heading">
                <span className="eyebrow">PLANNING INVENTORY</span>
                <span>
                  {filtered.length} of {facilities.length}
                </span>
              </div>
              {filtered.map((f) => (
                <button
                  key={facilityId(f)}
                  className={`site-item ${id === facilityId(f) ? "selected" : ""}`}
                  onClick={() => ctx.setFacility(facilityId(f))}
                >
                  <span
                    className={`site-icon ${f.kind === "clinic" ? "green" : f.kind === "shelter" ? "violet" : "cyan"}`}
                  >
                    {f.kind === "hospital" ? (
                      <Hospital size={19} />
                    ) : (
                      <MapPin size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{nameOf(f)}</strong>
                    <small>{String(f.kind).replaceAll("_", " ")}</small>
                    <span
                      className={`site-status ${active(f) ? "green" : "muted"}`}
                    >
                      {active(f) ? "Active" : f.status || "Candidate"}
                    </span>
                  </div>
                  <ChevronRight size={14} />
                </button>
              ))}
              {!filtered.length ? (
                <p className="small-copy muted resource-padding">
                  No sites match these filters.
                </p>
              ) : null}
              <div className="site-list-note">
                <ShieldCheck size={17} />
                <p>
                  {ctx.dataset?.synthetic !== false
                    ? "Fictional planning inventory."
                    : "User-supplied planning inventory."}{" "}
                  Sources and assumptions remain attached to each site.
                </p>
              </div>
            </aside>
            <div className="resource-map">
              <CampusMap ctx={ctx} resources />
              {!active(facility) && !shelter ? (
                <section
                  className="dependency-overlay candidate-dependency-overlay"
                  aria-labelledby="candidate-dependency-title"
                >
                  <div className="candidate-dependency-heading">
                    <div>
                      <span className="eyebrow">ACTIVATION PATH</span>
                      <strong id="candidate-dependency-title">
                        {nameOf(facility)}
                      </strong>
                    </div>
                    <Badge tone="neutral">Candidate</Badge>
                  </div>
                  <div className="dependency-nodes">
                    {[
                      [
                        "space",
                        Building2,
                        "declared places",
                        `${installedPlaces} installed / ${plannedPlaces} planned`,
                      ],
                      ["staff", Users, "assigned staff", assignedStaff.size],
                      [
                        "equipment",
                        Boxes,
                        "equipment pools",
                        siteEquipment.length,
                      ],
                      [
                        "setup",
                        Clock3,
                        "setup lead time",
                        `${Number(facility.activation_minutes || 0) / 60}h setup`,
                      ],
                    ].map(([key, Icon, label, value]) => {
                      const I = Icon as typeof Users;
                      return (
                        <button
                          key={String(key)}
                          onClick={() =>
                            plan(
                              String(key) === "setup" ? "space" : String(key),
                            )
                          }
                          aria-label={`Plan ${String(label)} for ${nameOf(facility)}`}
                        >
                          <I size={19} />
                          <strong>{String(value)}</strong>
                          <span>{String(label)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="dependency-flow" aria-hidden="true">
                    <span />
                  </div>
                  <button
                    className="dependency-target"
                    onClick={() => plan("staff")}
                    aria-label={`Plan activation for ${nameOf(facility)}`}
                  >
                    <MapPin size={15} />
                    <span>
                      <strong>{nameOf(facility)}</strong>
                      <small>Candidate site · resource schedule required</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                  <p className="small-copy muted">
                    Select a dependency to schedule the declared resource
                    requirement at the selected time.
                  </p>
                </section>
              ) : null}
            </div>
            <aside
              className="inspector site-inspector"
              id="resources-inspector-dock"
              hidden={panels.inspectorHidden}
            >
              {ctx.selectedResource ? (
                <ResourceSelection
                  ctx={ctx}
                  updates={updates}
                  onUpdate={onUpdate}
                />
              ) : (
                <>
                  <div className="inspector-header">
                    <div className="inspector-icon">
                      <MapPin size={20} />
                    </div>
                    <div>
                      <span className="eyebrow">SELECTED SITE</span>
                      <h2>{nameOf(facility)}</h2>
                    </div>
                  </div>
                  <div className="inspector-section">
                    <Badge tone={active(facility) ? "success" : "neutral"}>
                      {type.replaceAll("_", " ")} ·{" "}
                      {active(facility) ? "active" : "candidate"}
                    </Badge>
                    <h3 className="section-space">Capacity & capability</h3>
                    {ctx.stateError ? (
                      <ErrorBox error={ctx.stateError} />
                    ) : clinic ? (
                      <>
                        <CapacityBar
                          label="Outpatient treatment"
                          {...outpatient}
                          capacity={outpatient.staffed}
                        />
                        <dl className="detail-list">
                          <div>
                            <dt>Receiving headroom</dt>
                            <dd>{outpatient.available}</dd>
                          </div>
                          <div>
                            <dt>Enabled / reserved</dt>
                            <dd>
                              {outpatient.enabled} / {outpatient.reserved}
                            </dd>
                          </div>
                        </dl>
                        <div className="constraint-callout">
                          <strong className="amber">
                            No inpatient / ICU capability
                          </strong>
                          <p>
                            Only explicitly eligible ambulatory arrivals can use
                            this service.
                          </p>
                        </div>
                      </>
                    ) : shelter ? (
                      <div className="info-note">
                        Shelter places provide nonclinical capacity. They cannot
                        receive inpatient or ICU placements.
                      </div>
                    ) : (
                      <>
                        <CapacityBar
                          label="Ward"
                          {...ward}
                          capacity={ward.staffed}
                        />
                        {selectedUnits.some((u) => u.kind === "icu") ? (
                          <CapacityBar
                            label="ICU"
                            {...icu}
                            capacity={icu.staffed}
                          />
                        ) : null}
                      </>
                    )}
                    <p className="small-copy muted">
                      {(facility.capabilities || []).join(" · ")}
                    </p>
                  </div>
                  <div className="inspector-section">
                    <h3>Requirements & readiness</h3>
                    {policies
                      .filter((p) =>
                        ["ward", "clinic", "icu"].includes(p.unit.kind),
                      )
                      .map(({ unit, policy }) => (
                        <p className="small-copy" key={unit.unit_id}>
                          <strong>{unit.name}</strong>
                          <br />
                          {unit.capacity_mode === "advertised_aggregate"
                            ? "Partner advertises staffed capacity."
                            : `${policy.slots_per_nurse ?? "—"} places / nurse; provider gate ${policy.minimum_provider_count ?? 0}, support gate ${policy.minimum_support_count ?? 0}.`}
                        </p>
                      ))}
                    <dl className="detail-list">
                      <div>
                        <dt>Setup lead time</dt>
                        <dd>
                          {Number(facility.activation_minutes || 0) / 60} hours
                        </dd>
                      </div>
                      <div>
                        <dt>Site equipment pools</dt>
                        <dd>{siteEquipment.length}</dd>
                      </div>
                      <div>
                        <dt>Staffing source</dt>
                        <dd>
                          {partner
                            ? "Partner-advertised"
                            : facility.status === "candidate"
                              ? "Unallocated reserve"
                              : "Declared roster + planned reserve"}
                        </dd>
                      </div>
                      <div>
                        <dt>Incoming route assumptions</dt>
                        <dd>{routes.length}</dd>
                      </div>
                      <div>
                        <dt>Coordinates</dt>
                        <dd>
                          {facility.latitude}, {facility.longitude}
                        </dd>
                      </div>
                    </dl>
                    {planned.length ? (
                      <div className="constraint-callout">
                        <strong>
                          {planned.length} saved resource responses
                        </strong>
                        {planned.map((p, i) => (
                          <p className="small-copy" key={p.id || i}>
                            {p.name || p.kind} ·{" "}
                            {localDate(p.start_at, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    <Button
                      primary
                      className="full-width"
                      disabled={ctx.canWrite === false || shelter || !!ctx.busy}
                      onClick={() => plan()}
                    >
                      {partner
                        ? "Plan receiving transfer"
                        : facility.kind === "hospital" &&
                            facility.status === "active"
                          ? "Allocate reserve to existing beds"
                          : "Assign resources & schedule"}
                      <ArrowUpRight size={15} />
                    </Button>
                    <details className="resource-source">
                      <summary>Source and assumptions</summary>
                      <p>
                        {facility.source ||
                          facility.provenance?.description ||
                          (facility.synthetic
                            ? "Synthetic generator"
                            : "Imported source")}
                      </p>
                      {facility.resource_requirements ? (
                        <pre>
                          {JSON.stringify(
                            facility.resource_requirements,
                            null,
                            2,
                          )}
                        </pre>
                      ) : null}
                      <p>
                        {facility.provenance?.notes ||
                          "Travel, staffing and equipment assumptions are included in the dataset."}
                      </p>
                    </details>
                  </div>
                  <div className="inspector-section">
                    <div className="spread">
                      <h3>Recent updates</h3>
                      <button
                        className="text-button"
                        onClick={() => setTab("updates")}
                      >
                        View all
                      </button>
                    </div>
                    {updateError ? (
                      <ErrorBox error={updateError} />
                    ) : relevantUpdates.length ? (
                      relevantUpdates.slice(0, 3).map((u) => (
                        <div className="update-mini" key={u.id}>
                          <span className="cyan-dot" />
                          <div>
                            <strong>{u.type?.replaceAll("_", " ")}</strong>
                            <small>
                              {localDate(u.effective_at, {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="small-copy muted">
                        No recorded updates for this scenario.
                      </p>
                    )}
                    <Button
                      className="full-width"
                      disabled={ctx.canWrite === false}
                      onClick={() => onUpdate({ kind: "facility", id })}
                    >
                      Record change
                    </Button>
                  </div>
                </>
              )}
            </aside>
          </div>
        </>
      ) : (
        <div className="resource-table-workspace">
          <div className="resource-table-page">
            {tab === "staff" ? (
              <>
                <div className="resource-summary-strip">
                  <div>
                    <Users size={22} />
                    <strong>{staff.length}</strong>
                    <span>declared staff</span>
                  </div>
                  <div>
                    <strong>{hospital.length}</strong>
                    <span>hospital roster</span>
                  </div>
                  <div>
                    <strong>{reserve.length}</strong>
                    <span>reserve roster</span>
                  </div>
                  <div>
                    <strong>{new Set(staff.map((s) => s.team_id)).size}</strong>
                    <span>declared teams</span>
                  </div>
                </div>
                <ResourceTable
                  rows={staff}
                  onInspect={(row) =>
                    ctx.inspectEntity("staff", row.staff_id || row.id)
                  }
                  columns={[
                    "staff_id",
                    "role",
                    "employment_pool",
                    "team_id",
                    "capabilities",
                  ]}
                />
              </>
            ) : tab === "equipment" ? (
              <>
                <PanelTitle
                  title="Reusable equipment inventory"
                  eyebrow="EXCLUSIVE RESOURCE ALLOCATIONS"
                />
                {ctx.state &&
                ctx.state.equipment_pool_state_available === false ? (
                  <p className="info-note">
                    This stored run predates individual equipment-pool history.
                    The table shows source inventory; run the scenario again to
                    inspect selected-time allocations.
                  </p>
                ) : null}
                <ResourceTable
                  rows={equipment}
                  onInspect={(row) =>
                    ctx.inspectEntity(
                      "equipment_pool",
                      row.equipment_pool_id || row.id,
                    )
                  }
                  columns={[
                    "equipment_pool_id",
                    "unit_id",
                    "quantity",
                    "unserviceable_quantity",
                    "portable",
                    "capability_code",
                  ]}
                />
              </>
            ) : tab === "transport" ? (
              <>
                <PanelTitle
                  title="Transport resources"
                  eyebrow="LOCATION, AVAILABILITY & DIRECTED ROUTES"
                />
                <ResourceTable
                  rows={vehicles}
                  onInspect={(row) =>
                    ctx.inspectEntity("vehicle", row.vehicle_id || row.id)
                  }
                  columns={[
                    "vehicle_id",
                    "location",
                    "patient_capacity",
                    "capabilities",
                    "available_at",
                  ]}
                />
                <PanelTitle title="Assumed travel matrix" />
                <ResourceTable
                  rows={ctx.dataset?.routes || []}
                  onInspect={(row) =>
                    ctx.inspectEntity("route", row.route_id || row.id)
                  }
                  columns={[
                    "route_id",
                    "from_facility_id",
                    "to_facility_id",
                    "travel_minutes",
                    "estimate_source",
                  ]}
                />
              </>
            ) : (
              <>
                <PanelTitle
                  title="Operational update history"
                  eyebrow="APPEND-ONLY SCENARIO RECORD"
                  actions={
                    <Button
                      primary
                      disabled={ctx.canWrite === false}
                      onClick={() => onUpdate()}
                    >
                      <Plus size={14} />
                      Record update
                    </Button>
                  }
                />
                {updateError ? <ErrorBox error={updateError} /> : null}
                <ResourceTable
                  rows={relevantUpdates}
                  onInspect={(row) => ctx.inspectEntity("update", row.id)}
                  columns={[
                    "id",
                    "type",
                    "effective_at",
                    "recorded_at",
                    "source",
                    "state_origin",
                    "status",
                  ]}
                />
              </>
            )}
          </div>
          <aside
            className="inspector resource-inspector"
            id="resources-inspector-dock"
            hidden={panels.inspectorHidden}
          >
            {ctx.selectedResource ? (
              <ResourceSelection
                ctx={ctx}
                updates={updates}
                onUpdate={onUpdate}
              />
            ) : (
              <div className="inspector-section resource-inspector-empty">
                <Users size={30} />
                <h3>Inspect a resource</h3>
                <p className="small-copy muted">
                  Choose Details to inspect its source record and available
                  ledger at the selected time.
                </p>
              </div>
            )}
          </aside>
        </div>
      )}
      <PlanningTimelineDock panels={panels} name="resources" ctx={ctx} />
      {transfer ? (
        <TransferPlanner ctx={ctx} onClose={() => setTransfer(false)} />
      ) : null}
      {activation ? (
        <SiteActivationDialog
          key={`${id}-${activation}`}
          ctx={ctx}
          facility={facility}
          initialSection={activation}
          onClose={() => setActivation(null)}
        />
      ) : null}
      {addSite ? (
        <AddSiteDialog ctx={ctx} onClose={() => setAddSite(false)} />
      ) : null}
    </div>
  );
}
function ResourceSelection({
  ctx,
  updates,
  onUpdate,
}: {
  ctx: PlanningContext;
  updates: Entity[];
  onUpdate: (target?: UpdateTarget) => void;
}) {
  const selection = ctx.selectedResource!;
  const tables: Record<string, string> = {
    staff: "staff",
    equipment_pool: "equipment_pools",
    vehicle: "vehicles",
    slot: "slots",
    route: "routes",
  };
  const table = tables[selection.kind];
  const record =
    selection.kind === "update"
      ? updates.find((value) => value.id === selection.id)
      : selection.kind === "route"
        ? ctx.dataset?.routes?.find(
            (value: Entity) => (value.route_id || value.id) === selection.id,
          )
        : table
          ? actualInventory(
              selection.kind as SearchKind,
              ctx.dataset?.[table] || [],
              ctx.stateLoading || ctx.stateError
                ? []
                : ctx.state?.[table] || [],
            ).find(
              (value) =>
                searchEntityId(selection.kind as SearchKind, value) ===
                selection.id,
            )
          : null;
  const assignments =
    selection.kind === "staff"
      ? unitsOf(ctx).filter((unit) =>
          unit.active_staff_ids?.includes(selection.id),
        )
      : [];
  return (
    <>
      <div className="inspector-header">
        <div className="inspector-icon">
          <Boxes size={20} />
        </div>
        <div>
          <span className="eyebrow">
            SELECTED {selection.kind.replaceAll("_", " ")}
          </span>
          <h2>{selection.id}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Clear selected resource"
          onClick={ctx.clearResource}
        >
          <X size={18} />
        </button>
      </div>
      <div className="inspector-section">
        <p className="small-copy muted">
          Frozen dataset {ctx.dataset?.id}
          {ctx.run?.status === "SUCCEEDED" &&
          ctx.state &&
          !ctx.stateLoading &&
          !ctx.stateError
            ? ` · selected simulation time ${localDate(ctx.selectedTime, { hour: "2-digit", minute: "2-digit" })}`
            : " · source snapshot"}
          .{" "}
          {selection.kind === "update"
            ? "Recorded update document; effective time and state origin determine its application."
            : selection.kind === "route"
              ? "Declared synthetic travel assumption from the source snapshot."
              : record?.search_source === "selected_time_state"
                ? "Created in the selected recorded trajectory; no source-snapshot row."
                : record?.search_source === "recorded_overlay"
                  ? "Recorded state overlays the frozen source record."
                  : "Source-snapshot record; no individual selected-time overlay is recorded."}
        </p>
        {ctx.stateLoading ? (
          <p role="status">Loading the selected-time resource ledger…</p>
        ) : null}
        {ctx.stateError ? <ErrorBox error={ctx.stateError} /> : null}
        {selection.kind === "staff" &&
        ctx.state &&
        !ctx.stateLoading &&
        !ctx.stateError ? (
          <p>
            Recorded assignments:{" "}
            {assignments.map(nameOf).join(" · ") || "No active unit assignment"}
            .
          </p>
        ) : null}
        {record ? (
          <dl className="resource-record">
            {Object.entries(record)
              .filter(
                ([key]) =>
                  !["search_kind", "search_source", "current"].includes(key),
              )
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll("_", " ")}</dt>
                  <dd>
                    {value && typeof value === "object" ? (
                      <pre>{JSON.stringify(value, null, 2)}</pre>
                    ) : (
                      String(value ?? "Not recorded")
                    )}
                  </dd>
                </div>
              ))}
          </dl>
        ) : (
          <p>
            This resource is not present in the selected dataset or recorded
            state.
          </p>
        )}
        {record && selection.kind !== "update" ? (
          <Button
            className="full-width"
            disabled={
              ctx.canWrite === false || !!ctx.stateLoading || !!ctx.stateError
            }
            onClick={() => onUpdate(selection as UpdateTarget)}
          >
            Record change
          </Button>
        ) : null}
      </div>
    </>
  );
}
function ResourceTable({
  rows,
  columns,
  onInspect,
}: {
  rows: Entity[];
  columns: string[];
  onInspect: (row: Entity) => void;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    pageSize = 50,
    filtered = rows.filter(
      (row) =>
        !query ||
        JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
    ),
    pages = Math.max(1, Math.ceil(filtered.length / pageSize)),
    current = Math.min(page, pages - 1);
  return (
    <>
      <div className="resource-table-toolbar">
        <label>
          Search records
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="ID, role, location, capability…"
          />
        </label>
        <span className="small-copy muted">
          {fmt(filtered.length)} matching records
        </span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c.replaceAll("_", " ")}</th>
              ))}
              <th>Inspect</th>
            </tr>
          </thead>
          <tbody>
            {filtered
              .slice(current * pageSize, (current + 1) * pageSize)
              .map((r, i) => (
                <tr key={r.id || r[columns[0]] || i}>
                  {columns.map((c) => (
                    <td key={c}>
                      {Array.isArray(r[c])
                        ? r[c].join(", ")
                        : r[c] !== null && typeof r[c] === "object"
                          ? JSON.stringify(r[c])
                          : String(
                              r[c] ??
                                r[c.replace("_id", "")] ??
                                (c.endsWith("_id") ? r.id : "—") ??
                                "—",
                            )}
                    </td>
                  ))}
                  <td>
                    <Button small onClick={() => onInspect(r)}>
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
            {!filtered.length ? (
              <tr>
                <td colSpan={columns.length + 1} className="muted">
                  No matching records.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="resource-table-pagination">
        <Button
          small
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          Previous
        </Button>
        <span>
          Page {current + 1} of {pages} ·{" "}
          {filtered.length ? current * pageSize + 1 : 0}–
          {Math.min(filtered.length, (current + 1) * pageSize)} of{" "}
          {filtered.length}
        </span>
        <Button
          small
          disabled={current + 1 >= pages}
          onClick={() => setPage(current + 1)}
        >
          Next
        </Button>
      </div>
    </>
  );
}
