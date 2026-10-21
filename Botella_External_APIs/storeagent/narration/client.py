"""Thin Anthropic Messages API client over the standard library (no SDK dep).

Keeps the project's zero-extra-dependency ethos: a single urllib POST to
/v1/messages. Returns the assistant's text, or raises NarrationError on any
failure so callers can fall back to the deterministic briefing.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from ..config import NARRATION, NarrationConfig


class NarrationError(RuntimeError):
    """Any failure talking to the model (no key, network, bad status)."""


def _headers(cfg: NarrationConfig) -> dict[str, str]:
    h = {
        "content-type": "application/json",
        "anthropic-version": cfg.version,
    }
    if cfg.api_key:
        h["x-api-key"] = cfg.api_key
    elif cfg.auth_token:
        h["authorization"] = f"Bearer {cfg.auth_token}"
    return h


def complete(system: str, user: str, cfg: NarrationConfig = NARRATION,
             max_tokens: int | None = None) -> str:
    """Single-turn completion. Returns the concatenated text blocks."""
    if not cfg.enabled:
        raise NarrationError("AI narration is not configured.")
    body = json.dumps({
        "model": cfg.model,
        "max_tokens": max_tokens or cfg.max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{cfg.base_url.rstrip('/')}/v1/messages",
        data=body, headers=_headers(cfg), method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg.timeout_s) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise NarrationError(f"Anthropic API {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise NarrationError(f"Could not reach Anthropic API: {e}") from e

    blocks = payload.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    if not text:
        raise NarrationError(f"Empty completion (stop_reason={payload.get('stop_reason')}).")
    return text
