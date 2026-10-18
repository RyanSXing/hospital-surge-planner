import { useRef, useState } from "react";
import { NumberInput, SegmentedControl, Slider } from "@mantine/core";
import type { Dataset } from "../types";
import { fmt } from "../api";
import { humanLabel } from "../presentation";
import {
  mainHospitalUnits,
  minimumPhysicalBeds,
  nurseRatio,
  scheduledStaff,
  staffedBedReadback,
  staffRoles,
} from "./hospitalConfigurationModel";
import type {
  ConfigurationTargets,
  UnitTarget,
} from "./hospitalConfigurationModel";
import "./configurationInputs.css";

export default function ConfigurationInputs({
  dataset,
  start,
  value,
  disabled,
  onEditStart,
  onChange,
}: {
  dataset: Dataset;
  start: string;
  value: ConfigurationTargets;
  disabled?: boolean;
  onEditStart: () => void;
  onChange: (value: ConfigurationTargets) => void;
}) {
  const units = mainHospitalUnits(dataset);
  const [selected, setSelected] = useState("");
  const [inputValues, setInputValues] = useState<
    Record<string, number | string>
  >({});
  const editing = useRef<string | null>(null);
  const unit = units.find((u) => u.unit_id === selected) || units[0];
  if (!unit) return null;
  const target = value.units[unit.unit_id] || {};
  const baseline = scheduledStaff(dataset, unit, start);
  const physical = target.physical_capacity ?? Number(unit.physical_capacity);
  const enabled = target.enabled_capacity ?? Number(unit.enabled_capacity);
  const ratio = nurseRatio(dataset, unit);
  const readback = staffedBedReadback(dataset, unit, target, baseline);
  const staffed = target.staffed_capacity ?? readback.supported;
  const minimum = minimumPhysicalBeds(dataset, unit);
  const noun = unit.kind === "ed" ? "places" : "beds";
  function update(key: string, next: UnitTarget) {
    if (disabled) return;
    if (editing.current !== key) {
      onEditStart();
      editing.current = key;
    }
    onChange({
      ...value,
      units: { ...value.units, [unit.unit_id]: { ...target, ...next } },
    });
  }
  const inputKey = (name: string) => `${unit.unit_id}:${name}`;
  function clearInput(name: string) {
    setInputValues((previous) => {
      const next = { ...previous };
      delete next[inputKey(name)];
      return next;
    });
  }
  function typeNumber(
    name: string,
    next: number | string,
    min: number,
    max: number,
    change: (number: number) => void,
  ) {
    setInputValues((previous) => ({ ...previous, [inputKey(name)]: next }));
    if (
      typeof next === "number" &&
      Number.isInteger(next) &&
      next >= min &&
      next <= max
    )
      change(next);
  }
  function finishNumber(
    name: string,
    fallback: number,
    min: number,
    max: number,
    change: (number: number) => void,
  ) {
    const raw = inputValues[inputKey(name)];
    if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) {
      const normalized = Math.max(min, Math.min(max, Math.round(Number(raw))));
      if (normalized !== fallback) change(normalized);
    }
    clearInput(name);
    editing.current = null;
  }
  const changeBeds = (beds: number) =>
    update("beds", {
      physical_capacity: beds,
      enabled_capacity: beds,
      staffed_capacity: Math.min(staffed, beds),
    });
  const changeStaffed = (beds: number) =>
    update("staffed", { staffed_capacity: beds, rn: Math.ceil(beds / ratio) });
  return (
    <section
      className="configuration-inputs"
      id="hospital-capacity-parameters"
      aria-labelledby="hospital-capacity-title"
    >
      <header>
        <div>
          <h3 id="hospital-capacity-title">Beds & staffing</h3>
          <p>Set the capacity and people available for each shift.</p>
        </div>
        <span>At the start of the simulation</span>
      </header>
      <SegmentedControl
        aria-label="Hospital unit to configure"
        value={unit.unit_id}
        onChange={(next) => {
          editing.current = null;
          setSelected(next);
        }}
        data={units.map((u) => ({
          value: u.unit_id,
          label: u.kind === "ed" ? "Emergency" : humanLabel(u.name || u.kind),
        }))}
      />
      <div className="configuration-capacity-fields">
        <NumberInput
          label={`Total ${noun}`}
          aria-label={`${unit.name} total ${noun}`}
          description={`Includes occupied ${noun}`}
          value={inputValues[inputKey("beds")] ?? physical}
          min={minimum}
          max={1000}
          allowDecimal={false}
          disabled={disabled}
          onChange={(next) =>
            typeNumber("beds", next, minimum, 1000, changeBeds)
          }
          onBlur={() =>
            finishNumber("beds", physical, minimum, 1000, changeBeds)
          }
        />
        <NumberInput
          label={`Staffed ${noun}`}
          aria-label={`${unit.name} staffed ${noun}`}
          description="Adjusts the nurse count to match"
          value={inputValues[inputKey("staffed")] ?? staffed}
          min={0}
          max={enabled}
          allowDecimal={false}
          disabled={disabled}
          onChange={(next) =>
            typeNumber("staffed", next, 0, enabled, changeStaffed)
          }
          onBlur={() =>
            finishNumber("staffed", staffed, 0, enabled, changeStaffed)
          }
        />
      </div>
      <div className="configuration-staff-sliders">
        {staffRoles.map(({ key, label }) => {
          const count = target[key] ?? baseline[key];
          const maximum = Math.min(
            500,
            Math.max(key === "rn" ? 30 : 10, Math.ceil(count / 10) * 10),
          );
          const change = (next: number) =>
            update(key, {
              [key]: next,
              ...(key === "rn"
                ? {
                    staffed_capacity: Math.min(
                      enabled,
                      Math.floor(next * ratio),
                    ),
                  }
                : {}),
            });
          return (
            <div
              className="configuration-staff-control"
              key={`${unit.unit_id}-${key}`}
            >
              <div>
                <label htmlFor={`configuration-${unit.unit_id}-${key}`}>
                  {label}
                </label>
                <NumberInput
                  id={`configuration-${unit.unit_id}-${key}`}
                  aria-label={`${unit.name} ${label.toLowerCase()}`}
                  value={inputValues[inputKey(key)] ?? count}
                  min={0}
                  max={500}
                  allowDecimal={false}
                  disabled={disabled}
                  onChange={(next) => typeNumber(key, next, 0, 500, change)}
                  onBlur={() => finishNumber(key, count, 0, 500, change)}
                />
              </div>
              <Slider
                thumbLabel={`${unit.name} ${label.toLowerCase()} per shift`}
                min={0}
                max={maximum}
                step={1}
                value={count}
                disabled={disabled}
                label={(next) => `${next} per shift`}
                onChange={(next) => {
                  clearInput(key);
                  clearInput("staffed");
                  change(next);
                }}
                onChangeEnd={() => {
                  editing.current = null;
                }}
              />
              <span>{fmt(count)} per shift</span>
            </div>
          );
        })}
      </div>
      <div
        className={`configuration-capacity-readback${readback.usable < staffed ? " has-shortage" : ""}`}
        role="status"
      >
        <strong>
          {fmt(readback.usable)} {noun} supported
        </strong>
        <span>
          {!readback.gate
            ? "More doctors or support staff are needed to receive patients."
            : readback.supported < staffed
              ? Math.floor((target.rn ?? baseline.rn) * ratio) < staffed
                ? "More nurses are needed to reach the staffed-bed setting."
                : "Current equipment limits the usable capacity."
              : `One nurse supports up to ${ratio} ${noun}.`}
        </span>
      </div>
      <p className="configuration-inputs-note">
        Scheduled changes in More parameters can adjust these starting settings
        later.
      </p>
    </section>
  );
}
