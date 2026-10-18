import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useElementSize } from "@mantine/hooks";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { localDate, fmt } from "../api";
import type { Entity } from "../types";
import { plannedArrivals } from "./plannedArrivalSeries";
import type { ArrivalPreviewOptions } from "./plannedArrivalSeries";
import { editPlannedArrivalDay } from "./arrivalCurveEditing";
import "./arrivalCurveEditing.css";

export interface ArrivalPreviewProps extends ArrivalPreviewOptions {
  editable?: boolean;
  /** Called once before the first changed value, so one gesture is one undo. */
  onEditStart?: () => void;
  onConditionsChange?: (
    conditions: Entity[],
    editedConditionId: string,
  ) => void;
  onEditEnd?: () => void;
}
interface EditGesture {
  source: "pointer" | "keyboard";
  pointerId?: number;
  at: string;
  minimum: number;
  value: number;
  ceiling: number;
  changed: boolean;
  options: ArrivalPreviewProps;
}

export default function ArrivalPreview(options: ArrivalPreviewProps) {
  const { ref, width } = useElementSize();
  const id = useId();
  const headingId = `arrival-preview-heading-${id}`,
    descriptionId = `arrival-preview-help-${id}`;
  const gesture = useRef<EditGesture | null>(null),
    frame = useRef<number | null>(null),
    pendingValue = useRef<number | null>(null);
  const [lockedCeiling, setLockedCeiling] = useState<number | null>(null),
    [activeAt, setActiveAt] = useState<string | null>(null),
    [windowStart, setWindowStart] = useState(0),
    [editError, setEditError] = useState("");
  const editable = !!options.editable && !!options.onConditionsChange;
  const W = Math.max(200, Math.round(width || 640)),
    H = 230;
  const allPoints = plannedArrivals(options);
  const windowSize = 31,
    first = Math.min(windowStart, Math.max(0, allPoints.length - 1)),
    points = allPoints.slice(first, first + windowSize);
  const high = Math.max(
    options.baselineRate,
    ...points.map((point) => point.planned),
    ...points.map((point) => point.baseline),
    1,
  );
  const ceiling = lockedCeiling ?? Math.ceil((high * 1.18) / 10) * 10;
  const left = 48,
    right = W - 14,
    top = 20,
    bottom = H - 36;
  const x = (index: number) =>
    points.length === 1
      ? (left + right) / 2
      : left + ((right - left) * index) / (points.length - 1);
  const y = (value: number) => bottom - ((bottom - top) * value) / ceiling;
  const plannedPath = points
    .map(
      (point, index) => `${index ? "L" : "M"}${x(index)},${y(point.planned)}`,
    )
    .join(" ");
  const path =
    points.length === 1
      ? `M${left},${y(points[0].planned)} L${right},${y(points[0].planned)}`
      : plannedPath;
  const baselinePath = points
    .map(
      (point, index) => `${index ? "L" : "M"}${x(index)},${y(point.baseline)}`,
    )
    .join(" ");
  const usual =
    allPoints.reduce((sum, point) => sum + point.baseline, 0) /
    Math.max(1, allPoints.length);
  const average =
    allPoints.reduce((sum, point) => sum + point.planned, 0) /
    Math.max(1, allPoints.length);
  const dates = [
    ...new Set(
      W < 350
        ? [0, points.length - 1]
        : [0, Math.floor((points.length - 1) / 2), points.length - 1],
    ),
  ];
  const active = allPoints.find((point) => point.at === activeAt);
  const dateLabel = (at: string, weekday = false) =>
    localDate(at, {
      ...(weekday ? { weekday: "short" as const } : {}),
      month: "short",
      day: "numeric",
      timeZone: options.timeZone,
    });

  useEffect(() => {
    const current = gesture.current;
    if (
      current &&
      (!editable ||
        current.options.start !== options.start ||
        current.options.end !== options.end ||
        current.options.stream !== options.stream)
    ) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pendingValue.current = null;
      gesture.current = null;
      setLockedCeiling(null);
      if (current.changed) current.options.onEditEnd?.();
    }
  }, [editable, options.start, options.end, options.stream]);
  useEffect(() => {
    setWindowStart(0);
    setActiveAt(null);
    setEditError("");
  }, [options.start, options.end, options.stream]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (gesture.current?.changed) gesture.current.options.onEditEnd?.();
    },
    [],
  );

  function applyValue(value: number) {
    const current = gesture.current;
    if (!current) return;
    const next = Math.max(
      current.minimum,
      Math.min(current.ceiling, Math.round(value)),
    );
    if (Math.abs(next - current.value) < 1e-8) return;
    try {
      const edited = editPlannedArrivalDay(current.options, current.at, next);
      if (!current.changed) {
        current.options.onEditStart?.();
        current.changed = true;
      }
      current.value = edited.planned;
      current.options.onConditionsChange?.(
        edited.conditions,
        edited.conditionId,
      );
      setEditError("");
    } catch (error) {
      setEditError((error as Error).message);
    }
  }
  function flushPending() {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (pendingValue.current !== null) {
      const value = pendingValue.current;
      pendingValue.current = null;
      applyValue(value);
    }
  }
  function finishGesture() {
    flushPending();
    const current = gesture.current;
    gesture.current = null;
    setLockedCeiling(null);
    if (current?.changed) current.options.onEditEnd?.();
  }
  function beginGesture(
    index: number,
    source: EditGesture["source"],
    pointerId?: number,
  ) {
    const point = points[index];
    if (!editable || point.baseline <= 0) return false;
    if (gesture.current) finishGesture();
    gesture.current = {
      source,
      pointerId,
      at: point.at,
      minimum: point.scheduled,
      value: point.planned,
      ceiling,
      changed: false,
      options,
    };
    setActiveAt(point.at);
    setLockedCeiling(ceiling);
    return true;
  }
  function pointerDown(event: PointerEvent<SVGGElement>, index: number) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      !beginGesture(index, "pointer", event.pointerId)
    )
      return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<SVGGElement>) {
    const current = gesture.current;
    if (
      !current ||
      current.source !== "pointer" ||
      current.pointerId !== event.pointerId
    )
      return;
    const svg = event.currentTarget.ownerSVGElement,
      matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return;
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    pendingValue.current =
      ((bottom - Math.max(top, Math.min(bottom, local.y))) / (bottom - top)) *
      current.ceiling;
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const value = pendingValue.current;
        pendingValue.current = null;
        if (value !== null) applyValue(value);
      });
  }
  function pointerEnd(event: PointerEvent<SVGGElement>) {
    if (
      gesture.current?.source === "pointer" &&
      gesture.current.pointerId === event.pointerId
    )
      finishGesture();
  }
  function keyDown(event: KeyboardEvent<SVGGElement>, index: number) {
    const changes: Record<string, number> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 10,
      PageDown: -10,
    };
    if (!(event.key in changes) && !["Home", "End"].includes(event.key)) return;
    if (
      !editable ||
      points[index].baseline <= 0 ||
      gesture.current?.source === "pointer"
    )
      return;
    event.preventDefault();
    if (!gesture.current && !beginGesture(index, "keyboard")) return;
    const current = gesture.current!;
    const next =
      event.key === "Home"
        ? current.minimum
        : event.key === "End"
          ? Math.max(current.minimum, current.ceiling)
          : current.value + changes[event.key] * (event.shiftKey ? 10 : 1);
    applyValue(next);
  }

  return (
    <section
      className={`arrival-preview${editable ? " arrival-preview-editable" : ""}`}
      aria-labelledby={headingId}
    >
      <div className="arrival-preview-heading">
        <div>
          <h3 id={headingId}>Expected daily arrivals</h3>
          <p>
            {options.stream === "ED_MAIN"
              ? "Emergency department"
              : "Direct hospital admissions"}
          </p>
        </div>
        <span className="preview-live">
          <i aria-hidden="true" />
          {editable ? "Drag blue points to edit" : "Updates as you edit"}
        </span>
      </div>
      {allPoints.length > windowSize && (
        <div
          className="arrival-curve-window"
          aria-label="Arrival chart date range"
        >
          <button
            type="button"
            aria-label="Show earlier arrival days"
            disabled={first === 0 || lockedCeiling !== null}
            onClick={() => setWindowStart(Math.max(0, first - windowSize))}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {points.length
              ? `${dateLabel(points[0].at)} – ${dateLabel(points.at(-1)!.at)}`
              : "No days"}
          </span>
          <button
            type="button"
            aria-label="Show later arrival days"
            disabled={
              first + windowSize >= allPoints.length || lockedCeiling !== null
            }
            onClick={() => setWindowStart(first + windowSize)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      <div className="arrival-preview-plot" ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role={editable ? "group" : "img"}
          aria-label={`Planned arrivals over ${options.days} ${options.days === 1 ? "day" : "days"}. Average ${Math.round(average)} patients per day; usual ${Math.round(usual)}.`}
          aria-describedby={editable ? descriptionId : undefined}
          data-testid="arrival-preview-chart"
          data-usual-arrivals={allPoints
            .map((point) => point.baseline.toFixed(2))
            .join(",")}
          data-planned-arrivals={allPoints
            .map((point) => point.planned.toFixed(2))
            .join(",")}
          data-scale-max={ceiling}
        >
          <title>Planned arrivals compared with usual arrivals</title>
          {[0, 1, 2, 3, 4].map((tick) => {
            const value = (ceiling * tick) / 4;
            return (
              <g key={tick} aria-hidden="true">
                <line
                  x1={left}
                  x2={right}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="#e6edf3"
                />
                <text x={left - 10} y={y(value) + 4} textAnchor="end">
                  {fmt(value, 0)}
                </text>
              </g>
            );
          })}
          {points.length > 0 && (
            <>
              <path
                d={`${path} L${right},${bottom} L${left},${bottom} Z`}
                fill="#e8f2fc"
                aria-hidden="true"
              />
              <path
                d={
                  points.length === 1
                    ? `M${left},${y(points[0].baseline)} L${right},${y(points[0].baseline)}`
                    : baselinePath
                }
                fill="none"
                stroke="#8495a7"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                aria-hidden="true"
              />
              <path
                d={path}
                fill="none"
                stroke="#2378bf"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              />
            </>
          )}
          {points.map((point, index) => {
            const canEdit = editable && point.baseline > 0;
            return (
              <g
                key={point.at}
                className={canEdit ? "arrival-curve-handle" : undefined}
                role={canEdit ? "slider" : undefined}
                tabIndex={canEdit ? 0 : undefined}
                aria-label={
                  canEdit ? `${dateLabel(point.at, true)} arrivals` : undefined
                }
                aria-orientation={canEdit ? "vertical" : undefined}
                aria-valuemin={canEdit ? point.scheduled : undefined}
                aria-valuemax={
                  canEdit
                    ? Math.max(ceiling, point.planned, point.scheduled)
                    : undefined
                }
                aria-valuenow={
                  canEdit ? Number(point.planned.toFixed(2)) : undefined
                }
                aria-valuetext={
                  canEdit
                    ? `${fmt(point.planned, 0)} patients${point.scheduled > 0 ? `, including ${fmt(point.scheduled, 0)} scheduled arrivals` : ""}`
                    : undefined
                }
                aria-describedby={canEdit ? descriptionId : undefined}
                data-testid={canEdit ? "arrival-day-handle" : undefined}
                data-at={point.at}
                onPointerDown={
                  canEdit ? (event) => pointerDown(event, index) : undefined
                }
                onPointerMove={canEdit ? pointerMove : undefined}
                onPointerUp={canEdit ? pointerEnd : undefined}
                onPointerCancel={canEdit ? pointerEnd : undefined}
                onLostPointerCapture={canEdit ? pointerEnd : undefined}
                onKeyDown={
                  canEdit ? (event) => keyDown(event, index) : undefined
                }
                onKeyUp={
                  canEdit
                    ? () => {
                        if (gesture.current?.source === "keyboard")
                          finishGesture();
                      }
                    : undefined
                }
                onFocus={canEdit ? () => setActiveAt(point.at) : undefined}
                onBlur={
                  canEdit
                    ? () => {
                        if (gesture.current?.source === "keyboard")
                          finishGesture();
                        setActiveAt(null);
                      }
                    : undefined
                }
              >
                <title>
                  {dateLabel(point.at, true)}: {fmt(point.planned, 0)} patients
                </title>
                {canEdit && (
                  <circle
                    className="arrival-curve-hit"
                    cx={x(index)}
                    cy={y(point.planned)}
                    r={11}
                    fill="transparent"
                  />
                )}
                <circle
                  className="arrival-curve-dot"
                  cx={x(index)}
                  cy={y(point.planned)}
                  r={canEdit && activeAt === point.at ? 5 : 3.5}
                  fill="#fff"
                  stroke="#2378bf"
                  strokeWidth={2}
                />
              </g>
            );
          })}
          {points.length > 0 &&
            dates.map((index) => (
              <text
                key={index}
                x={x(index)}
                y={bottom + 27}
                textAnchor={
                  index === 0 && points.length > 1
                    ? "start"
                    : index === points.length - 1 && points.length > 1
                      ? "end"
                      : "middle"
                }
                aria-hidden="true"
              >
                {dateLabel(points[index].at)}
              </text>
            ))}
        </svg>
      </div>
      {editable && (
        <div className="arrival-curve-help" id={descriptionId}>
          <span>
            {editError ||
              (active
                ? `${dateLabel(active.at, true)} · ${fmt(active.planned, 0)} patients${active.scheduled > 0 ? ` (${fmt(active.scheduled, 0)} scheduled)` : ""}`
                : "Drag a blue point up or down to change that day.")}
          </span>
          <span className="arrival-curve-keyboard-hint">
            Arrow keys adjust a focused point. Scheduled arrivals stay fixed.
          </span>
        </div>
      )}
      <div className="arrival-preview-footer">
        <div className="arrival-preview-legend">
          <span>
            <i />
            Your plan
          </span>
          <span>
            <i />
            Usual arrivals
          </span>
        </div>
        <p>
          <strong>{fmt(average, 0)}</strong> patients / day on average
        </p>
      </div>
    </section>
  );
}
