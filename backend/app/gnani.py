from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import httpx
from dotenv import load_dotenv

from .pipeline_logging import PipelineLogStore


SUPPORTED_AUDIO_TYPES = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
}


class GnaniConfigurationError(RuntimeError):
    pass


class GnaniProviderError(RuntimeError):
    def __init__(self, stage: str, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.stage = stage
        self.status_code = status_code


@dataclass(frozen=True)
class GnaniSettings:
    api_key: str
    prisma_url: str
    timbre_url: str
    prisma_model: str
    prisma_language: str
    prisma_format: str
    timbre_model: str
    timbre_language: str
    timbre_voice: str
    timeout_seconds: float
    debug_provider_logs: bool

    @classmethod
    def from_env(cls) -> "GnaniSettings":
        load_dotenv(Path(__file__).resolve().parents[1] / ".env")
        api_key = os.getenv("GNANI_API_KEY", "").strip()
        if not api_key or api_key.startswith("replace-"):
            raise GnaniConfigurationError("GNANI_API_KEY is not configured.")
        return cls(
            api_key=api_key,
            prisma_url=os.getenv(
                "GNANI_PRISMA_URL", "https://api.vachana.ai/stt/v3"
            ).strip(),
            timbre_url=os.getenv(
                "GNANI_TIMBRE_URL", "https://api.vachana.ai/api/v1/tts/inference"
            ).strip(),
            prisma_model=os.getenv("GNANI_PRISMA_MODEL", "prisma-v3.0").strip(),
            # Up to 4 Prisma language hints. Include Marathi for code-mixed EN/HI/MR use.
            prisma_language=os.getenv("GNANI_PRISMA_LANGUAGE", "hi-IN,en-IN,mr-IN").strip(),
            prisma_format=os.getenv("GNANI_PRISMA_FORMAT", "codemix").strip(),
            timbre_model=os.getenv("GNANI_TIMBRE_MODEL", "timbre-v3.0").strip(),
            # `auto` lets Timbre normalize from script; callers may override per reply.
            timbre_language=os.getenv("GNANI_TIMBRE_LANGUAGE", "auto").strip(),
            timbre_voice=os.getenv("GNANI_TIMBRE_VOICE", "Avinash").strip(),
            timeout_seconds=float(os.getenv("GNANI_TIMEOUT_SECONDS", "30")),
            debug_provider_logs=(
                os.getenv("WUNDRO_DEBUG_PROVIDER_LOGS")
                or os.getenv("SHABDVERSE_DEBUG_PROVIDER_LOGS")
                or "false"
            ).lower() == "true",
        )


class GnaniSpeechClient:
    def __init__(
        self,
        settings: GnaniSettings,
        logs: PipelineLogStore,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.settings = settings
        self.logs = logs
        self.http = http_client or httpx.Client(timeout=settings.timeout_seconds)

    def transcribe(
        self,
        request_id: str,
        audio: bytes,
        content_type: str,
        duration_ms: int,
    ) -> dict[str, Any]:
        extension = SUPPORTED_AUDIO_TYPES.get(content_type)
        if not extension:
            raise GnaniProviderError("prisma", f"Unsupported audio type: {content_type}", 415)
        metadata = {
            "url": self.settings.prisma_url,
            "model": self.settings.prisma_model,
            "language_code": self.settings.prisma_language,
            "format": self.settings.prisma_format,
            "audio_format": content_type,
            "audio_size_bytes": len(audio),
            "duration_ms": duration_ms,
        }
        self.logs.emit(request_id, "prisma", "request_started", **metadata)
        started = perf_counter()
        try:
            response = self.http.post(
                self.settings.prisma_url,
                headers={
                    "X-API-Key-ID": self.settings.api_key,
                    "X-API-Request-ID": request_id,
                },
                data={
                    "model": self.settings.prisma_model,
                    "language_code": self.settings.prisma_language,
                    "format": self.settings.prisma_format,
                },
                files={"audio_file": (f"voice{extension}", audio, content_type)},
            )
        except httpx.TimeoutException as error:
            self.logs.emit(request_id, "prisma", "request_failed", "error", error="timeout")
            raise GnaniProviderError("prisma", "Prisma transcription timed out.", 504) from error
        except httpx.HTTPError as error:
            self.logs.emit(request_id, "prisma", "request_failed", "error", error=str(error))
            raise GnaniProviderError("prisma", "Could not reach Gnani Prisma.") from error

        latency_ms = round((perf_counter() - started) * 1000)
        payload = self._json_or_error(response, "prisma", request_id, latency_ms)
        transcript = str(payload.get("transcript", "")).strip()
        if not transcript:
            self.logs.emit(
                request_id, "prisma", "validation_failed", "error",
                latency_ms=latency_ms, response=payload,
            )
            raise GnaniProviderError("prisma", "Prisma returned an empty transcript.", 422)
        log_data = {
            "http_status": response.status_code,
            "latency_ms": latency_ms,
            "provider_request_id": payload.get("request_id"),
            "model": payload.get("model", self.settings.prisma_model),
            "detected_language": payload.get("detected_language_code"),
            "transcript": transcript,
        }
        if self.settings.debug_provider_logs:
            log_data["provider_response"] = payload
        self.logs.emit(request_id, "prisma", "request_completed", "success", **log_data)
        return {
            "transcript": transcript,
            "detected_language": payload.get("detected_language_code"),
            "provider_request_id": payload.get("request_id"),
            "latency_ms": latency_ms,
        }

    @staticmethod
    def resolve_tts_language(detected_language: str | None, fallback: str) -> str:
        code = (detected_language or "").strip()
        mapping = {
            "mr-IN": "mr-IN",
            "mr": "mr-IN",
            "hi-IN": "hi-IN",
            "hi": "hi-IN",
            "en-IN": "en-IN",
            "en": "en-IN",
            "hi-en": "hi-en",
        }
        if code in mapping:
            return mapping[code]
        if code:
            return "auto"
        return fallback or "auto"

    def synthesize(
        self,
        request_id: str,
        text: str,
        *,
        language: str | None = None,
        detected_language: str | None = None,
    ) -> dict[str, Any]:
        tts_language = language or self.resolve_tts_language(
            detected_language, self.settings.timbre_language
        )
        payload = {
            "text": text,
            "model": self.settings.timbre_model,
            "voice": self.settings.timbre_voice,
            "language": tts_language,
            "speed": 1.0,
            "audio_config": {
                "sample_rate": 48000,
                "num_channels": 1,
                "sample_width": 2,
                "encoding": "linear_pcm",
                "container": "wav",
            },
        }
        self.logs.emit(
            request_id, "timbre", "request_started",
            url=self.settings.timbre_url,
            model=self.settings.timbre_model,
            voice=self.settings.timbre_voice,
            language=tts_language,
            detected_language=detected_language,
            text=text,
        )
        started = perf_counter()
        try:
            response = self.http.post(
                self.settings.timbre_url,
                headers={"X-API-Key-ID": self.settings.api_key},
                json=payload,
            )
        except httpx.TimeoutException as error:
            self.logs.emit(request_id, "timbre", "request_failed", "error", error="timeout")
            raise GnaniProviderError("timbre", "Timbre synthesis timed out.", 504) from error
        except httpx.HTTPError as error:
            self.logs.emit(request_id, "timbre", "request_failed", "error", error=str(error))
            raise GnaniProviderError("timbre", "Could not reach Gnani Timbre.") from error

        latency_ms = round((perf_counter() - started) * 1000)
        if response.status_code >= 400:
            detail = self._safe_error(response)
            self.logs.emit(
                request_id, "timbre", "request_failed", "error",
                http_status=response.status_code, latency_ms=latency_ms, response=detail,
            )
            raise GnaniProviderError(
                "timbre", f"Timbre rejected synthesis: {detail}",
                429 if response.status_code == 429 else 502,
            )
        audio = response.content
        if not audio:
            raise GnaniProviderError("timbre", "Timbre returned empty audio.")
        content_type = response.headers.get("content-type", "audio/wav").split(";")[0]
        if content_type == "application/octet-stream" and audio[:4] == b"RIFF":
            content_type = "audio/wav"
        if content_type in {"application/json", "text/plain"}:
            raise GnaniProviderError("timbre", "Timbre returned metadata instead of audio.")
        self.logs.emit(
            request_id, "timbre", "request_completed", "success",
            http_status=response.status_code,
            latency_ms=latency_ms,
            audio_format=content_type,
            audio_size_bytes=len(audio),
            response_headers={
                "content-type": content_type,
                "content-length": response.headers.get("content-length"),
            },
        )
        return {"audio": audio, "content_type": content_type, "latency_ms": latency_ms}

    def _json_or_error(
        self, response: httpx.Response, stage: str, request_id: str, latency_ms: int
    ) -> dict[str, Any]:
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as error:
            raise GnaniProviderError(stage, f"{stage.title()} returned invalid JSON.") from error
        if not isinstance(payload, dict):
            raise GnaniProviderError(stage, f"{stage.title()} returned an invalid response shape.")
        if response.status_code >= 400 or not payload.get("success", False):
            detail = str(payload.get("message") or payload.get("error") or payload.get("detail"))
            self.logs.emit(
                request_id, stage, "request_failed", "error",
                http_status=response.status_code, latency_ms=latency_ms, response=payload,
            )
            raise GnaniProviderError(
                stage, f"{stage.title()} rejected the request: {detail[:300]}",
                429 if response.status_code == 429 else 502,
            )
        return payload

    @staticmethod
    def _safe_error(response: httpx.Response) -> str:
        try:
            payload = response.json()
            return str(payload)[:500]
        except ValueError:
            return response.text[:500]

