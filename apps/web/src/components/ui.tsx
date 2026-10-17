import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  LoaderCircle,
  X,
} from "lucide-react";
import type { Entity } from "../types";
import { fmt, num } from "../api";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      {tone === "success" ? <span className="status-dot" /> : null}
      {children}
    </span>
  );
}
export function Button({
  children,
  primary = false,
  small = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${small ? "small" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function PanelTitle({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
      </div>
      {actions}
    </div>
  );
}
export function CapacityBar({
  label,
  occupied,
  capacity,
  physical,
  color = "cyan",
}: {
  label: string;
  occupied: number;
  capacity: number;
  physical?: number;
  color?: string;
}) {
  return (
    <div className="capacity-row">
      <div className="spread">
        <span>{label}</span>
        <strong className={color}>
          {fmt(occupied)} <span className="muted">/ {fmt(capacity)}</span>
        </strong>
      </div>
      <div className="capacity-track">
        <span
          className={color}
          style={{
            width: `${Math.min(100, capacity ? (occupied / capacity) * 100 : 0)}%`,
          }}
        />
      </div>
      {physical !== undefined ? (
        <small>
          {fmt(physical)} physical · {fmt(Math.max(0, physical - capacity))}{" "}
          unsupported by staff
        </small>
      ) : null}
    </div>
  );
}
export function BedGrid({
  physical,
  staffed,
  occupied,
  cleaning = 0,
  selected,
  onSelect,
  compact = false,
  slots,
  selectedSlot,
  onSelectSlot,
}: {
  physical: number;
  staffed: number;
  occupied: number;
  cleaning?: number;
  selected?: number;
  onSelect?: (i: number) => void;
  compact?: boolean;
  slots?: Entity[];
  selectedSlot?: string;
  onSelectSlot?: (slot: Entity) => void;
}) {
  const rows: Entity[] =
    slots ||
    Array.from({ length: Math.max(0, physical) }, (_, i) => ({
      slot_id: `place-${i}`,
      display_label: String(i + 1),
      status:
        i < occupied
          ? "occupied"
          : i < occupied + cleaning
            ? "cleaning"
            : i < staffed
              ? "ready"
              : "disabled",
    }));
  return (
    <div
      className={`bed-grid ${compact ? "compact" : ""}`}
      style={
        {
          "--columns": physical > 40 ? 20 : physical > 20 ? 10 : 6,
        } as React.CSSProperties
      }
      aria-label={`${occupied} occupied, ${staffed} staffed, ${physical} physical places`}
    >
      {rows.map((slot, i) => {
        const state = slot.status || "disabled",
          status =
            state === "ready"
              ? "available"
              : state === "disabled"
                ? "unstaffed"
                : state;
        const description = `${slot.display_label || slot.slot_id}: ${state}${slot.patient_id ? `, patient ${slot.patient_id}` : slot.background_occupied ? ", background occupancy" : ""}${slot.reservation_id ? `, reservation ${slot.reservation_id}` : ""}${state === "ready" ? "; admission also requires available staffing and equipment" : ""}`;
        return (
          <button
            type="button"
            key={slot.slot_id || i}
            className={`bed ${status} ${selectedSlot === slot.slot_id || selected === i ? "selected" : ""}`}
            onClick={() => {
              onSelectSlot?.(slot);
              onSelect?.(i);
            }}
            title={description}
            aria-label={description}
            tabIndex={onSelectSlot || onSelect ? 0 : -1}
          />
        );
      })}
    </div>
  );
}
export function BedLegend() {
  return (
    <div className="bed-legend">
      <span>
        <i className="bed occupied" />
        Occupied
      </span>
      <span>
        <i className="bed available" />
        Ready physical place
      </span>
      <span>
        <i className="bed unstaffed" />
        Disabled
      </span>
      <span>
        <i className="bed reserved" />
        Reserved
      </span>
      <span>
        <i className="bed cleaning" />
        Turnover
      </span>
    </div>
  );
}
export function EmptyState({
  icon: Icon = ArrowUpRight,
  title,
  description,
  action,
}: {
  icon?: any;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={28} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Busy({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="loading-inline">
      <LoaderCircle size={18} className="spin" />
      {label}
    </div>
  );
}
export function ErrorBox({
  error,
  onDismiss,
}: {
  error: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <AlertTriangle size={18} />
      <span>{error}</span>
      {onDismiss ? (
        <button onClick={onDismiss} aria-label="Dismiss error">
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    close = useRef(onClose),
    returnFocus = useRef<HTMLElement | null>(
      document.activeElement as HTMLElement,
    );
  close.current = onClose;
  useEffect(() => {
    const node = ref.current;
    const focusable = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ) || [],
      ).filter((e) => e.tabIndex !== -1 && e.getClientRects().length > 0);
    if (!node?.contains(document.activeElement)) focusable()[0]?.focus();
    function key(e: KeyboardEvent) {
      // Page-level editors stay mounted to retain drafts. Their hidden dialogs
      // must not intercept keyboard input in the active workspace.
      if (!node?.getClientRects().length) return;
      const dialogs = Array.from(
        document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
      ).filter((dialog) => dialog.getClientRects().length > 0);
      if (dialogs[dialogs.length - 1] !== node) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (e.key === "Tab") {
        const targets = focusable(),
          first = targets[0],
          last = targets.at(-1);
        if (!targets.length) {
          e.preventDefault();
          node?.focus();
        } else if (
          e.shiftKey &&
          (document.activeElement === first ||
            !node?.contains(document.activeElement))
        ) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !node?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (
        returnFocus.current?.isConnected &&
        returnFocus.current.getClientRects().length
      )
        returnFocus.current.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
export function Stat({
  label,
  value,
  unit,
  change,
  tone = "",
}: {
  label: string;
  value: any;
  unit?: string;
  change?: string;
  tone?: string;
}) {
  return (
    <div className="stat">
      <span className="eyebrow">{label}</span>
      <div className={`stat-value ${tone}`}>
        {typeof value === "number" ? fmt(value) : value}
        <small>{unit}</small>
      </div>
      {change ? <span className="stat-caption">{change}</span> : null}
    </div>
  );
}
export function MetricTable({ metrics }: { metrics: Entity }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Outcome</th>
          <th>Median</th>
          <th>Possible range P10–P90</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(metrics)
          .filter(([, v]) => v && typeof v === "object" && "p50" in v)
          .map(([k, v]) => (
            <tr key={k}>
              <td>{k.replaceAll("_", " ")}</td>
              <td className="numeric">{fmt(num(v), 1)}</td>
              <td className="muted numeric">
                {fmt(num(v, "p10"), 1)} – {fmt(num(v, "p90"), 1)}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}
export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="link-button" onClick={onClick}>
      {children}
      <ChevronRight size={15} />
    </button>
  );
}
export function SavedIndicator() {
  return (
    <span className="saved-indicator">
      <Check size={12} /> All changes saved
    </span>
  );
}
