import {
  Menu as ActionMenu,
  NativeSelect,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
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
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
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
  UpdateTarget,
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
import HospitalResourceDetails from "./components/HospitalResourceDetails";
import Login from "./components/Login";
import type { LogoOrigin } from "./components/Login";
import AegisLogo from "./components/AegisLogo";
import BrandTransition from "./components/BrandTransition";
import { resourceFacility } from "./entityLocation";
import {
  destination,
  isAnalysisPage,
  readNavigation,
  writeNavigation,
} from "./navigation";
import type { AnalysisPage, AnalyticsSection } from "./navigation";
import "./workspaceFlow.css";
import {
  actualInventory,
  searchEntityId,
  type SearchKind,
} from "./components/workspaceSearch";
const Summary = lazy(() => import("./pages/Overview")),
  PlanningOverview = lazy(() => import("./pages/PlanningOverview")),
  Analytics = lazy(() => import("./pages/Analytics")),
  Scenarios = lazy(() => import("./pages/Scenarios")),
  Compare = lazy(() => import("./pages/Compare")),
  Replay = lazy(() => import("./pages/Replay")),
  DataSetup = lazy(() => import("./pages/DataSetup"));
const analysisNav = [
  { id: "summary", name: "Summary", icon: Map },
  { id: "replay", name: "Replay", icon: Play },
  { id: "analytics", name: "Analytics", icon: Activity },
  { id: "comparison", name: "Comparison", icon: GitCompareArrows },
] as const;
export default function App() {
  const queryClient = useQueryClient();
  const [brandOrigin, setBrandOrigin] = useState<LogoOrigin | null>(null);
  const brandLogo = useRef<SVGSVGElement>(null);
  const finishBrandTransition = useCallback(() => {
    setBrandOrigin(null);
    requestAnimationFrame(() =>
      brandLogo.current?.closest("button")?.focus({ preventScroll: true }),
    );
  }, []);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem("hospital-navigation-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleNavigation = () =>
    setNavCollapsed((value) => {
      try {
        localStorage.setItem("hospital-navigation-collapsed", String(!value));
      } catch {
        /* Preference storage is optional. */
      }
      return !value;
    });
  const [route, setRoute] = useState(() =>
    readNavigation(new URLSearchParams(location.search)),
  );
  const { page, section: analyticsSection } = route;
  const lastAnalysisPage = useRef<AnalysisPage>(
    isAnalysisPage(page) ? page : "summary",
  );
  const [restoringLocation, setRestoringLocation] = useState(false);
  const historyRequest = useRef(0);
  const [comparisonSelection, setComparisonSelection] = useState<
    string | null | undefined
  >(() => new URLSearchParams(location.search).get("comparison") || undefined);
  const [comparisonVisited, setComparisonVisited] = useState(
    page === "comparison",
  );
  const [overviewVisited, setOverviewVisited] = useState(page === "overview");
  const [dataset, setDatasetState] = useState<Dataset | null>(null),
    [draftDataset, setDraftDataset] = useState<Dataset | null>(null),
    [scenario, setScenario] = useState<Scenario | null>(null),
    [run, setRun] = useState<RunGroup | null>(null),
    [selectedTime, setSelectedTime] = useState("2026-10-16T05:00:00Z"),
    [selectedFacility, setFacilityState] = useState("FAC-MAIN"),
    [selectedPatient, setPatient] = useState<Entity | null>(null),
    [selectedUnit, setSelectedUnit] = useState(""),
    [selectedResource, setSelectedResource] = useState<{
      kind: string;
      id: string;
    } | null>(null),
    [grain, setGrain] = useState<Grain>("day"),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [toast, setToast] = useState(""),
    [toastTone, setToastTone] = useState("success"),
    [searchOpen, setSearchOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [updateOpen, setUpdateOpen] = useState(false),
    [updateTarget, setUpdateTarget] = useState<UpdateTarget | null>(null),
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
    setDraftDataset(value);
    setSelectedUnit("");
    setSelectedResource(null);
  }, []);
  const setFacility = useCallback((value: string) => {
    setFacilityState(value);
    setPatient(null);
    setSelectedUnit("");
    setSelectedResource(null);
  }, []);
  const setUnit = useCallback((id: string) => {
    setSelectedUnit(id);
    setPatient(null);
    setSelectedResource(null);
  }, []);
  const clearResource = useCallback(() => setSelectedResource(null), []);
  const openUpdate = (target?: UpdateTarget) => {
    setUpdateTarget(target || null);
    setUpdateOpen(true);
  };
  const summary = useQuery({
    queryKey: ["summary"],
    queryFn: async () => {
      const params = new URLSearchParams(location.search);
      const selection = new URLSearchParams();
      if (params.get("scenario"))
        selection.set("scenario_id", params.get("scenario")!);
      if (params.get("run")) selection.set("run_group_id", params.get("run")!);
      const [s] = await Promise.all([
        api(
          `/workspaces/workspace-main/summary${selection.size ? `?${selection}` : ""}`,
        ),
        api("/me").then((user) => {
          setUser(user);
          return user;
        }),
      ]);
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
      setDraftDataset(summary.data.draft_dataset || d);
      setScenario(summary.data.scenario);
      setRun(summary.data.run_group || summary.data.run || null);
      if (d?.snapshot_at) {
        const params = new URLSearchParams(location.search);
        setSelectedTime(params.get("at") || d.snapshot_at);
        const initialUnit = d.units?.find(
          (value: Entity) => value.unit_id === params.get("unit"),
        );
        setFacility(
          initialUnit?.facility_id || params.get("facility") || "FAC-MAIN",
        );
        if (params.get("unit")) setUnit(params.get("unit")!);
        if (params.get("resource") && params.get("resource_type"))
          setSelectedResource({
            kind: params.get("resource_type")!,
            id: params.get("resource")!,
          });
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
    // Retain panels while changing chart grain, only for the same frozen run.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === run?.id ? previous : undefined,
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
      page !== "overview" &&
      !!(activeReplicationId || run?.selected_replication_id) &&
      run?.status === "SUCCEEDED",
    staleTime: Infinity,
  });
  const metrics =
      run?.status === "SUCCEEDED" ? metricsQuery.data || null : null,
    state = run?.status === "SUCCEEDED" ? stateQuery.data || null : null;
  const displayedGrain: Grain =
    metricsQuery.isPlaceholderData &&
    ["day", "week", "month"].includes(metrics?.context?.grain)
      ? metrics!.context.grain
      : grain;
  const resultScenario = run?.scenario_context || scenario;
  const editingContext = ["overview", "comparison", "data"].includes(page);
  const presentationScenario = editingContext ? scenario : resultScenario;
  const inspectionDataset = editingContext ? draftDataset || dataset : dataset;
  const draftDatasetDiffers =
    editingContext && inspectionDataset?.id !== dataset?.id;
  const inspectionState =
    inspectionDataset?.id === dataset?.id &&
    !stateQuery.isFetching &&
    !stateQuery.error
      ? state
      : null;
  setPresentationTimezone(
    presentationScenario?.timezone ||
      inspectionDataset?.timezone ||
      "America/Chicago",
  );
  const setPage = useCallback(
    (p: PageId) => {
      ++historyRequest.current;
      setRestoringLocation(false);
      const next = destination(p, analyticsSection);
      setRoute(next);
      setMobileNav(false);
      if (isAnalysisPage(next.page)) lastAnalysisPage.current = next.page;
      if (next.page === "comparison") setComparisonVisited(true);
      if (next.page === "overview") setOverviewVisited(true);
      const url = writeNavigation(new URL(location.href), next);
      if (url.href !== location.href) history.pushState({}, "", url);
    },
    [analyticsSection],
  );
  const setAnalyticsSection = useCallback((section: AnalyticsSection) => {
    ++historyRequest.current;
    setRestoringLocation(false);
    const next = { page: "analytics" as const, section };
    setRoute(next);
    lastAnalysisPage.current = "analytics";
    const url = writeNavigation(new URL(location.href), next);
    if (url.href !== location.href) history.pushState({}, "", url);
  }, []);
  const setTime = useCallback((t: string) => setSelectedTime(t), []);
  const selectedDay = Math.max(
    0,
    localDayIndex(
      presentationScenario?.start_at ||
        inspectionDataset?.snapshot_at ||
        selectedTime,
      selectedTime,
      presentationScenario?.timezone || inspectionDataset?.timezone,
    ),
  );
  const setDay = useCallback(
    (d: number) =>
      setSelectedTime(
        atDay(
          presentationScenario?.start_at ||
            inspectionDataset?.snapshot_at ||
            "2026-10-16T05:00:00Z",
          d,
          0,
          presentationScenario?.timezone || inspectionDataset?.timezone,
        ),
      ),
    [
      presentationScenario?.start_at,
      presentationScenario?.timezone,
      inspectionDataset?.snapshot_at,
      inspectionDataset?.timezone,
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
    setComparisonSelection(null);
    const contextUrl = new URL(location.href);
    contextUrl.searchParams.delete("comparison");
    history.replaceState({}, "", contextUrl);
    const s = await api("/workspaces/workspace-main/summary");
    setDataset(s.dataset);
    setDraftDataset(s.draft_dataset || s.dataset);
    setScenario(s.scenario);
    setRun(s.run_group || s.run || null);
    setReplication("");
    setPatient(null);
    await queryClient.invalidateQueries({ queryKey: ["summary"] });
  }, [queryClient]);
  async function saveScenario(p: Entity) {
    return action("Saving scenario", async () => {
      if (p.__select) {
        setComparisonSelection(null);
        const contextUrl = new URL(location.href);
        contextUrl.searchParams.delete("comparison");
        history.replaceState({}, "", contextUrl);
        const selected = await api(
          `/workspaces/workspace-main/summary?scenario_id=${encodeURIComponent(p.__select)}`,
        );
        const s = selected.scenario as Scenario;
        setDataset(selected.dataset);
        setDraftDataset(selected.draft_dataset || selected.dataset);
        setScenario(s);
        setRun(selected.run_group || selected.run || null);
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
  async function openRun(id: string, target: PageId = "summary") {
    await action("Opening evaluated result", async () => {
      const selected = await api(
        `/workspaces/workspace-main/summary?run_group_id=${encodeURIComponent(id)}`,
      );
      const r = (selected.run_group || selected.run) as RunGroup;
      const s = selected.scenario as Scenario;
      setDataset(selected.dataset);
      setDraftDataset(selected.draft_dataset || selected.dataset);
      setScenario(s);
      setRun(r);
      setSelectedResource(null);
      setSelectedUnit("");
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
      if (dataset?.id !== chosen.dataset_version_id) {
        const selected = await api(
          `/workspaces/workspace-main/summary?run_group_id=${encodeURIComponent(r.id)}`,
        );
        setDataset(selected.dataset);
        setDraftDataset(selected.draft_dataset || selected.dataset);
      }
      setRun(r);
      setSelectedResource(null);
      setSelectedUnit("");
      setReplication("");
      setPatient(null);
      setScenario(chosen);
      setSelectedTime(chosen.start_at);
      setPage("summary");
      await queryClient.invalidateQueries({ queryKey: ["run"] });
      notify(
        "Simulation queued. Progress reflects completed patient-flow runs.",
      );
    });
  }
  async function loadDataset(fixture: string) {
    await action("Loading hospital baseline", async () => {
      setComparisonSelection(null);
      const contextUrl = new URL(location.href);
      contextUrl.searchParams.delete("comparison");
      history.replaceState({}, "", contextUrl);
      const d = [
        "hospital_baseline",
        "planning_baseline",
        "stress_snapshot",
      ].includes(fixture)
        ? await post<Dataset>("/demo-datasets", {
            fixture,
            seed: 41021,
            days: 365,
          })
        : await api<Dataset>(`/datasets/${fixture}`);
      setDataset(d);
      const s = await post<Scenario>("/scenarios", {
        name: "New simulation",
        dataset_version_id: d.id || d.dataset_version_id,
        start_at: d.snapshot_at,
        timezone: d.timezone,
        horizon_calendar_days: 7,
        base_seed: 20261016,
        replications: 10,
        conditions: [],
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
  const inspectEntity = useCallback(
    (kind: string, id: string) => {
      if (!inspectionDataset) return;
      const prepareInspection = () => {
        if (inspectionDataset.id !== dataset?.id) {
          setRun(null);
          setReplication("");
          setDataset(inspectionDataset);
          setSelectedTime(inspectionDataset.snapshot_at);
        }
      };
      if (kind === "unit") {
        const unit = actualInventory(
          "unit",
          inspectionDataset.units,
          inspectionState?.units,
        ).find((value) => (value.unit_id || value.id) === id);
        if (!unit) return;
        prepareInspection();
        setFacilityState(unit.facility_id);
        setUnit(id);
        setPage("patients");
        return;
      }
      if (kind === "facility") {
        prepareInspection();
        setFacility(id);
        setPage("summary");
        return;
      }
      if (kind === "route" || kind === "update") {
        prepareInspection();
        setPatient(null);
        setSelectedUnit("");
        setSelectedResource({ kind, id });
        return;
      }
      const inventory: Record<string, Entity[]> = {
        staff: inspectionDataset.staff || [],
        equipment_pool: inspectionDataset.equipment_pools || [],
        vehicle: inspectionDataset.vehicles || [],
        slot: inspectionDataset.slots || [],
      };
      const identity: Record<string, string> = {
        staff: "staff_id",
        equipment_pool: "equipment_pool_id",
        vehicle: "vehicle_id",
        slot: "slot_id",
      };
      const stateTable: Record<string, string> = {
        staff: "staff",
        equipment_pool: "equipment_pools",
        vehicle: "vehicles",
        slot: "slots",
      };
      const row = identity[kind]
        ? actualInventory(
            kind as SearchKind,
            inventory[kind],
            inspectionState?.[stateTable[kind]],
          ).find((value) => searchEntityId(kind as SearchKind, value) === id)
        : undefined;
      if (!row) return;
      prepareInspection();
      const facility = resourceFacility(
        kind,
        id,
        row,
        inspectionDataset.units || [],
        inspectionState?.units || [],
      );
      if (facility) setFacilityState(facility);
      setPatient(null);
      setSelectedUnit("");
      setSelectedResource({ kind, id });
    },
    [
      dataset?.id,
      inspectionDataset,
      inspectionState,
      setDataset,
      setFacility,
      setPage,
      setUnit,
    ],
  );
  const ctx: PlanningContext = {
    dataset: editingContext ? draftDataset || dataset : dataset,
    scenario,
    resultScenario: editingContext ? null : resultScenario,
    run: page === "overview" || draftDatasetDiffers ? null : run,
    canWrite: user?.role !== "viewer",
    role: user?.role,
    activeReplicationId:
      page === "overview" || draftDatasetDiffers ? "" : activeReplicationId,
    setReplication,
    metrics: page === "overview" || draftDatasetDiffers ? null : metrics,
    metricsLoading: run?.status === "SUCCEEDED" && metricsQuery.isFetching,
    metricsError: metricsQuery.error?.message || null,
    retryMetrics: () => {
      void metricsQuery.refetch();
    },
    state:
      page === "overview" ? null : editingContext ? inspectionState : state,
    stateLoading:
      page !== "overview" && !draftDatasetDiffers && stateQuery.isFetching,
    stateError:
      page === "overview" || draftDatasetDiffers
        ? null
        : stateQuery.error?.message || null,
    selectedTime:
      page === "overview"
        ? inspectionDataset?.snapshot_at || selectedTime
        : selectedTime,
    selectedDay: page === "overview" ? 0 : selectedDay,
    selectedFacility,
    selectedPatient,
    selectedUnit,
    selectedResource,
    grain: displayedGrain,
    loading: summary.isLoading,
    busy,
    error,
    page,
    setPage,
    setTime,
    setDay,
    setFacility,
    setPatient: (patient) => {
      if (patient && draftDatasetDiffers && inspectionDataset) {
        setRun(null);
        setReplication("");
        setDataset(inspectionDataset);
        setSelectedTime(inspectionDataset.snapshot_at);
      }
      setPatient(patient);
    },
    setUnit,
    inspectEntity,
    clearResource,
    setGrain,
    refresh,
    action,
    openRun,
    runScenario,
    saveScenario,
    loadDataset,
    notify,
  };
  // Global result tools use the selected frozen run even while Overview shows
  // the source baseline and an independently editable scenario draft.
  const resultToolsCtx: PlanningContext = {
    ...ctx,
    dataset,
    run,
    metrics,
    state,
    selectedTime,
    selectedDay,
    resultScenario,
    activeReplicationId,
    stateLoading: stateQuery.isFetching,
    stateError: stateQuery.error?.message || null,
  };
  useEffect(() => {
    document.title =
      summary.error && (summary.error as ApiError).status === 401
        ? "Sign in | AEGIS"
        : `${page === "overview" ? "Configuration" : page === "data" ? "Data & setup" : `Analysis · ${analysisNav.find((item) => item.id === page)?.name}`} | AEGIS`;
    document.getElementById("main-content")?.scrollTo({ top: 0 });
  }, [page, analyticsSection, summary.error]);
  useEffect(() => {
    async function restoreHistory() {
      const request = ++historyRequest.current;
      const params = new URLSearchParams(location.search);
      const next = readNavigation(params);
      setRestoringLocation(true);
      try {
        let restoredDataset = dataset;
        let restoredScenario = scenario;
        if (
          params.get("scenario") !== scenario?.id ||
          params.get("run") !== (run?.id || null)
        ) {
          const selection = new URLSearchParams();
          if (params.get("scenario"))
            selection.set("scenario_id", params.get("scenario")!);
          if (params.get("run"))
            selection.set("run_group_id", params.get("run")!);
          const selected = await api(
            `/workspaces/workspace-main/summary${selection.size ? `?${selection}` : ""}`,
          );
          if (request !== historyRequest.current) return;
          restoredDataset = selected.dataset;
          restoredScenario = selected.scenario;
          setDataset(selected.dataset);
          setDraftDataset(selected.draft_dataset || selected.dataset);
          setScenario(selected.scenario);
          setRun(
            params.get("run")
              ? selected.run_group || selected.run || null
              : null,
          );
        }
        if (request !== historyRequest.current) return;
        setRoute(next);
        if (isAnalysisPage(next.page)) lastAnalysisPage.current = next.page;
        if (next.page === "comparison") setComparisonVisited(true);
        if (next.page === "overview") setOverviewVisited(true);
        setComparisonSelection(params.get("comparison"));
        setMobileNav(false);
        setSelectedTime(
          params.get("at") ||
            restoredScenario?.start_at ||
            restoredDataset?.snapshot_at ||
            "2026-10-16T05:00:00Z",
        );
        setFacilityState(params.get("facility") || "FAC-MAIN");
        setReplication(params.get("replication") || "");
        setPatient(
          params.get("patient") ? { patient_id: params.get("patient") } : null,
        );
        setSelectedUnit(params.get("unit") || "");
        setSelectedResource(
          params.get("resource") && params.get("resource_type")
            ? {
                id: params.get("resource")!,
                kind: params.get("resource_type")!,
              }
            : null,
        );
        const value = params.get("grain");
        setGrain(value === "week" || value === "month" ? value : "day");
      } catch (failure) {
        if (request === historyRequest.current)
          setError(
            `Could not restore workspace: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
      } finally {
        if (request === historyRequest.current) setRestoringLocation(false);
      }
    }
    window.addEventListener("popstate", restoreHistory);
    return () => window.removeEventListener("popstate", restoreHistory);
  }, [dataset, scenario?.id, run?.id, setDataset]);
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
  useEffect(() => {
    if (!dataset || !scenario || restoringLocation) return;
    const u = writeNavigation(new URL(location.href), route);
    u.searchParams.set("scenario", scenario.id);
    u.searchParams.set("dataset", inspectionDataset?.id || dataset.id);
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
    if (selectedUnit) u.searchParams.set("unit", selectedUnit);
    else u.searchParams.delete("unit");
    if (selectedResource) {
      u.searchParams.set("resource", selectedResource.id);
      u.searchParams.set("resource_type", selectedResource.kind);
    } else {
      u.searchParams.delete("resource");
      u.searchParams.delete("resource_type");
    }
    history.replaceState({}, "", u);
  }, [
    dataset?.id,
    inspectionDataset?.id,
    scenario?.id,
    run?.id,
    selectedTime,
    selectedFacility,
    grain,
    activeReplicationId,
    selectedPatient,
    selectedUnit,
    selectedResource,
    route,
    restoringLocation,
  ]);
  const active =
    run &&
    ["QUEUED", "RUNNING", "AGGREGATING", "CANCEL_REQUESTED"].includes(
      run.status,
    );
  const completed = Number(run?.replications_completed ?? run?.completed ?? 0),
    total = Number(run?.replications_requested ?? run?.total ?? 100);
  const brandTransition = brandOrigin ? (
    <BrandTransition
      origin={brandOrigin}
      ready={!summary.error && Boolean(summary.data && user)}
      destinationRef={brandLogo}
      onComplete={finishBrandTransition}
    />
  ) : null;
  if (summary.error && (summary.error as ApiError).status === 401)
    return (
      <>
        <Login
          blocked={Boolean(brandOrigin)}
          onLogin={async (origin) => {
            setBrandOrigin(origin);
            const result = await summary.refetch();
            if (result.error) {
              setBrandOrigin(null);
              throw result.error;
            }
          }}
        />
        {brandTransition}
      </>
    );
  const needsForecastMetrics =
    run?.status === "SUCCEEDED" && !metrics && page === "summary";
  return (
    <>
      <div
        className={`app-shell${navCollapsed ? " navigation-collapsed" : ""}`}
        data-role={user?.role}
        inert={Boolean(brandOrigin)}
      >
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
          <button
            className="brand aegis-brand"
            data-brand-pending={brandOrigin ? "true" : undefined}
            onClick={() => setPage("overview")}
            aria-label="AEGIS home"
          >
            <AegisLogo
              ref={brandLogo}
              variant="symbol"
              decorative={false}
              className="aegis-header-logo"
            />
          </button>
          <Tooltip
            label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <button
              className="desktop-nav-toggle icon-button"
              onClick={toggleNavigation}
              aria-label={
                navCollapsed ? "Expand navigation" : "Collapse navigation"
              }
              aria-expanded={!navCollapsed}
              aria-controls="workspace-navigation"
            >
              {navCollapsed ? (
                <PanelLeftOpen size={19} />
              ) : (
                <PanelLeftClose size={19} />
              )}
            </button>
          </Tooltip>
          <div className="hospital-selector">
            <Hospital size={18} />
            <span>
              {inspectionDataset?.facilities
                ?.find((f) => f.facility_id === "FAC-MAIN")
                ?.name?.replace(/^Demo /, "") || "Central Hospital"}
              <small>Planning workspace</small>
            </span>
          </div>
          <div className="top-context">
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
        <aside
          id="workspace-navigation"
          className={`sidebar ${mobileNav ? "open" : ""}`}
          aria-label="Workspace navigation"
        >
          <div className="sidebar-section-label">WORKSPACE</div>
          <nav aria-label="Main navigation">
            <UnstyledButton
              title={navCollapsed ? "Configuration" : undefined}
              aria-label="Configuration"
              className={page === "overview" ? "active" : ""}
              aria-current={page === "overview" ? "page" : undefined}
              onClick={() => setPage("overview")}
            >
              <Hospital size={18} />
              <span>Configuration</span>
              {page === "overview" ? <i /> : null}
            </UnstyledButton>
            <UnstyledButton
              title={navCollapsed ? "Analysis" : undefined}
              aria-label="Analysis"
              className={isAnalysisPage(page) ? "active" : ""}
              aria-current={isAnalysisPage(page) ? "page" : undefined}
              onClick={() => setPage(lastAnalysisPage.current)}
            >
              <Activity size={18} />
              <span>Analysis</span>
              {isAnalysisPage(page) ? <i /> : null}
            </UnstyledButton>
          </nav>
          <div className="sidebar-bottom">
            <button
              aria-label="Data & setup"
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
          </div>
        </aside>
        <div className="workspace">
          <div className="contextbar">
            <div className="breadcrumb">
              <span className="context-label">
                {page === "comparison"
                  ? "Draft scenario"
                  : isAnalysisPage(page)
                    ? "Results for"
                    : "Scenario"}
              </span>
              <strong title={presentationScenario?.name}>
                {presentationScenario?.name || "Hospital planning"}
              </strong>
            </div>
            <div className="context-actions">
              <span className="context-date" hidden={page === "comparison"}>
                <CalendarDays size={14} />
                {presentationScenario
                  ? `${localDate(presentationScenario.start_at)} – ${localDate(atDay(presentationScenario.start_at, presentationScenario.horizon_calendar_days - 1, 0, presentationScenario.timezone))}`
                  : "—"}
              </span>
              {isAnalysisPage(page) ? (
                <Button small onClick={() => setPage("overview")}>
                  <SlidersHorizontal size={13} /> Edit scenario
                </Button>
              ) : null}
              <ActionMenu position="bottom-end" shadow="md" width={225}>
                <ActionMenu.Target>
                  <button
                    className="icon-button"
                    aria-label="Workspace options"
                  >
                    <MoreHorizontal size={20} />
                    <span className="context-more-label">More</span>
                  </button>
                </ActionMenu.Target>
                <ActionMenu.Dropdown>
                  <ActionMenu.Label>Workspace tools</ActionMenu.Label>
                  <ActionMenu.Item
                    leftSection={<ArrowDownToLine size={15} />}
                    disabled={!run || run.status !== "SUCCEEDED"}
                    onClick={() => setExportOpen(true)}
                  >
                    Export results
                  </ActionMenu.Item>
                  <ActionMenu.Item
                    leftSection={<Layers size={15} />}
                    onClick={() => {
                      setFacility("FAC-MAIN");
                      setPatient(null);
                      setGrain("day");
                      setReplication("");
                      setDay(0);
                    }}
                  >
                    Reset view
                  </ActionMenu.Item>
                  <ActionMenu.Item
                    leftSection={<Database size={15} />}
                    onClick={() => setPage("data")}
                  >
                    Data &amp; setup
                  </ActionMenu.Item>
                  <ActionMenu.Divider />
                  <ActionMenu.Item
                    leftSection={<HelpCircle size={15} />}
                    onClick={() => setHelpOpen(true)}
                  >
                    Assumptions &amp; model details
                  </ActionMenu.Item>
                </ActionMenu.Dropdown>
              </ActionMenu>
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
                  setComparisonSelection(run.comparison_id);
                  setPage("compare");
                }}
              >
                Return to comparison <ArrowRight size={12} />
              </button>
            </div>
          ) : null}
          {page !== "overview" && stateQuery.error ? (
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
                {run.status === "CANCEL_REQUESTED"
                  ? "Cancelling simulation"
                  : run.status === "AGGREGATING"
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
                disabled={
                  user?.role === "viewer" ||
                  run.status === "CANCEL_REQUESTED" ||
                  !!busy
                }
                onClick={() =>
                  action("Cancelling run", async () => {
                    setRun(
                      await post<RunGroup>(`/run-groups/${run.id}/cancel`),
                    );
                  })
                }
              >
                {run.status === "CANCEL_REQUESTED"
                  ? "Cancellation requested"
                  : "Cancel"}
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
              {page !== "overview" ? (
                <button
                  disabled={user?.role === "viewer"}
                  onClick={() => runScenario()}
                >
                  Rerun updated scenario <ArrowRight size={12} />
                </button>
              ) : null}
            </div>
          ) : null}
          {run?.status === "FAILED" || run?.status === "CANCELLED" ? (
            <div className="global-error">
              {run.status === "CANCELLED" ? (
                <div className="info-note" role="status">
                  <strong>Simulation cancelled.</strong> {completed} of {total}{" "}
                  replications were saved. No completed forecast is available.
                  Retry uses the same frozen inputs and seeds.
                  <small className="mono"> Run {run.id}</small>
                </div>
              ) : (
                <ErrorBox
                  error={`Simulation failed: ${run.error?.message || run.error || run.failure_message || run.failure_code || "See diagnostic details."} · Run ${run.id}`}
                />
              )}
              <Button
                small
                disabled={user?.role === "viewer" || !!busy}
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
          {isAnalysisPage(page) ? (
            <div className="analysis-bar">
              <nav aria-label="Analysis navigation">
                {analysisNav.map((item) => (
                  <button
                    key={item.id}
                    aria-current={page === item.id ? "page" : undefined}
                    className={page === item.id ? "active" : ""}
                    onClick={() => setPage(item.id)}
                  >
                    <item.icon size={15} />
                    <span>{item.name}</span>
                  </button>
                ))}
              </nav>
              <div
                className="analysis-run-context"
                aria-label="Selected analysis run"
              >
                <span className={`status-dot${active ? " running" : ""}`} />
                <span>
                  {run
                    ? `${completed} / ${total} runs · ${run.status.toLowerCase().replaceAll("_", " ")}`
                    : "No simulation selected"}
                </span>
                {run?.source_draft_revision ? (
                  <small>REV {run.source_draft_revision}</small>
                ) : null}
              </div>
            </div>
          ) : null}
          <main
            id="main-content"
            tabIndex={-1}
            aria-busy={
              restoringLocation ||
              summary.isLoading ||
              (needsForecastMetrics && !metricsQuery.error)
            }
          >
            {summary.isLoading ? (
              <div className="workspace-loading">
                <Busy label="Preparing your planning workspace" />
                <p>
                  Loading versioned datasets, resources, and scenario context.
                </p>
              </div>
            ) : dataset ? (
              <Suspense fallback={<Busy label="Opening workspace view" />}>
                {overviewVisited ? (
                  <div
                    className="workspace-view planning-view"
                    hidden={page !== "overview"}
                  >
                    <PlanningOverview
                      ctx={{ ...ctx, dataset: draftDataset || dataset, run }}
                      configuration={
                        <Scenarios
                          ctx={{
                            ...ctx,
                            dataset: draftDataset || dataset,
                            run: null,
                            metrics: null,
                            state: null,
                            stateLoading: false,
                            stateError: null,
                            resultScenario: null,
                            selectedTime: (draftDataset || dataset).snapshot_at,
                            selectedDay: 0,
                            busy: active ? "Simulation in progress" : busy,
                          }}
                        />
                      }
                      onInspectBaseline={() => setPage("data")}
                      onOpenAnalysis={() => setPage("summary")}
                    />
                  </div>
                ) : null}
                {needsForecastMetrics ? (
                  <div
                    className="analysis-empty"
                    role={metricsQuery.error ? "alert" : "status"}
                  >
                    {metricsQuery.error ? (
                      <Activity size={30} />
                    ) : (
                      <LoaderCircle size={30} className="spin" />
                    )}
                    <h1>
                      {metricsQuery.error
                        ? "Forecast results unavailable"
                        : "Loading forecast results"}
                    </h1>
                    <p>
                      {metricsQuery.error
                        ? "The simulation is saved, but its forecast could not be loaded. Retry to retrieve the recorded results."
                        : "Retrieving occupancy, waiting, and uncertainty from the completed simulation."}
                    </p>
                    {metricsQuery.error ? (
                      <Button primary onClick={() => metricsQuery.refetch()}>
                        Retry results
                      </Button>
                    ) : null}
                  </div>
                ) : page === "summary" ? (
                  run?.status === "SUCCEEDED" ? (
                    <Summary ctx={ctx} onUpdate={() => openUpdate()} />
                  ) : (
                    <div className="analysis-empty">
                      {active ? (
                        <LoaderCircle size={32} className="spin" />
                      ) : (
                        <Activity size={32} />
                      )}
                      <span className="eyebrow">ANALYSIS · SUMMARY</span>
                      <h1>
                        {active
                          ? "Your simulation is running"
                          : run
                            ? "Simulation needs attention"
                            : "Your analysis starts here"}
                      </h1>
                      <p>
                        {active
                          ? "Computed outcomes will appear here as soon as all runs finish. You can continue reviewing your baseline while the simulation runs."
                          : "Configure your hospital scenario in Configuration and run a simulation to explore its results, replay, and analytics."}
                      </p>
                      <Button primary onClick={() => setPage("overview")}>
                        Go to Configuration <ArrowRight size={15} />
                      </Button>
                    </div>
                  )
                ) : page === "analytics" ? (
                  <Analytics
                    ctx={ctx}
                    section={analyticsSection}
                    onSectionChange={setAnalyticsSection}
                    onUpdate={openUpdate}
                  />
                ) : page === "replay" ? (
                  <Replay ctx={ctx} />
                ) : page === "data" ? (
                  <DataSetup ctx={ctx} />
                ) : null}
                {comparisonVisited ? (
                  <div
                    className="workspace-view comparison-view"
                    hidden={page !== "comparison"}
                  >
                    <Compare
                      key={scenario?.id}
                      comparisonId={comparisonSelection}
                      onComparisonSelect={setComparisonSelection}
                      ctx={{
                        ...ctx,
                        dataset: draftDataset || dataset,
                        resultScenario: null,
                      }}
                    />
                  </div>
                ) : null}
              </Suspense>
            ) : (
              <div className="workspace-loading">
                <h1>Your hospital planning workspace</h1>
                <p>Load the hospital baseline to begin planning.</p>
                <Button
                  primary
                  onClick={() => loadDataset("hospital_baseline")}
                >
                  Load planning dataset <ArrowRight size={16} />
                </Button>
              </div>
            )}
            {restoringLocation ? (
              <div className="history-loading">
                <Busy label="Opening saved workspace context" />
              </div>
            ) : null}
          </main>
          <footer className="statusbar">
            <span>
              <span className="status-dot" />{" "}
              {busy ||
                (active
                  ? "Simulation worker active"
                  : metricsQuery.isPlaceholderData
                    ? "Updating charts"
                    : stateQuery.isFetching
                      ? "Updating selected time"
                      : summary.error || stateQuery.error || metricsQuery.error
                        ? "Connection requires attention"
                        : "Workspace connected")}
            </span>
            <span>
              {run?.status === "SUCCEEDED"
                ? `${completed} completed runs · Model ${run.model_version || "1.0"}`
                : "Versioned inputs · Reproducible simulation"}{" "}
              <b>·</b>{" "}
              {presentationScenario?.timezone ||
                inspectionDataset?.timezone ||
                "America/Chicago"}
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
          <SearchDialog
            ctx={
              page === "overview" && !draftDatasetDiffers
                ? {
                    ...ctx,
                    run,
                    state: inspectionState,
                    stateLoading: stateQuery.isFetching,
                    stateError: stateQuery.error?.message || null,
                    selectedTime,
                    selectedDay,
                    activeReplicationId,
                  }
                : ctx
            }
            onClose={() => setSearchOpen(false)}
          />
        ) : null}
        {selectedResource ? (
          <HospitalResourceDetails
            ctx={ctx}
            onClose={() => setSelectedResource(null)}
            onUpdate={() => {
              setUpdateTarget({
                ...selectedResource,
                kind: selectedResource.kind as UpdateTarget["kind"],
              });
              setSelectedResource(null);
              setUpdateOpen(true);
            }}
          />
        ) : null}
        {exportOpen ? (
          <ExportDialog
            ctx={resultToolsCtx}
            onClose={() => setExportOpen(false)}
          />
        ) : null}
        {updateOpen ? (
          <UpdateDialog
            ctx={ctx}
            target={updateTarget}
            onClose={() => {
              setUpdateOpen(false);
              setUpdateTarget(null);
            }}
          />
        ) : null}
        {alertsOpen ? (
          <AlertsDialog
            ctx={resultToolsCtx}
            onClose={() => setAlertsOpen(false)}
          />
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
                <h3>What makes a bed available</h3>
                <p>
                  A place is usable only when it is installed, ready, and
                  supported by qualified staff and compatible equipment.
                </p>
              </div>
              <div>
                <span className="eyebrow">DATA PROVENANCE</span>
                <h3>Synthetic planning dataset</h3>
                <p>
                  Patients, facilities, staffing, capabilities, travel times,
                  and stay assumptions are generated engineering fixtures. They
                  can be inspected and edited through Data & setup.
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
      {brandTransition}
    </>
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
          <NativeSelect
            aria-label="Export format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="zip">Complete planning package (.zip)</option>
            <option value="csv">Computed metrics (.csv)</option>
            <option value="json">Scenario and results (.json)</option>
          </NativeSelect>
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
