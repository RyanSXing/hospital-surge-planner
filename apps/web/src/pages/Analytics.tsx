import { lazy, Suspense } from "react";
import { BarChart3, Boxes, Users } from "lucide-react";
import type { PlanningContext, UpdateTarget } from "../types";
import type { AnalyticsSection } from "../navigation";
import "./analytics.css";

const Patients = lazy(() => import("./Patients"));
const Resources = lazy(() => import("./Resources"));
const Outcomes = lazy(() => import("./OutcomeAnalytics"));
export type { AnalyticsSection } from "../navigation";

export default function Analytics({
  ctx,
  section,
  onSectionChange,
  onUpdate,
}: {
  ctx: PlanningContext;
  section: AnalyticsSection;
  onSectionChange: (section: AnalyticsSection) => void;
  onUpdate: (target?: UpdateTarget) => void;
}) {
  return (
    <section className="analytics-page" aria-label="Analytics">
      <nav className="analytics-sections" aria-label="Analytics sections">
        <button
          type="button"
          aria-current={section === "outcomes" ? "page" : undefined}
          onClick={() => onSectionChange("outcomes")}
        >
          <BarChart3 size={16} aria-hidden="true" />
          Outcomes
        </button>
        <button
          type="button"
          aria-current={section === "patients" ? "page" : undefined}
          onClick={() => onSectionChange("patients")}
        >
          <Users size={16} aria-hidden="true" />
          Patients & units
        </button>
        <button
          type="button"
          aria-current={section === "resources" ? "page" : undefined}
          onClick={() => onSectionChange("resources")}
        >
          <Boxes size={16} aria-hidden="true" />
          Resources
        </button>
      </nav>
      <div className="analytics-content">
        <Suspense
          fallback={
            <div className="analytics-loading" role="status">
              Loading{" "}
              {section === "outcomes"
                ? "outcomes"
                : section === "patients"
                  ? "census and units"
                  : "resources"}
              …
            </div>
          }
        >
          {section === "outcomes" ? (
            <Outcomes ctx={ctx} />
          ) : section === "patients" ? (
            <Patients ctx={ctx} onUpdate={onUpdate} />
          ) : (
            <Resources ctx={ctx} onUpdate={onUpdate} />
          )}
        </Suspense>
      </div>
    </section>
  );
}
