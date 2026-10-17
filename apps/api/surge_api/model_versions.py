"""Never recompute a frozen run with a different simulation implementation."""

SCENARIO_PROVENANCE_FIELDS = frozenset(
    {
        "state_origin",
        "reconciliation",
        "model_migration",
        "parent_scenario_id",
        "parent_scenario_revision_id",
        "parent_run_group_id",
        "parent_replication_id",
        "source_replication_id",
        "branch_strategy",
        "branch_at",
        "branch_replication_index",
        "measurement_start_at",
        "conditional_label",
    }
)


class InvalidResetProvenance(ValueError):
    pass


def require_complete_reset(scenario, session, workspace_id):
    """An observed reset replaces state; it never replays a selected old prefix."""
    from surge_engine import validate_dataset
    from surge_engine.common import dt

    from .db import Document, digest

    def invalid():
        raise InvalidResetProvenance(
            "Observed resets require a complete owned snapshot and valid reconciliation; use the update/reset workflow"
        )

    if any(
        scenario.get(field) is not None
        for field in (
            "branch_strategy",
            "branch_replication_index",
            "parent_replication_id",
            "source_replication_id",
        )
    ):
        invalid()
    report = scenario.get("reconciliation")
    if not isinstance(report, dict) or report.get("policy") != "replace_complete_snapshot":
        invalid()
    fields = (
        "previous_dataset_version_id",
        "observed_dataset_version_id",
        "effective_at",
        "matched",
        "absent",
        "new",
        "basis",
        "included_update_ids",
    )
    if any(field not in report for field in fields) or report.get("reconciliation_hash") != digest(
        {field: report[field] for field in fields}
    ):
        invalid()
    dataset = session.get(Document, scenario.get("dataset_version_id"))
    if (
        not dataset
        or dataset.kind != "dataset"
        or dataset.workspace_id != workspace_id
        or report["observed_dataset_version_id"] != dataset.id
    ):
        invalid()
    try:
        cutoff = dt(report["effective_at"])
        if dt(dataset.data["snapshot_at"]) != cutoff or dt(scenario["start_at"]) != cutoff:
            invalid()
        if any(
            scenario.get(field) and dt(scenario[field]) != cutoff
            for field in ("branch_at", "measurement_start_at")
        ):
            invalid()
    except (KeyError, TypeError, ValueError):
        invalid()
    if not validate_dataset(dataset.data)["valid"]:
        invalid()


class ModelVersionMismatch(ValueError):
    code = "MODEL_VERSION_MISMATCH"

    def __init__(self, frozen, current):
        self.frozen = frozen
        self.current = current
        super().__init__(
            f"This run uses model {frozen or 'unknown legacy version'}, but the installed model is {current}. "
            "Clone its scenario and start a new run with the current model. Existing saved results and artifacts remain available."
        )


def require_current_model(payload):
    from surge_engine.common import MODEL_VERSION

    if payload.get("model_version") != MODEL_VERSION:
        raise ModelVersionMismatch(payload.get("model_version"), MODEL_VERSION)


def require_current_run_context(payload, session, workspace_id):
    """A current job may still carry a saved branch of a historical parent."""
    from .db import Document, Job

    require_current_model(payload)
    scenario = payload.get("scenario", {})
    if scenario.get("state_origin") == "observed_reset":
        require_complete_reset(scenario, session, workspace_id)
        return
    parent_id = scenario.get("parent_run_group_id")
    if not parent_id and scenario.get("parent_replication_id"):
        replication = session.get(Document, scenario["parent_replication_id"])
        if not replication or replication.workspace_id != workspace_id:
            raise ValueError("Branch source requires an owned parent replication")
        parent_id = replication.data.get("run_group_id")
    if parent_id:
        parent = session.get(Job, parent_id)
        if not parent or parent.workspace_id != workspace_id or parent.kind != "run":
            raise ValueError("Branch source requires an owned parent run")
        require_current_model(parent.payload)
