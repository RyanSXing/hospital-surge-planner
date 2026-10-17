/** Typed write boundaries, generated request contracts stay owned by the API. */
import { post, patch } from "./api";
import type { Entity } from "./types";
import type {
  AlertRule,
  ComparisonCreate,
  DatasetEdit,
  ExportCreate,
  JobView,
  MemberCreate,
  RunCreate,
  ScenarioCreate,
  ScenarioPatch,
  UpdateApply,
  UpdateCreate,
} from "./api-contracts";

export const createScenario = (value: ScenarioCreate) =>
  post<Entity>("/scenarios", value);
export const editScenario = (
  id: string,
  value: ScenarioPatch,
  revision: number,
) => patch<Entity>(`/scenarios/${id}`, value, revision);
export const queueRun = (value: RunCreate) =>
  post<JobView>("/run-groups", value);
export const comparePlans = (value: ComparisonCreate) =>
  post<Entity>("/comparisons", value);
export const createUpdate = (value: UpdateCreate) =>
  post<Entity>("/updates", value);
export const applyUpdate = (
  id: string,
  value: UpdateApply,
  revision?: number,
) => post<Entity>(`/updates/${id}/apply`, value, revision);
export const createMember = (workspace: string, value: MemberCreate) =>
  post<Entity>(`/workspaces/${workspace}/members`, value);
export const createAlertRule = (value: AlertRule) =>
  post<Entity>("/alert-rules", value);
export const createExport = (value: ExportCreate) =>
  post<Entity>("/exports", value);
export const editDataset = (id: string, value: DatasetEdit, revision: number) =>
  patch<Entity>(`/dataset-drafts/${id}/entities`, value, revision);
