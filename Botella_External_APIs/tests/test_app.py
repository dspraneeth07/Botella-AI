from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def test_health_endpoints() -> None:
    app = create_app()
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}

        body = client.get("/healthz").json()
        assert body["status"] == "ok"
        assert "candidate_pool_size" in body
        assert "max_recommendations" in body  # underscore key, consistent naming
        # Value depends on whether the local .env sets SERVICE_API_KEY.
        assert isinstance(body["auth_enabled"], bool)


def test_openapi_exposes_run_endpoint() -> None:
    app = create_app()
    with TestClient(app) as client:
        paths = client.get("/openapi.json").json()["paths"]
        assert "/run-recommendations/{client_id}/{location_id}" in paths
        # Non-blocking batch flow.
        assert "/run-recommendations/batch" in paths
        assert "/run-recommendations/batch/{batch_id}" in paths
        assert "/run-recommendations/batch/{batch_id}/collect" in paths


def test_api_key_required_when_configured() -> None:
    app = create_app()
    with TestClient(app) as client:
        client.app.state.settings.service_api_key = "sekret"  # type: ignore[attr-defined]
        try:
            denied = client.post("/run-recommendations", json={"pairs": []})
            assert denied.status_code == 401
            assert denied.json()["error"]["code"] == "unauthorized"

            wrong = client.post(
                "/run-recommendations", json={"pairs": []}, headers={"X-API-Key": "nope"}
            )
            assert wrong.status_code == 401

            # Correct key passes auth (then fails pydantic validation, not 401).
            ok = client.post(
                "/run-recommendations", json={"pairs": []}, headers={"X-API-Key": "sekret"}
            )
            assert ok.status_code == 422

            # Health endpoints stay open for probes.
            assert client.get("/health").status_code == 200
        finally:
            client.app.state.settings.service_api_key = None  # type: ignore[attr-defined]
