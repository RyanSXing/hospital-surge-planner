import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Database,
  FileJson,
  GitCompareArrows,
  HelpCircle,
  Hospital,
  Layers,
  LoaderCircle,
  LogOut,
  Map,
  Menu,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import type {
  Dataset,
  Entity,
  Grain,
  Metrics,
  PageId,
  PlanningContext,
  RunGroup,
  Scenario,
} from "./types";
import {
  ApiError,
  api,
  atDay,
  fmt,
  idOf,
  items,
  localDate,
  localDayIndex,
  patch,
  patientId,
  post,
  setPresentationTimezone,
} from "./api";
import { Badge, Button, Busy, ErrorBox, Modal } from "./components/ui";
import UpdateDialog from "./components/UpdateDialog";
import AdminDialog from "./components/AdminDialog";
import AlertsDialog from "./components/AlertsDialog";
import SearchDialog from "./components/SearchDialog";
const Overview = lazy(() => import("./pages/Overview")),
  Scenarios = lazy(() => import("./pages/Scenarios")),
  Patients = lazy(() => import("./pages/Patients")),
  Resources = lazy(() => import("./pages/Resources")),
  Compare = lazy(() => import("./pages/Compare")),
  Replay = lazy(() => import("./pages/Replay")),
  DataSetup = lazy(() => import("./pages/DataSetup"));
const nav = [
  { id: "overview", name: "Overview", icon: Map },
  { id: "scenarios", name: "Scenarios", icon: SlidersHorizontal },
  { id: "patients", name: "Patients & units", icon: Users },
  { id: "resources", name: "Resources", icon: Building2 },
  { id: "compare", name: "Compare responses", icon: GitCompareArrows },
  { id: "replay", name: "Flow replay", icon: Play },
] as const;
export default function App() {
  const queryClient = useQueryClient();
  const [page, setPageState] = useState<PageId>(
      () =>
        (new URLSearchParams(location.search).get("view") ||
          "overview") as PageId,
    ),
    [dataset, setDatasetState] = useState<Dataset | null>(null),
    [scenario, setScenario] = useState<Scenario | null>(null),
    [run, setRun] = useState<RunGroup | null>(null),
    [selectedTime, setSelectedTime] = useState("2026-10-16T05:00:00Z"),
    [selectedFacility, setFacilityState] = useState("FAC-MAIN"),
    [selectedPatient, setPatient] = useState<Entity | null>(null),
    [grain, setGrain] = useState<Grain>("day"),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [toast, setToast] = useState(""),
    [toastTone, setToastTone] = useState("success"),
    [searchOpen, setSearchOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [updateOpen, setUpdateOpen] = useState(false),
    [alertsOpen, setAlertsOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [accountOpen, setAccountOpen] = useState(false),
    [adminOpen, setAdminOpen] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [user, setUser] = useState<Entity | null>(null),
    [activeReplicationId, setReplication] = useState("");
  const setDataset = useCallback((value: Dataset | null) => {
    setPresentationTimezone(value?.timezone || "America/Chicago");
    setDatasetState(value);
  }, []);
  const setFacility = useCallback((value: string) => {
    setFacilityState(value);
    setPatient(null);
  }, []);
  const summary = useQuery({
    queryKey: ["summary"],
    queryFn: async () => {
      const [s, u] = await Promise.all([
        api("/workspaces/workspace-main/summary"),
        api("/me"),
      ]);
      setUser(u);
      const params = new URLSearchParams(location.search);
      if (params.get("scenario")) {
        const chosen = await api(`/scenarios/${params.get("scenario")}`);
        s.scenario = chosen;
        s.dataset = await api(`/datasets/${chosen.dataset_version_id}`);
        s.run =
          (s.runs || []).find((r: Entity) => r.scenario_id === chosen.id) ||
          null;
        s.run_group = s.run;
      }
      if (params.get("run")) {
        const chosen = await api(`/run-groups/${params.get("run")}`);
        if (chosen.scenario_id === s.scenario?.id) {
          s.run = chosen;
          s.run_group = chosen;
        }
      }
      return s;
    },
    retry: 1,
  });
  const notify = useCallback((s: string) => {
    setToastTone("success");
    setToast(s);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (summary.data && !dataset) {
      const d = summary.data.dataset;
      setDataset(d);
      setScenario(summary.data.scenario);
      setRun(summary.data.run_group || summary.data.run || null);
      if (d?.snapshot_at) {
        const params = new URLSearchParams(location.search);
        setSelectedTime(params.get("at") || d.snapshot_at);
        setFacility(params.get("facility") || "FAC-MAIN");
        const g = params.get("grain");
        if (g === "day" || g === "week" || g === "month") setGrain(g);
        if (params.get("replication"))
          setReplication(params.get("replication")!);
        if (params.get("patient"))
          setPatient({ patient_id: params.get("patient") });
      }
    }
  }, [summary.data]);
  const runQuery = useQuery({
    queryKey: ["run", run?.id],
    queryFn: () => api<RunGroup>(`/run-groups/${run?.id}`),
    enabled: !!run?.id,
    refetchInterval: (q) =>
      ["QUEUED", "RUNNING", "AGGREGATING", "CANCEL_REQUESTED"].includes(
        q.state.data?.status || run?.status || "",
      )
        ? document.hidden
          ? 10000
          : 2000
        : false,
  });
  useEffect(() => {
    if (runQuery.data) setRun(runQuery.data);
  }, [runQuery.data]);
  const metricsQuery = useQuery({
    queryKey: ["metrics", run?.id, run?.status, grain],
    queryFn: () =>
      api<Metrics>(`/run-groups/${run?.id}/metrics?grain=${grain}`),
    enabled: run?.status === "SUCCEEDED",
    staleTime: Infinity,
  });
  const stateQuery = useQuery({
    queryKey: [
      "run-state",
      activeReplicationId || run?.selected_replication_id,
      selectedTime,
    ],
    queryFn: () =>
      api(
        `/runs/${activeReplicationId || run?.selected_replication_id}/state?at=${encodeURIComponent(selectedTime)}`,
      ),
    enabled:
      !!(activeReplicationId || run?.selected_replication_id) &&
      run?.status === "SUCCEEDED",
    staleTime: Infinity,
  });
  const metrics = metricsQuery.data || null,
    state = stateQuery.data || null;
  const setPage = useCallback((p: PageId) => {
    setPageState(p);
    setMobileNav(false);
    const u = new URL(location.href);
    u.searchParams.set("view", p);
    history.replaceState({}, "", u);
  }, []);
  const setTime = useCallback((t: string) => setSelectedTime(t), []);
  const selectedDay = Math.max(
    0,
    localDayIndex(
      scenario?.start_at || dataset?.snapshot_at || selectedTime,
      selectedTime,
      scenario?.timezone || dataset?.timezone,
    ),
  );
  const setDay = useCallback(
    (d: number) =>
      setSelectedTime(
        atDay(
          scenario?.start_at || dataset?.snapshot_at || "2026-10-16T05:00:00Z",
          d,
          0,
          scenario?.timezone || dataset?.timezone,
        ),
      ),
    [
      scenario?.start_at,
      scenario?.timezone,
      dataset?.snapshot_at,
      dataset?.timezone,
    ],
  );
  const action = useCallback(
    async <T,>(name: string, f: () => Promise<T>): Promise<T | undefined> => {
      setBusy(name);
      setError(null);
      try {
        return await f();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setToastTone("error");
        setToast(message);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  const refresh = useCallback(async () => {
    const contextUrl = new URL(location.href);
    contextUrl.searchParams.delete("comparison");
    history.replaceState({}, "", contextUrl);
    const s = await api("/workspaces/workspace-main/summary");
    setDataset(s.dataset);
    setScenario(s.scenario);
    setRun(s.run_group || s.run || null);
    await queryClient.invalidateQueries({ queryKey: ["summary"] });
  }, [queryClient]);
  async function saveScenario(p: Entity) {
    return action("Saving scenario", async () => {
      if (p.__select) {
        const contextUrl = new URL(location.href);
        contextUrl.searchParams.delete("comparison");
        history.replaceState({}, "", contextUrl);
        const s = await api<Scenario>(`/scenarios/${p.__select}`);
        setScenario(s);
        setDataset(await api<Dataset>(`/datasets/${s.dataset_version_id}`));
        const summary = await api("/workspaces/workspace-main/summary");
        setRun(
          (summary.runs || []).find((r: Entity) => r.scenario_id === s.id) ||
            null,
        );
        setReplication("");
        setPatient(null);
        setSelectedTime(s.start_at);
        return s;
      }
      const s = scenario
        ? await patch<Scenario>(
            `/scenarios/${scenario.id}`,
            p,
            scenario.revision,
          )
        : await post<Scenario>("/scenarios", {
            ...p,
            dataset_version_id: dataset?.id,
          });
      setScenario(s);
      notify(
        "Scenario draft saved. Existing results retain their original revision.",
      );
      return s;
    });
  }
  async function openRun(id: string, target: PageId = "overview") {
    await action("Opening evaluated result", async () => {
      const r = await api<RunGroup>(`/run-groups/${id}`);
      const s = await api<Scenario>(`/scenarios/${r.scenario_id}`);
      setDataset(
        await api<Dataset>(
          `/datasets/${r.dataset_version_id || s.dataset_version_id}`,
        ),
      );
      setScenario(s);
      setRun(r);
      setReplication("");
      setPatient(null);
      setSelectedTime(r.start_at || s.start_at);
      setPage(target);
    });
  }
  async function runScenario(s?: Scenario) {
    await action("Submitting simulation", async () => {
      const chosen = s || scenario;
      if (!chosen)
        throw new Error("Load a dataset and create a scenario first.");
      const r = await post<RunGroup>("/run-groups", {
        scenario_id: chosen.id,
        replications: chosen.replications,
      });
      setRun(r);
      setReplication("");
      setPatient(null);
      setScenario(chosen);
      setSelectedTime(chosen.start_at);
      await queryClient.invalidateQueries({ queryKey: ["run"] });
      notify(
        "Simulation queued. Progress reflects completed patient-flow runs.",
      );
    });
  }
  async function loadDataset(fixture: string) {
    await action("Loading synthetic dataset", async () => {
      const contextUrl = new URL(location.href);
      contextUrl.searchParams.delete("comparison");
      history.replaceState({}, "", contextUrl);
      const d = ["planning_baseline", "stress_snapshot"].includes(fixture)
        ? await post<Dataset>("/demo-datasets", {
            fixture,
            seed: 41021,
            days: 365,
          })
        : await api<Dataset>(`/datasets/${fixture}`);
      setDataset(d);
      const s = await post<Scenario>("/scenarios", {
        name: "Respiratory surge — sustained +70%",
        dataset_version_id: d.id || d.dataset_version_id,
        start_at: d.snapshot_at,
        timezone: d.timezone,
        horizon_calendar_days: 30,
        base_seed: 20261016,
        replications: 100,
        conditions: [
          {
            id: "arrival-sustained",
            kind: "arrival_multiplier",
            entry_stream_id: "ED_MAIN",
            shape: "step",
            surge_percent: 70,
            control_points: [
              { at: d.snapshot_at, multiplier: 1.7 },
              { at: atDay(d.snapshot_at, 30), multiplier: 1.7 },
            ],
            source: "user_assumption",
          },
        ],
        interventions: [],
      });
      setScenario(s);
      setRun(null);
      setReplication("");
      setPatient(null);
      setFacility("FAC-MAIN");
      setSelectedTime(d.snapshot_at);
      notify("Dataset loaded. Scenario assumptions are ready to review.");
    });
  }
  const ctx: PlanningContext = {
    dataset,
    scenario,
    run,
    canWrite: user?.role !== "viewer",
    role: user?.role,
    activeReplicationId,
    setReplication,
    metrics,
    state,
    stateLoading: stateQuery.isFetching,
    stateError: stateQuery.error?.message || null,
    selectedTime,
    selectedDay,
    selectedFacility,
    selectedPatient,
    grain,
    loading: summary.isLoading,
    busy,
    error,
    page,
    setPage,
    setTime,
    setDay,
    setFacility,
    setPatient,
    setGrain,
    refresh,
    action,
    openRun,
    runScenario,
    saveScenario,
    loadDataset,
    notify,
  };
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setMobileNav(false);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const previousRunId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousRunId.current && previousRunId.current !== run?.id) {
      setReplication("");
      setPatient(null);
    }
    previousRunId.current = run?.id;
  }, [run?.id]);
  useEffect(() => {
    if (!dataset || !scenario) return;
    const u = new URL(location.href);
    u.searchParams.set("scenario", scenario.id);
    u.searchParams.set("dataset", dataset.id);
    u.searchParams.set("at", selectedTime);
    u.searchParams.set("facility", selectedFacility);
    u.searchParams.set("grain", grain);
    if (run?.id) u.searchParams.set("run", run.id);
    else u.searchParams.delete("run");
    if (activeReplicationId)
      u.searchParams.set("replication", activeReplicationId);
    else u.searchParams.delete("replication");
    if (selectedPatient)
      u.searchParams.set("patient", patientId(selectedPatient));
    else u.searchParams.delete("patient");
    history.replaceState({}, "", u);
  }, [
    dataset?.id,
    scenario?.id,
    run?.id,
    selectedTime,
    selectedFacility,
    grain,
    activeReplicationId,
    selectedPatient,
  ]);
  const active =
    run &&
    ["QUEUED", "RUNNING", "AGGREGATING", "CANCEL_REQUESTED"].includes(
      run.status,
    );
  const completed = Number(run?.replications_completed ?? run?.completed ?? 0),
    total = Number(run?.replications_requested ?? run?.total ?? 100);
  if (summary.error && (summary.error as ApiError).status === 401)
    return <Login onLogin={() => summary.refetch()} />;
  return (
    <div className="app-shell" data-role={user?.role}>
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <header className="topbar">
        <button
          className="mobile-menu"
          onClick={() => setMobileNav(!mobileNav)}
          aria-label="Toggle navigation"
        >
          <Menu size={22} />
        </button>
        <button className="brand" onClick={() => setPage("overview")}>
          <img src="/assets/mark.svg" alt="" />
          <span>
            HOSPITAL<span>SURGE PLANNER</span>
          </span>
        </button>
        <button className="hospital-selector" onClick={() => setPage("data")}>
          <Hospital size={18} />
          <span>
            {dataset?.facilities?.find((f) => f.facility_id === "FAC-MAIN")
              ?.name || "Central Hospital"}
            <small>Planning workspace</small>
          </span>
          <ChevronDown size={13} />
        </button>
        <div className="top-context">
          <span className="top-context-label">SCENARIO</span>
          <strong>
            {run?.comparison_id
              ? run.scenario_name || scenario?.name
              : scenario?.name || "Preparing workspace"}
          </strong>
          {dataset ? <Badge tone="warning">Synthetic dataset</Badge> : null}
          {user?.role === "viewer" ? <Badge>Read-only access</Badge> : null}
        </div>
        <div className="topbar-actions">
          <button
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
            aria-label="Search workspace"
          >
            <Search size={16} />
            <span>Search</span>
            <kbd>⌘ K</kbd>
          </button>
          <button
            className={`icon-button ${alertsOpen ? "active" : ""}`}
            onClick={() => setAlertsOpen(true)}
            aria-label="Planning alerts"
          >
            <Bell size={17} />
          </button>
          <button
            className="avatar"
            onClick={() => setAccountOpen(true)}
            aria-label="Account and workspace"
          >
            {user?.name?.slice(0, 2).toUpperCase() || "OP"}
          </button>
        </div>
      </header>
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="sidebar-section-label">PLAN & EXPLORE</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {page === n.id ? <i /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={page === "data" ? "active" : ""}
            onClick={() => setPage("data")}
          >
            <Database size={17} />
            <span>Data & setup</span>
          </button>
          <button onClick={() => setHelpOpen(true)}>
            <HelpCircle size={17} />
            <span>Planning guide</span>
            <ArrowUpRight size={13} />
          </button>
          <div className="workspace-status">
            <span className="status-dot" />
            <div>
              <strong>Workspace connected</strong>
              <small>
                {user?.role || "Planner"} ·{" "}
                {user?.local_session ? "Local planning" : "Planning workspace"}
              </small>
            </div>
          </div>
          <span className="sidebar-version">
            HOSPITAL SURGE PLANNER <b>1.0</b>
          </span>
        </div>
      </aside>
      <div className="workspace">
        <div className="contextbar">
          <div className="breadcrumb">
            <Layers size={13} />
            <span>Workspace</span>
            <ChevronRight size={11} />
            <strong>
              {nav.find((n) => n.id === page)?.name || "Data & setup"}
            </strong>
            <span className="context-divider" />
            <span>
              Dataset{" "}
              <b>{dataset?.fixture?.replaceAll("_", " ") || "loading"}</b>
            </span>
            {scenario?.revision ? (
              <span className="revision-tag">REV {scenario.revision}</span>
            ) : null}
          </div>
          <div className="context-actions">
            <span>
              <CalendarDays size={13} />
              {scenario
                ? `${localDate(scenario.start_at)} – ${localDate(atDay(scenario.start_at, scenario.horizon_calendar_days - 1, 0, scenario.timezone))}`
                : "—"}
            </span>
            <button
              title="Reset visual filters and selection"
              onClick={() => {
                setFacility("FAC-MAIN");
                setPatient(null);
                setGrain("day");
                setReplication("");
                setDay(0);
              }}
            >
              Reset view
            </button>
            <button
              onClick={() => setExportOpen(true)}
              disabled={!run || run.status !== "SUCCEEDED"}
            >
              <ArrowDownToLine size={13} />
              Export
            </button>
            <Button
              small
              primary
              disabled={
                user?.role === "viewer" || !!busy || !!active || !scenario
              }
              title={
                user?.role === "viewer"
                  ? "Viewer access is read-only"
                  : undefined
              }
              onClick={() => runScenario()}
            >
              {active ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Play size={12} />
              )}{" "}
              {active ? "Running" : "Run scenario"}
            </Button>
          </div>
        </div>
        {run?.comparison_id ? (
          <div className="evaluated-plan-banner">
            <GitCompareArrows size={13} />
            <span>
              Evaluated comparison plan:{" "}
              <strong>{run.scenario_name || "Saved alternative"}</strong> ·
              Results use its frozen resource assumptions.
            </span>
            <button
              onClick={() => {
                const u = new URL(location.href);
                u.searchParams.set("comparison", run.comparison_id);
                history.replaceState({}, "", u);
                setPage("compare");
              }}
            >
              Return to comparison <ArrowRight size={12} />
            </button>
          </div>
        ) : null}
        {stateQuery.error ? (
          <div className="global-error">
            <ErrorBox
              error={`Selected run state unavailable: ${stateQuery.error.message}`}
            />
            <Button small onClick={() => stateQuery.refetch()}>
              Retry state request
            </Button>
          </div>
        ) : null}
        {error || summary.error ? (
          <div className="global-error">
            <ErrorBox
              error={error || String(summary.error)}
              onDismiss={() => setError(null)}
            />
          </div>
        ) : null}
        {active ? (
          <div className="run-banner" role="status">
            <LoaderCircle size={15} className="spin" />
            <strong>
              {run.status === "AGGREGATING"
                ? "Aggregating computed outcomes"
                : "Simulating patient flow"}
            </strong>
            <span>
              {completed} of {total} runs complete
            </span>
            <div className="run-progress">
              <i
                style={{ width: `${total ? (completed / total) * 100 : 0}%` }}
              />
            </div>
            <button
              disabled={user?.role === "viewer"}
              onClick={() =>
                action("Cancelling run", async () => {
                  setRun(await post<RunGroup>(`/run-groups/${run.id}/cancel`));
                })
              }
            >
              Cancel
            </button>
          </div>
        ) : null}
        {run?.status === "SUCCEEDED" &&
        run.source_draft_revision &&
        scenario?.revision !== run.source_draft_revision ? (
          <div className="stale-banner">
            <span>
              Results are from saved revision {run.source_draft_revision}. The
              current draft has changes.
            </span>
            <button
              disabled={user?.role === "viewer"}
              onClick={() => runScenario()}
            >
              Rerun updated scenario <ArrowRight size={12} />
            </button>
          </div>
        ) : null}
        {stateQuery.isFetching && run?.status === "SUCCEEDED" ? (
          <div className="state-banner">
            <LoaderCircle className="spin" size={12} />
            Reconstructing selected run at{" "}
            {localDate(selectedTime, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            …
          </div>
        ) : null}
        {run?.status === "FAILED" ? (
          <div className="global-error">
            <ErrorBox
              error={`Simulation failed: ${run.error?.message || run.error || run.failure_message || run.failure_code || "See diagnostic details."}`}
            />
            <Button
              small
              disabled={user?.role === "viewer"}
              onClick={() =>
                action("Retrying run", async () =>
                  setRun(await post<RunGroup>(`/run-groups/${run.id}/retry`)),
                )
              }
            >
              Retry same inputs
            </Button>
          </div>
        ) : null}
        <main id="main-content" tabIndex={-1}>
          {summary.isLoading ? (
            <div className="workspace-loading">
              <Busy label="Preparing your planning workspace" />
              <p>
                Loading versioned datasets, resources, and scenario context.
              </p>
            </div>
          ) : dataset ? (
            <Suspense fallback={<Busy label="Opening workspace view" />}>
              {page === "overview" ? (
                <Overview ctx={ctx} onUpdate={() => setUpdateOpen(true)} />
              ) : page === "scenarios" ? (
                <Scenarios ctx={ctx} />
              ) : page === "patients" ? (
                <Patients ctx={ctx} onUpdate={() => setUpdateOpen(true)} />
              ) : page === "resources" ? (
                <Resources ctx={ctx} onUpdate={() => setUpdateOpen(true)} />
              ) : page === "compare" ? (
                <Compare ctx={ctx} />
              ) : page === "replay" ? (
                <Replay ctx={ctx} />
              ) : (
                <DataSetup ctx={ctx} />
              )}
            </Suspense>
          ) : (
            <div className="workspace-loading">
              <h1>Your hospital planning workspace</h1>
              <p>Generate the supplied synthetic dataset to begin planning.</p>
              <Button primary onClick={() => loadDataset("planning_baseline")}>
                Load planning dataset <ArrowRight size={16} />
              </Button>
            </div>
          )}
        </main>
        <footer className="statusbar">
          <span>
            <span className="status-dot" />{" "}
            {busy ||
              (active
                ? "Simulation worker active"
                : stateQuery.isFetching
                  ? "Reconstructing selected state"
                  : summary.error || stateQuery.error
                    ? "Connection requires attention"
                    : "Workspace connected")}
          </span>
          <span>
            {run?.status === "SUCCEEDED"
              ? `${completed} completed runs · Model ${run.model_version || "1.0"}`
              : "Versioned inputs · Reproducible simulation"}{" "}
            <b>·</b>{" "}
            {scenario?.timezone || dataset?.timezone || "America/Chicago"}
          </span>
          <button onClick={() => setHelpOpen(true)}>
            Assumptions & provenance <ArrowUpRight size={10} />
          </button>
        </footer>
      </div>
      {toast ? (
        <div
          className={`toast ${toastTone}`}
          role={toastTone === "error" ? "alert" : "status"}
        >
          {toastTone === "error" ? <X size={17} /> : <Check size={17} />}
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {busy ? (
        <div className="busy-pill" role="status">
          <LoaderCircle size={15} className="spin" />
          {busy}
        </div>
      ) : null}
      {searchOpen ? (
        <SearchDialog ctx={ctx} onClose={() => setSearchOpen(false)} />
      ) : null}
      {exportOpen ? (
        <ExportDialog ctx={ctx} onClose={() => setExportOpen(false)} />
      ) : null}
      {updateOpen ? (
        <UpdateDialog ctx={ctx} onClose={() => setUpdateOpen(false)} />
      ) : null}
      {alertsOpen ? (
        <AlertsDialog ctx={ctx} onClose={() => setAlertsOpen(false)} />
      ) : null}
      {helpOpen ? (
        <Modal
          title="Planning guide & model assumptions"
          wide
          onClose={() => setHelpOpen(false)}
        >
          <div className="guide-grid">
            <div>
              <span className="eyebrow">THE PLANNING LOOP</span>
              <h3>Configure → simulate → inspect → compare → update</h3>
              <p>
                Review your dataset, select a surge assumption, and run the
                patient-flow model. Inspect constrained time periods, compare
                feasible responses, and preserve changes as new revisions.
              </p>
              <h3>Understand the results</h3>
              <p>
                Forecast charts show the median and P10–P90 range across
                simulation runs. Patient views and replay show one explicitly
                selected run. Waiting patient-hours accumulate time awaiting
                suitable inpatient placement.
              </p>
              <h3>Resources work together</h3>
              <p>
                A place is usable only when it is installed, ready, and
                supported by qualified staff and compatible equipment.
                Outpatient spaces and shelter places have distinct capabilities.
              </p>
            </div>
            <div>
              <span className="eyebrow">DATA PROVENANCE</span>
              <h3>Synthetic planning dataset</h3>
              <p>
                Patients, facilities, staffing, capabilities, travel times, and
                stay assumptions are generated engineering fixtures. They can be
                inspected and edited through Data & setup.
              </p>
              <h3>Reproducible outcomes</h3>
              <p>
                Saved inputs, model version, random seeds, and completed runs
                stay linked. Updating assumptions creates a new forecast and
                preserves prior results.
              </p>
              <Button
                onClick={() => {
                  setHelpOpen(false);
                  setPage("data");
                }}
              >
                Inspect data and assumptions <ArrowRight size={14} />
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {adminOpen ? (
        <AdminDialog
          ctx={ctx}
          user={user || {}}
          onClose={() => setAdminOpen(false)}
        />
      ) : null}
      {accountOpen ? (
        <Modal
          title="Workspace & account"
          onClose={() => setAccountOpen(false)}
        >
          <dl className="detail-list">
            <div>
              <dt>User</dt>
              <dd>{user?.name}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{user?.role}</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>Hospital planning</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                {user?.local_session ? "Local development" : "Authenticated"}
              </dd>
            </div>
          </dl>
          <Button
            onClick={() => {
              setAccountOpen(false);
              setPage("data");
            }}
          >
            <Database size={15} />
            Manage datasets
          </Button>
          {user?.role === "admin" ? (
            <Button
              onClick={() => {
                setAccountOpen(false);
                setAdminOpen(true);
              }}
            >
              <Settings2 size={15} />
              Members & workspace policy
            </Button>
          ) : null}
          <Button
            onClick={() =>
              action("Signing out", async () => {
                await post("/auth/logout");
                location.reload();
              })
            }
          >
            <LogOut size={15} />
            Sign out
          </Button>
        </Modal>
      ) : null}
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState("");
  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/assets/mark.svg" alt="" />
        <span className="eyebrow">HOSPITAL SURGE PLANNER</span>
        <h1>Enter your planning workspace.</h1>
        <p>Model capacity. Understand pressure. Plan a response.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post("/auth/login", { email, username: email, password });
              onLogin();
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <label>
            Email or username
            <input
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error ? <ErrorBox error={error} /> : null}
          <Button primary type="submit">
            Sign in <ArrowRight size={16} />
          </Button>
        </form>
      </div>
    </div>
  );
}

function ExportDialog({
  ctx,
  onClose,
}: {
  ctx: PlanningContext;
  onClose: () => void;
}) {
  const [format, setFormat] = useState("zip"),
    [includeEvents, setIncludeEvents] = useState(true),
    [includeComparison, setIncludeComparison] = useState(
      !!new URLSearchParams(location.search).get("comparison"),
    ),
    [exportError, setExportError] = useState(""),
    [result, setResult] = useState<Entity | null>(null);
  useEffect(() => {
    if (
      !result?.id ||
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(result.status) ||
      result.download_url
    )
      return;
    const t = setInterval(
      () =>
        api(`/exports/${result.id}`)
          .then(setResult)
          .catch((e) => setExportError(e.message)),
      1500,
    );
    return () => clearInterval(t);
  }, [result?.id, result?.status]);
  return (
    <Modal title="Export a reproducible planning artifact" onClose={onClose}>
      <div className="form-stack">
        <p className="muted">
          Preserve the selected scenario, assumptions, computed metrics, and
          provenance.
        </p>
        <label>
          Export format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="zip">Complete planning package (.zip)</option>
            <option value="csv">Computed metrics (.csv)</option>
            <option value="json">Scenario and results (.json)</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={includeEvents}
            onChange={(e) => setIncludeEvents(e.target.checked)}
          />
          Include event trace for the selected simulation run
        </label>
        {new URLSearchParams(location.search).get("comparison") ? (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeComparison}
              onChange={(e) => setIncludeComparison(e.target.checked)}
            />
            Include the completed response comparison
          </label>
        ) : null}
        <div className="info-note">
          Includes model version, completed run count, seeds, time zone, units,
          and synthetic-data labels.
        </div>
        {exportError || result?.status === "FAILED" ? (
          <ErrorBox
            error={
              exportError ||
              result?.error ||
              "Export failed. Try generating a new package."
            }
          />
        ) : null}
        {result?.download_url ? (
          <a
            className="button primary"
            href={
              result.download_url.startsWith("/api")
                ? result.download_url
                : `/api${result.download_url}`
            }
          >
            Download export <ArrowDownToLine size={15} />
          </a>
        ) : (
          <Button
            primary
            disabled={
              !ctx.run || !!ctx.busy || (!!result && result.status !== "FAILED")
            }
            onClick={() =>
              ctx.action("Preparing export", async () =>
                setResult(
                  await post("/exports", {
                    run_group_id: ctx.run?.id,
                    scenario_id: ctx.scenario?.id,
                    format,
                    include_events: includeEvents,
                    replication_id:
                      ctx.activeReplicationId ||
                      ctx.run?.selected_replication_id,
                    comparison_id: includeComparison
                      ? new URLSearchParams(location.search).get("comparison")
                      : undefined,
                  }),
                ),
              )
            }
          >
            {result && result.status !== "FAILED"
              ? "Generating package…"
              : result?.status === "FAILED"
                ? "Retry export"
                : "Generate export"}{" "}
            <ArrowRight size={15} />
          </Button>
        )}
      </div>
    </Modal>
  );
}
