import { useEffect, useRef, useState } from "react";
import {
  Button as MantineButton,
  Badge as MantineBadge,
  Modal as MantineModal,
  Alert,
} from "@mantine/core";
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
  const colors: Record<string, string> = {
    success: "teal",
    warning: "yellow",
    amber: "yellow",
    danger: "red",
    red: "red",
    cyan: "blue",
    violet: "violet",
  };
  return (
    <MantineBadge
      className={`badge ${tone}`}
      color={colors[tone] || "gray"}
      variant="light"
      size="sm"
      tt="none"
      fw={500}
    >
      {children}
    </MantineBadge>
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
    <MantineButton
      variant={primary ? "filled" : "default"}
      size={small ? "xs" : "sm"}
      className={`button ${primary ? "primary" : ""} ${small ? "small" : ""} ${className}`}
      {...props}
    >
      {children}
    </MantineButton>
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
    <Alert
      className="error-box"
      color="red"
      variant="light"
      role="alert"
      icon={<AlertTriangle size={18} />}
      withCloseButton={!!onDismiss}
      onClose={onDismiss}
      closeButtonLabel="Dismiss error"
    >
      {error}
    </Alert>
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
  const anchor = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement,
  );
  const [visible, setVisible] = useState(true);
  // Editors remain mounted between pages. A hidden editor's dialog must stay
  // hidden too, including its portal and keyboard focus trap.
  useEffect(() => {
    const ancestors: Element[] = [];
    let node: Element | null = anchor.current;
    while (node) {
      ancestors.push(node);
      node = node.parentElement;
    }
    const sync = () => setVisible(!anchor.current?.closest("[hidden]"));
    const observer = new MutationObserver(sync);
    ancestors.forEach((element) =>
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["hidden"],
      }),
    );
    sync();
    return () => {
      observer.disconnect();
      // These dialogs are conditionally mounted, so restore focus after the
      // Mantine subtree has unmounted instead of waiting for a close transition.
      queueMicrotask(() => {
        const target = returnFocus.current;
        const other = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"]'),
        ).find((dialog) => dialog.getClientRects().length > 0);
        if (
          target?.isConnected &&
          target.getClientRects().length &&
          !target.closest("[hidden]") &&
          (!other || other.contains(target))
        )
          target.focus();
      });
    };
  }, []);
  return (
    <div ref={anchor} className="dialog-anchor">
      <MantineModal
        opened={visible}
        onClose={onClose}
        title={title}
        size={wide ? 860 : 520}
        withinPortal={false}
        returnFocus={false}
        classNames={{
          content: `hospital-dialog ${wide ? "wide" : ""}`,
          header: "modal-header",
          body: "modal-body",
        }}
        closeButtonProps={{ "aria-label": "Close dialog" }}
      >
        {children}
      </MantineModal>
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
