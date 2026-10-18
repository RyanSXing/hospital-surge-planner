import { describe, expect, it } from "vitest";
import {
  canonicalDraft,
  createPlanningDraftBridge,
  fingerprintDraft,
  PlanningDraftConflict,
  preparePlanningDraftAdoption,
  sameDraftToken,
  type PlanningDraftSource,
} from "./planningDraft";
import type { Scenario } from "./types";

const source = (): PlanningDraftSource => ({
  scenario_id: "scenario-a",
  dataset_version_id: "dataset-a",
  saved_revision: 4,
  draft_revision: 1,
  draft: { name: "Our plan", conditions: [], replications: 2 },
  scenario_name: "Our plan",
  dirty: true,
  can_write: true,
});
describe("shared conversational planning draft", () => {
  it("canonicalizes object order while preserving ordered conditions and omitted fields", async () => {
    const first = { b: 2, a: { z: 1, q: "é" }, absent: undefined };
    const second = { a: { q: "é", z: 1 }, b: 2 };
    expect(canonicalDraft(first)).toBe('{"a":{"q":"é","z":1},"b":2}');
    expect(await fingerprintDraft(first)).toBe(await fingerprintDraft(second));
    expect(await fingerprintDraft({ conditions: [1, 2] })).not.toBe(
      await fingerprintDraft({ conditions: [2, 1] }),
    );
    expect(() => canonicalDraft({ count: Number.NaN })).toThrow(
      "valid configuration",
    );
  });
  it("returns an isolated capture and writes the validated change through the one editor", async () => {
    let current = source();
    const writes: unknown[] = [];
    const bridge = createPlanningDraftBridge(
      () => current,
      (draft) => {
        writes.push(draft);
        current = {
          ...current,
          draft,
          draft_revision: current.draft_revision + 1,
        };
      },
    );
    const before = await bridge.capture();
    before.draft.conditions.push({ id: "external mutation" });
    expect(current.draft.conditions).toEqual([]);
    const expected = await bridge.capture();
    const changed = await bridge.apply(expected, {
      ...current.draft,
      replications: 3,
    });
    expect(writes).toHaveLength(1);
    expect(changed.draft.replications).toBe(3);
    expect(changed.draft_revision).toBe(2);
    expect(await bridge.isCurrent(expected)).toBe(false);
    expect(await bridge.isCurrent(changed)).toBe(true);
  });
  it.each([
    "scenario_id",
    "dataset_version_id",
    "saved_revision",
    "draft_revision",
  ] as const)("rejects stale %s before writing", async (field) => {
    let current = source();
    let writes = 0;
    const bridge = createPlanningDraftBridge(
      () => current,
      () => writes++,
    );
    const expected = await bridge.capture();
    current = {
      ...current,
      [field]:
        typeof current[field] === "number"
          ? Number(current[field]) + 1
          : "changed",
    };
    await expect(
      bridge.apply(expected, { replications: 3 }),
    ).rejects.toBeInstanceOf(PlanningDraftConflict);
    expect(writes).toBe(0);
  });
  it("detects changed data even when an editing gesture has the same sequence", async () => {
    const current = source();
    const bridge = createPlanningDraftBridge(
      () => current,
      () => {
        throw new Error("must not write");
      },
    );
    const expected = await bridge.capture();
    current.draft.replications = 9;
    expect(await bridge.isCurrent(expected)).toBe(false);
    await expect(
      bridge.apply(expected, { replications: 3 }),
    ).rejects.toBeInstanceOf(PlanningDraftConflict);
  });
  it("does not publish a fingerprint if a manual edit happened during hashing", async () => {
    let resolve!: (value: string) => void;
    const current = source();
    const bridge = createPlanningDraftBridge(
      () => current,
      () => {},
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = bridge.capture();
    current.draft.replications = 3;
    current.draft_revision++;
    resolve("old-fingerprint");
    await expect(pending).rejects.toBeInstanceOf(PlanningDraftConflict);
  });
  it("keeps read-only context available while rejecting mutation", async () => {
    const current = { ...source(), can_write: false };
    let writes = 0;
    const bridge = createPlanningDraftBridge(
      () => current,
      () => writes++,
    );
    const expected = await bridge.capture();
    expect(expected.scenario_id).toBe("scenario-a");
    await expect(bridge.apply(expected, {})).rejects.toThrow("cannot edit");
    expect(writes).toBe(0);
  });
  it("checks fresh committed data again between capture resolution and the apply continuation", async () => {
    const current = source();
    let mutate = false;
    let writes = 0;
    const bridge = createPlanningDraftBridge(
      () => current,
      () => {
        writes++;
      },
      async () => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (mutate) {
              current.draft_revision++;
              current.draft.replications = 8;
            }
          }),
        );
        return "same-fingerprint";
      },
    );
    const expected = await bridge.capture();
    mutate = true;
    await expect(
      bridge.apply(expected, { replications: 4 }),
    ).rejects.toBeInstanceOf(PlanningDraftConflict);
    expect(current.draft.replications).toBe(8);
    expect(writes).toBe(0);
  });
  it("requires all identity fields rather than fingerprint alone", async () => {
    const expected = await createPlanningDraftBridge(
      source,
      () => {},
    ).capture();
    expect(sameDraftToken(expected, { ...expected, saved_revision: 5 })).toBe(
      false,
    );
  });
  it("adopts the saved base while preserving edits made during an execution request", async () => {
    const current = source();
    const applied = await createPlanningDraftBridge(
      () => current,
      () => {},
    ).capture();
    current.draft.replications = 8;
    current.draft_revision++;
    const saved = {
      id: current.scenario_id,
      dataset_version_id: current.dataset_version_id,
      revision: 5,
    } as Scenario;
    const adoption = preparePlanningDraftAdoption(current, saved, applied);
    expect(adoption?.draft.replications).toBe(8);
    expect(adoption?.dirty).toBe(true);
    expect(adoption?.revision).toBe(5);
    expect(applied.draft.replications).toBe(2);
  });
  it("marks the exact saved draft clean and refuses unrelated or newer saved bases", async () => {
    const current = source();
    const applied = await createPlanningDraftBridge(
      () => current,
      () => {},
    ).capture();
    const saved = {
      id: current.scenario_id,
      dataset_version_id: current.dataset_version_id,
      revision: 5,
    } as Scenario;
    expect(preparePlanningDraftAdoption(current, saved, applied)?.dirty).toBe(
      false,
    );
    expect(
      preparePlanningDraftAdoption(current, { ...saved, id: "other" }, applied),
    ).toBeNull();
    expect(
      preparePlanningDraftAdoption(
        current,
        { ...saved, dataset_version_id: "other" },
        applied,
      ),
    ).toBeNull();
    expect(
      preparePlanningDraftAdoption(
        { ...current, saved_revision: 6 },
        saved,
        applied,
      ),
    ).toBeNull();
  });
});
