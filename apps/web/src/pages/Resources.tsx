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
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt, items, localDate } from "../api";
import {
  Badge,
  Button,
  CapacityBar,
  ErrorBox,
  Modal,
  PanelTitle,
} from "../components/ui";
import CampusMap from "../components/CampusMap";
import TransferPlanner from "../components/TransferPlanner";
import SiteActivationDialog from "../components/SiteActivationDialog";
import AddSiteDialog from "../components/AddSiteDialog";
import { nameOf, statsFor, unitsOf } from "../model";
import "./resources.css";

const facilityId = (f: Entity) => String(f.facility_id || f.id);
export default function Resources({
  ctx,
  onUpdate,
}: {
  ctx: PlanningContext;
  onUpdate: () => void;
}) {
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
  const planned = (ctx.scenario?.interventions || []).filter(
    (p) =>
      p.enabled !== false &&
      (p.facility_id === id ||
        selectedUnits.some(
          (u) => u.unit_id === (p.unit_id || p.destination_unit_id),
        )),
  );
  const siteEquipment = (ctx.dataset?.equipment_pools || []).filter(
    (p: Entity) => selectedUnits.some((u) => u.unit_id === p.unit_id),
  );
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
  const staff = ctx.dataset?.staff || [],
    reserve = staff.filter((s) => s.employment_pool === "reserve"),
    hospital = staff.filter((s) => s.employment_pool === "hospital");
  return (
    <div className="resources-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">REGIONAL RESOURCES</div>
          <h1>Resource planning</h1>
          <p>Connect available space, people, and capabilities.</p>
        </div>
        <div className="heading-actions">
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
          <Button primary disabled={ctx.canWrite === false} onClick={onUpdate}>
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
              onClick={() => setTab(String(key))}
            >
              <I size={15} />
              {String(label)}
              <span>
                {key === "sites"
                  ? facilities.length
                  : key === "staff"
                    ? staff.length
                    : key === "equipment"
                      ? ctx.dataset?.equipment_pools.length
                      : key === "transport"
                        ? ctx.dataset?.vehicles?.length
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
              {!shelter ? (
                <div className="dependency-overlay">
                  <span className="eyebrow">
                    INSPECT ACTIVATION DEPENDENCIES
                  </span>
                  <div className="dependency-nodes">
                    {[
                      [
                        "space",
                        Building2,
                        "Space",
                        selectedUnits.reduce(
                          (n, u) =>
                            n +
                            (ctx.dataset?.slots || []).filter(
                              (s) =>
                                s.unit_id === u.unit_id &&
                                s.installation_status !== "removed",
                            ).length,
                          0,
                        ),
                      ],
                      [
                        "staff",
                        Users,
                        "Personnel",
                        `${planned.length} planned actions`,
                      ],
                      [
                        "equipment",
                        Boxes,
                        "Equipment",
                        `${siteEquipment.length} local pools`,
                      ],
                      [
                        "readiness",
                        Clock3,
                        "Readiness",
                        `${Number(facility.activation_minutes || 0) / 60}h setup`,
                      ],
                    ].map(([key, Icon, label, value]) => {
                      const I = Icon as typeof Users;
                      return (
                        <button
                          key={String(key)}
                          onClick={() => plan(String(key))}
                        >
                          <I size={19} />
                          <strong>{String(value)}</strong>
                          <span>{String(label)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="small-copy muted">
                    Select a dependency to inspect required, declared, and
                    committed resources.
                  </p>
                </div>
              ) : null}
            </div>
            <aside className="inspector site-inspector">
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
                    <strong>{planned.length} saved resource responses</strong>
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
                      {JSON.stringify(facility.resource_requirements, null, 2)}
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
                  onClick={onUpdate}
                >
                  Record timestamped update
                </Button>
              </div>
            </aside>
          </div>
        </>
      ) : (
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
              <ResourceTable
                rows={ctx.dataset?.equipment_pools || []}
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
                rows={(ctx.dataset?.vehicles || []).map((v: Entity) => ({
                  ...v,
                  ...(ctx.state?.vehicles || []).find(
                    (s: Entity) => s.vehicle_id === v.vehicle_id,
                  ),
                }))}
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
                    onClick={onUpdate}
                  >
                    <Plus size={14} />
                    Record update
                  </Button>
                }
              />
              {updateError ? <ErrorBox error={updateError} /> : null}
              <ResourceTable
                rows={relevantUpdates}
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
      )}
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
function ResourceTable({
  rows,
  columns,
}: {
  rows: Entity[];
  columns: string[];
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<Entity | null>(null),
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
                    <Button small onClick={() => setSelected(r)}>
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
      {selected ? (
        <Modal title="Resource record" onClose={() => setSelected(null)}>
          <dl className="resource-record">
            {Object.entries(selected).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll("_", " ")}</dt>
                <dd>
                  {value && typeof value === "object" ? (
                    <pre>{JSON.stringify(value, null, 2)}</pre>
                  ) : (
                    String(value ?? "—")
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Modal>
      ) : null}
    </>
  );
}
