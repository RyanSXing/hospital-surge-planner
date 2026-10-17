import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Database,
  GitBranch,
  Plus,
  Save,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt, items, localDate, patch, post } from "../api";
import ImportWizard, {
  canonicalCollections,
  entityIds,
} from "../components/ImportWizard";
import { Badge, Button, ErrorBox, Modal, PanelTitle } from "../components/ui";

function download(name: string, value: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
function records(value: any): Entity[] {
  return Array.isArray(value)
    ? value.map((v, i) =>
        typeof v === "object" && v !== null ? v : { index: i, value: v },
      )
    : value && typeof value === "object"
      ? [value]
      : [];
}
function csv(rows: Entity[]) {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: any) => {
    let text = String(
      v === null || v === undefined
        ? ""
        : typeof v === "object"
          ? JSON.stringify(v)
          : v,
    );
    if (typeof v === "string" && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    columns.map(cell).join(","),
    ...rows.map((r) => columns.map((k) => cell(r[k])).join(",")),
  ].join("\r\n");
}
const label = (s: string) => s.replaceAll("_", " ");
const derivedDemandCollections = new Set([
  "arrival_profiles",
  "baseline",
  "hour_of_day_baseline",
  "weekday_baseline",
]);
const enumValues: Record<string, string[]> = {
  "units.kind": ["ward", "icu", "ed", "clinic", "shelter"],
  "facilities.kind": ["hospital", "clinic", "ward_overflow", "shelter"],
  "facilities.status": ["active", "candidate", "inactive"],
  installation_status: ["planned", "installed", "removed"],
  capacity_mode: ["staff_derived", "advertised_aggregate"],
  employment_pool: ["regular", "reserve"],
  role: ["rn", "provider", "support"],
  "patients.state": [
    "ed_waiting",
    "direct_waiting",
    "ed_assessment",
    "ed_boarding",
    "inpatient",
    "clinic_assessment",
    "transfer_reserved",
    "in_transit",
    "discharged",
  ],
  care_level: ["ambulatory", "ward", "icu", "nonclinical"],
  target_unit_kind: ["ward", "icu"],
  slot_kind: ["ward_bed", "icu_bed", "ed_bay", "clinic_space", "shelter_space"],
};
const referenceCollections: Record<string, string> = {
  facility_id: "facilities",
  from_facility_id: "facilities",
  to_facility_id: "facilities",
  home_facility_id: "facilities",
  destination_facility_id: "facilities",
  unit_id: "units",
  slot_id: "slots",
  staff_id: "staff",
  capacity_policy_id: "capacity_policies",
  cohort_template_id: "cohorts",
  template_id: "los_templates",
  remaining_stay_template_id: "los_templates",
  assessment_template_id: "los_templates",
  organization_id: "organizations",
  capability_code: "capabilities",
  resource_profile_id: "resource_profiles",
};
function Field({
  field,
  value,
  onChange,
  dataset,
  collection,
  readOnly,
  depth = 0,
}: {
  field: string;
  value: any;
  onChange: (v: any) => void;
  dataset: Entity;
  collection: string;
  readOnly: boolean;
  depth?: number;
}) {
  const foreign = referenceCollections[field],
    options = enumValues[`${collection}.${field}`] || enumValues[field],
    isId = field === "id" || field === entityIds[collection];
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return (
      <fieldset
        className="typed-object"
        style={{
          gridColumn: "1 / -1",
          border: "1px solid var(--border)",
          padding: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
          gap: 12,
        }}
      >
        <legend>{label(field)}</legend>
        {Object.keys(value).map((k) => (
          <Field
            key={k}
            field={k}
            value={value[k]}
            onChange={(v) => onChange({ ...value, [k]: v })}
            dataset={dataset}
            collection={collection}
            readOnly={readOnly}
            depth={depth + 1}
          />
        ))}
      </fieldset>
    );
  if (Array.isArray(value))
    return (
      <fieldset
        style={{
          gridColumn: "1 / -1",
          border: "1px solid var(--border)",
          padding: 14,
        }}
      >
        <legend>
          {label(field)} · {value.length} entries
        </legend>
        {value.map((v, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "start",
              marginBottom: 8,
            }}
          >
            <div style={{ flex: 1 }}>
              <Field
                field={String(i + 1)}
                value={v}
                onChange={(next) =>
                  onChange(value.map((old, j) => (j === i ? next : old)))
                }
                dataset={dataset}
                collection={collection}
                readOnly={readOnly}
                depth={depth + 1}
              />
            </div>
            {!readOnly ? (
              <Button
                small
                onClick={() => onChange(value.filter((_, j) => i !== j))}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {!readOnly ? (
          <Button
            small
            onClick={() =>
              onChange([
                ...value,
                value.length && typeof value[0] === "object"
                  ? structuredClone(value[0])
                  : "",
              ])
            }
          >
            <Plus size={12} />
            Add entry
          </Button>
        ) : null}
      </fieldset>
    );
  const refs =
      foreign && foreign !== collection ? records(dataset[foreign]) : [],
    refId = foreign ? entityIds[foreign] || "id" : "id";
  const choices =
    options || refs.map((r) => String(r[refId] ?? r.id)).filter(Boolean);
  const inputLabel = label(field),
    nullable = value === null;
  return (
    <label className="form-stack" style={{ gap: 5, fontSize: 11 }}>
      <span>
        {inputLabel}
        {nullable ? <small className="muted"> · not specified</small> : null}
      </span>
      {typeof value === "boolean" ? (
        <select
          aria-label={inputLabel}
          value={String(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : choices?.length && !isId ? (
        <select
          aria-label={inputLabel}
          value={value ?? ""}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Not specified</option>
          {[...new Set([...(value ? [String(value)] : []), ...choices])].map(
            (o) => (
              <option key={o} value={o}>
                {o}
                {refs.find((r) => r[refId] === o)?.name
                  ? ` — ${refs.find((r) => r[refId] === o)?.name}`
                  : ""}
              </option>
            ),
          )}
        </select>
      ) : typeof value === "number" ? (
        <input
          aria-label={inputLabel}
          type="number"
          step="any"
          value={value}
          readOnly={readOnly}
          onChange={(e) => {
            if (
              e.target.value !== "" &&
              Number.isFinite(Number(e.target.value))
            )
              onChange(Number(e.target.value));
          }}
        />
      ) : String(value || "").length > 150 ? (
        <textarea
          aria-label={inputLabel}
          value={value ?? ""}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          aria-label={inputLabel}
          value={value ?? ""}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
        />
      )}
    </label>
  );
}
export default function DataSetup({ ctx }: { ctx: PlanningContext }) {
  const [fullDataset, setFullDataset] = useState<Entity | null>(null),
    [fullLoading, setFullLoading] = useState(false),
    [wizard, setWizard] = useState(false),
    [collection, setCollection] = useState("units"),
    [draft, setDraft] = useState<Entity | null>(null),
    [versions, setVersions] = useState<Entity[]>([]),
    [edit, setEdit] = useState<Entity | null>(null),
    [json, setJson] = useState(""),
    [editorMode, setEditorMode] = useState("fields"),
    [validation, setValidation] = useState<Entity | null>(null),
    [sourceTab, setSourceTab] = useState("inventory"),
    [newRow, setNewRow] = useState(false),
    [page, setPage] = useState(0),
    [query, setQuery] = useState("");
  const dataset = draft?.dataset || draft?.data || fullDataset || ctx.dataset,
    raw = dataset?.[collection],
    rows = useMemo(() => records(raw), [raw]),
    columns = [...new Set(rows.flatMap(Object.keys))],
    visibleColumns = columns
      .filter(
        (k) =>
          ![
            "geometry",
            "state_intervals",
            "pathway",
            "trajectory",
            "remaining_stage_spec",
          ].includes(k),
      )
      .slice(0, 7),
    filtered = rows.filter(
      (r) =>
        !query || JSON.stringify(r).toLowerCase().includes(query.toLowerCase()),
    ),
    derivedDemand = derivedDemandCollections.has(collection),
    canEdit = ctx.canWrite !== false && !!draft && !derivedDemand;
  const collections = [
    ...new Set([
      ...canonicalCollections,
      "assumptions",
      ...Object.keys(dataset?.collection_counts || {}),
    ]),
  ].filter(
    (c) =>
      dataset?.[c] !== undefined ||
      dataset?.collection_counts?.[c] !== undefined ||
      canonicalCollections.includes(c),
  );
  let editing: Entity = {},
    jsonError = "";
  try {
    editing = JSON.parse(json || "{}");
    if (!editing || Array.isArray(editing) || typeof editing !== "object")
      jsonError = "A record must be a JSON object.";
  } catch (e) {
    jsonError = e instanceof Error ? e.message : String(e);
  }
  useEffect(() => {
    let current = true;
    setFullDataset(null);
    setDraft(null);
    setValidation(null);
    setFullLoading(true);
    if (ctx.dataset?.id)
      api(`/datasets/${ctx.dataset.id}`)
        .then((v) => {
          if (current) setFullDataset(v);
        })
        .catch((e) => ctx.notify(`Full dataset unavailable: ${e.message}`))
        .finally(() => {
          if (current) setFullLoading(false);
        });
    else setFullLoading(false);
    return () => {
      current = false;
    };
  }, [ctx.dataset?.id]);
  useEffect(() => {
    api("/datasets")
      .then((v) => setVersions(items(v)))
      .catch(() => {});
  }, [ctx.dataset?.id, draft?.id]);
  useEffect(() => {
    setPage(0);
    setQuery("");
  }, [collection]);
  async function beginDraft() {
    await ctx.action("Creating editable dataset draft", async () => {
      const d = await post("/dataset-drafts", {
        source_dataset_version_id: ctx.dataset?.id,
        name: `${ctx.dataset?.fixture || "Dataset"} — edited`,
      });
      setDraft(await api(`/dataset-drafts/${d.id}`));
      setValidation(null);
    });
  }
  async function saveEntity() {
    if (!draft || !canEdit || jsonError) return;
    await ctx.action("Saving entity changes", async () => {
      let entity = JSON.parse(json);
      const key = entityIds[collection] || "id";
      if (collection === "assumptions") {
        if (typeof entity.value !== "string" || !entity.value.trim())
          throw new Error("Enter an assumption description.");
        entity = newRow
          ? [...(raw || []), entity.value]
          : (raw || []).map((v: string, i: number) =>
              i === edit?.index ? entity.value : v,
            );
      } else if (newRow && entity.id !== undefined && entity[key])
        entity.id = entity[key];
      const result = await patch(
        `/dataset-drafts/${draft.id}/entities`,
        {
          operations: [
            {
              collection,
              action: "upsert",
              entity,
              id: entity[key] ?? entity.id,
            },
          ],
        },
        draft.revision,
      );
      setDraft(result);
      setEdit(null);
      setNewRow(false);
      setValidation(result.validation || null);
    });
  }
  async function validate() {
    await ctx.action("Validating dataset", async () => {
      const v = await post(
        draft
          ? `/dataset-drafts/${draft.id}/validate`
          : `/datasets/${ctx.dataset?.id}/validate`,
      );
      setValidation(v);
      ctx.notify(
        v.valid
          ? "Dataset validation passed."
          : "Review the dataset validation report.",
      );
    });
  }
  async function commit() {
    if (!draft) return;
    await ctx.action("Committing immutable dataset version", async () => {
      const v = await post(
        `/dataset-drafts/${draft.id}/commit`,
        {},
        draft.revision,
      );
      setDraft(null);
      await ctx.loadDataset(v.id);
      ctx.notify(`Immutable dataset ${v.id} saved and loaded.`);
    });
  }
  function openRecord(row: Entity) {
    setEdit(row);
    setJson(JSON.stringify(row, null, 2));
    setEditorMode("fields");
  }
  function addRecord() {
    const template =
      collection === "assumptions"
        ? { value: "" }
        : structuredClone(rows[0] || { [entityIds[collection] || "id"]: "" });
    for (const key of ["id", entityIds[collection]])
      if (key && key in template) template[key] = "";
    setJson(JSON.stringify(template, null, 2));
    setEditorMode("fields");
    setNewRow(true);
  }
  const count = (c: string) =>
    dataset?.collection_counts?.[c] ??
    (Array.isArray(dataset?.[c])
      ? dataset[c].length
      : dataset?.[c] && typeof dataset[c] === "object"
        ? 1
        : null);
  return (
    <div className="data-page page-scroll">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DATA & SETUP</div>
          <h1>A clear foundation for every forecast.</h1>
          <p>
            Review source data, validate assumptions, and manage immutable
            versions.
          </p>
        </div>
        <div className="heading-actions">
          <Button
            onClick={() => setWizard(true)}
            disabled={ctx.canWrite === false || fullLoading}
          >
            <Upload size={15} />
            Import dataset
          </Button>
          <Button
            onClick={() =>
              download(
                `hospital-dataset-${dataset?.fixture || "version"}.json`,
                JSON.stringify(dataset, null, 2),
              )
            }
            disabled={fullLoading}
          >
            <ArrowDownToLine size={15} />
            Export dataset
          </Button>
          {draft ? (
            <Button
              primary
              onClick={commit}
              disabled={!!ctx.busy || !validation?.valid}
            >
              <Check size={15} />
              Commit new version
            </Button>
          ) : (
            <Button
              primary
              onClick={beginDraft}
              disabled={ctx.canWrite === false || fullLoading}
            >
              <GitBranch size={15} />
              Create editable draft
            </Button>
          )}
        </div>
      </div>
      <div className="dataset-banner">
        <div className="dataset-avatar">
          <Database size={27} />
        </div>
        <div>
          <div className="spread">
            <h2>
              {draft?.name ||
                dataset?.name ||
                dataset?.label ||
                "Hospital planning dataset"}
            </h2>
            <Badge tone={draft ? "warning" : "success"}>
              {draft ? "Editable draft" : "Immutable version"}
            </Badge>
            {dataset?.synthetic ? (
              <Badge tone="warning">Synthetic dataset</Badge>
            ) : null}
          </div>
          <p>
            {dataset?.fixture?.replaceAll("_", " ")} · As of{" "}
            {localDate(dataset?.snapshot_at || "", {
              timeZone: dataset?.timezone || "America/Chicago",
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            · {dataset?.timezone || "Timezone unspecified"}
          </p>
          <span className="mono muted">
            {draft?.id || ctx.dataset?.id} <b>·</b> Schema{" "}
            {dataset?.schema_version || "—"} <b>·</b> Generator seed{" "}
            {dataset?.generator_seed ?? dataset?.seed ?? "—"}
          </span>
        </div>
        <Button
          onClick={validate}
          disabled={fullLoading || ctx.canWrite === false}
        >
          <ShieldCheck size={15} />
          Validate data
        </Button>
      </div>
      <div className="data-tabs">
        {[
          ["inventory", "Entity inventory"],
          ["assumptions", "Assumptions registry"],
          ["source", "Full source & manifest"],
          ["versions", "Dataset versions"],
          ["fixtures", "Generate synthetic data"],
        ].map(([id, title]) => (
          <button
            key={id}
            className={sourceTab === id ? "active" : ""}
            onClick={() => {
              setSourceTab(id);
              if (id === "assumptions") setCollection("assumptions");
              else if (id === "inventory" && collection === "assumptions")
                setCollection("units");
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {sourceTab === "fixtures" ? (
        <div className="fixture-cards">
          <FixtureCard
            title="Plan a future surge"
            count="84"
            subtitle="Initial patients · 72 inpatient / 12 ED"
            description="A planning baseline with available capacity and no existing inpatient boarders. Model when and where future demand creates pressure."
            disabled={ctx.canWrite === false}
            action={() => ctx.loadDataset("planning_baseline")}
          />
          <FixtureCard
            title="Inspect an already-full hospital"
            count="116"
            subtitle="Initial patients · 92 inpatient / 24 ED"
            description="A stress snapshot with 14 ED boarders awaiting inpatient placement. Explore a constraint that already exists at the start."
            disabled={ctx.canWrite === false}
            action={() => ctx.loadDataset("stress_snapshot")}
          />
          <div className="generation-notes">
            <ShieldCheck size={22} />
            <h3>Reproducible by construction</h3>
            <p>
              Both snapshots use generator seed 41021, versioned resource
              policies, synthetic stay distributions, census assignments, and
              resource ledgers.
            </p>
            <p>
              Inspect the generated manifest for exact collection counts,
              coverage dates, schema version, and input checksums.
            </p>
            <p className="muted">
              Generated operational assumptions are engineering fixtures. Their
              values remain visible in the inventory and full source.
            </p>
          </div>
        </div>
      ) : sourceTab === "versions" ? (
        <div className="version-list">
          {versions.map((v) => (
            <div className="version-row" key={v.id}>
              <Database size={19} />
              <div>
                <strong>{v.name || v.label || v.fixture}</strong>
                <span className="mono">{v.id}</span>
              </div>
              {v.synthetic ? <Badge tone="warning">Synthetic</Badge> : null}
              <span>{localDate(v.snapshot_at || v.created_at)}</span>
              <Button
                small
                onClick={() =>
                  ctx.action("Opening dataset", () => ctx.loadDataset(v.id))
                }
              >
                Open version <ArrowRight size={14} />
              </Button>
            </div>
          ))}
        </div>
      ) : sourceTab === "source" ? (
        <section className="entity-panel">
          <PanelTitle
            title="Complete source dataset"
            eyebrow={`${Object.keys(dataset || {}).length} TOP-LEVEL FIELDS · SCHEMA ${dataset?.schema_version || "—"}`}
            actions={
              <Button
                small
                disabled={fullLoading}
                onClick={() =>
                  download(
                    "dataset-manifest.json",
                    JSON.stringify(dataset?.manifest || {}, null, 2),
                  )
                }
              >
                <ArrowDownToLine size={13} />
                Manifest
              </Button>
            }
          />
          <div className="info-note">
            The inventory table shows a subset of columns for scanning. This
            source contains every saved field, assumption, resource policy, and
            provenance record.
          </div>
          <textarea
            className="json-editor"
            aria-label="Complete dataset JSON"
            readOnly
            value={
              fullLoading
                ? "Loading full source…"
                : JSON.stringify(dataset, null, 2)
            }
          />
        </section>
      ) : (
        <div className="dataset-inventory">
          <aside className="collection-list">
            <span className="eyebrow">DATA COLLECTIONS</span>
            {collections.map((c) => (
              <button
                key={c}
                className={collection === c ? "selected" : ""}
                onClick={() => setCollection(c)}
              >
                <span>{label(c)}</span>
                <strong>{count(c) === null ? "—" : fmt(count(c))}</strong>
              </button>
            ))}
          </aside>
          <section className="entity-panel">
            <PanelTitle
              title={label(collection)}
              eyebrow={`${count(collection) === null ? "—" : fmt(count(collection))} RECORDS · ${columns.length} FIELDS`}
              actions={
                <>
                  <Button
                    small
                    disabled={
                      !rows.length ||
                      fullLoading ||
                      !Array.isArray(raw) ||
                      collection === "assumptions"
                    }
                    onClick={() =>
                      download(`${collection}.csv`, csv(rows), "text/csv")
                    }
                  >
                    <ArrowDownToLine size={13} />
                    CSV sample / export
                  </Button>
                  {canEdit ? (
                    <Button small onClick={addRecord}>
                      <Plus size={13} />
                      Add record
                    </Button>
                  ) : (
                    <span className="muted small-copy">
                      {derivedDemand
                        ? "Derived · read-only"
                        : ctx.canWrite === false
                          ? "Read-only role"
                          : "Create a draft to edit"}
                    </span>
                  )}
                </>
              }
            />
            {derivedDemand ? (
              <div className="info-note">
                These demand summaries are calculated from enabled entry streams
                and declared cohort selection weights. Rates are summed; hourly
                and weekday profiles are weighted by each stream's daily
                arrivals. Each stream keeps its own profile.
                <Button small onClick={() => setCollection("entry_streams")}>
                  View entry streams
                </Button>
              </div>
            ) : collection === "entry_streams" ? (
              <div className="info-note">
                Entry streams are the editable demand source. Saving a stream
                updates baseline totals and profile summaries automatically.
              </div>
            ) : collection === "cohorts" ? (
              <div className="info-note">
                Cohort selection weights determine the baseline cohort mixture.
                Save all related weights before validating; each care group's
                weights must total 1. Per-stream pathway overrides stay
                separate.
              </div>
            ) : null}
            <div
              style={{
                padding: "12px 18px",
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <input
                aria-label="Search collection"
                placeholder="Search all fields…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
              <span className="muted small-copy">
                Open a row to inspect all {columns.length} fields.
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    {visibleColumns.map((k) => (
                      <th key={k}>{label(k)}</th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(page * 100, page * 100 + 100).map((r, i) => (
                    <tr
                      key={r[entityIds[collection]] || r.id || i}
                      onClick={() => openRecord(r)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openRecord(r);
                      }}
                    >
                      {visibleColumns.map((k) => (
                        <td key={k} className={k.includes("id") ? "mono" : ""}>
                          {typeof r[k] === "object"
                            ? JSON.stringify(r[k])
                            : String(r[k] ?? "—")}
                        </td>
                      ))}
                      <td>
                        <ChevronRight size={14} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {fullLoading ? (
                <p className="info-note">
                  Loading complete source collections…
                </p>
              ) : !rows.length ? (
                <p className="info-note">No records in this collection.</p>
              ) : null}
            </div>
            <div className="table-footer">
              <span>
                {fmt(filtered.length)} matching records · Page {page + 1} of{" "}
                {Math.max(1, Math.ceil(filtered.length / 100))}
              </span>
              <div>
                <Button
                  small
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  small
                  disabled={(page + 1) * 100 >= filtered.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}
      {validation ? (
        <div className={`validation-report ${validation.valid ? "valid" : ""}`}>
          <PanelTitle
            title={
              validation.valid ? "Dataset checks passed" : "Validation report"
            }
            eyebrow="CROSS-ENTITY CONSISTENCY"
            actions={
              <Button
                small
                onClick={() =>
                  download(
                    "dataset-validation-report.json",
                    JSON.stringify(validation, null, 2),
                  )
                }
              >
                <ArrowDownToLine size={12} />
                Report
              </Button>
            }
          />
          {(validation.errors || []).map((e: any, i: number) => (
            <ErrorBox
              key={i}
              error={
                typeof e === "string"
                  ? e
                  : [
                      e.file || e.collection,
                      e.row !== undefined ? `row ${e.row}` : null,
                      e.entity_id,
                      e.field,
                      e.message || e.code,
                    ]
                      .filter(Boolean)
                      .join(" · ")
              }
            />
          ))}
          {validation.valid ? (
            <p>
              <CheckCircle2 size={16} /> Counts, references, assignments,
              capacities, and time coverage are consistent.
            </p>
          ) : null}
          {validation.change_summary?.length ? (
            <p>Changed collections: {validation.change_summary.join(", ")}</p>
          ) : null}
          {(validation.warnings || []).map((w: any, i: number) => (
            <p key={i} className="amber">
              {typeof w === "string" ? w : w.message}
            </p>
          ))}
        </div>
      ) : null}
      {edit || newRow ? (
        <Modal
          title={`${canEdit ? "Edit" : "Inspect"} ${collection} record · ${Object.keys(editing).length} fields`}
          wide
          onClose={() => {
            setEdit(null);
            setNewRow(false);
          }}
        >
          <div className="data-tabs">
            <button
              className={editorMode === "fields" ? "active" : ""}
              onClick={() => setEditorMode("fields")}
            >
              Structured fields
            </button>
            <button
              className={editorMode === "json" ? "active" : ""}
              onClick={() => setEditorMode("json")}
            >
              Advanced JSON
            </button>
          </div>
          {derivedDemand ? (
            <div className="info-note">
              Read-only demand summary. Change the corresponding entry stream or
              cohort selection weight to update this value; imported sources
              must already agree.
              <Button
                small
                onClick={() => {
                  setEdit(null);
                  setNewRow(false);
                  setCollection("entry_streams");
                }}
              >
                View entry streams
              </Button>
            </div>
          ) : null}
          {jsonError ? <ErrorBox error={jsonError} /> : null}
          {editorMode === "fields" && !jsonError ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))",
                gap: 16,
                maxHeight: "60vh",
                overflow: "auto",
                padding: 4,
              }}
            >
              {Object.keys(editing).map((k) => (
                <Field
                  key={k}
                  field={k}
                  value={editing[k]}
                  onChange={(v) =>
                    setJson(JSON.stringify({ ...editing, [k]: v }, null, 2))
                  }
                  dataset={dataset || {}}
                  collection={collection}
                  readOnly={
                    !canEdit ||
                    (!newRow &&
                      (k === "id" ||
                        k === "index" ||
                        k === entityIds[collection]))
                  }
                />
              ))}
            </div>
          ) : (
            <textarea
              className="json-editor"
              value={json}
              readOnly={!canEdit}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
              aria-label="Entity JSON"
            />
          )}
          {canEdit ? (
            <>
              <div className="info-note">
                Changes stay in this draft until validation and commit.
                {collection === "entry_streams"
                  ? " Demand summaries update from these stream values automatically."
                  : ""}
                Installed and enabled capacity must reconcile with slot records;
                capacity policies and staff assignments determine usable places.
              </div>
              <Button
                primary
                onClick={saveEntity}
                disabled={!!jsonError || !!ctx.busy}
              >
                <Save size={15} />
                Save record
              </Button>
            </>
          ) : !derivedDemand && !draft && ctx.canWrite !== false ? (
            <Button
              onClick={() => {
                setEdit(null);
                beginDraft();
              }}
            >
              Create draft to edit
            </Button>
          ) : null}
        </Modal>
      ) : null}
      {wizard ? (
        <ImportWizard
          ctx={{ ...ctx, dataset: (fullDataset || ctx.dataset) as any }}
          onClose={() => setWizard(false)}
          onCommitted={() => ctx.refresh()}
        />
      ) : null}
    </div>
  );
}
function FixtureCard({
  title,
  count,
  subtitle,
  description,
  action,
  disabled,
}: {
  title: string;
  count: string;
  subtitle: string;
  description: string;
  action: () => void;
  disabled: boolean;
}) {
  return (
    <div className="fixture-card">
      <span className="eyebrow">SYNTHETIC GENERATOR</span>
      <h2>{title}</h2>
      <strong className="fixture-count">{count}</strong>
      <span>{subtitle}</span>
      <p>{description}</p>
      <Button primary disabled={disabled} onClick={action}>
        Generate and load <ArrowRight size={15} />
      </Button>
    </div>
  );
}
