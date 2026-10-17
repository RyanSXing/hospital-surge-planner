import { useRef, useState, type ReactNode } from "react";
import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { PlanningContext } from "../types";
import { Timeline } from "./Charts";
import "./planningPanels.css";

export function usePlanningPanels(initialHeight = 220) {
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [timelineHidden, setTimelineHidden] = useState(false);
  const [height, setHeight] = useState(initialHeight);
  return {
    inspectorHidden,
    setInspectorHidden,
    timelineHidden,
    setTimelineHidden,
    height,
    setHeight: (value: number) =>
      setHeight(Math.max(180, Math.min(260, value))),
  };
}
export type PlanningPanels = ReturnType<typeof usePlanningPanels>;

export function PlanningPanelControls({
  panels,
  name,
  inspector = true,
  timeline = true,
}: {
  panels: PlanningPanels;
  name: string;
  inspector?: boolean;
  timeline?: boolean;
}) {
  return (
    <div className="planning-panel-controls">
      {inspector ? (
        <button
          className="icon-button"
          aria-label={`${panels.inspectorHidden ? "Show" : "Hide"} ${name} inspector`}
          aria-expanded={!panels.inspectorHidden}
          aria-controls={`${name}-inspector-dock`}
          title={`${panels.inspectorHidden ? "Show" : "Hide"} inspector`}
          onClick={() => panels.setInspectorHidden(!panels.inspectorHidden)}
        >
          {panels.inspectorHidden ? (
            <PanelRightOpen size={17} />
          ) : (
            <PanelRightClose size={17} />
          )}
        </button>
      ) : null}
      {timeline ? (
        <button
          className="icon-button"
          aria-label={`${panels.timelineHidden ? "Show" : "Hide"} ${name} timeline`}
          aria-expanded={!panels.timelineHidden}
          aria-controls={`${name}-timeline-dock`}
          title={`${panels.timelineHidden ? "Show" : "Hide"} timeline`}
          onClick={() => panels.setTimelineHidden(!panels.timelineHidden)}
        >
          {panels.timelineHidden ? (
            <PanelBottomOpen size={17} />
          ) : (
            <PanelBottomClose size={17} />
          )}
        </button>
      ) : null}
    </div>
  );
}

export function PlanningTimelineDock({
  panels,
  name,
  ctx,
  children,
}: {
  panels: PlanningPanels;
  name: string;
  ctx?: PlanningContext;
  children?: ReactNode;
}) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  return (
    <section
      className="planning-timeline-dock"
      id={`${name}-timeline-dock`}
      hidden={panels.timelineHidden}
      style={{ height: panels.height }}
      aria-label={`${name} selected-time dock`}
    >
      <div
        className="planning-timeline-resizer"
        role="separator"
        aria-label={`Resize ${name} timeline`}
        aria-orientation="horizontal"
        aria-valuemin={180}
        aria-valuemax={260}
        aria-valuenow={panels.height}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { y: event.clientY, height: panels.height };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            panels.setHeight(
              drag.current.height + drag.current.y - event.clientY,
            );
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          panels.setHeight(
            event.key === "Home"
              ? 180
              : event.key === "End"
                ? 260
                : panels.height + (event.key === "ArrowUp" ? 10 : -10),
          );
        }}
      >
        <span />
      </div>
      <div className="planning-timeline-content">
        {children ||
          (ctx ? (
            <Timeline ctx={ctx} heatmapOnly title="Selected scenario time" />
          ) : null)}
      </div>
    </section>
  );
}
