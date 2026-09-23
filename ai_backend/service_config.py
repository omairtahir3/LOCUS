"""Where the AI backend finds the other LOCUS services.

Sibling of db_config.py: that one answers "which database?", this one answers
"which host?". Both exist for the same reason -- the answers were literals
scattered through the code, so nothing could be deployed anywhere but one
laptop.

    LOCUS_API_URL     the Node/Express backend (medication logs, notifications)
    AI_SERVICE_URL    this FastAPI service, for callbacks into itself

Unset, both point at localhost and behave exactly as before.

Note the pairing with db_config: pointing MONGODB_URI at a hosted cluster
while the pipeline still POSTs its medication logs to http://localhost:5000
gets you a half-migrated system where events reach the cloud and
notifications quietly do not.
"""

from __future__ import annotations

import os

DEFAULT_LOCUS_API = "http://localhost:5000"
DEFAULT_AI_SERVICE = "http://localhost:8000"


def _clean(url: str) -> str:
    """No trailing slash, so f"{base}/api/..." never yields a double slash."""
    return url.rstrip("/")


def get_locus_api_url() -> str:
    """The Node backend."""
    return _clean(os.environ.get("LOCUS_API_URL") or DEFAULT_LOCUS_API)


def get_ai_service_url() -> str:
    """This service, as other components should address it."""
    return _clean(os.environ.get("AI_SERVICE_URL")
                  or os.environ.get("PYTHON_SERVICE_URL")
                  or DEFAULT_AI_SERVICE)
