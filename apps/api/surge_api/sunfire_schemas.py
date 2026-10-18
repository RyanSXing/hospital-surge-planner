"""Strict, bounded command envelopes for Sunfire's existing-app adapters."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import ConfiguredStaffCounts, ControlPoint, SeverityMix, SupplySettings


class StrictCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DraftToken(StrictCommand):
    scenario_id: str = Field(min_length=1, max_length=96)
    saved_revision: int = Field(ge=1)
    dataset_version_id: str = Field(min_length=1, max_length=96)
    draft_revision: int = Field(ge=0)
    draft_fingerprint: str = Field(min_length=1, max_length=128)


class PlanningCapture(DraftToken):
    draft: dict[str, Any]
    selected_run_group_id: str | None = Field(default=None, max_length=96)
    selected_replication_id: str | None = Field(default=None, max_length=96)
    selected_time: str | None = Field(default=None, max_length=64)
    page: str = Field(default="overview", max_length=40)
    timezone: str | None = Field(default=None, max_length=64)


class ChatCreate(StrictCommand):
    scenario_id: str = Field(min_length=1, max_length=96)
    title: str | None = Field(default=None, max_length=120)


class TurnCreate(StrictCommand):
    message: str = Field(min_length=1, max_length=8000)
    context: PlanningCapture


class AppliedDraft(StrictCommand):
    draft_revision: int = Field(ge=0)
    draft_fingerprint: str = Field(min_length=1, max_length=128)
    draft: dict[str, Any]


class ApplyAction(StrictCommand):
    expected: DraftToken
    after: AppliedDraft


class UndoAction(StrictCommand):
    context: PlanningCapture


class EmptyArguments(StrictCommand):
    pass


class GuideArguments(StrictCommand):
    topic: Literal["workflow", "arrivals", "capacity", "operations", "results", "safety"] = "workflow"


class ResultsArguments(StrictCommand):
    run_group_id: str = Field(min_length=1, max_length=96)
    scope: Literal["ensemble", "example_run"] = "ensemble"
    replication_id: str | None = Field(default=None, max_length=96)
    local_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    at: str | None = Field(default=None, max_length=64)


class ScenarioSearchArguments(StrictCommand):
    query: str = Field(min_length=1, max_length=120)
    limit: int = Field(default=5, ge=1, le=10)


class ComparisonArguments(StrictCommand):
    left_scenario_id: str = Field(min_length=1, max_length=96)
    right_scenario_id: str = Field(min_length=1, max_length=96)


class ParametersChange(StrictCommand):
    type: Literal["parameters"]
    name: str | None = Field(default=None, min_length=1, max_length=160)
    horizon_calendar_days: int | None = Field(default=None, ge=1, le=365)
    replications: int | None = Field(default=None, ge=1, le=500)
    base_seed: int | None = Field(default=None, ge=0, le=2**53 - 1)


class UnitChange(StrictCommand):
    type: Literal["unit"]
    unit_id: str = Field(min_length=1, max_length=96)
    physical_capacity: int | None = Field(default=None, ge=0, le=1000)
    enabled_capacity: int | None = Field(default=None, ge=0, le=1000)
    staffed_capacity: int | None = Field(default=None, ge=0, le=1000)
    staff_counts: ConfiguredStaffCounts | None = None


class ArrivalsChange(StrictCommand):
    type: Literal["arrivals"]
    entry_stream_id: str = Field(min_length=1, max_length=96)
    multiplier: float = Field(ge=0, le=100, allow_inf_nan=False)
    shape: Literal["step", "ramp", "wave", "piecewise_linear"] = "step"
    start_at: str
    end_at: str
    control_points: list[ControlPoint] | None = Field(default=None, max_length=732)


class ArrivalBatchChange(StrictCommand):
    type: Literal["arrival_batch"]
    count: int = Field(ge=1, le=10000)
    at: str
    entry_stream_id: str = Field(min_length=1, max_length=96)
    spread_minutes: float = Field(default=0, ge=0, allow_inf_nan=False)
    care_mix: dict[Literal["discharge", "ward", "icu"], float] | None = None


class TemporaryBedsChange(StrictCommand):
    type: Literal["temporary_beds"]
    unit_id: str = Field(min_length=1, max_length=96)
    unavailable_count: int = Field(ge=1, le=1000)
    start_at: str
    end_at: str


class StaffAbsenceChange(StrictCommand):
    type: Literal["staff_absence"]
    unit_id: str = Field(min_length=1, max_length=96)
    count: int = Field(ge=1, le=500)
    start_at: str
    end_at: str


class OperationsChange(StrictCommand):
    type: Literal["operations"]
    severity_mix: SeverityMix | None = None
    supplies: SupplySettings | None = None
    disruption_chance_percent: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)


class EquipmentChange(StrictCommand):
    type: Literal["equipment"]
    equipment_pool_id: str = Field(min_length=1, max_length=96)
    operation: Literal["add", "fail", "repair", "decommission"]
    quantity: int = Field(ge=1, le=100000)
    at: str


class RemoveChange(StrictCommand):
    type: Literal["remove_planned_item"]
    collection: Literal["conditions", "interventions", "updates"]
    id: str = Field(min_length=1, max_length=128)


class ExistingControlChange(StrictCommand):
    """Bounded escape hatch for supported existing advanced controls, never provenance."""

    type: Literal["existing_control"]
    collection: Literal["conditions", "interventions", "updates"]
    record: dict[str, Any]


Change = Annotated[
    ParametersChange
    | UnitChange
    | ArrivalsChange
    | ArrivalBatchChange
    | TemporaryBedsChange
    | StaffAbsenceChange
    | OperationsChange
    | EquipmentChange
    | RemoveChange
    | ExistingControlChange,
    Field(discriminator="type"),
]


class PrepareArguments(StrictCommand):
    changes: list[Change] = Field(default_factory=list, max_length=24)
    terminal: Literal["edit", "save", "run", "cancel_run", "undo"] = "edit"
    mode: Literal["direct", "proposal"] = "proposal"
    authorization_quote: str | None = Field(default=None, max_length=8000)
    run_group_id: str | None = Field(default=None, max_length=96)
    explanation: str = Field(default="", max_length=1500)


TOOL_MODELS = {
    "get_current_context": EmptyArguments,
    "read_planning_guide": GuideArguments,
    "read_results": ResultsArguments,
    "find_saved_scenarios": ScenarioSearchArguments,
    "compare_saved_scenarios": ComparisonArguments,
    "prepare_action": PrepareArguments,
}


def tool_definitions():
    descriptions = {
        "get_current_context": "Read the captured CURRENT unsaved draft, baseline units/ranges, selected frozen results and validation. No patient rows.",
        "read_planning_guide": "Read a concise, versioned guide to existing app controls and evidence semantics.",
        "read_results": "Read real completed frozen simulation results. Optional local_date selects ONE actually recorded local-day interval, not whole-horizon metrics. Distinguishes ensemble from one explicitly labelled example; missing is unavailable.",
        "find_saved_scenarios": "Find up to10 owned saved scenarios by name using literal text, to obtain real IDs for a comparison. Does not load patient records or modify scenarios.",
        "compare_saved_scenarios": "Compare two different SAVED scenarios using existing revision/period/model compatibility guards; descriptive, never a paired causal claim.",
        "prepare_action": 'TERMINAL planning handoff: prepare ONE composed action containing ALL requested changes. After successful validation the app creates canonical readback; no final prose call is needed. This NEVER executes a mutation. Ask for material missing unit/time/duration first. The server derives direct eligibility from the CURRENT human instruction and validates every changed intent, independent of the model mode hint. Suggestions remain proposals. changes is ALWAYS an ARRAY of TYPED objects. Examples: [{"type":"operations","disruption_chance_percent":25}]; [{"type":"arrival_batch","count":100,"at":"<requested ISO time>","entry_stream_id":"ED_MAIN","spread_minutes":60},{"type":"temporary_beds","unit_id":"UNIT-WARD-A","unavailable_count":10,"start_at":"<requested ISO start>","end_at":"<requested ISO end>"}]. Use temporary_beds/unavailable_count exactly, not unit_unavailable/count.25 is25percentage points, not0.25.',
    }
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": descriptions[name],
                "parameters": model.model_json_schema(),
            },
        }
        for name, model in TOOL_MODELS.items()
    ]
