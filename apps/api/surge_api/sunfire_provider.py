"""Bounded server-only OCI chat transport; application tools execute elsewhere.

The default is deliberately unverified. A deployment operator records a successful
instance-principal tool-call probe before marking a matching configuration ready.
Status reads never perform paid inference. Grok requests through OCI are hosted
externally by xAI; this adapter never adds patient records to the supplied context.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import oci

DEFAULT_MODEL = "openai.gpt-oss-120b"
# An operator may explicitly select one of these transports. This is an
# allowlist, never a fallback chain; each exact model needs its own access proof.
SUPPORTED_MODELS = frozenset({DEFAULT_MODEL, "xai.grok-4.7", "meta.llama-3.3-70b-instruct"})
SUPPORTED_REGIONS = frozenset({"us-chicago-1", "us-ashburn-1", "us-phoenix-1"})
VERIFICATION_VERSION = 1
MAX_REQUEST_BYTES = 160_000
MAX_RESPONSE_BYTES = 64_000
MAX_ARGUMENT_BYTES = 16_000
MAX_TOOL_CALLS = 12
_local = threading.local()
_failure_lock = threading.RLock()
_failures: dict[tuple, tuple[float, dict]] = {}
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_CALL_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def _after_fork():
    # Workers must not inherit another process's refresh signer, connection
    # pool, or potentially held synchronization primitive.
    global _local, _failure_lock, _failures
    _local = threading.local()
    _failure_lock = threading.RLock()
    _failures = {}


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


class ProviderError(RuntimeError):
    """Only these constructed messages may be persisted or shown to the user."""

    def __init__(self, message, *, code="provider_error", retryable=False):
        self.code = code
        self.retryable = retryable
        super().__init__(message)


class ProviderUnavailable(ProviderError):
    pass


class ProviderRateLimited(ProviderError):
    pass


class ProviderCancelled(ProviderError):
    def __init__(self):
        super().__init__("Sunfire request cancelled.", code="cancelled")


@dataclass(frozen=True)
class _Settings:
    model: str
    region: str
    compartment: str
    auth: str
    profile: str
    config_file: str
    enabled: bool
    access_status: str
    verification: str

    @property
    def key(self):
        return (
            os.getpid(),
            self.model,
            self.region,
            self.compartment,
            self.auth,
            self.profile,
            self.config_file,
            self.access_status,
            self.verification,
        )


def _settings():
    return _Settings(
        model=os.getenv("SUNFIRE_OCI_MODEL", DEFAULT_MODEL),
        region=os.getenv("SUNFIRE_OCI_REGION", os.getenv("OCI_REGION", "us-chicago-1")),
        compartment=os.getenv("SUNFIRE_OCI_COMPARTMENT_ID", os.getenv("OCI_COMPARTMENT_ID", "")),
        auth=os.getenv("OCI_AUTH", "instance_principal"),
        profile=os.getenv("SUNFIRE_OCI_CONFIG_PROFILE", os.getenv("OCI_CONFIG_PROFILE", "DEFAULT")),
        config_file=os.getenv("OCI_CONFIG_FILE", oci.config.DEFAULT_LOCATION),
        enabled=os.getenv("SUNFIRE_ENABLED", "").lower() in {"1", "true"},
        access_status=os.getenv("SUNFIRE_OCI_ACCESS_STATUS", "unverified"),
        verification=os.getenv("SUNFIRE_OCI_VERIFICATION", ""),
    )


def _reject_constant(_value):
    raise ValueError("Non-finite JSON")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON member")
        result[key] = value
    return result


def _json(value, maximum=MAX_RESPONSE_BYTES):
    if not isinstance(value, str) or len(value.encode("utf-8")) > maximum:
        raise ValueError("JSON exceeds its allowed size")

    def finite_float(text):
        result = float(text)
        if not math.isfinite(result):
            raise ValueError("Non-finite JSON number")
        return result

    return json.loads(
        value,
        parse_constant=_reject_constant,
        parse_float=finite_float,
        object_pairs_hook=_unique_object,
    )


def _verification(settings):
    try:
        proof = _json(settings.verification, 4096)
        if not isinstance(proof, dict) or type(proof.get("version")) is not int:
            return None
        if (
            proof["version"] != VERIFICATION_VERSION
            or proof.get("model") != settings.model
            or proof.get("region") != settings.region
            or proof.get("compartment_id") != settings.compartment
            or proof.get("auth") != settings.auth
            or proof.get("status") != settings.access_status
        ):
            return None
        at = datetime.fromisoformat(proof["verified_at"])
        if at.tzinfo is None or at > datetime.now(UTC) + timedelta(minutes=5):
            return None
        if settings.access_status == "ready" and proof.get("tool_calling") is not True:
            return None
        return proof
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def _status(settings):
    base = {
        "available": False,
        "model": settings.model,
        "region": settings.region,
        "retryable": False,
        "external_provider": "xAI" if settings.model.startswith("xai.") else None,
    }
    if not settings.enabled:
        return {**base, "code": "disabled", "reason": "Sunfire is not enabled on this server."}
    if settings.model not in SUPPORTED_MODELS or settings.region not in SUPPORTED_REGIONS:
        return {
            **base,
            "code": "configuration_invalid",
            "reason": "Sunfire's OCI model or region is not supported.",
        }
    if not re.fullmatch(r"ocid1\.compartment\.oc1\.\.[A-Za-z0-9]+", settings.compartment):
        return {
            **base,
            "code": "configuration_invalid",
            "reason": "Sunfire's OCI compartment is not configured.",
        }
    if settings.auth not in {"instance_principal", "api_key"} or (
        os.getenv("APP_ENV") in {"production", "staging"} and settings.auth != "instance_principal"
    ):
        return {
            **base,
            "code": "configuration_invalid",
            "reason": "Sunfire requires server-side OCI instance authentication.",
        }
    proof = _verification(settings)
    if not proof:
        return {
            **base,
            "code": "unverified",
            "reason": "Sunfire's model access has not been verified for this server configuration.",
        }
    base["verified_at"] = proof["verified_at"]
    if settings.access_status == "quota_zero":
        return {
            **base,
            "code": "quota_zero",
            "reason": "The selected OCI model has no service quota in this region. Request a service-limit increase before trying again.",
        }
    if settings.access_status == "permission_denied":
        return {
            **base,
            "code": "permission_denied",
            "reason": "This server does not have permission to use the selected OCI chat model.",
        }
    if settings.access_status != "ready":
        return {**base, "code": "unverified", "reason": "Sunfire's model access has not been verified."}
    with _failure_lock:
        observed = _failures.get(settings.key)
        if observed and observed[0] > time.monotonic():
            return {**base, **observed[1]}
        _failures.pop(settings.key, None)
    return {**base, "available": True, "code": "ready"}


def availability():
    """Report matched operator verification and recent failures, without a model call."""
    return _status(_settings())


def clear_cached_failures():
    """Operator/test hook after access changes; it cannot mark a model verified."""
    with _failure_lock:
        _failures.clear()


def _remember_failure(settings, exc):
    with _failure_lock:
        if len(_failures) >= 8:
            _failures.clear()
        _failures[settings.key] = (
            time.monotonic() + (30 if exc.retryable else 3600),
            {"available": False, "code": exc.code, "reason": str(exc), "retryable": exc.retryable},
        )


def _client(settings):
    cached = getattr(_local, "client", None)
    if settings.auth == "instance_principal" and cached and cached[0] == settings.key:
        return cached[1]
    options = {"timeout": (5, 45), "retry_strategy": oci.retry.NoneRetryStrategy()}
    if settings.auth == "instance_principal":
        signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner(
            retry_strategy=oci.retry.NoneRetryStrategy(),
        )
        client = oci.generative_ai_inference.GenerativeAiInferenceClient(
            {"region": settings.region},
            signer=signer,
            **options,
        )
    else:
        config = oci.config.from_file(file_location=settings.config_file, profile_name=settings.profile)
        client = oci.generative_ai_inference.GenerativeAiInferenceClient(
            {**config, "region": settings.region},
            **options,
        )
    if settings.auth == "instance_principal":
        _local.client = (settings.key, client)
    return client


def _bounded_json(value, maximum):
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > maximum:
        raise ValueError("Payload exceeds its allowed size")
    return encoded


def _inline_schema(root):
    """Expose local definitions to OCI's native tool renderer.

    The hosted renderer omits referenced union members from its model-facing
    format. Expand local schema references, preserving validation assertions;
    the application's original Pydantic schema still validates every tool call.
    Never fetch external schemas or expand cyclic/unbounded references.
    """
    maps = {"properties", "patternProperties", "dependentSchemas"}
    arrays = {"allOf", "anyOf", "oneOf", "prefixItems"}
    singles = {
        "items",
        "additionalProperties",
        "additionalItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
        "unevaluatedProperties",
        "unevaluatedItems",
        "contentSchema",
    }
    budget = 4000

    def walk(schema, references=(), depth=0):
        nonlocal budget
        budget -= 1
        if budget < 0 or depth > 40:
            raise ValueError("Tool schema expansion exceeds its allowed complexity")
        if isinstance(schema, bool):
            return schema
        if not isinstance(schema, dict):
            raise TypeError("Invalid tool schema")
        ref = schema.get("$ref")
        expanded = None
        if ref is not None:
            if not isinstance(ref, str) or not ref.startswith("#/") or ref in references:
                raise ValueError("Only acyclic local schema references are supported")
            target = root
            for token in ref[2:].split("/"):
                member = token.replace("~1", "/").replace("~0", "~")
                if not isinstance(target, dict) or member not in target:
                    raise ValueError("Invalid local schema reference")
                target = target[member]
            expanded = walk(target, (*references, ref), depth + 1)
        result = {}
        for key, value in schema.items():
            # discriminator is an OpenAPI annotation; the retained oneOf/type
            # assertions preserve validation without dangling mapping references.
            if key in {"$ref", "$defs", "definitions", "discriminator"}:
                continue
            if key in maps:
                result[key] = {name: walk(item, references, depth + 1) for name, item in value.items()}
            elif key in arrays or key == "items" and isinstance(value, list):
                result[key] = [walk(item, references, depth + 1) for item in value]
            elif key in singles:
                result[key] = walk(value, references, depth + 1)
            else:
                # Literal defaults/enum values may themselves contain a key
                # named $ref; those are data and must never be rewritten.
                result[key] = copy.deepcopy(value)
        if ref is not None:
            return {"allOf": [expanded, result]} if result else expanded
        return result

    result = walk(root)
    _bounded_json(result, MAX_REQUEST_BYTES)
    return result


def _request(messages, tools):
    m = oci.generative_ai_inference.models
    if not isinstance(messages, list) or not 1 <= len(messages) <= 64:
        raise ValueError("Invalid conversation length")
    if not isinstance(tools, list) or len(tools) > 24:
        raise ValueError("Invalid tool count")
    _bounded_json([messages, tools], MAX_REQUEST_BYTES)
    definitions, names = [], set()
    for definition in tools:
        definition = definition.get("function", definition)
        name = definition.get("name")
        parameters = definition.get("parameters", {"type": "object", "properties": {}})
        if not isinstance(name, str) or not _NAME.fullmatch(name) or name in names:
            raise ValueError("Invalid or duplicate tool name")
        if not isinstance(parameters, dict) or parameters.get("type") != "object":
            raise ValueError("Tools require object parameter schemas")
        description = definition.get("description", "")
        if not isinstance(description, str) or len(description) > 2048:
            raise ValueError("Invalid tool description")
        names.add(name)
        definitions.append(
            m.FunctionDefinition(name=name, description=description, parameters=_inline_schema(parameters))
        )
    _bounded_json([messages, [oci.util.to_dict(definition) for definition in definitions]], MAX_REQUEST_BYTES)
    converted = []
    classes = {
        "system": m.SystemMessage,
        "user": m.UserMessage,
        "assistant": m.AssistantMessage,
        "tool": m.ToolMessage,
    }
    for message in messages:
        role = message.get("role")
        if role not in classes:
            raise ValueError("Unsupported message role")
        content = message.get("content", "")
        if content is None:
            content = ""
        if not isinstance(content, str):
            raise TypeError("Only text messages are supported")
        fields = {"content": [m.TextContent(text=content)]}
        if role == "assistant" and message.get("tool_calls"):
            if not isinstance(message["tool_calls"], list) or len(message["tool_calls"]) > MAX_TOOL_CALLS:
                raise ValueError("Invalid tool history")
            calls = []
            for call in message["tool_calls"]:
                arguments = call.get("arguments")
                if (
                    not _CALL_ID.fullmatch(call.get("id", ""))
                    or call.get("name") not in names
                    or not isinstance(arguments, dict)
                ):
                    raise ValueError("Invalid tool history")
                calls.append(
                    m.FunctionCall(
                        id=call["id"],
                        name=call["name"],
                        arguments=_bounded_json(arguments, MAX_ARGUMENT_BYTES),
                    )
                )
            fields["tool_calls"] = calls
        if role == "tool":
            if not _CALL_ID.fullmatch(message.get("tool_call_id", "")):
                raise ValueError("Invalid tool response identity")
            fields["tool_call_id"] = message["tool_call_id"]
        converted.append(classes[role](**fields))
    return converted, definitions, names


def _response(data, names, model):
    value = oci.util.to_dict(data) if not isinstance(data, dict) else data
    response = value.get("chat_response") or {}
    choices = response.get("choices") or []
    # SDK transport timestamps are datetime objects. Bound the actual model
    # payload without serializing unrelated transport metadata or credentials.
    _bounded_json({"choices": choices, "usage": response.get("usage")}, MAX_RESPONSE_BYTES)
    if len(choices) != 1:
        raise ValueError("Expected one model choice")
    choice = choices[0]
    if str(choice.get("finish_reason", "")).lower() not in {"stop", "tool_calls"}:
        raise ValueError("Incomplete model response")
    message = choice.get("message") or {}
    if message.get("refusal"):
        raise ValueError("Model declined the request")
    text = "".join(
        item.get("text", "") for item in (message.get("content") or []) if item.get("type") == "TEXT"
    )
    calls, ids = [], set()
    returned = message.get("tool_calls") or []
    if len(returned) > MAX_TOOL_CALLS:
        raise ValueError("Too many model tool calls")
    for call in returned:
        identity, name = call.get("id"), call.get("name")
        if (
            call.get("type") != "FUNCTION"
            or not isinstance(identity, str)
            or not _CALL_ID.fullmatch(identity)
            or identity in ids
            or name not in names
        ):
            raise ValueError("Unknown or duplicate model tool call")
        arguments = _json(call.get("arguments"), MAX_ARGUMENT_BYTES)
        if not isinstance(arguments, dict):
            raise TypeError("Tool arguments require an object")
        ids.add(identity)
        calls.append({"id": identity, "name": name, "arguments": arguments})
    if not text.strip() and not calls:
        raise ValueError("Empty model response")
    usage = response.get("usage")
    if isinstance(usage, dict):
        usage = {
            key: usage[key]
            for key in ("prompt_tokens", "completion_tokens", "total_tokens")
            if type(usage.get(key)) is int and 0 <= usage[key] <= 2_000_000
        } or None
    else:
        usage = None
    return {"text": text, "tool_calls": calls, "model": model, "usage": usage}


def _service_error(exc):
    if exc.status == 429:
        if re.search(r"(?:limit|quota).*?(?:set to\s*0|zero)", exc.message or "", re.IGNORECASE):
            return ProviderUnavailable(
                "The selected OCI model has no service quota in this region. Request a service-limit increase before trying again.",
                code="quota_zero",
            )
        return ProviderRateLimited(
            "OCI is limiting Sunfire requests. Try again shortly.", code="rate_limited", retryable=True
        )
    if exc.status in {401, 403, 404}:
        return ProviderUnavailable(
            "This server cannot access the selected OCI chat model. Check its model-scoped chat permission.",
            code="permission_denied",
        )
    return ProviderUnavailable(
        "OCI could not complete the Sunfire request.",
        code="provider_unavailable",
        retryable=exc.status >= 500,
    )


def complete(messages, tools, *, request_id, cancel_check=None):
    """Make one non-streaming, non-retried OCI call; never execute a model tool.

    The orchestrator owns strict per-tool Pydantic validation and all authorized
    reads/writes. Cancellation discards any late result; the SDK call is bounded
    by connection/read timeouts and has no automatic retries.
    """
    if cancel_check and cancel_check():
        raise ProviderCancelled()
    settings = _settings()
    status = _status(settings)
    if not status["available"]:
        raise ProviderUnavailable(status["reason"], code=status["code"], retryable=status["retryable"])
    if not isinstance(request_id, str) or not _CALL_ID.fullmatch(request_id):
        raise ProviderError("Sunfire request identity is invalid.", code="request_invalid")
    try:
        converted, definitions, names = _request(messages, tools)
    except (ValueError, TypeError, AttributeError, RecursionError):
        raise ProviderError(
            "Sunfire's model request is invalid or exceeds its size limit.", code="request_invalid"
        ) from None
    try:
        m = oci.generative_ai_inference.models
        request = m.GenericChatRequest(
            messages=converted,
            tools=definitions or None,
            tool_choice=m.ToolChoiceAuto() if definitions else m.ToolChoiceNone(),
            max_tokens=2048,
            is_stream=False,
            is_parallel_tool_calls=False,
            **(
                {"reasoning_effort": "LOW"}
                if settings.model.startswith(("xai.", "openai.gpt-oss-"))
                else {"temperature": 0.1}
            ),
        )
        result = _client(settings).chat(
            m.ChatDetails(
                compartment_id=settings.compartment,
                serving_mode=m.OnDemandServingMode(model_id=settings.model),
                chat_request=request,
            ),
            opc_request_id=request_id,
            retry_strategy=oci.retry.NoneRetryStrategy(),
        )
    except oci.exceptions.ServiceError as exc:
        if cancel_check and cancel_check():
            raise ProviderCancelled() from None
        safe = _service_error(exc)
        _remember_failure(settings, safe)
        raise safe from None
    except Exception:  # noqa: BLE001 -- do not expose raw SDK/auth/network exceptions or credentials.
        if cancel_check and cancel_check():
            raise ProviderCancelled() from None
        safe = ProviderUnavailable(
            "Sunfire could not connect to OCI. Check server authentication and connectivity.",
            code="connection_unavailable",
            retryable=True,
        )
        _remember_failure(settings, safe)
        raise safe from None
    if cancel_check and cancel_check():
        raise ProviderCancelled()
    try:
        return _response(result.data, names, settings.model)
    except (ValueError, TypeError, AttributeError, KeyError, RecursionError):
        raise ProviderError(
            "Sunfire received an incomplete or invalid model response. No model tool was executed.",
            code="response_invalid",
        ) from None
