import { useRef, type CSSProperties } from "react";
import type { FloorBed, FloorPlan, FloorUnit } from "./replayFloorPlanModel";
import type { FloorJourney, FloorMotionWindow } from "./floorPlanTransitModel";
import FloorPlanTransit from "./FloorPlanTransit";
import "./replayFloorPlan.css";

const value = (number: number | null) =>
  number === null ? "—" : number.toLocaleString();
interface RoomProps {
  unit: FloorUnit;
  selectedPatientId?: string;
  selectedUnitId?: string;
  onBedSelect: (bed: FloorBed, unit: FloorUnit) => void;
  onUnitSelect: (unit: FloorUnit) => void;
}
function HospitalRoom({
  unit,
  selectedPatientId,
  selectedUnitId,
  onBedSelect,
  onUnitSelect,
}: RoomProps) {
  return (
    <article
      className={`floor-plan-unit floor-plan-unit--${unit.kind}${selectedUnitId === unit.id ? " floor-plan-unit--selected" : ""}`}
      data-unit-id={unit.id}
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
            <button
              key={bed.id}
              className={`floor-plan-bed floor-plan-bed--${bed.status}${bed.patientId && bed.patientId === selectedPatientId ? " floor-plan-bed--selected" : ""}`}
              data-slot-id={bed.id}
              data-unit-id={unit.id}
              data-status={bed.status}
              data-patient-id={bed.patientId || undefined}
              aria-label={`${unit.name}, ${bed.label}: ${bed.description}`}
              aria-pressed={Boolean(
                bed.patientId && bed.patientId === selectedPatientId,
              )}
              title={`${bed.label} · ${bed.description}`}
              onClick={() => onBedSelect(bed, unit)}
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
  onBedSelect: (bed: FloorBed, unit: FloorUnit) => void;
  onUnitSelect: (unit: FloorUnit) => void;
  onAreaSelect: (area: "ed" | "bed" | "discharge") => void;
}) {
  const building = useRef<HTMLDivElement>(null);
  const upper = plan.units.filter((unit) => unit.kind === "ward");
  const lower = plan.units.filter((unit) => unit.kind !== "ward");
  const roomProps = {
    selectedPatientId,
    selectedUnitId,
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
      aria-label="Hospital floor plan"
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
      <div className="floor-plan-scroll">
        <div
          ref={building}
          className="floor-plan-building"
          style={{ zoom } as CSSProperties}
        >
          {upper.length ? (
            <div
              className="floor-plan-upper-wing"
              style={{
                gridTemplateColumns: `repeat(${upper.length}, minmax(160px, 1fr))`,
              }}
            >
              {upper.map((unit) => (
                <HospitalRoom key={unit.id} unit={unit} {...roomProps} />
              ))}
            </div>
          ) : null}
          <div className="floor-plan-corridor" aria-hidden="true">
            <span className="floor-plan-entrance">
              → <b>Main entrance</b>
            </span>
            <span>Patient corridor</span>
            <span className="floor-plan-corridor-arrow">→</span>
          </div>
          <div
            className="floor-plan-lower-wing"
            style={{
              gridTemplateColumns: `repeat(${lower.length + 1}, minmax(160px, 1fr))`,
            }}
          >
            {lower.map((unit) => (
              <HospitalRoom key={unit.id} unit={unit} {...roomProps} />
            ))}
            <div className="floor-plan-support-areas">
              <button
                className="floor-plan-count-area"
                data-testid="floor-plan-ed-waiting"
                data-count={plan.edWaiting ?? "unknown"}
                onClick={() => onAreaSelect("ed")}
                title="Patients awaiting emergency assessment. This is a queue count, not room capacity."
              >
                <strong>ED waiting</strong>
                <b>{value(plan.edWaiting)}</b>
              </button>
              <button
                className="floor-plan-count-area"
                data-testid="floor-plan-bed-waiting"
                data-count={plan.bedWaiting ?? "unknown"}
                onClick={() => onAreaSelect("bed")}
                title="Patients waiting in ED or ICU for their next bed. This is a queue count, not room capacity."
              >
                <strong>Waiting for a bed</strong>
                <b>{value(plan.bedWaiting)}</b>
              </button>
              <button
                className="floor-plan-count-area floor-plan-count-area--discharge"
                data-testid="floor-plan-discharges"
                data-count={plan.discharges ?? "unknown"}
                onClick={() => onAreaSelect("discharge")}
                title="Recorded discharges since this run began. This area has no modeled beds or dwell time."
              >
                <strong>Discharged so far</strong>
                <b>{value(plan.discharges)}</b>
                <span className="floor-plan-exit" aria-hidden="true">
                  → Exit
                </span>
              </button>
            </div>
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
            zoom={zoom}
          />
        </div>
      </div>
      <div className="floor-plan-caption">
        <span>
          {retaining
            ? "Holding the last recorded moment while the next loads."
            : "Available counts include shared staffing and equipment limits."}
        </span>
        <span>Illustrative layout · recorded units and installed beds</span>
      </div>
    </section>
  );
}
