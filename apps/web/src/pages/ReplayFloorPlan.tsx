import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FloorBed, FloorPlan, FloorUnit } from "./replayFloorPlanModel";
import type { FloorJourney, FloorMotionWindow } from "./floorPlanTransitModel";
import FloorPlanTransit from "./FloorPlanTransit";
import FloorPlanArchitecture from "./FloorPlanArchitecture";
import ReplayBedLight from "./ReplayBedLight";
import { floorPlanFitScale, floorPlanNaturalWidth } from "./floorPlanFitModel";
import "./replayFloorPlan.css";

const value = (number: number | null) =>
  number === null ? "—" : number.toLocaleString();
interface RoomProps {
  unit: FloorUnit;
  selectedPatientId?: string;
  selectedUnitId?: string;
  reducedMotion?: boolean;
  onBedSelect: (bed: FloorBed, unit: FloorUnit) => void;
  onUnitSelect: (unit: FloorUnit) => void;
}
function HospitalRoom({
  unit,
  selectedPatientId,
  selectedUnitId,
  reducedMotion,
  onBedSelect,
  onUnitSelect,
}: RoomProps) {
  return (
    <article
      className={`floor-plan-unit floor-plan-unit--${unit.kind}${selectedUnitId === unit.id ? " floor-plan-unit--selected" : ""}`}
      data-unit-id={unit.id}
      data-unit-kind={unit.kind}
      data-door-side={
        unit.kind === "ward" ? "south" : unit.kind === "icu" ? "west" : "east"
      }
      data-pressure={unit.pressure ?? "unknown"}
      data-occupied={unit.occupied ?? "unknown"}
      data-staffed={unit.staffed ?? "unknown"}
      data-physical={unit.physical ?? "unknown"}
      data-available={unit.available ?? "unknown"}
      style={
        {
          "--unit-tint": `rgba(214, 60, 65, ${0.01 + (unit.pressure ?? 0) * 0.19})`,
          "--bed-columns": unit.beds.length > 60 ? 15 : 10,
        } as CSSProperties
      }
      aria-label={`${unit.name}. ${value(unit.occupied)} occupied, ${value(unit.staffed)} supported. ${unit.pressureText}`}
    >
      <button
        className="floor-plan-unit-heading"
        onClick={() => onUnitSelect(unit)}
        title={unit.pressureText}
      >
        <strong>{unit.name}</strong>
        <span className="floor-plan-occupancy">
          <b>
            {value(unit.occupied)} / {value(unit.physical)}
          </b>
          <small> occupied</small>
        </span>
      </button>
      {unit.beds.length ? (
        <div
          className="floor-plan-beds"
          role="group"
          aria-label={`${unit.name} recorded beds`}
        >
          {unit.beds.map((bed) => (
            <ReplayBedLight
              key={bed.id}
              bed={bed}
              unit={unit}
              selected={Boolean(
                bed.patientId && bed.patientId === selectedPatientId,
              )}
              reducedMotion={reducedMotion}
              onSelect={onBedSelect}
            />
          ))}
        </div>
      ) : unit.physical === 0 ? (
        <div className="floor-plan-unit-count">
          <strong>{value(unit.occupied)}</strong>
          <span>patients in this area</span>
        </div>
      ) : (
        <p className="floor-plan-unknown">Recorded bed inventory unavailable</p>
      )}
      <div className="floor-plan-unit-footer">
        <span title="Admission availability includes the unit’s shared staffing and equipment limits.">
          <b>{value(unit.available)}</b> available{" "}
          <span className="floor-capacity-divider">·</span>{" "}
          {value(unit.staffed)} supported
        </span>
        <button
          onClick={() => onUnitSelect(unit)}
          title={unit.pressureText}
          aria-label={`${unit.name}: ${unit.pressureText}`}
        >
          <span className="floor-unit-pressure-bar">
            <i
              style={{ width: `${Math.round((unit.pressure ?? 0) * 100)}%` }}
            />
          </span>
          {unit.reasons.length
            ? "Constraint"
            : unit.pressure === null
              ? "Unavailable"
              : unit.utilization !== null && unit.utilization >= 0.85
                ? "High occupancy"
                : "Capacity"}
        </button>
      </div>
      <span className="floor-plan-door" aria-hidden="true">
        <svg viewBox="0 0 36 32">
          <path d="M2 31V2M2 2A29 29 0 0 1 31 31" />
        </svg>
      </span>
    </article>
  );
}
export default function ReplayFloorPlan({
  plan,
  retaining = false,
  zoom = 1,
  selectedPatientId,
  selectedUnitId,
  reducedMotion = false,
  journeys = [],
  motionWindow = null,
  moving = false,
  motionDurationMs = 1000,
  onBedSelect,
  onUnitSelect,
  onAreaSelect,
}: {
  plan: FloorPlan;
  retaining?: boolean;
  zoom?: number;
  selectedPatientId?: string;
  selectedUnitId?: string;
  reducedMotion?: boolean;
  journeys?: FloorJourney[];
  motionWindow?: FloorMotionWindow | null;
  moving?: boolean;
  motionDurationMs?: number;
  onBedSelect: (bed: FloorBed, unit: FloorUnit) => void;
  onUnitSelect: (unit: FloorUnit) => void;
  onAreaSelect: (area: "ed" | "bed" | "discharge") => void;
}) {
  const building = useRef<HTMLDivElement>(null);
  const fitViewport = useRef<HTMLDivElement>(null);
  const [fitSize, setFitSize] = useState({
    viewportWidth: 0,
    viewportHeight: 0,
    contentWidth: 1000,
    contentHeight: 0,
  });
  const upper = plan.units.filter((unit) => unit.kind === "ward");
  const critical = plan.units.filter((unit) => unit.kind === "icu");
  const emergency = plan.units.filter(
    (unit) => !["ward", "icu"].includes(unit.kind),
  );
  const layoutKey = plan.units
    .map((unit) => `${unit.id}:${unit.beds.length}`)
    .join("|");
  useLayoutEffect(() => {
    const viewport = fitViewport.current,
      node = building.current;
    if (!viewport || !node) return;
    const measure = () => {
      const style = getComputedStyle(viewport);
      const viewportWidth = Math.max(
        0,
        viewport.clientWidth -
          parseFloat(style.paddingLeft || "0") -
          parseFloat(style.paddingRight || "0"),
      );
      const viewportHeight = Math.max(
        0,
        viewport.clientHeight -
          parseFloat(style.paddingTop || "0") -
          parseFloat(style.paddingBottom || "0"),
      );
      const next = {
        viewportWidth,
        viewportHeight,
        contentWidth: floorPlanNaturalWidth(viewportWidth),
        contentHeight: node.offsetHeight,
      };
      setFitSize((previous) =>
        Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layoutKey, fitSize.contentWidth]);
  const fitScale = floorPlanFitScale(fitSize),
    mapScale = fitScale * zoom;
  const roomProps = {
    selectedPatientId,
    selectedUnitId,
    reducedMotion,
    onBedSelect,
    onUnitSelect,
  };
  return (
    <section
      className={`hospital-floor-plan${reducedMotion ? " hospital-floor-plan--still" : ""}`}
      data-testid="replay-floor-plan"
      data-recorded-at={plan.at || ""}
      data-replication-id={plan.replicationId || ""}
      data-retaining={retaining ? "true" : "false"}
      data-fit-mode={zoom === 1 ? "fit" : "manual"}
      data-fit-scale={fitScale}
      data-map-scale={mapScale}
      aria-label="Hospital floor plan"
      title={
        retaining
          ? "Holding the last recorded moment while the next loads."
          : "Illustrative layout of recorded units and installed beds. Available places include shared staffing and equipment limits."
      }
    >
      <div className="floor-plan-key">
        <span>
          <i className="floor-key-bed floor-key-bed--occupied" />
          Occupied
        </span>
        <span>
          <i className="floor-key-bed" />
          Ready physical bed
        </span>
        <span>
          <i className="floor-key-bed floor-key-bed--reserved" />
          Reserved
        </span>
        <span>
          <i className="floor-key-bed floor-key-bed--cleaning" />
          Cleaning
        </span>
        <span>
          <i className="floor-key-bed floor-key-bed--blocked" />
          Unavailable / unstaffed
        </span>
        <span title="During playback, a small sample of recorded patient movements follows the corridors. Bed states and counts remain exact.">
          <i className="floor-key-move" />
          Recorded moves
        </span>
        <span className="floor-pressure-key">
          Lower pressure <i className="floor-pressure-gradient" /> Higher
          pressure
        </span>
      </div>
      <div
        ref={fitViewport}
        className="floor-plan-scroll"
        data-testid="floor-plan-fit-viewport"
      >
        <div
          className="floor-plan-scaled-frame"
          style={{
            width: fitSize.contentWidth * mapScale,
            height: fitSize.contentHeight * mapScale,
          }}
        >
          <div
            ref={building}
            className="floor-plan-building"
            style={
              { width: fitSize.contentWidth, zoom: mapScale } as CSSProperties
            }
          >
            <FloorPlanArchitecture
              building={building}
              layoutKey={layoutKey}
              zoom={mapScale}
            />
            <div
              className="floor-plan-upper-wing"
              data-footprint="inpatient-wing"
              style={{
                gridTemplateColumns: `repeat(${Math.max(1, upper.length)}, minmax(160px, 1fr))`,
              }}
            >
              {upper.map((unit) => (
                <HospitalRoom key={unit.id} unit={unit} {...roomProps} />
              ))}
            </div>
            <div
              className="floor-plan-ward-hall floor-plan-corridor"
              data-footprint="inpatient-corridor"
              aria-hidden="true"
            >
              <span>Inpatient corridor</span>
            </div>
            <div
              className="floor-plan-front-spine"
              data-footprint="entrance-spine"
              aria-hidden="true"
            >
              <span className="floor-plan-lobby-label">Lobby</span>
            </div>
            <div className="floor-plan-admission-zone">
              <button
                className="floor-plan-count-area floor-plan-count-area--waiting"
                data-testid="floor-plan-bed-waiting"
                data-count={plan.bedWaiting ?? "unknown"}
                onClick={() => onAreaSelect("bed")}
                title="Patients awaiting their next ward or ICU bed. This is a queue count, not room capacity."
              >
                <strong>Waiting for a bed</strong>
                <b>{value(plan.bedWaiting)}</b>
              </button>
            </div>
            <div
              className="floor-plan-critical-hall"
              data-footprint={critical.length ? "critical-corridor" : undefined}
              data-stacked={critical.length > 1}
              aria-hidden="true"
            />
            <div
              className="floor-plan-critical-wing"
              data-footprint={critical.length ? "critical-wing" : undefined}
            >
              {critical.map((unit) => (
                <HospitalRoom key={unit.id} unit={unit} {...roomProps} />
              ))}
            </div>
            <div
              className="floor-plan-emergency-wing"
              data-footprint={emergency.length ? "emergency-wing" : undefined}
            >
              {emergency.map((unit) => (
                <HospitalRoom key={unit.id} unit={unit} {...roomProps} />
              ))}
            </div>
            <div
              className="floor-plan-emergency-hall"
              data-footprint={
                emergency.length ? "emergency-corridor" : undefined
              }
              data-stacked={emergency.length > 1}
              aria-hidden="true"
            />
            <div className="floor-plan-ed-zone">
              <button
                className="floor-plan-count-area floor-plan-count-area--waiting"
                data-testid="floor-plan-ed-waiting"
                data-count={plan.edWaiting ?? "unknown"}
                onClick={() => onAreaSelect("ed")}
                title="Patients awaiting emergency assessment, before entering emergency treatment. This is a queue count, not room capacity."
              >
                <strong>ED waiting</strong>
                <b>{value(plan.edWaiting)}</b>
              </button>
            </div>
            <div
              className="floor-plan-exit-hall"
              data-footprint="discharge-corridor"
              aria-hidden="true"
            />
            <button
              className="floor-plan-count-area floor-plan-count-area--discharge"
              data-footprint="discharge-area"
              data-testid="floor-plan-discharges"
              data-count={plan.discharges ?? "unknown"}
              onClick={() => onAreaSelect("discharge")}
              title="Recorded discharges since this run began. This area has no modeled beds or dwell time."
            >
              <strong>Discharged so far</strong>
              <b>{value(plan.discharges)}</b>
              <span className="floor-plan-exit" aria-hidden="true">
                Exit →
              </span>
            </button>
            <div className="floor-plan-entrance" aria-hidden="true">
              <span className="floor-plan-entry-door" />
              <span className="floor-plan-hospital-mark">+</span>
              <b>↑ Main entrance</b>
            </div>
            <FloorPlanTransit
              building={building}
              journeys={journeys}
              windowKey={
                motionWindow
                  ? `${motionWindow.rep}|${motionWindow.from}|${motionWindow.to}`
                  : ""
              }
              from={motionWindow?.from || ""}
              to={motionWindow?.to || ""}
              active={moving && !reducedMotion}
              zoom={mapScale}
              motionDurationMs={motionDurationMs}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
