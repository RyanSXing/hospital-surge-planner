import { useEffect, useMemo, useRef, useState } from "react";
import { NumberInput, Slider, Switch, TextInput } from "@mantine/core";
import { CalendarPlus, Trash2 } from "lucide-react";
import { Button } from "../components/ui";
import { utcToWall } from "../zonedTime";
import type {
  HospitalDisruption,
  HospitalOperations,
  PatientSeverity,
  SeverityMix,
} from "../types";
import {
  averageSeverityStay,
  changeSeverityShare,
  defaultSeverityMix,
  defaultSupplies,
  disruptionForDate,
  disruptionWithinHorizon,
  firstDisruptionDate,
  moveSeverityBoundary,
  operationsError,
  severityOrder,
  withOperation,
} from "./hospitalOperationsModel";
import "./hospitalOperations.css";

const severityLabels: Record<PatientSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
const severityColors: Record<PatientSeverity, string> = {
  low: "#3c9a8a",
  medium: "#d8a03a",
  high: "#c66a73",
};
const noDisruptions: HospitalDisruption[] = [];

function NumericField({
  value,
  min,
  max,
  onChange,
  onFinish,
  ...rest
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onFinish: () => void;
  label?: string;
  "aria-label": string;
  suffix?: string;
  step?: number;
  decimalScale?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState<number | string>(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <NumberInput
      {...rest}
      size="xs"
      value={text}
      min={min}
      max={max}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(next) => {
        setText(next);
        if (
          typeof next === "number" &&
          Number.isFinite(next) &&
          next >= min &&
          next <= max
        )
          onChange(next);
      }}
      onBlur={() => {
        const normalized =
          text === "" || !Number.isFinite(Number(text))
            ? value
            : Math.max(min, Math.min(max, Number(text)));
        setText(normalized);
        focused.current = false;
        if (normalized !== value) onChange(normalized);
        onFinish();
      }}
    />
  );
}
const pointAt = (percent: number, radius = 72) => {
  const angle = (percent / 100) * Math.PI * 2 - Math.PI / 2;
  return { x: 90 + Math.cos(angle) * radius, y: 90 + Math.sin(angle) * radius };
};
function slicePath(start: number, end: number) {
  if (end - start >= 99.999) return "M90 18 A72 72 0 1 1 89.99 18 L90 90 Z";
  const a = pointAt(start),
    b = pointAt(end);
  return `M90 90 L${a.x} ${a.y} A72 72 0 ${end - start > 50 ? 1 : 0} 1 ${b.x} ${b.y} Z`;
}
function SeverityPie({
  mix,
  disabled,
  onEditStart,
  onFinish,
  onChange,
}: {
  mix: SeverityMix;
  disabled?: boolean;
  onEditStart: () => void;
  onFinish: () => void;
  onChange: (mix: SeverityMix) => void;
}) {
  const [dragging, setDragging] = useState<0 | 1 | null>(null);
  const boundaries = [
    mix.low.percentage,
    mix.low.percentage + mix.medium.percentage,
  ];
  let cumulative = 0;
  return (
    <svg
      className="severity-pie"
      viewBox="0 0 180 180"
      role="group"
      aria-label="Editable patient severity pie chart"
      onPointerMove={(event) => {
        if (dragging === null || disabled) return;
        const rect = event.currentTarget.getBoundingClientRect();
        let angle =
          Math.atan2(
            event.clientY - rect.top - rect.height / 2,
            event.clientX - rect.left - rect.width / 2,
          ) +
          Math.PI / 2;
        if (angle < 0) angle += Math.PI * 2;
        // Keep a handle approaching midnight at its nearest end, rather than wrapping 100% → 0%.
        let percent = (angle / (Math.PI * 2)) * 100;
        if (percent < 5 && boundaries[dragging] > 95) percent = 100;
        else if (percent > 95 && boundaries[dragging] < 5) percent = 0;
        onChange(moveSeverityBoundary(mix, dragging, percent));
      }}
      onPointerUp={() => {
        setDragging(null);
        onFinish();
      }}
      onPointerCancel={() => {
        setDragging(null);
        onFinish();
      }}
      onLostPointerCapture={() => {
        setDragging(null);
        onFinish();
      }}
    >
      <title>
        Patient severity percentages. Drag the two circular handles, or use the
        percentage controls.
      </title>
      {severityOrder.map((key) => {
        const start = cumulative;
        cumulative += mix[key].percentage;
        return mix[key].percentage > 0 ? (
          <path
            key={key}
            d={slicePath(start, cumulative)}
            fill={severityColors[key]}
          >
            <title>
              {severityLabels[key]} severity: {mix[key].percentage}%
            </title>
          </path>
        ) : null;
      })}
      <circle cx="90" cy="90" r="43" fill="white" />
      <text x="90" y="87" textAnchor="middle" className="severity-pie-total">
        100%
      </text>
      <text x="90" y="105" textAnchor="middle" className="severity-pie-caption">
        patient mix
      </text>
      {boundaries.map((boundary, index) => {
        const position = pointAt(boundary);
        return (
          <circle
            key={index}
            {...{ cx: position.x, cy: position.y }}
            r="7"
            fill="white"
            stroke="#456d8b"
            strokeWidth="2"
            className="severity-pie-handle"
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={
              index === 0
                ? "Low and medium severity boundary"
                : "Medium and high severity boundary"
            }
            aria-valuemin={index === 0 ? 0 : mix.low.percentage}
            aria-valuemax={index === 0 ? boundaries[1] : 100}
            aria-valuenow={boundary}
            aria-disabled={disabled || undefined}
            onPointerDown={(event) => {
              if (disabled) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              onEditStart();
              setDragging(index as 0 | 1);
            }}
            onKeyDown={(event) => {
              if (
                disabled ||
                ![
                  "ArrowLeft",
                  "ArrowDown",
                  "ArrowRight",
                  "ArrowUp",
                  "Home",
                  "End",
                ].includes(event.key)
              )
                return;
              event.preventDefault();
              onEditStart();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 100
                    : boundary +
                      (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1);
              onChange(moveSeverityBoundary(mix, index as 0 | 1, next));
              onFinish();
            }}
          />
        );
      })}
    </svg>
  );
}

export default function HospitalOperationsControls({
  value,
  start,
  end,
  timeZone,
  disabled,
  onEditStart,
  onChange,
}: {
  value: HospitalOperations | null | undefined;
  start: string;
  end: string;
  timeZone: string;
  disabled?: boolean;
  onEditStart: () => void;
  onChange: (value: HospitalOperations | null) => void;
}) {
  const editing = useRef<string | null>(null);
  const [dateError, setDateError] = useState("");
  const mix = value?.severity_mix || defaultSeverityMix();
  const supplies = value?.supplies || defaultSupplies();
  const disruptions = value?.disruptions || noDisruptions;
  const availableDate = useMemo(
    () => firstDisruptionDate(start, end, timeZone, disruptions),
    [start, end, timeZone, disruptions],
  );
  const mixEnabled = Boolean(value?.severity_mix),
    suppliesEnabled = Boolean(value?.supplies);
  const finish = () => {
    editing.current = null;
  };
  function edit(key: string, next: HospitalOperations | null) {
    if (disabled) return;
    if (editing.current !== key) {
      onEditStart();
      editing.current = key;
    }
    onChange(next);
  }
  function changeMix(next: SeverityMix, key: string) {
    edit(key, withOperation(value, "severity_mix", next));
  }
  function changeSupply(key: keyof typeof supplies, next: number) {
    edit(
      `supplies-${key}`,
      withOperation(value, "supplies", { ...supplies, [key]: next }),
    );
  }
  const minimumDate = utcToWall(start, timeZone).slice(0, 10);
  const maximumDate = utcToWall(
    new Date(Date.parse(end) - 1).toISOString(),
    timeZone,
  ).slice(0, 10);
  const error = operationsError(value, start, end);
  return (
    <section
      className="hospital-operations"
      aria-labelledby="hospital-operations-title"
    >
      <header>
        <h3 id="hospital-operations-title">
          Patient needs & hospital operations
        </h3>
        <span>Applied to new simulation runs</span>
      </header>
      <div className="hospital-operations-grid">
        <section
          className="operations-panel severity-panel"
          aria-labelledby="patient-severity-title"
        >
          <header>
            <h4 id="patient-severity-title">Patient severity</h4>
            <Switch
              size="xs"
              label="Apply severity mix"
              checked={mixEnabled}
              disabled={disabled}
              onChange={(event) => {
                edit(
                  "toggle-severity",
                  withOperation(
                    value,
                    "severity_mix",
                    event.currentTarget.checked
                      ? defaultSeverityMix()
                      : undefined,
                  ),
                );
                finish();
              }}
            />
          </header>
          <p>Set the patient mix and average stay after admission to a bed.</p>
          <div
            className={`severity-editor ${mixEnabled ? "" : "operations-inactive"}`}
          >
            <div className="severity-chart-wrap">
              <SeverityPie
                mix={mix}
                disabled={disabled || !mixEnabled}
                onEditStart={() => {
                  if (editing.current !== "severity-pie") {
                    onEditStart();
                    editing.current = "severity-pie";
                  }
                }}
                onFinish={finish}
                onChange={(next) => changeMix(next, "severity-pie")}
              />
              <span>
                {mixEnabled
                  ? "Drag the handles to adjust"
                  : "Turn on to customize"}
              </span>
            </div>
            <div className="severity-fields">
              <div className="severity-field-head">
                <span>Severity</span>
                <span>Share</span>
                <span>Average stay</span>
              </div>
              {severityOrder.map((key) => (
                <div className="severity-row" key={key}>
                  <label>
                    <i style={{ background: severityColors[key] }} />
                    {severityLabels[key]}
                  </label>
                  <div className="severity-share">
                    <NumericField
                      aria-label={`${severityLabels[key]} severity percentage`}
                      suffix="%"
                      value={mix[key].percentage}
                      min={0}
                      max={100}
                      decimalScale={2}
                      disabled={disabled || !mixEnabled}
                      onChange={(next) =>
                        changeMix(
                          changeSeverityShare(mix, key, next),
                          `severity-${key}`,
                        )
                      }
                      onFinish={finish}
                    />
                    <Slider
                      value={mix[key].percentage}
                      min={0}
                      max={100}
                      step={1}
                      color={severityColors[key]}
                      size="xs"
                      thumbSize={12}
                      disabled={disabled || !mixEnabled}
                      thumbLabel={`${severityLabels[key]} severity share`}
                      label={(next) => `${next}%`}
                      onChange={(next) =>
                        changeMix(
                          changeSeverityShare(mix, key, next),
                          `severity-${key}`,
                        )
                      }
                      onChangeEnd={finish}
                    />
                  </div>
                  <NumericField
                    aria-label={`${severityLabels[key]} severity average stay hours`}
                    suffix=" h"
                    value={mix[key].average_stay_hours}
                    min={0.1}
                    max={8760}
                    decimalScale={1}
                    step={1}
                    disabled={disabled || !mixEnabled}
                    onChange={(next) =>
                      changeMix(
                        {
                          ...mix,
                          [key]: { ...mix[key], average_stay_hours: next },
                        },
                        `stay-${key}`,
                      )
                    }
                    onFinish={finish}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="operations-readback">
            {mixEnabled ? (
              <>
                Average across this mix:{" "}
                <strong>
                  {(averageSeverityStay(mix) / 24).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}{" "}
                  days
                </strong>
              </>
            ) : (
              "Existing patient stay assumptions remain in use."
            )}
          </div>
        </section>
        <section
          className="operations-panel supplies-panel"
          aria-labelledby="medical-supplies-title"
        >
          <header>
            <h4 id="medical-supplies-title">Medical supplies</h4>
            <Switch
              size="xs"
              label="Track supplies"
              checked={suppliesEnabled}
              disabled={disabled}
              onChange={(event) => {
                edit(
                  "toggle-supplies",
                  withOperation(
                    value,
                    "supplies",
                    event.currentTarget.checked ? defaultSupplies() : undefined,
                  ),
                );
                finish();
              }}
            />
          </header>
          <p>One shared stock level for the hospital.</p>
          <div className={suppliesEnabled ? "" : "operations-inactive"}>
            <div className="supply-stock-label">
              <label>Starting stock</label>
              <NumericField
                aria-label="Starting medical supply percentage"
                value={supplies.initial_percent}
                min={0}
                max={100}
                suffix="%"
                decimalScale={1}
                disabled={disabled || !suppliesEnabled}
                onChange={(next) => changeSupply("initial_percent", next)}
                onFinish={finish}
              />
            </div>
            <Slider
              value={supplies.initial_percent}
              min={0}
              max={100}
              step={1}
              thumbLabel="Starting medical supply percentage"
              label={(next) => `${next}%`}
              disabled={disabled || !suppliesEnabled}
              onChange={(next) => changeSupply("initial_percent", next)}
              onChangeEnd={finish}
            />
            <div className="supply-fields">
              <NumericField
                label="Refill every"
                aria-label="Supply refill interval days"
                value={supplies.refill_every_days}
                min={1}
                max={365}
                suffix=" days"
                decimalScale={0}
                disabled={disabled || !suppliesEnabled}
                onChange={(next) =>
                  changeSupply("refill_every_days", Math.round(next))
                }
                onFinish={finish}
              />
              <NumericField
                label="Amount per refill"
                aria-label="Supply refill percentage"
                value={supplies.refill_percent}
                min={0}
                max={100}
                suffix="%"
                decimalScale={1}
                disabled={disabled || !suppliesEnabled}
                onChange={(next) => changeSupply("refill_percent", next)}
                onFinish={finish}
              />
              <NumericField
                label="Maximum stock"
                aria-label="Maximum medical supply capacity"
                value={supplies.capacity}
                min={0.1}
                max={1000000000}
                suffix=" units"
                decimalScale={1}
                disabled={disabled || !suppliesEnabled}
                onChange={(next) => changeSupply("capacity", next)}
                onFinish={finish}
              />
              <NumericField
                label="Use per patient / day"
                aria-label="Medical supply usage per patient per day"
                value={supplies.usage_per_patient_day}
                min={0}
                max={1000000}
                suffix=" units"
                decimalScale={2}
                disabled={disabled || !suppliesEnabled}
                onChange={(next) => changeSupply("usage_per_patient_day", next)}
                onFinish={finish}
              />
            </div>
          </div>
          <div className="operations-readback">
            {suppliesEnabled ? (
              <>
                Refills add {supplies.refill_percent}% of maximum stock, up to
                100%. Care pauses if stock runs out.
              </>
            ) : (
              "Supply shortages are not modeled until enabled."
            )}
          </div>
        </section>
      </div>
      <section
        className="disruption-controls"
        aria-labelledby="disruption-title"
      >
        <div>
          <h4 id="disruption-title">Treatment disruptions</h4>
          <p>Choose a day when treatment stops. Patients continue arriving.</p>
        </div>
        <Button
          disabled={disabled || !availableDate}
          onClick={() => {
            const date = availableDate;
            if (!date) return;
            edit(
              "add-disruption",
              withOperation(value, "disruptions", [
                ...disruptions,
                disruptionForDate(
                  date,
                  timeZone,
                  `disruption-${crypto.randomUUID()}`,
                ),
              ]),
            );
            setDateError("");
            finish();
          }}
        >
          <CalendarPlus size={15} />
          Add disruption
        </Button>
        {disruptions.length > 0 && (
          <div className="disruption-list">
            {disruptions.map((disruption, index) => (
              <div className="disruption-row" key={disruption.id}>
                <TextInput
                  size="xs"
                  type="date"
                  label={`Disruption ${index + 1}`}
                  aria-label={`Disruption ${index + 1} date`}
                  value={utcToWall(disruption.start_at, timeZone).slice(0, 10)}
                  min={minimumDate}
                  max={maximumDate}
                  disabled={disabled}
                  onChange={(event) => {
                    if (!event.currentTarget.value) return;
                    try {
                      const interval = disruptionForDate(
                        event.currentTarget.value,
                        timeZone,
                        disruption.id,
                      );
                      const next = {
                        ...disruption,
                        start_at: interval.start_at,
                        end_at: interval.end_at,
                      };
                      if (!disruptionWithinHorizon(next, start, end))
                        throw new Error(
                          "Choose a complete day within the simulation.",
                        );
                      if (
                        disruptions.some(
                          (item) =>
                            item.id !== next.id &&
                            item.start_at === next.start_at,
                        )
                      )
                        throw new Error(
                          "There is already a disruption on this date.",
                        );
                      edit(
                        `disruption-${disruption.id}`,
                        withOperation(
                          value,
                          "disruptions",
                          disruptions.map((item) =>
                            item.id === next.id ? next : item,
                          ),
                        ),
                      );
                      setDateError("");
                      finish();
                    } catch (reason) {
                      setDateError((reason as Error).message);
                    }
                  }}
                />
                <span>No treatment · full local day</span>
                <button
                  type="button"
                  className="disruption-remove"
                  aria-label={`Remove disruption ${index + 1}`}
                  disabled={disabled}
                  onClick={() => {
                    edit(
                      `remove-${disruption.id}`,
                      withOperation(
                        value,
                        "disruptions",
                        disruptions.filter((item) => item.id !== disruption.id),
                      ),
                    );
                    setDateError("");
                    finish();
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
        {dateError && (
          <p className="operations-error" role="alert">
            {dateError}
          </p>
        )}
      </section>
      {error && (
        <p className="operations-error" role="alert">
          {error}
        </p>
      )}
      <details className="operations-definitions">
        <summary>How these settings affect the simulation</summary>
        <p>
          Severity is assigned to new arrivals. For patients admitted to a bed,
          the average you set controls their total inpatient and step-down care
          time. Emergency and clinic assessments keep their separate baseline
          durations. Patients discharged from emergency care do not receive an
          inpatient stay. Waiting and interruptions add extra time. Patients
          already in the hospital keep their remaining stay. Supplies are used
          by patients actively receiving care, measured per 24 hours. Refills
          follow local calendar days from the simulation start and add stock up
          to the maximum. During a disruption or when supplies are empty,
          treatment pauses, arrivals continue, and care resumes when the
          constraint clears. Disruptions use {timeZone}.
        </p>
      </details>
    </section>
  );
}
