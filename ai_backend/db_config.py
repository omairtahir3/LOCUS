"""The one place the AI backend decides which MongoDB it talks to.

Core FE-9 asks for the event record to go "to the cloud". The record itself
was already complete -- timestamp, action type, confidence, GPS, keyframe ids
-- but the destination was the string "mongodb://127.0.0.1:27017" repeated in
twenty places across five files, so pointing the system at a hosted cluster
meant editing every one of them and hoping none was missed.

Set MONGODB_URI (and optionally MONGODB_DB) in ai_backend/detection_pipeline/.env
and every writer follows, local or hosted:

    MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
    MONGODB_DB=locusDB

Unset, it stays on localhost, so nothing changes for a local run.

MONGO_URI is accepted as an alias because the Node backend already uses that
name; keeping one spelling across both halves avoids a split-brain deployment
where the two services write to different databases.
"""

from __future__ import annotations

import os

DEFAULT_URI = "mongodb://127.0.0.1:27017"


def get_mongo_uri() -> str:
    return os.environ.get("MONGODB_URI") or os.environ.get("MONGO_URI") or DEFAULT_URI


def get_db_name() -> str:
    return os.environ.get("MONGODB_DB") or os.environ.get("MONGO_DB") or "locusDB"


def is_remote() -> bool:
    """True when we are NOT talking to a database on this machine."""
    uri = get_mongo_uri()
    return "localhost" not in uri and "127.0.0.1" not in uri


def get_client(**kwargs):
    """A MongoClient for the configured URI.

    serverSelectionTimeoutMS defaults higher for a remote cluster: the 2000 ms
    used for a local socket is not enough for a TLS handshake across the
    internet, and a timeout here silently drops an event record.
    """
    from pymongo import MongoClient

    kwargs.setdefault("serverSelectionTimeoutMS", 10000 if is_remote() else 2000)
    return MongoClient(get_mongo_uri(), **kwargs)


def get_db(**kwargs):
    """The configured database handle."""
    return get_client(**kwargs)[get_db_name()]
