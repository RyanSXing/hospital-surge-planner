"""Bounded serialized response cache for immutable, already-authorized results."""

import os
import threading
from collections import OrderedDict

from fastapi.responses import Response

from .db import canonical

_cache = OrderedDict()
_lock = threading.Lock()
_size = 0


def cached_response(key):
    with _lock:
        if key not in _cache:
            return None
        payload = _cache.pop(key)
        _cache[key] = payload
    return Response(payload, media_type="application/json")


def json_response(value, key=None):
    global _size
    payload = canonical(value)
    if key is not None:
        with _lock:
            if key in _cache:
                _size -= len(_cache.pop(key))
            budget = int(os.getenv("RESULT_RESPONSE_CACHE_BYTES", "67108864"))
            if len(payload) <= budget:
                while _cache and (_size + len(payload) > budget or len(_cache) >= 128):
                    _, old = _cache.popitem(last=False)
                    _size -= len(old)
                _cache[key] = payload
                _size += len(payload)
    return Response(payload, media_type="application/json")
