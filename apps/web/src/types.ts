export type Entity = Record<string, any>;
export type PageId =
  | "overview"
  | "summary"
  | "analytics"
  | "comparison"
  | "scenarios"
  | "patients"
  | "resources"
  | "compare"
  | "replay"
  | "data";
export type Grain = "day" | "week" | "month";
export type UpdateTarget = {
  kind:
    | "unit"
    | "patient"
    | "facility"
    | "staff"
    | "equipment_pool"
    | "route"
    | "slot"
    | "vehicle";
  id: string;
};
export interface Dataset extends Entity {
  id: string;
  dataset_version_id?: string;
  fixture: string;
  patients: Entity[];
  units: Entity[];
  facilities: Entity[];
  staff: Entity[];
  equipment_pools: Entity[];
  slots: Entity[];
  snapshot_at: string;
  timezone: string;
}
export interface Scenario extends Entity {
  id: string;
  name: string;
  dataset_version_id: string;
  start_at: string;
  horizon_calendar_days: number;
  base_seed: number;
  replications: number;
  conditions: Entity[];
  interventions: Entity[];
  revision?: number;
  hospital_operations?: HospitalOperations | null;
}
export type PatientSeverity = "low" | "medium" | "high";
export type SeverityMix = Record<
  PatientSeverity,
  { percentage: number; average_stay_hours: number }
>;
export interface HospitalDisruption {
  id: string;
  start_at: string;
  end_at: string;
  name?: string;
}
export interface HospitalSupplies {
  initial_percent: number;
  capacity: number;
  usage_per_patient_day: number;
  refill_every_days: number;
  refill_percent: number;
}
export interface HospitalOperations {
  severity_mix?: SeverityMix;
  disruptions?: HospitalDisruption[];
  supplies?: HospitalSupplies;
}
export interface RunGroup extends Entity {
  id: string;
  status: string;
  replications_completed: number;
  replications_requested: number;
  selected_replication_id?: string;
  scenario_context?: Scenario | null;
}
export interface Metrics extends Entity {
  scalar_metrics: Record<string, Entity>;
  series: Entity[];
  daily: Entity[];
}
export interface PlanningContext {
  dataset: Dataset | null;
  scenario: Scenario | null;
  resultScenario?: Scenario | null;
  run: RunGroup | null;
  metrics: Metrics | null;
  metricsLoading?: boolean;
  metricsError?: string | null;
  retryMetrics?: () => void;
  state: Entity | null;
  selectedTime: string;
  selectedDay: number;
  selectedFacility: string;
  selectedPatient: Entity | null;
  selectedUnit: string;
  selectedResource: { kind: string; id: string } | null;
  grain: Grain;
  loading: boolean;
  canWrite?: boolean;
  role?: string;
  activeReplicationId?: string;
  setReplication: (id: string) => void;
  openReplayAt?: (id: string, at: string) => Promise<void>;
  stateLoading?: boolean;
  stateError?: string | null;
  busy: string | null;
  error: string | null;
  page: PageId;
  setPage: (p: PageId) => void;
  compareScenarios?: () => void;
  setTime: (t: string) => void;
  setDay: (d: number) => void;
  setFacility: (s: string) => void;
  setPatient: (p: Entity | null) => void;
  setUnit: (id: string) => void;
  inspectEntity: (kind: string, id: string) => void;
  clearResource: () => void;
  setGrain: (g: Grain) => void;
  refresh: () => Promise<void>;
  action: <T>(name: string, f: () => Promise<T>) => Promise<T | undefined>;
  openRun: (id: string, page?: PageId) => Promise<void>;
  runScenario: (s?: Scenario) => Promise<void>;
  saveScenario: (patch: Entity) => Promise<Scenario | undefined>;
  loadDataset: (fixture: string) => Promise<void>;
  notify: (s: string) => void;
}
