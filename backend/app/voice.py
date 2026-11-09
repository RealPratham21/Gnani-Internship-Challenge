from __future__ import annotations

import base64
from time import perf_counter

from .gnani import GnaniSettings, GnaniSpeechClient
from .interpreter import (
    CohereInterpreter,
    InterpreterOutputError,
    InterpreterProviderError,
    create_interpreter_from_env,
)
from .models import (
    SceneSnapshot,
    VoiceCompleteRequest,
    VoiceCompleteResponse,
    VoicePlanResponse,
    WorldState,
)
from .pipeline_logging import PipelineLogStore


class VoicePipelineService:
    def __init__(
        self,
        speech: GnaniSpeechClient,
        interpreter: CohereInterpreter,
        logs: PipelineLogStore,
    ) -> None:
        self.speech = speech
        self.interpreter = interpreter
        self.logs = logs

    def plan(
        self,
        request_id: str,
        audio: bytes,
        content_type: str,
        duration_ms: int,
        scene: SceneSnapshot,
        world: WorldState | None = None,
    ) -> VoicePlanResponse:
        world = world or WorldState()
        total_started = perf_counter()
        self.logs.emit(
            request_id, "pipeline", "plan_started",
            audio_format=content_type, audio_size_bytes=len(audio), duration_ms=duration_ms,
            scene_objects=len(scene.objects), active_id=scene.activeId,
            world=world.model_dump(mode="json"),
        )
        transcription = self.speech.transcribe(request_id, audio, content_type, duration_ms)
        self.logs.emit(
            request_id, "cohere", "request_started",
            model=self.interpreter.model,
            purpose="world_plan",
            transcript=transcription["transcript"],
            scene_objects=len(scene.objects),
            world_status=world.status,
        )
        cohere_started = perf_counter()
        interpretation = self.interpreter.interpret(
            transcription["transcript"], scene, world
        )
        cohere_latency = round((perf_counter() - cohere_started) * 1000)
        self.logs.emit(
            request_id, "cohere", "request_completed", "success",
            model=interpretation.model,
            purpose="world_plan",
            latency_ms=cohere_latency,
            actions=[item.model_dump(mode="json", exclude_none=True) for item in interpretation.actions],
            clarification=interpretation.clarification,
            acknowledgement=interpretation.acknowledgement,
            validation="passed",
        )
        self.logs.emit(
            request_id, "pipeline", "plan_completed", "success",
            latency_ms=round((perf_counter() - total_started) * 1000),
        )
        return VoicePlanResponse(
            request_id=request_id,
            transcript=transcription["transcript"],
            detected_language=transcription.get("detected_language"),
            actions=interpretation.actions,
            clarification=interpretation.clarification,
            acknowledgement=interpretation.acknowledgement,
            model=interpretation.model,
        )

    def complete(self, payload: VoiceCompleteRequest) -> VoiceCompleteResponse:
        response_context = {
            "transcript": payload.transcript,
            "planned_actions": [
                item.model_dump(mode="json", exclude_none=True) for item in payload.actions
            ],
            "clarification": payload.clarification,
            "execution": payload.execution,
            "world_after": payload.world_after.model_dump(mode="json"),
            "scene_after": payload.scene_after.model_dump(mode="json"),
        }
        self.logs.emit(
            payload.request_id, "cohere", "request_started",
            model=self.interpreter.model, purpose="spoken_response",
            execution_success=payload.execution.get("success") if payload.execution else None,
            world_status=payload.world_after.status,
        )
        started = perf_counter()
        try:
            spoken_text = self.interpreter.respond(response_context)
            validation = "passed"
        except (InterpreterOutputError, InterpreterProviderError) as error:
            spoken_text = compose_spoken_response(payload)
            validation = "fallback"
            self.logs.emit(
                payload.request_id, "cohere", "response_fallback", "error",
                error=str(error), fallback=spoken_text,
            )
        self.logs.emit(
            payload.request_id, "cohere", "request_completed", "success",
            model=self.interpreter.model,
            purpose="spoken_response",
            latency_ms=round((perf_counter() - started) * 1000),
            reply=spoken_text,
            validation=validation,
        )
        return self.speak(
            payload.request_id,
            spoken_text,
            "final",
            detected_language=payload.detected_language,
        )

    def speak(
        self,
        request_id: str,
        text: str,
        kind: str,
        *,
        detected_language: str | None = None,
    ) -> VoiceCompleteResponse:
        self.logs.emit(
            request_id, "response", "composed", "success",
            kind=kind, text=text, detected_language=detected_language,
        )
        synthesis = self.speech.synthesize(
            request_id, text, detected_language=detected_language
        )
        return VoiceCompleteResponse(
            request_id=request_id,
            spoken_text=text,
            audio_mime=synthesis["content_type"],
            audio_base64=base64.b64encode(synthesis["audio"]).decode("ascii"),
        )


def compose_spoken_response(payload: VoiceCompleteRequest) -> str:
    """Deterministic safety fallback retained for tests and provider outages."""
    lang = (payload.detected_language or "").lower()
    marathi = lang.startswith("mr")
    if payload.clarification or not payload.actions:
        if marathi:
            return f"थोडं स्पष्ट सांगा: {payload.clarification or 'काय करायचं?'}"
        return f"Thoda clear bolo: {payload.clarification or 'What should I change?'}"
    execution = payload.execution or {}
    succeeded = int(execution.get("succeeded", 0))
    failed = int(execution.get("failed", 0))
    if succeeded and failed:
        if marathi:
            return f"अर्धवट जमलं. {succeeded} झालं, {failed} अडकलं."
        return f"Half victory. {succeeded} change ho gaya, {failed} fail hua."
    if failed or not execution.get("success", False):
        if payload.world_after.status == "error" and payload.world_after.error:
            return (
                f"मॉडेल आलं नाही: {payload.world_after.error[:100]}"
                if marathi
                else f"Asset load fail hua: {payload.world_after.error[:120]}"
            )
        return "झालं नाही. पुन्हा प्रयत्न करूया." if marathi else (
            "That did not work. Even virtual furniture has boundaries."
        )
    if payload.world_after.status == "awaiting_placement":
        return "मॉडेल तयार आहे. कुठे ठेवू?" if marathi else "Model ready hai. Kahan rakhna hai?"
    if payload.world_after.status == "placed":
        return "ठेवलं. आता दृश्य थोडं चांगलं वाटतं." if marathi else (
            "Placed. Reality just got better furniture."
        )
    return f"झालं. {succeeded} बदल केला." if marathi else f"Done. {succeeded} change applied."


def create_voice_service(logs: PipelineLogStore) -> VoicePipelineService:
    settings = GnaniSettings.from_env()
    speech = GnaniSpeechClient(settings, logs)
    return VoicePipelineService(speech, create_interpreter_from_env(), logs)
