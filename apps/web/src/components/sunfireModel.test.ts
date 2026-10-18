import { describe, expect, it } from "vitest";
import {
  changeValue,
  directActionEligible,
  draftToken,
  pendingSunfireTurn,
  settledSunfireTurnCache,
  sunfireContext,
  sunfireRunOutcomes,
  usableEvidenceLink,
} from "./sunfireModel";
import type { Metrics, PlanningContext, RunGroup } from "../types";
import type { SunfireAction, SunfireLink } from "./sunfireTypes";

describe("Sunfire planning envelopes", () => {
  const snapshot = {
    scenario_id: "S",
    saved_revision: 2,
    dataset_version_id: "D",
    draft_revision: 4,
    draft_fingerprint: "fingerprint",
    draft: { replications: 3 },
    scenario_name: "Current draft",
    dirty: true,
  };
  it("sends only strict server context fields and the actual unsaved patch", () => {
    const ctx = {
      page: "overview",
      run: { id: "R", selected_replication_id: "REP" },
      selectedTime: "2026-10-16T05:00:00Z",
      scenario: { timezone: "America/Chicago" },
    } as unknown as PlanningContext;
    const value = sunfireContext(snapshot, ctx);
    expect(value.draft).toEqual({ replications: 3 });
    expect(value.selected_replication_id).toBe("REP");
    expect(value).not.toHaveProperty("dirty");
    expect(value).not.toHaveProperty("scenario_name");
    expect(Object.keys(draftToken(snapshot))).toHaveLength(5);
  });
  it("never automatically applies a suggestion, unfinished response, other scenario, or viewer action", () => {
    const action = {
      status: "READY",
      mode: "direct",
      expected: draftToken(snapshot),
    } as SunfireAction;
    expect(directActionEligible(action, "SUCCEEDED", "S", true)).toBe(true);
    expect(
      directActionEligible(
        { ...action, mode: "proposal" },
        "SUCCEEDED",
        "S",
        true,
      ),
    ).toBe(false);
    expect(directActionEligible(action, "RUNNING", "S", true)).toBe(false);
    expect(directActionEligible(action, "SUCCEEDED", "OTHER", true)).toBe(
      false,
    );
    expect(directActionEligible(action, "SUCCEEDED", "S", false)).toBe(false);
    expect(
      directActionEligible(
        { ...action, status: "APPLIED" },
        "SUCCEEDED",
        "S",
        true,
      ),
    ).toBe(false);
  });
  it("preserves unavailable values and avoids raw object/field dumps", () => {
    expect(changeValue(null)).toBe("Not set");
    expect(changeValue(0, "beds")).toBe("0 beds");
    expect(changeValue(20, "%")).toBe("20%");
    expect(changeValue({ rn: 4 })).toBe("Custom settings");
    expect(changeValue(false)).toBe("Off");
  });
  it("accepts only real same-app destinations with complete typed context", () => {
    expect(
      usableEvidenceLink({
        kind: "run",
        label: "View results",
        run_group_id: "run_1",
      }),
    ).toBe(true);
    expect(
      usableEvidenceLink({
        kind: "replay",
        label: "View bottleneck",
        replication_id: "rep_1",
        at: "2026-10-16T05:00:00Z",
      }),
    ).toBe(true);
    expect(
      usableEvidenceLink({
        kind: "comparison",
        label: "Compare",
        left_scenario_id: "s1",
        right_scenario_id: "s2",
      }),
    ).toBe(true);
    for (const link of [
      { kind: "run", run_group_id: "javascript:alert(1)" },
      { kind: "replay", replication_id: "rep_1", at: "missing" },
      { kind: "comparison", left_scenario_id: "s1", right_scenario_id: "s1" },
      { kind: "url", url: "https://unknown.example" },
    ])
      expect(usableEvidenceLink(link as SunfireLink)).toBe(false);
  });
  it("keeps cancel-requested turns pending until the server confirms their outcome", () => {
    expect(pendingSunfireTurn("CANCEL_REQUESTED")).toBe(true);
    expect(pendingSunfireTurn("CANCELLED")).toBe(false);
    expect(pendingSunfireTurn("FAILED")).toBe(false);
    expect(settledSunfireTurnCache("SUCCEEDED", "RUNNING")).toBe(false);
    expect(settledSunfireTurnCache("FAILED", "QUEUED")).toBe(false);
    expect(settledSunfireTurnCache("SUCCEEDED", "SUCCEEDED")).toBe(true);
    expect(settledSunfireTurnCache("RUNNING", "RUNNING")).toBe(false);
  });
  it("shows measured completed ensemble outcomes with real zero, raw percentages and unavailable missing values", () => {
    const run = {
      id: "R",
      status: "SUCCEEDED",
      scenario_id: "S",
      scenario_revision_id: "REV",
      dataset_version_id: "D",
      replications_completed: 2,
      replications_requested: 2,
    } as RunGroup;
    const metrics = {
      context: {
        run_group_id: "R",
        scenario_id: "S",
        scenario_revision_id: "REV",
        dataset_version_id: "D",
      },
      scalar_metrics: {
        average_wait_per_patient_hours: { p50: 0 },
        success_score_percent: { p50: 91.5 },
      },
    } as unknown as Metrics;
    expect(sunfireRunOutcomes(run, metrics).map((row) => row.value)).toEqual([
      0,
      null,
      91.5,
    ]);
    expect(
      sunfireRunOutcomes({ ...run, status: "FAILED" }, metrics).every(
        (row) => row.value === null,
      ),
    ).toBe(true);
    expect(
      sunfireRunOutcomes(run, {
        ...metrics,
        context: { ...metrics.context, scenario_revision_id: "OTHER" },
      }).every((row) => row.value === null),
    ).toBe(true);
    expect(sunfireRunOutcomes(run).every((row) => row.value === null)).toBe(
      true,
    );
    expect(
      sunfireRunOutcomes(run, {
        ...metrics,
        scalar_metrics: { success_score_percent: { p50: 200 } },
      })[2].value,
    ).toBeNull();
  });
});
