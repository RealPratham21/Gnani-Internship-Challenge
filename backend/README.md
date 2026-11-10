# Wundro backend

FastAPI service for the Wundro conversational WebXR client.

For the full project story, phone/ADB setup, architecture, and challenge context, see the
**[root README](../README.md)**.

## Quick start

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Add COHERE_API_KEY and GNANI_API_KEY
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## Useful env vars

See `.env.example`. Highlights:

- `GNANI_PRISMA_LANGUAGE=hi-IN,en-IN,mr-IN`
- `GNANI_TIMBRE_LANGUAGE=auto`
- `WUNDRO_DEBUG_PROVIDER_LOGS=false`
- `WUNDRO_ASSET_CACHE` (optional; `SHABDVERSE_ASSET_CACHE` still accepted)
