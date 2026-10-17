import { useEffect, useState } from "react";
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
export default function SearchDialog({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const [search, setSearch] = useState(""),
    [scenarios, setScenarios] = useState<Entity[]>([]),
    [matches, setMatches] = useState<Entity[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const rep = ctx.activeReplicationId || ctx.run?.selected_replication_id;
  useEffect(() => {
    let ignore = false;
    api("/scenarios?limit=200")
      .then((v) => {
        if (!ignore) setScenarios(items(v));
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, []);
  useEffect(() => {
    let ignore = false;
    setMatches([]);
    setError("");
    if (!search.trim()) {
      setLoading(false);
      return;
    }
    if (!rep || ctx.run?.status !== "SUCCEEDED") {
      setMatches(
        (ctx.dataset?.patients || [])
          .filter((p) =>
            patientId(p).toLowerCase().includes(search.toLowerCase()),
          )
          .slice(0, 10),
      );
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      () =>
        api(
          `/runs/${rep}/patients?at=${encodeURIComponent(ctx.selectedTime)}&search=${encodeURIComponent(search.trim())}&limit=10`,
        )
          .then((v) => {
            if (!ignore) setMatches(items(v));
          })
          .catch((e) => {
            if (!ignore) setError(e.message);
          })
          .finally(() => {
            if (!ignore) setLoading(false);
          }),
      250,
    );
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [search, rep, ctx.selectedTime, ctx.run?.status, ctx.dataset?.id]);
  return (
    <Modal title="Search workspace" onClose={onClose}>
      <label className="global-search">
        <Search size={18} />
        <input
          autoFocus
          placeholder="Patient ID, facility, or workspace view…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>ESC</kbd>
      </label>
      {error ? <ErrorBox error={error} /> : null}
      <div className="search-results">
        {pages
          .filter(
            ([, name]) =>
              !search || name.toLowerCase().includes(search.toLowerCase()),
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
        {loading ? (
          <Busy label="Searching the complete selected-run census" />
        ) : (
          matches.map((p) => (
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
          ))
        )}
        {search
          ? scenarios
              .filter((s) =>
                s.name?.toLowerCase().includes(search.toLowerCase()),
              )
              .slice(0, 5)
              .map((s) => (
                <button
                  key={s.id}
                  onClick={async () => {
                    await ctx.saveScenario({ __select: s.id });
                    ctx.setPage("scenarios");
                    onClose();
                  }}
                >
                  <Layers size={16} />
                  <span>{s.name}</span>
                  <small>Scenario</small>
                </button>
              ))
          : null}
        {search
          ? (ctx.dataset?.units || [])
              .filter((u) =>
                (u.name + " " + u.unit_id)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((u) => (
                <button
                  key={u.unit_id}
                  onClick={() => {
                    ctx.setFacility(u.facility_id);
                    ctx.setPage("patients");
                    onClose();
                  }}
                >
                  <Hospital size={16} />
                  <span>{u.name}</span>
                  <small>{u.unit_id}</small>
                </button>
              ))
          : null}
        {(ctx.dataset?.facilities || [])
          .filter(
            (f) =>
              search && f.name?.toLowerCase().includes(search.toLowerCase()),
          )
          .map((f) => (
            <button
              key={idOf(f)}
              onClick={() => {
                ctx.setFacility(f.facility_id || f.id);
                ctx.setPage("resources");
                onClose();
              }}
            >
              <Building2 size={16} />
              <span>{f.name}</span>
            </button>
          ))}
      </div>
    </Modal>
  );
}
