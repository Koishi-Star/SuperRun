from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT_DIR / ".env"


def load_env_file(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}

    if not env_path.exists():
        return values

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")

    return values


def get_config() -> tuple[str, str]:
    env_values = load_env_file(ENV_FILE)

    api_key = env_values.get("OPENAI_API_KEY", "").strip()
    base_url = env_values.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip()
    base_url = base_url.rstrip("/")

    # Reject the repo's placeholder value and obviously invalid non-ASCII input early.
    if (
        not api_key
        or api_key.lower() in {"your_key", "your-api-key"}
        or any(ord(char) > 127 for char in api_key)
    ):
        raise SystemExit(
            "Invalid OPENAI_API_KEY in .env. Replace the placeholder with a real API key."
        )

    return api_key, base_url


def fetch_models(api_key: str, base_url: str) -> list[dict[str, object]]:
    request = urllib.request.Request(
        url=f"{base_url}/models",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Model request failed: HTTP {exc.code}\n{body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Failed to reach API: {exc}") from exc

    data = payload.get("data")
    if not isinstance(data, list):
        raise SystemExit(f"Unexpected response payload: {json.dumps(payload, ensure_ascii=False)}")

    return data


def main() -> None:
    api_key, base_url = get_config()
    models = fetch_models(api_key, base_url)

    for index, model in enumerate(models):
        model_id = model.get("id", "<missing id>")
        print(f"model[{index}]: {model_id}")


if __name__ == "__main__":
    main()
