import type { Entity, RunGroup, Scenario } from "../types";
import type {
  PlanningDraftSnapshot,
  PlanningDraftToken,
} from "../planningDraft";

export type SunfireMode = "closed" | "compact" | "expanded";
export type SunfireTurnStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED";
export interface SunfireStatus {
  name: string;
  available: boolean;
  model: string;
  reason?: string;
  code?: string;
  guide_version: string;
}
export interface SunfireContext extends PlanningDraftToken {
  draft: Entity;
  selected_run_group_id: string | null;
  selected_replication_id: string | null;
  selected_time: string | null;
  page: string;
  timezone: string;
}
export interface SunfireChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
  unit?: string;
  start_at?: string;
  end_at?: string;
}
export interface SunfireAction {
  id: string;
  status: "READY" | "APPLIED" | "UNDONE";
  mode: "direct" | "proposal";
  kind: "edit" | "save" | "run" | "cancel_run" | "undo";
  expected: PlanningDraftToken;
  validated_draft: Entity;
  before_after: SunfireChange[];
  explanation: string;
  warnings: string[];
  normalized_before_sha256?: string;
  normalized_after_sha256?: string;
  run_group_id?: string | null;
  applied_token?: PlanningDraftToken | null;
  [key: string]: unknown;
}
export interface SunfireLink {
  kind: "run" | "replay" | "comparison";
  label: string;
  run_group_id?: string;
  replication_id?: string;
  at?: string;
  left_scenario_id?: string;
  right_scenario_id?: string;
}
export interface SunfireEvidence extends Entity {
  kind?: string;
  title?: string;
  scope?: string;
  summary?: string;
  context?: Entity;
  links?: SunfireLink[];
}
export interface SunfireTurn {
  id: string;
  chat_id: string;
  status: SunfireTurnStatus;
  text: string;
  evidence: SunfireEvidence[];
  actions: SunfireAction[];
  error?: { message?: string; code?: string } | string | null;
  created_at: string;
  completed_at?: string | null;
}
export interface SunfireMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  turn_id: string;
  created_at: string;
}
export interface SunfireChat {
  id: string;
  scenario_id: string;
  title: string;
  messages: SunfireMessage[];
  turns: Pick<SunfireTurn, "id" | "status" | "created_at" | "completed_at">[];
  created_at: string;
  updated_at: string;
}
export interface SunfireReceipt {
  action: SunfireAction;
  saved_scenario?: Scenario;
  run_group?: RunGroup;
  cancelled_run?: RunGroup;
}
export interface SunfireApplyBody {
  expected: PlanningDraftToken;
  after: Pick<
    PlanningDraftSnapshot,
    "draft_revision" | "draft_fingerprint" | "draft"
  >;
}
export interface SunfireExecution {
  status: "applying" | "confirming" | "applied" | "stale" | "error";
  error?: string;
  after?: PlanningDraftSnapshot;
  body?: SunfireApplyBody;
  receipt?: SunfireReceipt;
  contextPreserved?: boolean;
}
