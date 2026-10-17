import { NativeSelect } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  AlertTriangle,
  Building2,
  Compass,
  Hospital,
  Layers,
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
  Route,
  UsersRound,
  X,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { api, fmt } from "../api";
import {
  nameOf,
  patientsOf,
  queueStats,
  stateUnavailable,
  statsFor,
  unitsOf,
} from "../model";
import {
  mapLayerData,
  selectedSiteStatus,
  sitePosition,
  type Site,
} from "./campusMapModel";

maplibregl.setWorkerUrl(workerUrl);

type LayerKey =
  | "facilities"
  | "capacity"
  | "cohorts"
  | "transfers"
  | "candidates"
  | "incidents"
  | "buildings";
const layerLabels: Record<LayerKey, { label: string; Icon: typeof Building2 }> =
  {
    facilities: { label: "Facilities", Icon: Hospital },
    capacity: { label: "Capacity", Icon: Building2 },
    cohorts: { label: "Patient cohorts", Icon: UsersRound },
    transfers: { label: "Transfer paths", Icon: Route },
    candidates: { label: "Candidate sites", Icon: LocateFixed },
    incidents: { label: "Incident reports", Icon: AlertTriangle },
    buildings: { label: "Buildings", Icon: Building2 },
  };
const initialLayers: Record<LayerKey, boolean> = {
  facilities: true,
  capacity: true,
  cohorts: true,
  transfers: true,
  candidates: true,
  incidents: true,
  buildings: true,
};

function cameraFor(sites: Site[]) {
  const points = sites.flatMap((site) =>
    site.position ? [site.position] : [],
  );
  if (!points.length) return { center: [0, 0] as [number, number], zoom: 2 };
  return {
    center: [
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length,
    ] as [number, number],
    zoom: 13.35,
  };
}
function siteDescription(ctx: PlanningContext, site: Site) {
  if (stateUnavailable(ctx)) return "Selected-time state unavailable";
  const units = unitsOf(ctx).filter((unit) => unit.facility_id === site.id);
  const kinds = Array.from(
    new Set(units.map((unit) => unit.kind).filter(Boolean)),
  );
  const counts = kinds
    .map((kind) => {
      const value = statsFor(ctx, kind, site.id);
      return `${String(kind).toUpperCase()} ${fmt(value.occupied)}/${fmt(value.staffed)}`;
    })
    .join(" · ");
  return `${site.status.replaceAll("_", " ")}${counts ? ` · ${counts}` : ""}${site.facility.kind === "shelter" ? " · Nonclinical" : ""}`;
}
function useFrozenReports(ctx: PlanningContext) {
  const [reports, setReports] = useState<Entity | null>(null);
  const [reportsFor, setReportsFor] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "ready">(
    "idle",
  );
  const request = useRef(0);
  const replication =
    ctx.activeReplicationId || ctx.run?.selected_replication_id;
  useEffect(() => {
    const current = ++request.current;
    if (!replication || ctx.run?.status !== "SUCCEEDED") {
      setReports(null);
      setReportsFor(null);
      setStatus("idle");
      return;
    }
    // Do not render an immutable report from a prior replication while the
    // request for the new replication is in flight.
    setReports(null);
    setReportsFor(replication);
    setStatus("loading");
    void api<Entity>(`/runs/${replication}/annotations`)
      .then((value) => {
        if (current !== request.current) return;
        setReports(value);
        setReportsFor(replication);
        setStatus("ready");
      })
      .catch(() => {
        if (current !== request.current) return;
        setReports(null);
        setReportsFor(replication);
        setStatus("error");
      });
  }, [replication, ctx.run?.status]);
  return {
    reports: reportsFor === replication ? reports : null,
    status:
      reportsFor === replication
        ? status
        : replication && ctx.run?.status === "SUCCEEDED"
          ? "loading"
          : "idle",
  };
}

export default function CampusMap({
  ctx,
  resources = false,
}: {
  ctx: PlanningContext;
  resources?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const baseCamera = useRef<{ center: [number, number]; zoom: number } | null>(
    null,
  );
  const cameraDataset = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [visible, setVisible] = useState(initialLayers);
  const [fallback, setFallback] = useState(false);
  const { reports, status: reportsStatus } = useFrozenReports(ctx);
  // Do not announce a previous selected-time transfer aggregate while the
  // current state request is pending or failed.
  const selectedState = ctx.stateLoading || ctx.stateError ? null : ctx.state;
  const inspectEntity = (
    ctx as PlanningContext & {
      inspectEntity?: (kind: string, id: string) => void;
    }
  ).inspectEntity;
  const siteStatuses = useMemo(() => {
    const stateUnits = stateUnavailable(ctx) ? [] : unitsOf(ctx);
    return new Map(
      (ctx.dataset?.facilities || []).map((facility) => {
        const id = String(facility.facility_id || facility.id);
        const units = stateUnits.filter((unit) => unit.facility_id === id);
        return [id, selectedSiteStatus(facility, units)] as const;
      }),
    );
  }, [ctx.dataset?.facilities, ctx.state, ctx.stateLoading, ctx.stateError]);
  const sites = useMemo(
    () =>
      ctx.dataset?.facilities.map((facility) => ({
        id: String(facility.facility_id || facility.id),
        facility,
        position: sitePosition(facility),
        status:
          siteStatuses.get(String(facility.facility_id || facility.id)) ||
          String(facility.status || "unspecified"),
      })) || [],
    [ctx.dataset?.id, ctx.dataset?.facilities, siteStatuses],
  );
  const capacity = useMemo(() => {
    const values = new Map<string, Entity>();
    if (stateUnavailable(ctx)) return values;
    for (const site of sites) {
      const kinds = Array.from(
        new Set(
          unitsOf(ctx)
            .filter((unit) => unit.facility_id === site.id)
            .map((unit) =>
              String(unit.kind || unit.unit_type || unit.type || ""),
            )
            .filter(Boolean),
        ),
      );
      const total = kinds.reduce(
        (sum, kind) => {
          const stat = statsFor(ctx, kind, site.id);
          return {
            occupied: Number(sum.occupied || 0) + stat.occupied,
            staffed: Number(sum.staffed || 0) + stat.staffed,
            available: Number(sum.available || 0) + stat.available,
          };
        },
        { occupied: 0, staffed: 0, available: 0 },
      );
      if (kinds.length) values.set(site.id, total);
    }
    return values;
  }, [
    ctx.dataset,
    ctx.state,
    ctx.stateLoading,
    ctx.stateError,
    ctx.selectedTime,
    sites,
  ]);
  const unitFacilities = useMemo(
    () =>
      new Map(
        (ctx.dataset?.units || []).map((unit) => [
          String(unit.unit_id || unit.id),
          String(unit.facility_id || ""),
        ]),
      ),
    [ctx.dataset?.units],
  );
  const entryFacilities = useMemo(
    () =>
      new Map<string, string>(
        (ctx.dataset?.entry_streams || []).map((stream: Entity) => [
          String(stream.entry_stream_id || stream.id),
          String(stream.destination_facility_id || ""),
        ]) as [string, string][],
      ),
    [ctx.dataset?.entry_streams],
  );
  const staffFacilities = useMemo(() => {
    const locations = new Map<string, string>();
    for (const staff of ctx.dataset?.staff || []) {
      const facility = String(
        staff.facility_id ||
          unitFacilities.get(
            String(staff.home_unit_id || staff.unit_id || ""),
          ) ||
          "",
      );
      if (facility) locations.set(String(staff.staff_id || staff.id), facility);
    }
    for (const unit of selectedState?.units || []) {
      for (const staffId of unit.active_staff_ids || [])
        if (unit.facility_id)
          locations.set(String(staffId), String(unit.facility_id));
    }
    return locations;
  }, [ctx.dataset?.staff, selectedState?.units, unitFacilities]);
  const equipmentFacilities = useMemo(() => {
    const locations = new Map<string, string>();
    const add = (pool: Entity) => {
      const facility = String(
        pool.facility_id ||
          unitFacilities.get(String(pool.unit_id || "")) ||
          "",
      );
      if (facility)
        locations.set(String(pool.equipment_pool_id || pool.id), facility);
    };
    for (const pool of ctx.dataset?.equipment_pools || []) add(pool);
    for (const pool of selectedState?.equipment_pools || []) add(pool);
    return locations;
  }, [
    ctx.dataset?.equipment_pools,
    selectedState?.equipment_pools,
    unitFacilities,
  ]);
  const mapData = useMemo(
    () =>
      mapLayerData({
        sites,
        routes: ctx.dataset?.routes || [],
        capacity,
        patients: patientsOf(ctx),
        patientGroups: selectedState?.patient_groups,
        transferPaths: selectedState?.transfer_paths,
        unitFacilities,
        entryFacilities,
        staffFacilities,
        equipmentFacilities,
        unavailable: stateUnavailable(ctx),
        selectedTime: ctx.selectedTime,
        reports:
          reports ||
          (ctx.run?.status === "SUCCEEDED"
            ? null
            : {
                conditions: ctx.scenario?.conditions || [],
                updates: ctx.scenario?.updates || [],
              }),
      }),
    [
      sites,
      ctx.dataset,
      capacity,
      selectedState,
      unitFacilities,
      entryFacilities,
      staffFacilities,
      equipmentFacilities,
      ctx.selectedTime,
      ctx.run?.status,
      ctx.scenario,
      reports,
    ],
  );
  const q = queueStats(ctx, "FAC-MAIN");
  const exactTransferSummary = Array.isArray(selectedState?.transfer_paths)
    ? {
        paths: selectedState.transfer_paths.length,
        requests: selectedState.transfer_paths.reduce(
          (total, path) => total + Number(path.count || 0),
          0,
        ),
      }
    : null;
  const selectFacility = useCallback(
    (id: string) => {
      if (resources) ctx.setFacility(id);
      else if (inspectEntity) inspectEntity("facility", id);
      else ctx.setFacility(id);
    },
    [ctx, inspectEntity, resources],
  );
  const unlocated = sites.filter((site) => !site.position);
  const fitAll = useCallback(() => {
    const m = map.current;
    const points = sites.flatMap((site) =>
      site.position ? [site.position] : [],
    );
    if (!m || !points.length) return;
    const bounds = points.reduce(
      (value, point) => value.extend(point),
      new maplibregl.LngLatBounds(points[0], points[0]),
    );
    m.fitBounds(bounds, {
      padding: {
        top: 65,
        bottom: 90,
        left: m.getContainer().clientWidth < 600 ? 90 : 210,
        right: m.getContainer().clientWidth < 600 ? 90 : 210,
      },
      maxZoom: 15.2,
      duration: 400,
      bearing: 0,
      pitch: 0,
    });
  }, [sites]);
  const resetCamera = useCallback(() => {
    const m = map.current;
    if (m && baseCamera.current)
      m.flyTo({ ...baseCamera.current, bearing: 0, pitch: 0, duration: 350 });
  }, []);

  useEffect(() => {
    if (!el.current) return;
    try {
      const m = new maplibregl.Map({
        container: el.current,
        center: [0, 0],
        zoom: 2,
        bearing: 0,
        pitch: 0,
        attributionControl: false,
        style: {
          version: 8,
          sources: {
            campus: { type: "geojson", data: "/assets/campus.geojson" },
            facilities: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
            capacity: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
            cohorts: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
            transfers: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
            candidates: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
            incidents: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
          },
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#f3f6f9" },
            },
            {
              id: "green",
              type: "fill",
              source: "campus",
              filter: ["==", "kind", "green"],
              paint: { "fill-color": "#dcece2", "fill-opacity": 0.65 },
            },
            {
              id: "buildings",
              type: "fill",
              source: "campus",
              filter: ["==", "kind", "building"],
              paint: {
                "fill-color": [
                  "match",
                  ["get", "shade"],
                  0,
                  "#e6ebf0",
                  1,
                  "#dde5ed",
                  2,
                  "#e0e7ed",
                  "#e9eef3",
                ],
                "fill-outline-color": "#c9d4df",
              },
            },
            {
              id: "road-edge",
              type: "line",
              source: "campus",
              filter: ["==", "kind", "road"],
              paint: { "line-color": "#ffffff", "line-width": 14 },
            },
            {
              id: "roads",
              type: "line",
              source: "campus",
              filter: ["==", "kind", "road"],
              paint: { "line-color": "#d7e0e8", "line-width": 5 },
            },
            {
              id: "highway",
              type: "line",
              source: "campus",
              filter: ["==", "kind", "highway"],
              paint: { "line-color": "#c5d0dc", "line-width": 6 },
            },
            {
              id: "transfer-paths",
              type: "line",
              source: "transfers",
              paint: {
                "line-color": [
                  "match",
                  ["get", "route_type"],
                  "recorded",
                  "#2684cc",
                  "#91a0af",
                ],
                "line-width": [
                  "match",
                  ["get", "route_type"],
                  "recorded",
                  2.5,
                  1.25,
                ],
                "line-dasharray": [3, 3],
                "line-opacity": 0.7,
              },
            },
            {
              id: "facility-fill",
              type: "fill",
              source: "facilities",
              paint: {
                "fill-color": [
                  "match",
                  ["get", "kind"],
                  "shelter",
                  "#e9e0f8",
                  "clinic",
                  "#d6efe6",
                  "ward_overflow",
                  "#f7ebd2",
                  "#daebf9",
                ],
                "fill-opacity": 0.95,
              },
            },
            {
              id: "facility-line",
              type: "line",
              source: "facilities",
              paint: {
                "line-color": [
                  "match",
                  ["get", "kind"],
                  "shelter",
                  "#8060b6",
                  "clinic",
                  "#168976",
                  "ward_overflow",
                  "#c29024",
                  "#2684cc",
                ],
                "line-width": 2,
              },
            },
            {
              id: "capacity-halo",
              type: "circle",
              source: "capacity",
              paint: {
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["get", "staffed"],
                  0,
                  7,
                  100,
                  23,
                ],
                "circle-color": "#eaf4fc",
                "circle-stroke-color": "#2684cc",
                "circle-stroke-width": 1.5,
                "circle-opacity": 0.9,
              },
            },
            {
              id: "capacity-used",
              type: "circle",
              source: "capacity",
              paint: {
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["get", "occupied"],
                  0,
                  2,
                  100,
                  16,
                ],
                "circle-color": "#e6ae58",
                "circle-opacity": 0.85,
              },
            },
            {
              id: "cohorts",
              type: "circle",
              source: "cohorts",
              paint: {
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["get", "count"],
                  1,
                  4,
                  50,
                  12,
                ],
                "circle-color": "#b581e4",
                "circle-stroke-color": "#e8d7fb",
                "circle-stroke-width": 1,
                "circle-opacity": 0.82,
              },
            },
            {
              id: "candidate-sites",
              type: "circle",
              source: "candidates",
              paint: {
                "circle-radius": 10,
                "circle-color": "#d8b15b",
                "circle-stroke-color": "#fff0ad",
                "circle-stroke-width": 2,
                "circle-opacity": 0.95,
              },
            },
            {
              id: "incident-reports",
              type: "circle",
              source: "incidents",
              paint: {
                "circle-radius": 7,
                "circle-color": "#ec765e",
                "circle-stroke-color": "#ffd0c4",
                "circle-stroke-width": 2,
                "circle-opacity": 0.96,
              },
            },
          ],
        },
      });
      map.current = m;
      m.on("load", () => setReady(true));
      m.on("error", () => {
        if (!m.isStyleLoaded()) setFallback(true);
      });
      m.addControl(
        new maplibregl.ScaleControl({ maxWidth: 100, unit: "metric" }),
        "bottom-left",
      );
      const observer = new ResizeObserver(() => m.resize());
      observer.observe(el.current);
      return () => {
        observer.disconnect();
        m.remove();
        map.current = null;
      };
    } catch {
      setFallback(true);
    }
  }, []);
  useEffect(() => {
    if (!ready || !sites.length || cameraDataset.current === ctx.dataset?.id)
      return;
    const camera = cameraFor(sites);
    baseCamera.current = camera;
    cameraDataset.current = ctx.dataset?.id;
    map.current?.jumpTo({ ...camera, bearing: 0, pitch: 0 });
  }, [ready, sites, ctx.dataset?.id]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (Object.entries(mapData) as [keyof typeof mapData, any][]).forEach(
      ([key, data]) =>
        (m.getSource(key) as maplibregl.GeoJSONSource | undefined)?.setData(
          data,
        ),
    );
  }, [ready, mapData]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const state = (key: LayerKey) => (visible[key] ? "visible" : "none");
    ["buildings", "road-edge", "roads", "highway"].forEach((id) =>
      m.setLayoutProperty(id, "visibility", state("buildings")),
    );
    ["facility-fill", "facility-line"].forEach((id) =>
      m.setLayoutProperty(id, "visibility", state("facilities")),
    );
    ["capacity-halo", "capacity-used"].forEach((id) =>
      m.setLayoutProperty(id, "visibility", state("capacity")),
    );
    m.setLayoutProperty("cohorts", "visibility", state("cohorts"));
    m.setLayoutProperty("transfer-paths", "visibility", state("transfers"));
    m.setLayoutProperty("candidate-sites", "visibility", state("candidates"));
    m.setLayoutProperty("incident-reports", "visibility", state("incidents"));
  }, [ready, visible]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const markers: maplibregl.Marker[] = [];
    const compact = m.getContainer().clientWidth < 600;
    for (const site of sites) {
      if (!site.position) continue;
      const button = document.createElement("button");
      const kind = site.facility.kind;
      button.type = "button";
      button.style.width = compact ? "44px" : "30px";
      button.style.height = compact ? "44px" : "30px";
      button.style.justifyContent = "center";
      button.style.display = visible.facilities ? "flex" : "none";
      button.style.zIndex = site.id === ctx.selectedFacility ? "4" : "2";
      button.className = `map-marker ${site.id === ctx.selectedFacility ? "selected" : ""} ${kind === "hospital" ? "main-hospital" : kind === "clinic" ? "clinic" : kind === "shelter" ? "shelter" : kind === "ward_overflow" ? "overflow" : ""}`;
      button.setAttribute(
        "aria-label",
        `Select ${nameOf(site.facility)}: ${siteDescription(ctx, site)}`,
      );
      button.setAttribute(
        "aria-pressed",
        String(site.id === ctx.selectedFacility),
      );
      const pin = document.createElement("span");
      pin.className = "marker-pin";
      pin.textContent = kind === "hospital" ? "+" : " ";
      button.appendChild(pin);
      const label = document.createElement("span");
      label.className = "marker-label";
      label.style.position = "absolute";
      // Keep a dense map legible. The selected marker remains labelled; other
      // fully-described accessible markers reveal their anchored label on hover
      // or keyboard focus.
      label.style.display = site.id === ctx.selectedFacility ? "flex" : "none";
      label.style.minWidth = "0";
      label.style.width = "max-content";
      label.style.maxWidth = "220px";
      label.style.margin = "0";
      label.style.top = "34px";
      label.style.left = "50%";
      label.style.transform = "translateX(-50%)";
      const title = document.createElement("strong");
      title.textContent = nameOf(site.facility);
      const description = document.createElement("small");
      description.textContent = siteDescription(ctx, site);
      description.style.display =
        site.id === ctx.selectedFacility ? "block" : "none";
      label.append(title, description);
      button.appendChild(label);
      button.onmouseenter = button.onfocus = () => {
        label.style.display = "flex";
        description.style.display = "block";
      };
      button.onmouseleave = button.onblur = () => {
        label.style.display =
          site.id === ctx.selectedFacility ? "flex" : "none";
        description.style.display =
          site.id === ctx.selectedFacility ? "block" : "none";
      };
      button.onclick = () => selectFacility(site.id);
      markers.push(
        new maplibregl.Marker({ element: button, anchor: "center" })
          .setLngLat(site.position)
          .addTo(m),
      );
    }
    return () => markers.forEach((marker) => marker.remove());
  }, [
    ready,
    sites,
    visible.facilities,
    ctx.selectedFacility,
    ctx.state,
    ctx.stateLoading,
    ctx.stateError,
    ctx.run?.status,
    inspectEntity,
    selectFacility,
  ]);
  const reportSource =
    reportsStatus === "ready"
      ? "Immutable selected-run reports and plans"
      : reportsStatus === "loading"
        ? "Loading immutable selected-run reports"
        : reportsStatus === "error"
          ? "Selected-run reports unavailable"
          : ctx.scenario
            ? "Draft scenario plans; no immutable run selected"
            : "No reports or plans selected";
  return (
    <div className={`campus-map ${resources ? "resources-map" : ""}`}>
      <div ref={el} className="map-canvas" />
      {fallback || (sites.length && !sites.some((site) => site.position)) ? (
        <div className="map-fallback">
          <Hospital size={70} />
          <h3>Facility schematic</h3>
          {sites.map((site) => (
            <button
              className={ctx.selectedFacility === site.id ? "selected" : ""}
              key={site.id}
              onClick={() => selectFacility(site.id)}
            >
              {nameOf(site.facility)}
              <small>{siteDescription(ctx, site)}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="map-topline">
        <BadgeLabel />
        <div className="map-tools">
          <button
            title="Map layers"
            aria-label="Map layers"
            className={layersOpen ? "active" : ""}
            onClick={() => setLayersOpen((open) => !open)}
          >
            <Layers size={16} />
          </button>
          <button
            title="Fit all sites"
            aria-label="Fit all sites"
            onClick={fitAll}
          >
            <LocateFixed size={16} />
          </button>
          <button
            title="Reset camera"
            aria-label="Reset camera"
            onClick={resetCamera}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </div>
      {layersOpen ? (
        <div className="map-layer-panel" aria-label="Map layer controls">
          <div className="spread">
            <strong>Visible layers</strong>
            <button
              onClick={() => setLayersOpen(false)}
              aria-label="Close layers"
            >
              <X size={14} />
            </button>
          </div>
          {(Object.keys(layerLabels) as LayerKey[]).map((key) => {
            const { label, Icon } = layerLabels[key];
            const count =
              mapData[key === "buildings" ? "facilities" : key]?.features
                .length;
            return (
              <label key={key}>
                <Icon size={15} />
                {label}
                <small>{key === "buildings" ? "base" : count}</small>
                <input
                  aria-label={`Show ${label}`}
                  type="checkbox"
                  checked={visible[key]}
                  onChange={(event) =>
                    setVisible((current) => ({
                      ...current,
                      [key]: event.target.checked,
                    }))
                  }
                />
              </label>
            );
          })}
          <p>
            {stateUnavailable(ctx)
              ? "Selected-time state is unavailable, so capacity and cohort layers are intentionally blank."
              : "Capacity and cohorts use the selected example run and time."}
          </p>
          <p>
            {reportSource}. Transfer paths are fixed route assumptions or
            recorded transfer requests; no moving route is inferred.
            {exactTransferSummary
              ? ` ${exactTransferSummary.requests} selected-time transfer request${exactTransferSummary.requests === 1 ? "" : "s"} across ${exactTransferSummary.paths} path${exactTransferSummary.paths === 1 ? "" : "s"}.`
              : ""}
          </p>
          <label>
            All dataset sites
            <NativeSelect
              aria-label="Select facility from map"
              value={ctx.selectedFacility}
              onChange={(event) => selectFacility(event.target.value)}
            >
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {nameOf(site.facility)}
                  {!site.position ? " · no coordinates" : ""}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
      ) : null}
      <div className="map-compass">
        <Compass size={32} />
        <span>N</span>
      </div>
      {q.total && !q.unavailable ? (
        <button className="map-queue" onClick={() => ctx.setPage("patients")}>
          <div className="patient-dot-cluster">
            {Array.from({ length: Math.min(14, q.total) }, (_, index) => (
              <i key={index} />
            ))}
          </div>
          <div>
            <strong>{q.total} awaiting placement</strong>
            <small>
              {q.ward} ward · {q.icu} ICU
            </small>
          </div>
        </button>
      ) : null}
      <div className="map-bottom">
        <div>
          <p>
            SCHEMATIC CONTEXT <span>·</span>{" "}
            {ctx.dataset?.synthetic ? "Synthetic" : "Dataset"} facility
            locations · Frozen route assumptions
            {unlocated.length
              ? ` · ${unlocated.length} site(s) without coordinates`
              : ""}
          </p>
        </div>
        <div className="map-zoom">
          <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>
            <Plus size={16} />
          </button>
          <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>
            <Minus size={16} />
          </button>
        </div>
      </div>
      <div className="map-legend">
        <span>
          <i className="cyan-dot" />
          Hospital
        </span>
        <span>
          <i className="green-dot" />
          Clinic
        </span>
        <span>
          <i className="amber-dot" />
          Capacity / candidate
        </span>
        <span>
          <i className="violet-dot" />
          Patient cohort
        </span>
        <span>
          <i className="red-dot" />
          Incident
        </span>
      </div>
    </div>
  );
}
function BadgeLabel() {
  return (
    <div className="map-badge">
      <span className="status-dot" />
      <span>REGIONAL CAPACITY</span>
      <small>Schematic map</small>
    </div>
  );
}
