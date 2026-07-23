"""Quick diagnostic: check pipeline detection status and try analysis."""
import requests, json

base = "http://localhost:8000"

# Detection status
try:
    r = requests.get(f"{base}/api/detection/status", timeout=5)
    print("=== Detection Status ===")
    print(json.dumps(r.json(), indent=2, default=str))
except Exception as e:
    print(f"Status error: {e}")

# Try analyze
try:
    r = requests.post(f"{base}/api/detection/analyze", timeout=30)
    print("\n=== Analysis Result ===")
    data = r.json()
    # Truncate large fields
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, str) and len(v) > 200:
                data[k] = v[:200] + "..."
    print(json.dumps(data, indent=2, default=str))
except Exception as e:
    print(f"Analyze error: {e}")

# Medicine count
try:
    r = requests.get(f"{base}/api/detection/medicine-count", timeout=5)
    print("\n=== Medicine Count ===")
    print(json.dumps(r.json(), indent=2, default=str))
except Exception as e:
    print(f"Count error: {e}")
