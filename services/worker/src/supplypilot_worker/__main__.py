"""Runs the worker: `python -m supplypilot_worker` (reads DATABASE_URL, WORKER_SERVICE_TOKEN, WORKER_PORT)."""

import uvicorn

from .app import create_app
from .settings import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port)


if __name__ == "__main__":
    main()
