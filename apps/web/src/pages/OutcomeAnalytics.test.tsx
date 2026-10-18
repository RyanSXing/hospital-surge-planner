import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Entity, PlanningContext } from "../types";
import OutcomeAnalytics from "./OutcomeAnalytics";

function renderOutcomes(recorded: Entity, configuration: Entity = {}) {
  const start_at = "2026-10-16T05:00:00Z";
  const end_at = "2026-10-17T05:00:00Z";
  const ctx = {
    metrics: {
      start_at,
      end_at,
      scalar_metrics: {},
      series: [],
      daily: [
        {
          start_at,
          end_at,
          arrivals: { p50: 100 },
          blocker_patient_hours: {},
          ...recorded,
        },
      ],
    },
    scenario: {
      id: "scenario_saved",
      name: "Saved plan",
      start_at,
      end_at,
      timezone: "America/Chicago",
      hospital_operations: configuration,
    },
    dataset: null,
    run: null,
    selectedTime: start_at,
    grain: "day",
  } as unknown as PlanningContext;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <OutcomeAnalytics ctx={ctx} />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe("analytics recorded constraint presentation", () => {
  it("keeps only the resource evidence amber when interruptions overlap", () => {
    const html = renderOutcomes({
      treatment_disruption_hours: { mean: 0.25 },
      medical_supplies_shortage_hours: { mean: 1 },
    });
    expect(html).toContain('data-kind="constraint"');
    expect(html).toContain('data-presentation="background"');
    expect(html).toContain("chart-constraint-background");
    expect(html).not.toContain("chart-constraint-ribbon");
    expect(html).not.toContain('data-kind="disruption"');
    expect(html).not.toContain('class="chart-constraint-key disruption"');
    expect(html).toContain("Out of medical supplies");
    const resourceTitle = html.match(
      /class="chart-constraint-period"[^>]*><title>([^<]+)<\/title>/,
    )![1];
    expect(resourceTitle).toContain("Out of medical supplies");
    expect(resourceTitle).not.toContain("Treatment interrupted");
    expect(html).toContain("Treatment interruptions were recorded");
    expect(html).toContain('data-recorded-at="2026-10-16T05:00:00.000Z"');
    expect(html).toContain('data-recorded-end-at="2026-10-17T05:00:00.000Z"');
    expect(html).toContain("one or more simulations");
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
  });

  it("keeps actual interruption facts collapsed without fabricating an amber shortage", () => {
    for (const recorded of [
      { treatment_disruption_hours: { mean: 24 } },
      { blocker_patient_hours: { treatment_disruption: { mean: 4 } } },
    ]) {
      const html = renderOutcomes(recorded);
      expect(html).not.toContain("chart-constraint-band");
      expect(html).not.toContain("chart-constraint-background");
      expect(html).not.toContain("chart-constraint-key");
      expect(html).toContain("Care interruption details");
      expect(html).toContain("Treatment interruptions were recorded");
      expect(html).toContain('<details class="outcome-interruption-details">');
      expect(html).not.toContain("<details open");
      expect(html).toContain(
        "No positive recorded resource constraint evidence is available",
      );
    }
  });

  it("keeps resource constraints amber when interruption evidence is unavailable", () => {
    const html = renderOutcomes({
      blocker_patient_hours: { nursing_capacity: { mean: 4 } },
      treatment_disruption_hours: { mean: null, p50: null },
    });
    expect(html).toContain('data-kind="constraint"');
    expect(html).toContain('fill="var(--warning)"');
    expect(html).toContain("Recorded constraints");
    expect(html).not.toContain('data-kind="disruption"');
    expect(html).not.toContain('fill="var(--danger)"');
  });

  it("never turns configured disruption risk or missing/zero evidence into red periods", () => {
    for (const recorded of [
      {},
      { treatment_disruption_hours: { mean: null, p50: null } },
      { treatment_disruption_hours: { mean: 0 } },
    ]) {
      const html = renderOutcomes(recorded, {
        disruption_chance_percent: 100,
        disruptions: [
          {
            id: "configured_only",
            start_at: "2026-10-16T05:00:00Z",
            end_at: "2026-10-17T05:00:00Z",
          },
        ],
      });
      expect(html).not.toContain("chart-constraint-band");
      expect(html).not.toContain("chart-constraint-background");
      expect(html).not.toContain("chart-constraint-key");
      expect(html).toContain(
        "No positive recorded resource constraint evidence is available",
      );
      expect(html).not.toContain("Care interruption details");
    }
  });
});
