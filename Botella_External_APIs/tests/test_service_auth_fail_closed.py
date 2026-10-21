"""SERVICE_API_KEY is required in production, and the service says so at startup.

Defect 4 of the 19 October 2026 QA audit: with ``SERVICE_API_KEY`` unset the
X-API-Key check in ``app/dependencies.py`` was a no-op, and the only thing that
said "set it in production" was a docstring. Node closed the same class in
checklist 6 - ``backend/middleware/auth.js`` throws at import when
``NODE_API_TOKEN`` is missing and ``NODE_ENV=production`` - and the Python side
now follows the same rule through a ``Settings`` validator, so ``get_settings()``
in ``app.main`` fails before uvicorn binds a port.

Outside production the behaviour is unchanged (open), announced by one warning
in the lifespan. These tests pin both halves and the message text that names
the variable, because a refusal that does not say what to set is an outage.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import SERVICE_API_KEY_REQUIRED_MESSAGE, Settings, get_settings
from app.dependencies import SERVICE_AUTH_OPEN_WARNING, warn_if_service_auth_open

REQUIRED = {"node_api_base_url": "http://node.test", "anthropic_api_key": "test-key"}


class _CapturingLog:
    def __init__(self) -> None:
        self.warnings: list[tuple[str, dict]] = []

    def warning(self, event: str, **kw: object) -> None:
        self.warnings.append((event, kw))


# ---------------------------------------------------------------- production


def test_production_without_key_refuses_to_construct_settings(monkeypatch) -> None:
    # The checkout's .env may carry a real key; an explicit None outranks it.
    monkeypatch.delenv("SERVICE_API_KEY", raising=False)
    with pytest.raises(ValidationError) as excinfo:
        Settings(**REQUIRED, environment="production", service_api_key=None)
    text = str(excinfo.value)
    assert "SERVICE_API_KEY" in text, "the refusal must name the variable"
    assert SERVICE_API_KEY_REQUIRED_MESSAGE in text


def test_production_with_empty_key_is_unset(monkeypatch) -> None:
    # `SERVICE_API_KEY=` in a .env arrives as "", which is not a key.
    monkeypatch.delenv("SERVICE_API_KEY", raising=False)
    with pytest.raises(ValidationError):
        Settings(**REQUIRED, environment="production", service_api_key="")


def test_production_with_key_constructs() -> None:
    s = Settings(**REQUIRED, environment="production", service_api_key="sekret")
    assert s.is_production
    assert s.service_api_key == "sekret"


@pytest.mark.parametrize("spelling", ["production", "Production", " PRODUCTION "])
def test_environment_is_matched_case_insensitively(monkeypatch, spelling: str) -> None:
    # The forgiving direction is the closed one: a capitalised value must not
    # quietly land in development mode.
    monkeypatch.delenv("SERVICE_API_KEY", raising=False)
    with pytest.raises(ValidationError):
        Settings(**REQUIRED, environment=spelling, service_api_key=None)


def test_refusal_names_where_the_matching_values_live() -> None:
    # The same key is sent by Node under two names; the message has to say so
    # or the operator sets one side and gets a 401 from a healthy server.
    for name in ("SERVICE_API_KEY", "REC_SERVICE_API_KEY", "STOREAGENT_API_KEY",
                 "Botella_External_APIs/.env", "backend/.env"):
        assert name in SERVICE_API_KEY_REQUIRED_MESSAGE


def test_startup_path_refuses_through_get_settings(monkeypatch) -> None:
    """The route uvicorn takes: app.main -> get_settings() -> Settings()."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    # An empty env var beats the dotenv file in pydantic-settings, so this
    # holds whether or not the developer's .env carries a key.
    monkeypatch.setenv("SERVICE_API_KEY", "")
    get_settings.cache_clear()
    try:
        with pytest.raises(ValidationError) as excinfo:
            get_settings()
        assert "SERVICE_API_KEY" in str(excinfo.value)
    finally:
        get_settings.cache_clear()


# --------------------------------------------------------------- development


def test_development_without_key_stays_open_and_warns_once(monkeypatch) -> None:
    monkeypatch.delenv("SERVICE_API_KEY", raising=False)
    s = Settings(**REQUIRED, environment="development", service_api_key=None)
    assert not s.is_production
    assert s.service_api_key is None  # today's behaviour: the check is a no-op

    log = _CapturingLog()
    assert warn_if_service_auth_open(s, log) is True
    assert len(log.warnings) == 1
    event, fields = log.warnings[0]
    assert event == "service_auth_open"
    assert fields["environment"] == "development"
    assert "SERVICE_API_KEY" in fields["message"]
    assert fields["message"] == SERVICE_AUTH_OPEN_WARNING


def test_key_set_means_no_warning() -> None:
    s = Settings(**REQUIRED, environment="development", service_api_key="sekret")
    log = _CapturingLog()
    assert warn_if_service_auth_open(s, log) is False
    assert log.warnings == []


def test_default_environment_is_development() -> None:
    # Nothing in the tree sets ENVIRONMENT except the operator's .env, so the
    # default has to be the open one or every fresh clone refuses to start.
    assert Settings.model_fields["environment"].default == "development"
