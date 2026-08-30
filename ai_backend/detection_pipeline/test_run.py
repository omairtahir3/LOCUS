import asyncio
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from scheduler import _check_schedules

async def main():
    print("Running _backfill_expired_slots once...")
    import scheduler
    await scheduler._backfill_expired_slots()
    print("Waiting for background tasks...")
    await asyncio.sleep(2)
    print("Done!")

if __name__ == "__main__":
    asyncio.run(main())
