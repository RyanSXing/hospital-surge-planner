import type { ReactNode } from "react";
import { ArrowRight, Database } from "lucide-react";
import type { PlanningContext } from "../types";
import { Button } from "../components/ui";
import "./planningOverview.css";

export interface PlanningOverviewProps {
  /** The editable scenario's source dataset, independent of result context. */
  ctx: PlanningContext;
  /** Keep the existing editor mounted here to retain all setup and draft state. */
  configuration: ReactNode;
  onInspectBaseline: () => void;
  onOpenAnalysis?: () => void;
}

export default function PlanningOverview({
  ctx,
  configuration,
  onInspectBaseline,
  onOpenAnalysis,
}: PlanningOverviewProps) {
  return (
    <div className="planning-overview-page">
      <header className="page-heading planning-overview-heading">
        <div>
          <h1>Configuration</h1>
        </div>
        <div className="heading-actions">
          <Button onClick={onInspectBaseline} disabled={!ctx.dataset}>
            <Database size={15} /> Inspect baseline data
          </Button>
          {onOpenAnalysis && ctx.run?.status === "SUCCEEDED" ? (
            <Button onClick={onOpenAnalysis}>
              View analysis <ArrowRight size={15} />
            </Button>
          ) : null}
        </div>
      </header>

      <section
        className="planning-overview-configuration"
        aria-label="Simulation configuration"
      >
        {configuration}
      </section>
    </div>
  );
}
