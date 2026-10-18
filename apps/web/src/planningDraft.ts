import type { Entity, Scenario } from "./types";

/** Identity of the one editor draft, captured when a conversation turn starts. */
export interface PlanningDraftToken {
  scenario_id: string;
  saved_revision: number;
  dataset_version_id: string;
  draft_revision: number;
  draft_fingerprint: string;
}
export interface PlanningDraftSnapshot extends PlanningDraftToken {
  draft: Entity;
  scenario_name: string;
  dirty: boolean;
}
export interface PlanningDraftSource {
  scenario_id: string;
  saved_revision: number;
  dataset_version_id: string;
  draft_revision: number;
  draft: Entity;
  can_write: boolean;
  scenario_name: string;
  dirty: boolean;
}
export interface PlanningDraftBridge {
  getVersion?: () => number;
  subscribe?: (listener: () => void) => () => void;
  capture: () => Promise<PlanningDraftSnapshot>;
  isCurrent: (expected: PlanningDraftToken) => Promise<boolean>;
  apply: (
    expected: PlanningDraftToken,
    validatedDraft: Entity,
  ) => Promise<PlanningDraftSnapshot>;
  /** Keep newer local edits when a server-authorized save advances the base. */
  prepareSavedRevision?: (
    saved: Scenario,
    applied: PlanningDraftSnapshot,
  ) => boolean;
}
export class PlanningDraftConflict extends Error {
  constructor(
    message = "The configuration changed. Ask again using the current draft.",
  ) {
    super(message);
    this.name = "PlanningDraftConflict";
  }
}

/** JSON semantics with deterministic object ordering; never reorder input arrays. */
export function canonicalDraft(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Finish entering valid configuration values first.");
    if (Array.isArray(item))
      return item.map((child) =>
        child === undefined ? null : normalize(child),
      );
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
export async function fingerprintDraft(value: Entity): Promise<string> {
  const data = new TextEncoder().encode(canonicalDraft(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function sameDraftToken(
  left: PlanningDraftToken,
  right: PlanningDraftToken,
): boolean {
  return (
    left.scenario_id === right.scenario_id &&
    left.saved_revision === right.saved_revision &&
    left.dataset_version_id === right.dataset_version_id &&
    left.draft_revision === right.draft_revision &&
    left.draft_fingerprint === right.draft_fingerprint
  );
}
export function preparePlanningDraftAdoption(
  current: PlanningDraftSource | null,
  saved: Scenario,
  applied: PlanningDraftSnapshot,
) {
  if (
    !current ||
    current.scenario_id !== saved.id ||
    current.dataset_version_id !== saved.dataset_version_id ||
    current.scenario_id !== applied.scenario_id ||
    current.saved_revision !== applied.saved_revision ||
    !Number.isInteger(saved.revision) ||
    saved.revision! < current.saved_revision
  )
    return null;
  return {
    scenarioId: saved.id,
    revision: saved.revision!,
    draft: structuredClone(current.draft),
    dirty: canonicalDraft(current.draft) !== canonicalDraft(applied.draft),
  };
}
function sourceKey(value: PlanningDraftSource) {
  return canonicalDraft({
    scenario_id: value.scenario_id,
    saved_revision: value.saved_revision,
    dataset_version_id: value.dataset_version_id,
    draft_revision: value.draft_revision,
    draft: value.draft,
    can_write: value.can_write,
  });
}

/**
 * The writer commits through the existing editor/undo stack synchronously.
 * Every awaited digest is checked again, so a pending model turn cannot replace
 * a newer manual edit, even when an edit is changed back to its old value.
 */
export function createPlanningDraftBridge(
  read: () => PlanningDraftSource,
  write: (draft: Entity) => void,
  fingerprint: (draft: Entity) => Promise<string> = fingerprintDraft,
): PlanningDraftBridge {
  async function capture() {
    const source = read();
    const frozen = structuredClone(source);
    const draft_fingerprint = await fingerprint(frozen.draft);
    if (sourceKey(read()) !== sourceKey(frozen))
      throw new PlanningDraftConflict();
    const { can_write: _canWrite, ...result } = frozen;
    return { ...result, draft_fingerprint };
  }
  return {
    capture,
    isCurrent: async (expected) => {
      try {
        return sameDraftToken(await capture(), expected);
      } catch {
        return false;
      }
    },
    apply: async (expected, validatedDraft) => {
      const current = await capture();
      if (!sameDraftToken(current, expected)) throw new PlanningDraftConflict();
      const fresh = read();
      if (!fresh.can_write)
        throw new PlanningDraftConflict(
          "Your account can view plans but cannot edit configuration.",
        );
      if (sourceKey(fresh) !== sourceKey({ ...current, can_write: true }))
        throw new PlanningDraftConflict();
      // No await is allowed between the final identity check and this commit.
      write(structuredClone(validatedDraft));
      // Record the exact committed transaction before yielding. Later manual
      // edits must not erase its receipt, and must not be adopted over it.
      const written = structuredClone(read());
      const draft_fingerprint = await fingerprint(written.draft);
      const { can_write: _canWrite, ...result } = written;
      return { ...result, draft_fingerprint };
    },
  };
}
