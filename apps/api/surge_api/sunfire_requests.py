"""Keep a short answer attached to its still-unfinished human planning request.

Conversation prose is not a permission store. Only owner-scoped human payloads
on the exact same draft can contribute, and any action or topic change closes
the request. The normal typed intent checks and browser CAS still apply.
"""

from __future__ import annotations

import re

from .db import digest

TOKEN_FIELDS = (
    "scenario_id",
    "dataset_version_id",
    "saved_revision",
    "draft_revision",
    "draft_fingerprint",
)
MAX_REQUEST_CHARS = 16_000


def _plain(message):
    return re.sub(r"```[\s\S]*?```|\"[^\"]*\"|'[^']*'", "", message.lower()).strip()


def setup_request(message):
    text = _plain(message)
    if re.search(
        r"\b(?:what if|hypothetically|should i|should we|explain|describe|recommend|suggest)\b",
        text,
    ):
        return False
    return bool(
        re.search(
            r"(?:^|[.!?;\n]\s*)(?:(?:please|yes|okay|ok)[, ]+|(?:can|could|would) you (?:please )?|"
            r"i (?:want|need|would like) (?:you )?to |go ahead )*"
            r"(?:set|configure|prepare|create|build|add|change|edit|increase|decrease|"
            r"reduce|raise|lower|make|remove|update|plan|close|disable|enable)\b",
            text,
        )
        or re.fullmatch(
            r"(?:a |an |the )?(?:massive |large |high |low |patient |emergency |"
            r"influx |surge |demand |staffing |shortage |disruption |outage |bed |"
            r"stress |test |capacity |\d+%? )+(?:scenario|simulation|plan|test)[.!]?",
            text,
        )
    )


def setup_reply(message):
    """Recognize an answer, not a new question or a command to resurrect work."""
    text = _plain(message)
    text = re.sub(r"^(\d+(?:\s+patients?)?)\s+instead[.!]?$", r"\1", text)
    if re.match(
        r"^(?:(?:please|also)\s+)*(?:open|show|read|find|search|list|archive|delete|"
        r"export|import|download|rename|navigate|switch|select)\b",
        text,
    ):
        return False
    if (
        not text
        or "?" in text
        or re.search(
            r"\b(?:never mind|nevermind|forget|cancel|stop|undo|revert|instead|new request|"
            r"different scenario|different task|new task|start over|explain|describe|compare|bottleneck|results?|"
            r"why|how|what|where|should|thanks|thank you)\b",
            text,
        )
    ):
        return False
    if setup_request(message):
        return False
    # Real answers often contain a date, a count, a unit name or a choice.
    # Keep them bounded; arbitrary quoted text or a different conversation is
    # never imported as an instruction.
    return len(text) <= 1500 and bool(
        re.search(r"\d", text)
        or re.search(
            r"\b(?:yes|ok|okay|sure|noon|midnight|today|tomorrow|start|ward|icu|"
            r"emergency|nurses?|hours?|days?|minutes?|usual|default|defaults|random|"
            r"decide|choose|figure|whatever|first|second|last|also)\b",
            text,
        )
    )


def resolve_setup_request(message, capture, turns, action_turn_ids):
    resolved = {"message": message, "continued": False, "source_turn_ids": []}
    if not setup_reply(message):
        return resolved
    chain, size = [], len(message)
    for turn in reversed(turns):
        prior = turn.payload.get("message", "")
        context = turn.payload.get("context", {})
        result = turn.result or {}
        # A prepared proposal is already a concrete handoff. An affirmative
        # reply cannot prepare or execute it for a second time.
        if (
            turn.status != "SUCCEEDED"
            or turn.id in action_turn_ids
            or result.get("evidence")
            or result.get("error")
            or any(context.get(key) != capture.get(key) for key in TOKEN_FIELDS)
            or digest(context.get("draft")) != digest(capture.get("draft"))
            or not (setup_request(prior) or setup_reply(prior))
        ):
            break
        size += len(prior)
        if size > MAX_REQUEST_CHARS:
            break
        chain.append(turn)
        if setup_request(prior):
            ordered = list(reversed(chain))
            return {
                "message": "\n".join([*(item.payload["message"] for item in ordered), message]),
                "continued": True,
                "source_turn_ids": [item.id for item in ordered],
            }
    return resolved


def missing_bed_unit_question(message, units):
    """Keep a known missing-unit question short, without optional time fields."""
    if not setup_request(message):
        return None
    text = _plain(message)
    count = re.search(r"\b(\d+)\s+(?:(?:enabled|available|installed|hospital)\s+)*beds?\b", text)
    if not count or not re.search(r"\b(?:unavailable|clos\w*|disabl\w*|remove\w*)\b", text):
        return None
    for unit in units:
        aliases = [unit.get("name", ""), unit.get("unit_id", "")]
        if unit.get("kind") == "icu":
            aliases += ["icu", "intensive care"]
        if unit.get("kind") == "ed":
            # 'Emergency patients' identifies an arrival stream, not which
            # unit loses beds; require the actual emergency-unit label here.
            aliases += ["emergency department", "ed"]
        if any(
            alias and re.search(r"(?<!\w)" + re.escape(alias.lower()) + r"(?!\w)", text) for alias in aliases
        ):
            return None
    if re.search(r"\btemporar\w*\b", text) and not re.search(
        r"\b(?:until|through|ending)\b|\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|days?|minutes?|mins?)\b",
        text,
    ):
        return f"Which hospital unit should lose the {count[1]} beds, and for how long?"
    return (
        f"Which hospital unit should lose the {count[1]} beds? "
        "I’ll use the current simulation period and keep the other settings."
    )
