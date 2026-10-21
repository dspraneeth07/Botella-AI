"""Settings must not depend on the process working directory.

`uvicorn app.main:app` launched one level above the repo used to load NO
settings at all and die on "node_api_base_url Field required" — a wrong-cwd
failure wearing a missing-.env costume.
"""
from __future__ import annotations

import os
from pathlib import Path

from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_env_file_is_anchored_to_the_repo_not_the_cwd() -> None:
    configured = Settings.model_config.get("env_file")
    assert configured is not None, "Settings must declare an env_file"
    as_path = Path(str(configured))
    assert as_path.is_absolute(), (
        f"env_file must be absolute so the cwd cannot change it; got {configured!r}"
    )
    assert as_path.parent == REPO_ROOT


def test_settings_load_from_an_unrelated_cwd(tmp_path, monkeypatch) -> None:
    # No .env here: if resolution were cwd-relative this would raise.
    monkeypatch.chdir(tmp_path)
    for required in ("NODE_API_BASE_URL", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(required, raising=False)

    assert not (tmp_path / ".env").exists()
    if not (REPO_ROOT / ".env").exists():
        # CI has no .env; the absolute-path assertion above is the real guard.
        return

    settings = Settings()
    assert settings.node_api_base_url
    assert os.getcwd() == str(tmp_path)
