"""Versioned command envelopes for validation and generated OpenAPI clients.

Domain identifiers, conservation and timeline relationships are checked against
the immutable dataset after these structural/type checks.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Command(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)


class ControlPoint(Command):
    at: str
    multiplier: float = Field(ge=0, allow_inf_nan=False)


class Condition(Command):
    kind: Literal[
        "arrival_multiplier",
        "care_mix_override",
        "staff_unavailability",
        "staff_absence",
        "arrival_batch",
        "stage_duration_multiplier",
    ] = "arrival_multiplier"
    start_at: str | None = None
    end_at: str | None = None
    entry_stream_id: str | None = None
    multiplier: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    surge_percent: float | None = Field(default=None, allow_inf_nan=False)
    control_points: list[ControlPoint] | None = None
    staff_ids: list[str] | None = None
    care_mix_override: dict[str, float] | None = None
    count: int | None = Field(default=None, ge=0)


class EquipmentAllocation(Command):
    equipment_pool_id: str
    quantity: int = Field(ge=0)


class Intervention(Command):
    kind: str | None = None
    template_kind: str | None = None
    facility_id: str | None = None
    unit_id: str | None = None
    destination_unit_id: str | None = None
    enabled_slots: int | None = Field(default=None, ge=0)
    equipment_allocations: list[EquipmentAllocation] | None = None
    name: str | None = None
    start_at: str | None = None
    end_at: str | None = None
    duration_minutes: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    activation_minutes: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    nurses: int | None = Field(default=None, ge=0)
    providers: int | None = Field(default=None, ge=0)
    support: int | None = Field(default=None, ge=0)
    quantity: int | None = Field(default=None, ge=0)
    enabled: bool = True
    assigned_staff_ids: list[str] | None = None


class ScenarioPatch(Command):
    name: str | None = None
    dataset_version_id: str | None = None
    start_at: str | None = None
    end_at: str | None = None
    timezone: str | None = None
    horizon_calendar_days: int | None = Field(default=None, ge=1, le=365)
    replications: int | None = Field(default=None, ge=1, le=500)
    base_seed: int | None = Field(default=None, ge=0)
    conditions: list[Condition] | None = None
    interventions: list[Intervention] | None = None
    updates: list[dict[str, Any]] | None = None


class ScenarioCreate(ScenarioPatch):
    dataset_version_id: str


class RunCreate(Command):
    scenario_id: str | None = None
    scenario: ScenarioCreate | None = None
    replications: int | None = Field(default=None, ge=1, le=500)


class Plan(Command):
    name: str
    interventions: list[Intervention] = Field(default_factory=list)


class ComparisonCreate(Command):
    scenario_id: str
    plans: list[Plan] | None = Field(default=None, min_length=1, max_length=3)
    candidates: list[Plan] | None = Field(default=None, min_length=1, max_length=3)
    replications: int | None = Field(default=None, ge=1, le=500)


class OperationalPayload(Command):
    facility_id: str | None = None
    unit_id: str | None = None
    patient_id: str | None = None
    count: int | None = Field(default=None, ge=0, le=10000)
    care_mix: dict[str, float] | None = None
    staff_ids: list[str] | None = None
    assigned_staff_ids: list[str] | None = None
    equipment_allocations: list[dict[str, Any]] | None = None
    effective_at: str | None = None
    until: str | None = None
    observed_dataset_version_id: str | None = None


UpdateKind = Literal[
    "arrival_batch",
    "patient_departure",
    "staff_unavailable",
    "staff_available",
    "site_ready",
    "capacity_change",
    "advertised_capacity_change",
    "census_replacement",
    "equipment_change",
    "route_change",
    "retract_or_correct",
]
StateOrigin = Literal["simulation_branch", "observed_reset"]


class UpdateCreate(Command):
    scenario_id: str
    type: UpdateKind
    effective_at: str
    state_origin: StateOrigin
    payload: OperationalPayload
    source: str = "user_planning_input"
    replication_id: str | None = None
    idempotency_key: str | None = Field(default=None, max_length=256)


class BranchSource(Command):
    parent_run_group_id: str | None = None
    branch_strategy: Literal["selected_replication", "paired_ensemble"] | None = None
    source_replication_id: str | None = None
    observed_dataset_version_id: str | None = None
    reconciliation_policy: Literal["replace_complete_snapshot"] | None = None
    included_update_ids: list[str] | None = None


class UpdateApply(Command):
    parent_scenario_revision_id: str | None = None
    effective_at: str | None = None
    state_origin: StateOrigin | None = None
    update_ids: list[str] | None = None
    source: BranchSource | None = None
    replications: int | None = Field(default=None, ge=1, le=500)
    enqueue: bool | None = None
    run: bool | None = None
    name: str | None = None


class ExportCreate(Command):
    run_group_id: str | None = None
    dataset_version_id: str | None = None
    scenario_id: str | None = None
    comparison_id: str | None = None
    plan_id: str | None = None
    replication_id: str | None = None
    format: Literal["zip", "json", "csv"] = "zip"
    include_events: bool = True


class EntityOperation(Command):
    collection: str
    action: Literal["upsert", "delete"] | None = None
    operation: Literal["upsert", "delete"] | None = None
    id: str | int | None = None
    entity_id: str | int | None = None
    entity: dict[str, Any] | list[str] | str | None = None
    value: dict[str, Any] | list[str] | str | None = None


class DatasetEdit(Command):
    operations: list[EntityOperation] = Field(max_length=500)


class AlertRule(Command):
    name: str
    metric: str
    scope_filters: dict[str, str] = Field(default_factory=dict)
    statistic: Literal["p10", "p50", "p90", "mean", "selected_replication"] = "p50"
    grain: Literal["day", "week", "month"] = "day"
    operator: Literal["gt", "gte", "lt", "lte"] = "gt"
    threshold: float = Field(allow_inf_nan=False)
    unit: str
    consecutive_buckets: int = Field(default=1, ge=1, le=365)
    severity: Literal["info", "warning", "critical"] = "warning"
    enabled: bool = True


class MemberCreate(Command):
    name: str
    username: str = Field(min_length=1)
    password: str = Field(min_length=16)
    role: Literal["viewer", "planner", "admin"] = "viewer"


class JobView(Command):
    id: str
    status: Literal[
        "QUEUED", "RUNNING", "AGGREGATING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "CANCELLED"
    ]
    kind: str
    completed: int
    total: int
    source_draft_revision: int | None = None
    scenario_id: str | None = None
    scenario_name: str | None = None
    scenario_revision_id: str | None = None
    dataset_version_id: str | None = None
    selected_replication_id: str | None = None
    start_at: str | None = None
    end_at: str | None = None
    error: str | None = None
    compute_estimate: dict[str, Any] | None = None


def command_dict(value):
    return value.model_dump(exclude_unset=True) if isinstance(value, BaseModel) else value
