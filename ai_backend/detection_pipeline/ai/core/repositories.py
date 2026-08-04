"""Durable MongoDB repositories for event records and verification jobs.

These repositories are deliberately independent of the local scheduler.  They
allow the current single-process deployment to keep working while a worker
service can later claim the same jobs using an atomic MongoDB lease.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from .contracts import EventRecord


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class EventRepository:
    collection_name = "events"

    def __init__(self, db) -> None:
        self.collection = db[self.collection_name]

    async def save(self, event: EventRecord, idempotency_key: str) -> dict[str, Any]:
        """Insert one event once, even when a worker retries the same action."""
        doc = event.to_dict()
        doc.update({
            "idempotency_key": idempotency_key,
            "created_at": utc_now(),
        })
        await self.collection.update_one(
            {"idempotency_key": idempotency_key},
            {"$setOnInsert": doc},
            upsert=True,
        )
        stored = await self.collection.find_one({"idempotency_key": idempotency_key}, {"_id": 0})
        return stored or doc


class VerificationJobRepository:
    """Lease-based work queue stored in MongoDB.

    A future worker fleet can claim jobs without sharing Python memory.  Jobs
    use string identifiers by design so API, Python, and mobile clients agree
    on their representation.
    """

    collection_name = "verification_jobs"

    def __init__(self, db) -> None:
        self.collection = db[self.collection_name]

    async def enqueue(
        self,
        *,
        user_id: str,
        scheduled_time: str,
        medication_ids: list[str],
        window_ends_at: datetime,
        camera_stream_url: str = "",
        source: str = "scheduler",
    ) -> dict[str, Any]:
        # The key makes one job per user/slot/day, regardless of scheduler retries.
        schedule_day = scheduled_time[:10] if "T" in scheduled_time else utc_now().date().isoformat()
        slot = scheduled_time[-5:]
        idempotency_key = f"{user_id}:{schedule_day}:{slot}:medication_verification"
        now = utc_now()
        doc = {
            "job_id": str(uuid4()),
            "idempotency_key": idempotency_key,
            "user_id": str(user_id),
            "job_type": "medication_verification",
            "scheduled_time": scheduled_time,
            "medication_ids": [str(medication_id) for medication_id in medication_ids],
            "camera_stream_url": camera_stream_url,
            "window_ends_at": window_ends_at,
            "status": "queued",
            "source": source,
            "attempt_count": 0,
            "created_at": now,
            "updated_at": now,
        }
        await self.collection.update_one(
            {"idempotency_key": idempotency_key},
            {"$setOnInsert": doc},
            upsert=True,
        )
        stored = await self.collection.find_one({"idempotency_key": idempotency_key}, {"_id": 0})
        return stored or doc

    async def claim(self, worker_id: str, lease_seconds: int = 120) -> dict[str, Any] | None:
        """Atomically lease one available job for a worker."""
        from pymongo import ReturnDocument

        now = utc_now()
        lease_until = now + timedelta(seconds=lease_seconds)
        query = {
            "$and": [
                {"window_ends_at": {"$gt": now}},
                {"$or": [
                    {"status": "queued"},
                    {"status": "running", "lease_until": {"$lt": now}},
                ]},
            ]
        }
        update = {
            "$set": {
                "status": "running",
                "worker_id": worker_id,
                "lease_until": lease_until,
                "updated_at": now,
            },
            "$inc": {"attempt_count": 1},
        }
        return await self.collection.find_one_and_update(
            query,
            update,
            sort=[("created_at", 1)],
            return_document=ReturnDocument.AFTER,
            projection={"_id": 0},
        )

    async def finish(self, job_id: str, worker_id: str, status: str, result_event_id: str = "") -> bool:
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("invalid terminal job status")
        result = await self.collection.update_one(
            {"job_id": job_id, "worker_id": worker_id, "status": "running"},
            {"$set": {
                "status": status,
                "result_event_id": result_event_id,
                "completed_at": utc_now(),
                "updated_at": utc_now(),
            }, "$unset": {"lease_until": ""}},
        )
        return result.modified_count == 1
