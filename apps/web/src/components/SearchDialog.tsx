import { useEffect, useRef, useState } from "react";
import {
  Building2,
  BedDouble,
  ChevronRight,
  Hospital,
  Layers,
  Package,
  Search,
  Stethoscope,
  Truck,
  Users,
} from "lucide-react";
import type { Entity, PageId, PlanningContext } from "../types";
import { api, idOf, items, patientId } from "../api";
import { Busy, ErrorBox, Modal } from "./ui";
import { humanLabel } from "../presentation";
import { resourceFacility } from "../entityLocation";
import {
  resourceSearchRows,
  searchEntityId,
  searchKindLabel,
  searchProvenanceLabel,
  type SearchKind,
} from "./workspaceSearch";

const pages: [PageId, string][] = [
  ["overview", "Configuration"],
  ["summary", "Analysis · Summary"],
  ["replay", "Analysis · Replay"],
  ["analytics", "Analysis · Analytics"],
  ["comparison", "Analysis · Comparison"],
  ["patients", "Patients & units"],
  ["data", "Data & setup"],
];

const entityKey = (row: Entity) =>
  row.patient_id ||
  row.unit_id ||
  row.facility_id ||
  row.staff_id ||
  row.equipment_pool_id ||
  row.vehicle_id ||
  row.slot_id ||
  idOf(row);

function useSearchPage(url: string) {
  const request = useRef(0);
  const [state, setState] = useState<{
    url: string;
    rows: Entity[];
    cursor: string | null;
    total: number;
    loading: boolean;
    error: string;
  }>({ url: "", rows: [], cursor: null, total: 0, loading: false, error: "" });
  async function load(cursor?: string) {
    if (!url) return;
    const current = ++request.current;
    setState((old) => ({ ...old, url, loading: true, error: "" }));
    try {
      const result = await api(
        url + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
      );
      if (current !== request.current) return;
      setState((old) => ({
        url,
        rows:
          cursor && old.url === url
            ? [
                ...old.rows,
                ...items(result).filter(
                  (row) =>
                    !old.rows.some(
                      (previous) => entityKey(previous) === entityKey(row),
                    ),
                ),
              ]
            : items(result),
        cursor: result.next_cursor || null,
        total: result.total ?? items(result).length,
        loading: false,
        error: "",
      }));
    } catch (error) {
      if (current === request.current)
        setState((old) => ({
          ...old,
          url,
          loading: false,
          error: (error as Error).message,
        }));
    }
  }
  useEffect(() => {
    setState({
      url,
      rows: [],
      cursor: null,
      total: 0,
      loading: Boolean(url),
      error: "",
    });
    const timer = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(timer);
      ++request.current;
    };
  }, [url]);
  const current =
    state.url === url
      ? state
      : {
          url,
          rows: [],
          cursor: null,
          total: 0,
          loading: Boolean(url),
          error: "",
        };
  return {
    ...current,
    more: () => void load(current.cursor || undefined),
    retry: () => void load(),
  };
}

export default function SearchDialog({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [resourceLimit, setResourceLimit] = useState(12);
  const term = search.trim(),
    encoded = encodeURIComponent(term);
  const rep = ctx.activeReplicationId || ctx.run?.selected_replication_id;
  const patientBase =
    rep && ctx.run?.status === "SUCCEEDED"
      ? `/runs/${rep}/patients?at=${encodeURIComponent(ctx.selectedTime)}`
      : ctx.dataset?.id
        ? `/datasets/${ctx.dataset.id}/patients?`
        : "";
  const patients = useSearchPage(
    term && patientBase ? `${patientBase}&search=${encoded}&limit=10` : "",
  );
  const scenarios = useSearchPage(
    term ? `/scenarios?search=${encoded}&limit=10` : "",
  );
  // Do not index a prior selected-time state while the current request is
  // loading or after it has failed; immutable snapshot rows remain searchable.
  const selectedState = ctx.stateLoading || ctx.stateError ? null : ctx.state;
  const resources = resourceSearchRows(ctx.dataset, selectedState, term).filter(
    (row) => {
      const kind = row.search_kind as SearchKind;
      const facility = resourceFacility(
        kind,
        searchEntityId(kind, row),
        row,
        ctx.dataset?.units || [],
        selectedState?.units || [],
      );
      return kind !== "vehicle" && (!facility || facility === "FAC-MAIN");
    },
  );
  useEffect(() => setResourceLimit(12), [term]);
  const inspectEntity = (
    ctx as PlanningContext & {
      inspectEntity?: (kind: string, id: string) => void;
    }
  ).inspectEntity;
  const inspectResource = (row: Entity) => {
    const kind = row.search_kind as SearchKind;
    const id = searchEntityId(kind, row);
    if (inspectEntity && id) {
      inspectEntity(kind, id);
      onClose();
      return;
    }
    // Kept for the brief interval before the shared navigation contract is loaded.
    ctx.setFacility(row.facility_id || row.id || ctx.selectedFacility);
    ctx.setPage("patients");
    onClose();
  };
  return (
    <Modal title="Search workspace" onClose={onClose}>
      <label className="global-search">
        <Search size={18} />
        <input
          autoFocus
          aria-label="Search workspace content"
          placeholder="Patient ID, scenario, facility, or view…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>ESC</kbd>
      </label>
      <div className="search-results">
        {pages
          .filter(
            ([, name]) =>
              !term || name.toLowerCase().includes(term.toLowerCase()),
          )
          .map(([id, name]) => (
            <button
              key={id}
              onClick={() => {
                ctx.setPage(id);
                onClose();
              }}
            >
              <Layers size={16} />
              <span>{name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        {term ? (
          <>
            <p className="small-copy">
              Patients · {patients.rows.length} of {patients.total}
              {rep && ctx.run?.status === "SUCCEEDED"
                ? " at the selected run time"
                : " in the source snapshot"}
            </p>
            {patients.error ? (
              <>
                <ErrorBox error={patients.error} />
                <button onClick={patients.retry}>Retry patient search</button>
              </>
            ) : null}
            {patients.rows.map((p) => (
              <button
                key={patientId(p)}
                onClick={() => {
                  ctx.setFacility(p.facility_id || ctx.selectedFacility);
                  ctx.setPatient(p);
                  ctx.setPage("patients");
                  onClose();
                }}
              >
                <Users size={16} />
                <span>{patientId(p)}</span>
                <small>{p.state?.replaceAll("_", " ")}</small>
              </button>
            ))}
            {patients.loading ? (
              <Busy label="Searching the complete patient census" />
            ) : null}
            {patients.cursor ? (
              <button disabled={patients.loading} onClick={patients.more}>
                Load more patient matches
              </button>
            ) : null}
            <p className="small-copy">
              Scenarios · {scenarios.rows.length} of {scenarios.total}
            </p>
            {scenarios.error ? (
              <>
                <ErrorBox error={scenarios.error} />
                <button onClick={scenarios.retry}>Retry scenario search</button>
              </>
            ) : null}
            {scenarios.rows.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  void ctx.action("Opening scenario", async () => {
                    await ctx.saveScenario({ __select: s.id });
                    ctx.setPage("scenarios");
                    onClose();
                  })
                }
              >
                <Layers size={16} />
                <span>{s.name}</span>
                <small>Revision {s.revision}</small>
              </button>
            ))}
            {scenarios.loading ? (
              <Busy label="Searching all saved scenarios" />
            ) : null}
            {scenarios.cursor ? (
              <button disabled={scenarios.loading} onClick={scenarios.more}>
                Load more scenario matches
              </button>
            ) : null}
            <p className="small-copy">
              Resources and sites · {Math.min(resources.length, resourceLimit)}{" "}
              of {resources.length} matching the frozen dataset
              {selectedState ? " and selected-time state" : ""}
            </p>
            {resources.slice(0, resourceLimit).map((row) => (
              <button
                key={`${row.search_kind}:${entityKey(row)}`}
                onClick={() => inspectResource(row)}
              >
                {row.search_kind === "unit" ? (
                  <Hospital size={16} />
                ) : row.search_kind === "facility" ? (
                  <Building2 size={16} />
                ) : row.search_kind === "staff" ? (
                  <Stethoscope size={16} />
                ) : row.search_kind === "equipment_pool" ? (
                  <Package size={16} />
                ) : row.search_kind === "vehicle" ? (
                  <Truck size={16} />
                ) : (
                  <BedDouble size={16} />
                )}
                <span>
                  {row.name ||
                    (row.search_kind === "slot"
                      ? `Bed ${row.display_label}`
                      : humanLabel(
                          row.capability_code || row.role || row.display_label,
                        ))}
                </span>
                <small>
                  {searchKindLabel(row.search_kind as SearchKind)} ·{" "}
                  {searchEntityId(row.search_kind as SearchKind, row)} ·{" "}
                  {searchProvenanceLabel(row)}
                </small>
              </button>
            ))}
            {resources.length > resourceLimit ? (
              <button onClick={() => setResourceLimit((n) => n + 10)}>
                Show more hospital matches
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
