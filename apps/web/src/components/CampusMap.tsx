import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  Building2,
  Compass,
  Hospital,
  Layers,
  LocateFixed,
  Minus,
  Plus,
  Route,
  X,
} from "lucide-react";
import type { Entity, PlanningContext } from "../types";
import { fmt } from "../api";
import {
  nameOf,
  queueStats,
  stateUnavailable,
  statsFor,
  unitsOf,
} from "../model";
maplibregl.setWorkerUrl(workerUrl);
type Site = { id: string; facility: Entity; position: [number, number] | null };
function sitePosition(f: Entity): [number, number] | null {
  const lng = f.longitude ?? f.geometry?.coordinates?.[0],
    lat = f.latitude ?? f.geometry?.coordinates?.[1];
  return lng !== null &&
    lng !== undefined &&
    lat !== null &&
    lat !== undefined &&
    Number.isFinite(Number(lng)) &&
    Number.isFinite(Number(lat)) &&
    Math.abs(Number(lng)) <= 180 &&
    Math.abs(Number(lat)) <= 90
    ? [Number(lng), Number(lat)]
    : null;
}
function siteDescription(ctx: PlanningContext, site: Site) {
  if (stateUnavailable(ctx)) return "Selected-time state unavailable";
  const units = unitsOf(ctx).filter((u) => u.facility_id === site.id),
    active = ctx.state
      ? units.some((u) => u.active)
      : site.facility.status === "active";
  const status = active
    ? "Active"
    : ctx.state
      ? units.length
        ? site.facility.status === "candidate"
          ? "Candidate"
          : "Inactive"
        : "No selected-time unit state"
      : String(site.facility.status || "Status unspecified").replaceAll(
          "_",
          " ",
        );
  const kinds = Array.from(new Set(units.map((u) => u.kind).filter(Boolean)));
  const counts = kinds
    .map((kind) => {
      const n = statsFor(ctx, kind, site.id);
      return `${kind.toUpperCase()} ${fmt(n.occupied)}/${fmt(n.staffed)}`;
    })
    .join(" · ");
  return `${status}${counts ? ` · ${counts}` : ""}${site.facility.kind === "shelter" ? " · Nonclinical" : ""}`;
}
function geometry(sites: Site[], routes: Entity[]) {
  const located = sites.filter(
      (s): s is Site & { position: [number, number] } => s.position !== null,
    ),
    byId = new Map(located.map((s) => [s.id, s.position]));
  const footprints = located.map((site) => {
    const [x, y] = site.position,
      dx =
        (site.facility.kind === "hospital" ? 0.0008 : 0.0004) /
        Math.cos((y * Math.PI) / 180),
      dy = site.facility.kind === "hospital" ? 0.0006 : 0.0003;
    return {
      type: "Feature" as const,
      properties: { facility_id: site.id, kind: site.facility.kind },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [x - dx, y - dy],
            [x + dx, y - dy],
            [x + dx, y + dy],
            [x - dx, y + dy],
            [x - dx, y - dy],
          ],
        ],
      },
    };
  });
  const seen = new Set<string>(),
    lines = routes.flatMap((r) => {
      const from = String(r.from_facility_id),
        to = String(r.to_facility_id),
        key = [from, to].sort().join("|");
      if (!byId.has(from) || !byId.has(to) || seen.has(key)) return [];
      seen.add(key);
      return [
        {
          type: "Feature" as const,
          properties: { route_id: r.route_id },
          geometry: {
            type: "LineString" as const,
            coordinates: [byId.get(from)!, byId.get(to)!],
          },
        },
      ];
    });
  return {
    footprints: { type: "FeatureCollection" as const, features: footprints },
    routes: { type: "FeatureCollection" as const, features: lines },
  };
}
export default function CampusMap({
  ctx,
  resources = false,
}: {
  ctx: PlanningContext;
  resources?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false),
    [layers, setLayers] = useState(false),
    [showRoutes, setShowRoutes] = useState(true),
    [showBuildings, setShowBuildings] = useState(true),
    [fallback, setFallback] = useState(false);
  const sites = useMemo(
    () =>
      ctx.dataset?.facilities.map((f) => ({
        id: String(f.facility_id || f.id),
        facility: f,
        position: sitePosition(f),
      })) || [],
    [ctx.dataset],
  );
  const mapData = useMemo(
    () => geometry(sites, ctx.dataset?.routes || []),
    [sites, ctx.dataset],
  );
  const q = queueStats(ctx, "FAC-MAIN"),
    unlocated = sites.filter((s) => !s.position);
  const fitAll = useCallback(() => {
    const m = map.current,
      points = sites.flatMap((s) => (s.position ? [s.position] : []));
    if (!m || !points.length) return;
    const bounds = points.reduce(
      (bounds, p) => bounds.extend(p),
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
    });
  }, [sites]);
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
            routes: {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            },
          },
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#101e29" },
            },
            {
              id: "green",
              type: "fill",
              source: "campus",
              filter: ["==", "kind", "green"],
              paint: { "fill-color": "#173830", "fill-opacity": 0.65 },
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
                  "#1b303d",
                  1,
                  "#213542",
                  2,
                  "#273a46",
                  "#182c38",
                ],
                "fill-outline-color": "#31414b",
              },
            },
            {
              id: "road-edge",
              type: "line",
              source: "campus",
              filter: ["==", "kind", "road"],
              paint: { "line-color": "#0a1720", "line-width": 14 },
            },
            {
              id: "roads",
              type: "line",
              source: "campus",
              filter: ["==", "kind", "road"],
              paint: { "line-color": "#32424e", "line-width": 5 },
            },
            {
              id: "highway",
              type: "line",
              source: "campus",
              filter: ["==", "kind", "highway"],
              paint: { "line-color": "#40515b", "line-width": 6 },
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
                  "#44375e",
                  "clinic",
                  "#1c5148",
                  "ward_overflow",
                  "#4d4632",
                  "#164254",
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
                  "#a28bdb",
                  "clinic",
                  "#62c7aa",
                  "ward_overflow",
                  "#dfbf74",
                  "#59d8ef",
                ],
                "line-width": 2,
              },
            },
            {
              id: "routes",
              type: "line",
              source: "routes",
              paint: {
                "line-color": "#65d9eb",
                "line-width": 1.5,
                "line-dasharray": [3, 3],
                "line-opacity": 0.45,
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
      const scaleCorner = m
        .getContainer()
        .querySelector<HTMLElement>(".maplibregl-ctrl-bottom-left");
      if (scaleCorner) scaleCorner.style.bottom = "40px";
      const scale = m
        .getContainer()
        .querySelector<HTMLElement>(".maplibregl-ctrl-scale");
      if (scale) {
        scale.style.background = "#0b1c27df";
        scale.style.color = "#b0c4d2";
        scale.style.borderColor = "#8fa8b9";
        scale.style.fontSize = "12px";
      }
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
    if (ready) fitAll();
  }, [ready, fitAll]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource("facilities") as maplibregl.GeoJSONSource).setData(
      mapData.footprints,
    );
    (m.getSource("routes") as maplibregl.GeoJSONSource).setData(mapData.routes);
  }, [ready, mapData]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const markers: maplibregl.Marker[] = [];
    const compact = m.getContainer().clientWidth < 600;
    for (const site of sites) {
      if (!site.position) continue;
      const b = document.createElement("button"),
        kind = site.facility.kind;
      b.type = "button";
      b.style.width = compact ? "44px" : "30px";
      b.style.height = compact ? "44px" : "30px";
      b.style.justifyContent = "center";
      b.style.zIndex = site.id === ctx.selectedFacility ? "4" : "2";
      b.className = `map-marker ${site.id === ctx.selectedFacility ? "selected" : ""} ${kind === "hospital" ? "main-hospital" : kind === "clinic" ? "clinic" : kind === "shelter" ? "shelter" : kind === "ward_overflow" ? "overflow" : ""}`;
      b.setAttribute(
        "aria-label",
        `Select ${nameOf(site.facility)}: ${siteDescription(ctx, site)}`,
      );
      b.setAttribute("aria-pressed", String(site.id === ctx.selectedFacility));
      const pin = document.createElement("span");
      pin.className = "marker-pin";
      pin.textContent = kind === "hospital" ? "+" : " ";
      b.appendChild(pin);
      const label = document.createElement("span");
      label.className = "marker-label";
      label.style.position = "absolute";
      label.style.display =
        compact && site.id !== ctx.selectedFacility ? "none" : "flex";
      label.style.minWidth = "0";
      label.style.width = "max-content";
      label.style.maxWidth = "220px";
      label.style.margin = "0";
      label.style.top = "34px";
      label.style.left = "50%";
      label.style.transform = "translateX(-50%)";
      if (site.id !== ctx.selectedFacility) {
        const center = sites.find(
          (s) => s.id === ctx.selectedFacility,
        )?.position;
        if (center && site.position[1] > center[1]) {
          label.style.top = "auto";
          label.style.bottom = "34px";
        }
        if (center && site.position[0] < center[0]) {
          label.style.left = "auto";
          label.style.right = "36px";
          label.style.transform = "none";
          label.style.top = "0";
          label.style.bottom = "auto";
        } else if (center && site.position[0] > center[0]) {
          label.style.left = "36px";
          label.style.transform = "none";
        }
      }
      const title = document.createElement("strong");
      title.textContent = nameOf(site.facility);
      title.style.fontSize = "12px";
      const desc = document.createElement("small");
      desc.textContent = siteDescription(ctx, site);
      desc.style.fontSize = "12px";
      desc.style.display = site.id === ctx.selectedFacility ? "block" : "none";
      b.onmouseenter = () => {
        label.style.display = "flex";
        desc.style.display = "block";
        b.style.zIndex = "5";
      };
      b.onmouseleave = () => {
        label.style.display =
          compact && site.id !== ctx.selectedFacility ? "none" : "flex";
        desc.style.display =
          site.id === ctx.selectedFacility ? "block" : "none";
        b.style.zIndex = site.id === ctx.selectedFacility ? "4" : "2";
      };
      b.onfocus = () => {
        label.style.display = "flex";
        desc.style.display = "block";
        b.style.zIndex = "5";
      };
      b.onblur = () => {
        label.style.display =
          compact && site.id !== ctx.selectedFacility ? "none" : "flex";
        desc.style.display =
          site.id === ctx.selectedFacility ? "block" : "none";
        b.style.zIndex = site.id === ctx.selectedFacility ? "4" : "2";
      };
      label.append(title, desc);
      b.appendChild(label);
      b.onclick = () => ctx.setFacility(site.id);
      markers.push(
        new maplibregl.Marker({ element: b, anchor: "center" })
          .setLngLat(site.position)
          .addTo(m),
      );
    }
    return () => markers.forEach((marker) => marker.remove());
  }, [
    ready,
    sites,
    ctx.selectedFacility,
    ctx.state,
    ctx.stateLoading,
    ctx.stateError,
    ctx.run?.status,
  ]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    for (const id of ["buildings", "facility-fill", "facility-line"])
      m.setLayoutProperty(id, "visibility", showBuildings ? "visible" : "none");
    m.setLayoutProperty(
      "routes",
      "visibility",
      showRoutes ? "visible" : "none",
    );
  }, [ready, showBuildings, showRoutes]);
  return (
    <div className={`campus-map ${resources ? "resources-map" : ""}`}>
      <div ref={el} className="map-canvas" />
      {fallback || (sites.length && !sites.some((s) => s.position)) ? (
        <div className="map-fallback">
          <Hospital size={70} />
          <h3>Facility schematic</h3>
          {sites.map((site) => (
            <button
              className={ctx.selectedFacility === site.id ? "selected" : ""}
              key={site.id}
              onClick={() => ctx.setFacility(site.id)}
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
            className={layers ? "active" : ""}
            onClick={() => setLayers(!layers)}
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
        </div>
      </div>
      {layers ? (
        <div className="map-layer-panel">
          <div className="spread">
            <strong>Visible layers</strong>
            <button onClick={() => setLayers(false)} aria-label="Close layers">
              <X size={14} />
            </button>
          </div>
          <label>
            <Building2 size={15} />
            Buildings
            <input
              type="checkbox"
              checked={showBuildings}
              onChange={(e) => setShowBuildings(e.target.checked)}
            />
          </label>
          <label>
            <Route size={15} />
            Transfer routes
            <input
              type="checkbox"
              checked={showRoutes}
              onChange={(e) => setShowRoutes(e.target.checked)}
            />
          </label>
          <p>
            Schematic footprints and route links. Facility coordinates come from
            the dataset.
          </p>
          <label>
            All dataset sites
            <select
              aria-label="Select facility from map"
              value={ctx.selectedFacility}
              onChange={(e) => ctx.setFacility(e.target.value)}
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {nameOf(s.facility)}
                  {!s.position ? " · no coordinates" : ""}
                </option>
              ))}
            </select>
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
            {Array.from({ length: Math.min(14, q.total) }, (_, i) => (
              <i key={i} />
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
            locations · Illustrative route links
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
          Waiting
        </span>
        <span>
          <i className="violet-dot" />
          Nonclinical
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
