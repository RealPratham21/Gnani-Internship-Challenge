from __future__ import annotations

import mimetypes

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError

from .asset_resolver import AssetResolver, AssetResolverError
from .gnani import GnaniConfigurationError, GnaniProviderError, GnaniSettings
from .interpreter import (
    InterpreterConfigurationError,
    InterpreterOutputError,
    InterpreterProviderError,
    create_interpreter_from_env,
)
from .models import (
    InterpretRequest,
    InterpretResponse,
    AssetResolveRequest,
    AssetResolveResponse,
    SceneSnapshot,
    VoiceClientEvent,
    VoiceCompleteRequest,
    VoiceCompleteResponse,
    VoicePlanResponse,
    VoiceSpeakRequest,
    WorldState,
)
from .pipeline_logging import pipeline_logs
from .voice import VoicePipelineService, create_voice_service


app = FastAPI(title="ShabdVerse Conversational World", version="0.7.0")


def _interpreter(request: Request):
    value = getattr(request.app.state, "interpreter", None)
    if value is None:
        value = create_interpreter_from_env()
        request.app.state.interpreter = value
    return value


def _voice_service(request: Request) -> VoicePipelineService:
    value = getattr(request.app.state, "voice_service", None)
    if value is None:
        value = create_voice_service(pipeline_logs)
        request.app.state.voice_service = value
    return value


def _asset_resolver(request: Request) -> AssetResolver:
    value = getattr(request.app.state, "asset_resolver", None)
    if value is None:
        value = AssetResolver(pipeline_logs)
        request.app.state.asset_resolver = value
    return value


def _raise_stage_error(request_id: str, error: Exception) -> None:
    if isinstance(error, (GnaniConfigurationError, InterpreterConfigurationError)):
        pipeline_logs.emit(request_id, "pipeline", "configuration_failed", "error", error=str(error))
        raise HTTPException(status_code=503, detail=str(error)) from error
    if isinstance(error, GnaniProviderError):
        pipeline_logs.emit(request_id, error.stage, "stage_failed", "error", error=str(error))
        raise HTTPException(
            status_code=error.status_code,
            detail={"stage": error.stage, "message": str(error), "request_id": request_id},
        ) from error
    if isinstance(error, InterpreterProviderError):
        pipeline_logs.emit(request_id, "cohere", "stage_failed", "error", error=str(error))
        raise HTTPException(
            status_code=error.status_code,
            detail={"stage": "cohere", "message": str(error), "request_id": request_id},
        ) from error
    if isinstance(error, InterpreterOutputError):
        pipeline_logs.emit(request_id, "cohere", "validation_failed", "error", error=str(error))
        raise HTTPException(
            status_code=502,
            detail={"stage": "cohere", "message": str(error), "request_id": request_id},
        ) from error
    pipeline_logs.emit(request_id, "pipeline", "unexpected_failure", "error", error=str(error))
    raise HTTPException(
        status_code=500,
        detail={"stage": "pipeline", "message": "Unexpected voice pipeline failure.", "request_id": request_id},
    ) from error


@app.get("/api/health")
def health(request: Request) -> dict[str, str | bool]:
    cohere_ready = True
    gnani_ready = True
    model = ""
    try:
        model = _interpreter(request).model
    except InterpreterConfigurationError:
        cohere_ready = False
    try:
        GnaniSettings.from_env()
    except GnaniConfigurationError:
        gnani_ready = False
    return {
        "status": "ready" if cohere_ready and gnani_ready else "not_ready",
        "version": "0.7.0",
        "cohereConfigured": cohere_ready,
        "gnaniConfigured": gnani_ready,
        "model": model,
    }


@app.post(
    "/api/interpret",
    response_model=InterpretResponse,
    response_model_exclude_none=True,
)
def interpret(payload: InterpretRequest, request: Request) -> InterpretResponse:
    try:
        return _interpreter(request).interpret(payload.instruction, payload.scene, payload.world)
    except InterpreterConfigurationError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except InterpreterOutputError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except InterpreterProviderError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Cohere interpretation request failed.") from error


@app.post(
    "/api/voice/plan",
    response_model=VoicePlanResponse,
    response_model_exclude_none=True,
)
def voice_plan(
    request: Request,
    request_id: str = Form(..., min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"),
    scene: str = Form(...),
    world: str = Form('{"status":"idle"}'),
    duration_ms: int = Form(..., ge=1, le=30000),
    audio: UploadFile = File(...),
) -> VoicePlanResponse:
    try:
        scene_snapshot = SceneSnapshot.model_validate_json(scene)
        world_state = WorldState.model_validate_json(world)
    except ValidationError as error:
        raise HTTPException(status_code=422, detail="Invalid scene or world snapshot.") from error
    audio_bytes = audio.file.read(10_000_001)
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="Recorded audio is empty.")
    if len(audio_bytes) > 10_000_000:
        raise HTTPException(status_code=413, detail="Recorded audio is too large.")
    content_type = (audio.content_type or "application/octet-stream").split(";")[0]
    try:
        return _voice_service(request).plan(
            request_id, audio_bytes, content_type, duration_ms, scene_snapshot, world_state
        )
    except Exception as error:
        _raise_stage_error(request_id, error)


@app.post(
    "/api/voice/complete",
    response_model=VoiceCompleteResponse,
)
def voice_complete(payload: VoiceCompleteRequest, request: Request) -> VoiceCompleteResponse:
    try:
        return _voice_service(request).complete(payload)
    except Exception as error:
        _raise_stage_error(payload.request_id, error)


@app.post("/api/voice/speak", response_model=VoiceCompleteResponse)
def voice_speak(payload: VoiceSpeakRequest, request: Request) -> VoiceCompleteResponse:
    try:
        return _voice_service(request).speak(
            payload.request_id,
            payload.text,
            payload.kind,
            detected_language=payload.detected_language,
        )
    except Exception as error:
        _raise_stage_error(payload.request_id, error)


@app.post("/api/assets/resolve", response_model=AssetResolveResponse)
def resolve_asset(payload: AssetResolveRequest, request: Request) -> AssetResolveResponse:
    try:
        return _asset_resolver(request).resolve(payload.query, payload.request_id)
    except AssetResolverError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"stage": "asset", "message": str(error), "request_id": payload.request_id},
        ) from error


@app.get("/api/assets/files/{asset_id}/{asset_path:path}")
def cached_asset_file(asset_id: str, asset_path: str, request: Request) -> FileResponse:
    try:
        path = _asset_resolver(request).cached_file(asset_id, asset_path)
    except AssetResolverError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@app.post("/api/voice/events")
def voice_event(payload: VoiceClientEvent) -> dict[str, bool]:
    # Client metadata must not collide with emit()'s reserved argument names.
    metadata = {
        key: value
        for key, value in payload.metadata.items()
        if key not in {"request_id", "stage", "event", "status"}
    }
    pipeline_logs.emit(
        payload.request_id,
        payload.stage,
        payload.event,
        payload.status,
        **metadata,
    )
    return {"accepted": True}


@app.get("/api/voice/diagnostics/{request_id}")
def voice_diagnostics(request_id: str) -> dict[str, object]:
    return {"request_id": request_id, "events": pipeline_logs.get(request_id)}


@app.get("/api/voice/diagnostics")
def recent_voice_diagnostics(limit: int = 20) -> dict[str, object]:
    return {"interactions": pipeline_logs.recent(limit)}

