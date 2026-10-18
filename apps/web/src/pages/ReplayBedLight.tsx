import { useLayoutEffect, useRef } from "react";
import type { FloorBed, FloorUnit } from "./replayFloorPlanModel";
import "./replayBedLight.css";

/** A bed changes its light once when its recorded occupancy switches. */
export default function ReplayBedLight({
  bed,
  unit,
  selected = false,
  reducedMotion = false,
  onSelect,
}: {
  bed: FloorBed;
  unit: FloorUnit;
  selected?: boolean;
  reducedMotion?: boolean;
  onSelect: (bed: FloorBed, unit: FloorUnit) => void;
}) {
  const node = useRef<HTMLButtonElement>(null);
  const previous = useRef(bed.status === "occupied");
  const occupied = bed.status === "occupied";
  useLayoutEffect(() => {
    const changed = previous.current !== occupied;
    previous.current = occupied;
    const element = node.current;
    if (!element || !changed || reducedMotion) return;
    const direction = occupied ? "on" : "off";
    element.dataset.lightChange = direction;
    const glow = occupied ? "68, 155, 225" : "133, 167, 194";
    const flash = element.animate(
      [
        { boxShadow: `0 0 0 0 rgba(${glow}, 0)`, filter: "brightness(1)" },
        {
          boxShadow: `0 0 5px 1px rgba(${glow}, 0.7)`,
          filter: "brightness(1.35)",
          offset: 0.25,
        },
        { boxShadow: `0 0 0 0 rgba(${glow}, 0)`, filter: "brightness(1)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
    const clear = () => {
      delete element.dataset.lightChange;
    };
    flash.addEventListener("finish", clear, { once: true });
    return () => {
      flash.removeEventListener("finish", clear);
      flash.cancel();
      clear();
    };
  }, [occupied, reducedMotion]);
  return (
    <button
      ref={node}
      className={`floor-plan-bed floor-plan-bed--${bed.status}${selected ? " floor-plan-bed--selected" : ""}`}
      data-slot-id={bed.id}
      data-unit-id={unit.id}
      data-status={bed.status}
      data-patient-id={bed.patientId || undefined}
      data-light-state={occupied ? "on" : "off"}
      aria-label={`${unit.name}, ${bed.label}: ${bed.description}`}
      aria-pressed={selected}
      title={`${bed.label} · ${bed.description}`}
      onClick={() => onSelect(bed, unit)}
    />
  );
}
