"""A user of the suite's own, so tests stop destroying the wearer's day.

Six suites exercise privacy by creating frames, purging them and checking what
survived. Every one of them did that against `6a6e439595ff22c2e2f91416` -- the
real wearer -- hitting the real stores and the real eventlogs. So running the
tests deleted whatever the camera had captured in the preceding 120 seconds
and stamped the surviving rows `privacy_redacted` with the reason "the
bathroom is private".

That is what it looked like from the outside: the washroom rule firing on a
desk, twice, deleting frames. It was not the rule. Measured 23 Oct 2026, the
whole database held exactly ONE purge carrying a trigger -- 13 Oct, Toilet at
0.941, correct -- while ten rows redacted on 22-23 Oct carried no trigger at
all. The production path always passes one, so a purge without a trigger can
only come from a direct call, and the only direct callers are these tests.

The suites that deliberately READ the wearer's real frames are untouched:
near_miss_retry, verifier, recover, adopt_sightings, tile_enrolment_only.
Reading harms nothing. It is the writing and deleting that had to move.

The privacy block is cloned from the wearer's so the tests behave exactly as
they did, including `sensitive_rooms: ['bathroom']`, which several of them
assert on.
"""

TEST_UID = "deadbeefdeadbeefdeadbeef"       # valid ObjectId hex, unmistakable in a listing

_SEED = {
    "mode": "off",
    "mode_set_at": None,
    "auto_dead_until": None,
    "auto_dead_reason": None,
    "auto_dead_kind": None,
    "sensitive_places": [],
    "sensitive_rooms": ["bathroom"],
}


def ensure_test_user(db=None):
    """Create or reset the suite's user. Returns TEST_UID."""
    from bson import ObjectId
    if db is None:
        from pymongo import MongoClient
        import os
        db = MongoClient(os.environ.get("MONGODB_URI",
                                        "mongodb://127.0.0.1:27017"))["locusDB"]
    db.users.update_one(
        {"_id": ObjectId(TEST_UID)},
        {"$set": {"name": "Suite Fixture", "role": "user",
                  "email": "fixture@locus.test", "privacy": dict(_SEED)}},
        upsert=True,
    )
    return TEST_UID


def clear_test_user(db=None):
    """Remove the rows this user accumulated. Frames are removed by the tests."""
    from bson import ObjectId
    if db is None:
        from pymongo import MongoClient
        import os
        db = MongoClient(os.environ.get("MONGODB_URI",
                                        "mongodb://127.0.0.1:27017"))["locusDB"]
    oid = ObjectId(TEST_UID)
    db.eventlogs.delete_many({"user_id": {"$in": [oid, TEST_UID]}})
