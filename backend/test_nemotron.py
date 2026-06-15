"""Quick test to verify the Nemotron instance is responding.

Usage:
    python test_nemotron.py

Set NEMOTRON_URL to your Brev instance endpoint before running.
Typical Brev endpoints look like:
    - http://localhost:8000/v1  (if you're SSH'd into the instance)
    - https://<instance-name>-8000.brev.dev/v1  (external access)

TensorRT-LLM serves an OpenAI-compatible API, so we hit /v1/chat/completions.
"""
import os
import httpx

# Change this to your Brev instance URL.
# If SSH'd in:      http://localhost:8000/v1
# If external:      https://<your-instance>-8000.brev.dev/v1
NEMOTRON_URL = os.environ.get("NEMOTRON_URL", "http://localhost:8000/v1")


def test_nemotron():
    url = f"{NEMOTRON_URL}/chat/completions"
    
    payload = {
        "model": "nvidia/nemotron-3-8b-chat-v0.3",  # adjust if different
        "messages": [
            {"role": "system", "content": "You are a logistics AI assistant."},
            {"role": "user", "content": "A truck carrying electronics is approaching a severe thunderstorm zone. Should it reroute? Answer in one sentence."},
        ],
        "max_tokens": 100,
        "temperature": 0.3,
    }

    print(f"Calling Nemotron at: {url}")
    print(f"Payload: {payload['messages'][-1]['content']}\n")

    try:
        resp = httpx.post(url, json=payload, timeout=30.0)
        resp.raise_for_status()
        data = resp.json()
        
        answer = data["choices"][0]["message"]["content"]
        print(f"✓ Nemotron responded!\n")
        print(f"Response: {answer}")
        print(f"\nUsage: {data.get('usage', 'N/A')}")
        return True
    except httpx.ConnectError:
        print(f"✗ Connection failed. Is the instance running at {NEMOTRON_URL}?")
        print("  - If using Brev, try: brev shell <instance> then check what port the model serves on")
        print("  - Common ports: 8000, 8080, 5000")
        return False
    except httpx.HTTPStatusError as e:
        print(f"✗ HTTP {e.response.status_code}: {e.response.text[:500]}")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False


def list_models():
    """Check what models are available on the endpoint."""
    url = f"{NEMOTRON_URL}/models"
    print(f"Checking available models at: {url}\n")
    try:
        resp = httpx.get(url, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        models = data.get("data", [])
        if models:
            print("Available models:")
            for m in models:
                print(f"  - {m['id']}")
        else:
            print("No models listed (endpoint responded but empty)")
        return models
    except Exception as e:
        print(f"Could not list models: {e}")
        return []


if __name__ == "__main__":
    print("=" * 50)
    print("  Nemotron TensorRT-LLM Test")
    print("=" * 50 + "\n")
    
    models = list_models()
    print()
    test_nemotron()
