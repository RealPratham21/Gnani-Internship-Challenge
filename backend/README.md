# ShabdVerse v0.7 conversational world backend

## Setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Add your Cohere and Gnani API keys to .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Optional: regenerate geometric fallback GLBs:

```powershell
backend\.venv\Scripts\python.exe frontend\scripts\build-fallback-glbs.py
```

The phone opens the Vite origin only; `/api` is proxied to FastAPI. Mobile microphone access and WebXR require a secure context, so use a trusted HTTPS certificate or HTTPS development tunnel when testing from another device.

## Required environment variables

- `COHERE_API_KEY`
- `GNANI_API_KEY`

Optional:

- `SHABDVERSE_ASSET_CACHE` — directory for Poly Haven downloads (defaults to `backend/.asset-cache`)

The example file contains the current documented Gnani REST endpoints and defaults:

- Prisma v3.0, `hi-IN,en-IN,mr-IN`, `codemix`
- Timbre v3.0, `auto` language routing (falls back per detected speech), voice `Avinash`, 48 kHz mono WAV

Override the model, endpoint, language, voice, or timeout values in `.env` if your Gnani account uses different provisioned settings.

## Pipeline and diagnostics

1. `POST /api/voice/plan`: WAV → Prisma → Cohere action plan (with world state).
2. Optional intermediate Timbre speech for long asset acknowledgements via `POST /api/voice/speak`.
3. The phone resolves assets (`POST /api/assets/resolve`), loads models, updates the translucent preview, and executes Scene Manager commands.
4. `POST /api/voice/complete`: actual execution + world state → response text → Timbre WAV.
5. The phone plays the returned audio and reports completion/failure.

Cached Poly Haven GLTF packages are served from `GET /api/assets/files/{asset_id}/{path}`. Local fallback GLBs live under `frontend/public/models/`.

Every stage uses one `request_id`. Structured events are printed in the FastAPI terminal and retained in a bounded in-memory diagnostic store:

- `GET /api/voice/diagnostics/{request_id}`
- `GET /api/voice/diagnostics?limit=20`

Set `SHABDVERSE_DEBUG_PROVIDER_LOGS=true` for additional redacted provider response metadata. API keys, authorization fields and tokens are masked, and raw microphone audio is never logged.

## Asset provider notes

Poly Haven public API (`https://api.polyhaven.com`) is used for discovery and downloads:

- Search: `/search?q=…&t=models`
- Metadata: `/info/{slug}`
- Files: `/files/{slug}` — GLTF packages at 1k/2k with checksums
- License: CC0; downloads from `dl.polyhaven.org` only
- User-Agent required by Poly Haven API terms

If discovery/download fails, a small verified local GLB catalogue (`sofa`, `table`, `chair`, `plant`) is used instead. Model URLs are never fabricated.

## Tests

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q

cd ..\frontend
npm test
npm run build
```
