import { NativeSelect } from "@mantine/core";
import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  FileJson,
  FileSpreadsheet,
  Plus,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt, post } from "../api";
import { Badge, Button, ErrorBox, Modal } from "./ui";
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  return rows;
}
export const canonicalCollections = [
  "facilities",
  "units",
  "slots",
  "staff",
  "assignments",
  "equipment_pools",
  "patients",
  "routes",
  "vehicles",
  "cohorts",
  "los_templates",
  "capacity_policies",
  "resource_profiles",
  "partner_equipment",
  "geometry",
  "virtual_locations",
  "organizations",
  "entry_streams",
  "clinic_policies",
  "pathway_profiles",
  "capabilities",
  "arrival_profiles",
  "hour_of_day_baseline",
  "weekday_baseline",
  "history",
  "historical_daily_summaries",
  "presets",
  "intervention_templates",
  "update_fixtures",
];
const names = canonicalCollections;
export const entityIds: Record<string, string> = {
  patients: "patient_id",
  facilities: "facility_id",
  units: "unit_id",
  slots: "slot_id",
  staff: "staff_id",
  assignments: "assignment_id",
  equipment_pools: "equipment_pool_id",
  routes: "route_id",
  vehicles: "vehicle_id",
  cohorts: "cohort_id",
  los_templates: "template_id",
  resource_profiles: "resource_profile_id",
  capacity_policies: "capacity_policy_id",
  clinic_policies: "clinic_policy_id",
  entry_streams: "entry_stream_id",
  pathway_profiles: "pathway_profile_id",
  capabilities: "capability_code",
  geometry: "unit_id",
  organizations: "organization_id",
  virtual_locations: "location_id",
  history: "episode_id",
  hour_of_day_baseline: "hour",
  weekday_baseline: "weekday",
  historical_daily_summaries: "local_date",
  presets: "preset_id",
  intervention_templates: "template_kind",
  update_fixtures: "update_id",
  partner_equipment: "advertisement_id",
};
export default function ImportWizard({
  ctx,
  onClose,
  onCommitted,
}: {
  ctx: PlanningContext;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]),
    [previews, setPreviews] = useState<Record<string, string[][]>>({}),
    [mapping, setMapping] = useState<Entity>({}),
    [base, setBase] = useState(true),
    [session, setSession] = useState<Entity | null>(null),
    [report, setReport] = useState<Entity | null>(null),
    [validatedPreview, setValidatedPreview] = useState<Entity | null>(null),
    [fileError, setFileError] = useState(""),
    [step, setStep] = useState(1),
    [active, setActive] = useState("");
  async function addFiles(list: FileList | null) {
    if (!list) return;
    setFileError("");
    try {
      if (Array.from(list).some((f) => !/[.](csv|json|zip)$/i.test(f.name)))
        throw new Error("Use CSV, JSON or ZIP files.");
      for (const f of Array.from(list)) {
        if (
          f.size >
          (f.name.toLowerCase().endsWith(".csv") ? 25 : 100) * 1024 * 1024
        )
          throw new Error(`${f.name} exceeds its size limit.`);
        if (f.name.toLowerCase().endsWith(".csv")) {
          const rows = parseCSV((await f.text()).replace(/^\uFEFF/, ""));
          if (!rows.length || !rows[0].length)
            throw new Error(`${f.name}: no CSV header found.`);
          if (new Set(rows[0]).size !== rows[0].length)
            throw new Error(
              `${f.name}: duplicate header names must be corrected before mapping.`,
            );
          setPreviews((v) => ({ ...v, [f.name]: rows.slice(0, 6) }));
          const stem = f.name
            .replace(/\.csv$/i, "")
            .replace("patient_census", "patients")
            .replace("staff_assignments", "assignments");
          const collection =
            names.includes(stem) && Array.isArray(ctx.dataset?.[stem])
              ? stem
              : "patients";
          setMapping((v: Entity) => ({
            ...v,
            [f.name]: {
              collection,
              columns: Object.fromEntries((rows[0] || []).map((h) => [h, h])),
              ignore: [],
            },
          }));
        }
      }
      setFiles((v) => [
        ...v,
        ...Array.from(list).filter((f) => !v.some((x) => x.name === f.name)),
      ]);
      setActive(list[0]?.name || "");
      setReport(null);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }
  async function validate() {
    await ctx.action("Uploading and validating import", async () => {
      if (!base && !files.some((f) => /\.(json|zip)$/i.test(f.name)))
        throw new Error(
          "CSV collections need an explicit base dataset or a complete JSON/ZIP bundle in this import.",
        );
      if (files.reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024)
        throw new Error("Combined files exceed the 100 MiB session limit.");
      const s = await post("/imports", {
        name: files.map((f) => f.name).join(", "),
        source_dataset_version_id: base ? ctx.dataset?.id : undefined,
        mapping,
      });
      setSession(s);
      for (const f of [...files].sort(
        (a, b) =>
          Number(a.name.toLowerCase().endsWith(".csv")) -
          Number(b.name.toLowerCase().endsWith(".csv")),
      )) {
        const data = new FormData();
        data.append("file", f);
        await api(`/imports/${s.id}/files`, { method: "POST", body: data });
      }
      const v = await post(`/imports/${s.id}/validate`, { mapping });
      setReport(v);
      setValidatedPreview(await api(`/imports/${s.id}`));
      setStep(3);
    });
  }
  function mapColumn(header: string, value: string) {
    setMapping((v: Entity) => {
      const m = v[active];
      return {
        ...v,
        [active]: {
          ...m,
          columns: {
            ...m.columns,
            [header]: value === "__ignore" ? null : value,
          },
          ignore:
            value === "__ignore"
              ? [...new Set([...m.ignore, header])]
              : m.ignore.filter((x: string) => x !== header),
        },
      };
    });
  }
  function reportDownload() {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "dataset-validation-report.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  const preview = previews[active],
    collection = mapping[active]?.collection;
  const sourceRows = ctx.dataset?.[collection] || [];
  const fields = Array.isArray(sourceRows)
    ? [
        ...new Set(
          sourceRows
            .filter((r: any) => r && typeof r === "object")
            .flatMap(Object.keys),
        ),
      ]
    : Object.keys(sourceRows || {});
  return (
    <Modal title="Import dataset" wide onClose={onClose}>
      {fileError ? <ErrorBox error={fileError} /> : null}
      <div className="wizard-steps">
        {["Choose files", "Preview & map", "Validate & commit"].map((s, i) => (
          <div className={step >= i + 1 ? "active" : ""} key={s}>
            <span>{step > i + 1 ? <Check size={11} /> : i + 1}</span>
            {s}
          </div>
        ))}
      </div>
      {step === 1 ? (
        <>
          <label
            className="upload-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
          >
            <Upload size={28} />
            <strong>Add dataset files</strong>
            <span>Versioned JSON bundle or CSV entity collections</span>
            <small>25 MiB per CSV · 100 MiB combined</small>
            <input
              type="file"
              accept=".csv,.json,.zip"
              multiple
              onChange={(e) => addFiles(e.target.files)}
            />
          </label>
          <label className="base-dataset-choice">
            <input
              type="checkbox"
              checked={base}
              onChange={(e) => setBase(e.target.checked)}
            />
            <span>
              <strong>Use the current dataset as an explicit base</strong>
              <small>
                Uploaded CSV collections replace the matching collections; other
                inputs remain from this selected version.
              </small>
            </span>
          </label>
          <div className="import-files">
            {files.map((f) => (
              <div key={f.name}>
                {f.name.toLowerCase().endsWith(".csv") ? (
                  <FileSpreadsheet size={16} />
                ) : (
                  <FileJson size={16} />
                )}
                <strong>{f.name}</strong>
                <span>{fmt(f.size / 1024)} KiB</span>
                <button
                  aria-label={`Remove ${f.name}`}
                  onClick={() =>
                    setFiles((v) => v.filter((x) => x.name !== f.name))
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="info-note">
            Use synthetic operational data. Supported fields are checked against
            the selected schema. Object-valued policies require a JSON bundle.
            Unmapped columns require explicit mapping or removal.
          </div>
          <Button
            primary
            disabled={!files.length}
            onClick={() => {
              setActive(files[0]?.name || "");
              setStep(2);
            }}
          >
            Preview and map fields <ArrowRight size={14} />
          </Button>
        </>
      ) : step === 2 ? (
        <>
          <div className="import-file-tabs">
            {files.map((f) => (
              <button
                key={f.name}
                className={active === f.name ? "active" : ""}
                onClick={() => setActive(f.name)}
              >
                {f.name}
              </button>
            ))}
          </div>
          {preview ? (
            <>
              <label className="collection-select">
                Target collection
                <NativeSelect aria-label="Target collection"
                  value={collection}
                  onChange={(e) =>
                    setMapping((v: Entity) => ({
                      ...v,
                      [active]: { ...v[active], collection: e.target.value },
                    }))
                  }
                >
                  {names
                    .filter((n) => Array.isArray(ctx.dataset?.[n]))
                    .map((n) => (
                      <option key={n} value={n}>
                        {n.replaceAll("_", " ")}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <div className="mapping-grid">
                <div className="eyebrow">SOURCE COLUMN</div>
                <div className="eyebrow">CANONICAL FIELD</div>
                <div className="eyebrow">FIRST SUPPLIED VALUE</div>
                {preview[0]?.map((h, i) => (
                  <div className="mapping-row" key={h}>
                    <span>{h}</span>
                    <NativeSelect
                      aria-label={`Map ${h}`}
                      value={
                        mapping[active]?.ignore?.includes(h)
                          ? "__ignore"
                          : mapping[active]?.columns[h] || h
                      }
                      onChange={(e) => mapColumn(h, e.target.value)}
                    >
                      {[...new Set([h, ...fields])].map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                      <option value="__ignore">
                        Explicitly ignore this column
                      </option>
                    </NativeSelect>
                    <code>{preview[1]?.[i] || "—"}</code>
                  </div>
                ))}
              </div>
              <h3 className="section-space">Sample rows</h3>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {preview[0]?.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(1).map((r, i) => (
                      <tr key={i}>
                        {r.map((v, j) => (
                          <td key={j}>{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="info-note">
              The versioned bundle will be parsed and validated in full,
              including its manifest and cross-entity references.
            </div>
          )}
          <div className="wizard-actions">
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button primary onClick={validate} disabled={!!ctx.busy}>
              Validate all files <ShieldCheck size={14} />
            </Button>
          </div>
        </>
      ) : (
        <>
          <Badge tone={report?.valid ? "success" : "warning"}>
            {report?.valid ? "Ready to commit" : "Validation needs attention"}
          </Badge>
          <div className="validation-items">
            {validatedPreview?.row_counts ? (
              <div className="info-note">
                Parsed collection counts:{" "}
                {Object.entries(validatedPreview.row_counts)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </div>
            ) : null}
            {report?.valid ? (
              <div className="info-note">
                All supplied files passed schema and cross-entity validation.
                Commit creates one immutable dataset version atomically.
              </div>
            ) : null}
            {report?.errors?.map((e: any, i: number) => (
              <ErrorBox
                key={i}
                error={
                  typeof e === "string"
                    ? e
                    : [
                        e.file || e.collection,
                        e.row !== undefined && `row ${e.row}`,
                        e.field,
                        e.entity_id,
                        e.message || e.code,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                }
              />
            ))}
            {report?.warnings?.map((e: any, i: number) => (
              <p className="amber small-copy" key={i}>
                {typeof e === "string" ? e : e.message}
              </p>
            ))}
          </div>
          <div className="wizard-actions">
            <Button onClick={() => setStep(2)}>Revise mapping</Button>
            <Button onClick={reportDownload}>
              <ArrowDownToLine size={13} />
              Validation report
            </Button>
            <Button
              primary
              disabled={!report?.valid || !!ctx.busy}
              onClick={() =>
                ctx.action("Committing imported dataset", async () => {
                  const d = await post(`/imports/${session?.id}/commit`);
                  await ctx.loadDataset(d.id);
                  ctx.notify("Dataset imported as an immutable version.");
                  onClose();
                })
              }
            >
              Commit dataset <ArrowRight size={14} />
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
