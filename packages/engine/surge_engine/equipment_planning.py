"""Exact inventory arithmetic for synthetic equipment assumptions."""

from .common import dt


def equipment_operation(payload):
    operation = payload.get("operation", "add" if payload.get("quantity_delta", 0) >= 0 else "decommission")
    quantity = payload.get("quantity", abs(payload.get("quantity_delta", 0)))
    return operation, quantity


def planned_equipment_errors(dataset, events):
    """Fold active equipment reports and plans by timestamp and saved order.

    This projection excludes trajectory-dependent relocation/usage. The runtime
    applies the same exact bounds to live inventory before each planned event.
    """
    pools = {
        p["equipment_pool_id"]: [p.get("quantity", 0), p.get("unserviceable_quantity", 0)]
        for p in dataset.get("equipment_pools", [])
    }
    ordered = []
    for index, event in enumerate(events if isinstance(events, list) else []):
        if (
            not isinstance(event, dict)
            or event.get("type") != "equipment_change"
            or event.get("status", "active") != "active"
        ):
            continue
        try:
            ordered.append((dt(event["effective_at"]), index, event))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    errors = []
    for _, index, event in sorted(ordered, key=lambda row: (row[0], row[1])):
        payload = event.get("payload")
        if not isinstance(payload, dict):
            continue
        pool = pools.get(payload.get("equipment_pool_id", payload.get("pool_id")))
        if pool is None:
            continue
        try:
            operation, quantity = equipment_operation(payload)
        except (TypeError, ValueError):
            continue
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 0:
            continue
        total, failed = pool
        limit = {"fail": total - failed, "repair": failed, "decommission": total}.get(operation)
        planned = event.get("input_kind") == "planned_assumption"
        if planned and limit is not None and quantity > limit:
            errors.append(
                {
                    "field": f"updates.{index}.payload.quantity",
                    "message": f"Planned {operation} quantity {quantity} exceeds {limit} available before this event; earlier equipment reports and plans are applied in time order",
                }
            )
            continue
        if not planned:
            # Existing reports keep their established saturating semantics.
            # Retirements remove available serviceable stock; live held stock
            # is handled by the runtime pending-decommission ledger.
            quantity = (
                min(quantity, max(0, total - failed) if operation == "decommission" else limit)
                if limit is not None
                else quantity
            )
        if operation == "add":
            pool[0] += quantity
        elif operation == "fail":
            pool[1] += quantity
        elif operation == "repair":
            pool[1] -= quantity
        elif operation == "decommission":
            pool[0] -= quantity
            if planned:
                pool[1] -= min(quantity, pool[1])
    return errors


def apply_planned_equipment(pool, operation, quantity):
    """Apply exactly or fail explicitly; held retirements remain pending."""
    total = pool["quantity"] - pool["pending_decommission"]
    limits = {"fail": max(0, total - pool["failed"]), "repair": pool["failed"], "decommission": max(0, total)}
    if operation in limits and quantity > limits[operation]:
        raise ValueError(
            f"Planned equipment {operation} cannot apply exactly to {pool['equipment_pool_id']}: requested {quantity}, available {limits[operation]} after prior allocations and changes"
        )
    if operation == "add":
        pool["quantity"] += quantity
    elif operation == "fail":
        pool["failed"] += quantity
    elif operation == "repair":
        pool["failed"] -= quantity
    elif operation == "decommission":
        held = sum(pool["in_use"].values()) + sum(pool["reserved"].values())
        immediate = min(quantity, max(0, pool["quantity"] - held - pool["pending_decommission"]))
        pool["failed"] -= min(quantity, pool["failed"])
        pool["quantity"] -= immediate
        pool["pending_decommission"] += quantity - immediate
    else:
        raise ValueError("Unsupported equipment operation")
