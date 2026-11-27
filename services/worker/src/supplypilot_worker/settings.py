from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str | None
    # Shared secret the API sends as a bearer token. Without it the /v1 routes
    # answer 503 instead of running unauthenticated.
    service_token: str | None
    port: int = 8001

    @classmethod
    def from_env(cls) -> Settings:
        token = os.environ.get("WORKER_SERVICE_TOKEN") or None
        if token is not None and len(token) < 32:
            raise ValueError("WORKER_SERVICE_TOKEN must be at least 32 characters")
        return cls(
            database_url=os.environ.get("DATABASE_URL") or None,
            service_token=token,
            port=int(os.environ.get("WORKER_PORT", "8001")),
        )
