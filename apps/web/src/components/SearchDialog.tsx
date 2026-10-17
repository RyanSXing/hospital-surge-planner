import { useEffect, useRef, useState } from "react";
import {
  Building2,
  ChevronRight,
  Hospital,
  Layers,
  Search,
  Users,
} from "lucide-react";
import type { Entity, PageId, PlanningContext } from "../types";
import { api, idOf, items, patientId } from "../api";
import { Busy, ErrorBox, Modal } from "./ui";

const pages: [PageId, string][] = [
  ["overview", "Overview"],
  ["scenarios", "Scenarios"],
  ["patients", "Patients & units"],
  ["resources", "Resources"],
  ["compare", "Compare responses"],
  ["replay", "Flow replay"],
  ["data", "Data & setup"],
];

const entityKey = (row: Entity) =>
  row.patient_id || row.unit_id || row.facility_id || idOf(row);

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
  const [resourceLimit, setResourceLimit] = useState(10);
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
  const resources = [
    ...(ctx.dataset?.units || []).map((row): Entity => ({
      ...row,
      search_kind: "unit",
    })),
    ...(ctx.dataset?.facilities || []).map((row): Entity => ({
      ...row,
      search_kind: "facility",
    })),
  ].filter(
    (row) =>
      term &&
      `${row.name} ${entityKey(row)}`
        .toLowerCase()
        .includes(term.toLowerCase()),
  );
  useEffect(() => setResourceLimit(10), [term]);
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
              Facilities and units · {Math.min(resources.length, resourceLimit)}{" "}
              of {resources.length}
            </p>
            {resources.slice(0, resourceLimit).map((row) => (
              <button
                key={`${row.search_kind}:${entityKey(row)}`}
                onClick={() => {
                  ctx.setFacility(row.facility_id || row.id);
                  ctx.setPage(
                    row.search_kind === "unit" ? "patients" : "resources",
                  );
                  onClose();
                }}
              >
                {row.search_kind === "unit" ? (
                  <Hospital size={16} />
                ) : (
                  <Building2 size={16} />
                )}
                <span>{row.name}</span>
                <small>{entityKey(row)}</small>
              </button>
            ))}
            {resources.length > resourceLimit ? (
              <button onClick={() => setResourceLimit((n) => n + 10)}>
                Load more facility and unit matches
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
