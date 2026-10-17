import { test, expect } from "@playwright/test";
import { api, capture, open, record, scenario, waitRun } from "./helpers";

test("replay clinical capacity excludes nonclinical shelter inventory", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    (window as any).__clinicalCapacityPaints = [];
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof fillText>
    ) {
      if (this.canvas.classList.contains("replay-canvas")) {
        const paints = (window as any).__clinicalCapacityPaints as string[];
        paints.push(String(args[0]));
        if (paints.length > 2000) paints.splice(0, paints.length - 2000);
      }
      return fillText.apply(this, args);
    };
  });
  const context = await scenario(page, "clinical replay capacity", {
    horizon_calendar_days: 1,
    replications: 1,
  });
  const run = await waitRun(
    page,
    (
      await api(page.request, "/run-groups", "POST", {
        scenario_id: context.scenario.id,
      })
    ).id,
  );
  const state = await api(
    page.request,
    `/runs/${run.selected_replication_id}/state?at=${encodeURIComponent(run.start_at)}`,
  );
  const ward = state.units.filter(
    (unit: any) =>
      unit.kind === "ward" && unit.facility_id !== "FAC-OVERFLOW-SOUTH",
  );
  const totals = ward.reduce(
    (sum: any, unit: any) => ({
      occupied: sum.occupied + unit.occupied,
      staffed: sum.staffed + unit.staffed,
      background: sum.background + unit.background_occupied,
    }),
    { occupied: 0, staffed: 0, background: 0 },
  );
  expect(totals).toEqual({ occupied: 108, staffed: 132, background: 44 });
  expect(state.units.find((unit: any) => unit.kind === "shelter").staffed).toBe(
    24,
  );
  await open(page, context.scenario.id, "replay", run.id);
  await expect(page.locator(".replay-canvas")).toHaveAttribute(
    "data-recorded-at",
    new Date(run.start_at).toISOString(),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__clinicalCapacityPaints))
    .toContain("108/132");
  const paints: string[] = await page.evaluate(
    () => (window as any).__clinicalCapacityPaints,
  );
  expect(paints).not.toContain("108/156");
  await capture(page, "replay-clinical-capacity", info);
  record("replay-clinical-capacity", {
    run_id: run.id,
    replication_id: run.selected_replication_id,
    at: run.start_at,
    ward: totals,
    excluded_shelter_places: 24,
    actual_canvas_label: "108/132",
  });
});
