import asyncio
import time
import httpx
from datetime import datetime

# We will patch httpx.AsyncClient.get to simulate the camera turning on at T=5 seconds
real_get = httpx.AsyncClient.get
camera_turn_on_time = None

async def fake_get(self, url, *args, **kwargs):
    if "paths/list" in url:
        # Before T=5s, no stream. After T=5s, return a fake stream.
        global camera_turn_on_time
        if camera_turn_on_time is None:
            return httpx.Response(200, json={"items": []})
        
        elapsed = time.time() - camera_turn_on_time
        if elapsed > 0:
            return httpx.Response(200, json={"items": [{"name": "live/6a5b37790bc066e70665f599"}]})
        return httpx.Response(200, json={"items": []})
    return await real_get(self, url, *args, **kwargs)

httpx.AsyncClient.get = fake_get

async def main():
    import sys
    sys.path.append("c:/Users/dell/Desktop/LOCUS/ai_backend/detection_pipeline")
    sys.path.append("c:/Users/dell/Desktop/LOCUS/ai_backend")
    import scheduler

    # Overwrite the pipeline spawn to just log the time it took
    real_spawn = scheduler._spawn_pipeline_for_user
    def fake_spawn(uid, url):
        global camera_turn_on_time
        delay = time.time() - camera_turn_on_time
        print(f"\n==================================================")
        print(f"✅ SUCCESS! Pipeline spawned {delay:.3f} seconds after camera turned on.")
        print(f"==================================================\n")
        # We don't actually need to spawn the real pipeline for this test
        scheduler._scheduler_running = False
        import os
        os._exit(0)
    scheduler._spawn_pipeline_for_user = fake_spawn

    # Start the stream monitor (which runs every 3s)
    import asyncio
    scheduler._scheduler_running = True
    asyncio.create_task(scheduler.run_stream_monitor())
    
    # Wait 2 seconds, then "turn on the camera"
    await asyncio.sleep(2)
    global camera_turn_on_time
    camera_turn_on_time = time.time()
    print(f"\n[Test] Camera turned on at {camera_turn_on_time:.2f} (mocked API). Waiting for scheduler to notice...")

    # Keep alive until test finishes
    await asyncio.sleep(10)

if __name__ == "__main__":
    asyncio.run(main())
