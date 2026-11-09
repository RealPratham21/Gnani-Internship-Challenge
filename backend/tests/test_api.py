from types import SimpleNamespace

from app.main import app, interpret, voice_event
from app.models import InterpretRequest, InterpretResponse, VoiceClientEvent


class StubInterpreter:
    def interpret(self, instruction, scene, world=None):
        return InterpretResponse(
            instruction=instruction,
            actions=[],
            clarification="Please name a supported scene action.",
            model="test-model",
        )


def test_interpret_endpoint_accepts_instruction_and_snapshot():
    app.state.interpreter = StubInterpreter()
    payload = InterpretRequest.model_validate({
        "instruction": "Kuch karo",
        "scene": {"version": "0.3", "activeId": None, "objects": []},
        "world": {"status": "idle"},
    })
    request = SimpleNamespace(app=app)

    response = interpret(payload, request)

    assert response.actions == []
    assert response.clarification


def test_voice_event_accepts_metadata_with_status_key():
    payload = VoiceClientEvent.model_validate({
        "request_id": "event-status-1",
        "stage": "state",
        "event": "transition",
        "status": "info",
        "metadata": {"status": "searching", "query": "sofa"},
    })
    assert voice_event(payload) == {"accepted": True}
