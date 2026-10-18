import { lazy, Suspense } from "react";
import { Tabs } from "@mantine/core";
import { BarChart3, Users } from "lucide-react";
import type { PlanningContext, UpdateTarget } from "../types";
import type { AnalyticsSection } from "../navigation";
import "./analytics.css";

const Patients = lazy(() => import("./Patients"));
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
      <Tabs
        className="analytics-tabs"
        value={section}
        onChange={(value) =>
          value && onSectionChange(value as AnalyticsSection)
        }
        keepMounted={false}
      >
        <Tabs.List
          className="analytics-sections"
          aria-label="Analytics sections"
        >
          <Tabs.Tab value="outcomes" leftSection={<BarChart3 size={16} />}>
            Outcomes
          </Tabs.Tab>
          <Tabs.Tab value="patients" leftSection={<Users size={16} />}>
            Patients &amp; units
          </Tabs.Tab>
        </Tabs.List>
        <div className="analytics-content">
          <Suspense
            fallback={
              <div className="analytics-loading" role="status">
                Loading{" "}
                {section === "outcomes" ? "outcomes" : "patients and units"}…
              </div>
            }
          >
            <Tabs.Panel value="outcomes">
              <Outcomes ctx={ctx} />
            </Tabs.Panel>
            <Tabs.Panel value="patients">
              <Patients ctx={ctx} onUpdate={onUpdate} />
            </Tabs.Panel>
          </Suspense>
        </div>
      </Tabs>
    </section>
  );
}
