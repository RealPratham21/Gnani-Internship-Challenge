import httpx
import pytest

from app.gnani import GnaniProviderError, GnaniSettings, GnaniSpeechClient
from app.models import SceneSnapshot, VoiceCompleteRequest
from app.pipeline_logging import PipelineLogStore, redact
from app.voice import compose_spoken_response


def settings():
    return GnaniSettings(
        api_key="secret-key",
        prisma_url="https://example.test/stt/v3",
        timbre_url="https://example.test/tts/inference",
        prisma_model="prisma-v3.0",
        prisma_language="hi-IN,en-IN,mr-IN",
        prisma_format="codemix",
        timbre_model="timbre-v3.0",
        timbre_language="auto",
        timbre_voice="Avinash",
        timeout_seconds=2,
        debug_provider_logs=False,
    )


class FakeHttp:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


def response(status=200, *, json=None, content=b"", content_type="application/json"):
    return httpx.Response(
        status,
        json=json,
        content=content if json is None else None,
        headers={"content-type": content_type},
        request=httpx.Request("POST", "https://example.test"),
    )


def snapshot():
    return SceneSnapshot.model_validate({
        "version": "0.3",
        "activeId": "sofa-1",
        "objects": [{
            "id": "sofa-1",
            "type": "sofa",
            "transform": {"position": [0, 0, -2], "rotation": [0, 0, 0], "scale": [1, 1, 1]},
            "properties": {},
        }],
    })


def test_prisma_uses_documented_multipart_contract_and_returns_transcript():
    http = FakeHttp([response(json={
        "success": True,
        "request_id": "provider-1",
        "transcript": "Sofa ko chhota karo",
        "model": "prisma-v3.0",
        "detected_language_code": "hi-IN",
    })])
    client = GnaniSpeechClient(settings(), PipelineLogStore(), http)
    result = client.transcribe("request-123", b"RIFFaudio", "audio/wav", 750)

    assert result["transcript"] == "Sofa ko chhota karo"
    _, call = http.calls[0]
    assert call["headers"]["X-API-Request-ID"] == "request-123"
    assert call["data"]["model"] == "prisma-v3.0"
    assert call["data"]["language_code"] == "hi-IN,en-IN,mr-IN"
    assert call["files"]["audio_file"][2] == "audio/wav"


def test_tts_language_maps_marathi_detection():
    assert GnaniSpeechClient.resolve_tts_language("mr-IN", "auto") == "mr-IN"
    assert GnaniSpeechClient.resolve_tts_language("hi-IN", "auto") == "hi-IN"
    assert GnaniSpeechClient.resolve_tts_language("en-IN", "auto") == "en-IN"
    assert GnaniSpeechClient.resolve_tts_language(None, "auto") == "auto"


def test_prisma_empty_transcript_is_attributed_to_transcription():
    http = FakeHttp([response(json={"success": True, "transcript": ""})])
    client = GnaniSpeechClient(settings(), PipelineLogStore(), http)
    with pytest.raises(GnaniProviderError) as captured:
        client.transcribe("request-123", b"RIFFaudio", "audio/wav", 500)
    assert captured.value.stage == "prisma"
    assert captured.value.status_code == 422


def test_timbre_errors_are_not_mistaken_for_audio():
    http = FakeHttp([response(503, json={
        "success": False,
        "error": {"type": "SERVICE_UNAVAILABLE", "message": "Try later"},
    })])
    client = GnaniSpeechClient(settings(), PipelineLogStore(), http)
    with pytest.raises(GnaniProviderError) as captured:
        client.synthesize("request-123", "Done")
    assert captured.value.stage == "timbre"


def test_partial_execution_response_never_claims_full_success():
    payload = VoiceCompleteRequest.model_validate({
        "request_id": "request-123",
        "transcript": "Do both",
        "actions": [
            {"action": "scale", "target": "active", "factor": 0.8},
            {"action": "move", "target": "active", "by": [1, 0, 0]},
        ],
        "execution": {"success": False, "succeeded": 1, "failed": 1, "results": []},
        "scene_after": snapshot().model_dump(mode="json"),
    })
    text = compose_spoken_response(payload)
    assert "1 change ho gaya" in text
    assert "1 fail hua" in text


def test_marathi_fallback_reply_uses_marathi_phrasing():
    payload = VoiceCompleteRequest.model_validate({
        "request_id": "request-mr",
        "transcript": "टेबल इथे ठेव",
        "detected_language": "mr-IN",
        "actions": [{"action": "request_asset", "query": "table", "place": True}],
        "execution": {"success": True, "succeeded": 1, "failed": 0, "results": []},
        "scene_after": snapshot().model_dump(mode="json"),
        "world_after": {"status": "placed"},
    })
    text = compose_spoken_response(payload)
    assert "ठेवलं" in text


def test_credentials_are_redacted_from_diagnostic_metadata():
    cleaned = redact({
        "Authorization": "Bearer secret",
        "X-API-Key-ID": "secret",
        "nested": {"api_key": "secret"},
    })
    assert cleaned["Authorization"] == "***REDACTED***"
    assert cleaned["X-API-Key-ID"] == "***REDACTED***"
    assert cleaned["nested"]["api_key"] == "***REDACTED***"

