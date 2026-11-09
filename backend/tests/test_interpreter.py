import json
from types import SimpleNamespace

import pytest

from app.interpreter import CohereInterpreter, InterpreterOutputError
from app.models import SceneSnapshot, WorldState


def scene(*ids: str, active: str | None = None) -> SceneSnapshot:
    return SceneSnapshot.model_validate({
        "version": "0.3",
        "activeId": active,
        "objects": [
            {
                "id": object_id,
                "type": "asset",
                "transform": {
                    "position": [0, 0, -2],
                    "rotation": [0, 0, 0],
                    "scale": [1, 1, 1],
                },
                "properties": {},
            }
            for object_id in ids
        ],
    })


def world(**kwargs) -> WorldState:
    return WorldState.model_validate(kwargs)


class FakeCohere:
    def __init__(self, payloads, include_thinking=False):
        if not isinstance(payloads, list):
            payloads = [payloads]
        self.payloads = payloads
        self.include_thinking = include_thinking
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        index = min(len(self.calls) - 1, len(self.payloads) - 1)
        payload = self.payloads[index]
        text = payload if isinstance(payload, str) else json.dumps(payload)
        content = []
        if self.include_thinking:
            content.append(SimpleNamespace(type="thinking", thinking="internal"))
        content.append(SimpleNamespace(type="text", text=text))
        return SimpleNamespace(
            finish_reason="COMPLETE",
            message=SimpleNamespace(content=content, finish_reason="COMPLETE"),
        )


def test_interprets_multiple_actions_using_actual_scene_schema():
    client = FakeCohere({
        "actions": [
            {"action": "scale", "target": "sofa-1", "factor": 0.8},
            {
                "action": "appearance",
                "target": "sofa-1",
                "appearance": {"color": "blue"},
            },
        ],
        "clarification": "",
        "acknowledgement": "",
    })
    result = CohereInterpreter(client).interpret(
        "Make the sofa smaller and blue", scene("sofa-1", active="sofa-1")
    )

    assert [item.action for item in result.actions] == ["scale", "appearance"]
    assert result.actions[0].factor == 0.8
    assert result.actions[1].appearance.color == "blue"
    assert result.actions[1].appearance.model_dump(exclude_none=True) == {"color": "blue"}
    assert client.calls[0]["response_format"]["type"] == "json_object"
    assert "schema" in client.calls[0]["response_format"]
    assert "thinking" not in client.calls[0]


def test_multi_turn_request_then_place_pending():
    client = FakeCohere({
        "actions": [{"action": "place_pending", "at": "aim"}],
        "clarification": "",
        "acknowledgement": "",
    })
    result = CohereInterpreter(client).interpret(
        "Yahin rakh do",
        scene(),
        world(
            status="awaiting_placement",
            pending={
                "id": "side_table_01",
                "name": "Side Table 01",
                "query": "table",
                "provider": "Poly Haven",
            },
        ),
    )
    assert result.actions[0].action == "place_pending"


def test_one_shot_place_and_follow_up_edit():
    client = FakeCohere({
        "actions": [
            {"action": "request_asset", "query": "table", "place": True},
            {"action": "appearance", "target": "last", "appearance": {"color": "blue"}},
        ],
        "clarification": "",
        "acknowledgement": "Table dhoondh raha hoon, thoda wait.",
    }, include_thinking=True)
    result = CohereInterpreter(client).interpret("Add a blue table here", scene())
    assert [item.action for item in result.actions] == ["request_asset", "appearance"]
    assert result.actions[0].place is True
    assert result.acknowledgement.startswith("Table")


def test_request_without_placement_keeps_pending():
    client = FakeCohere({
        "actions": [{"action": "request_asset", "query": "table", "place": False}],
        "clarification": "",
        "acknowledgement": "Table khojta hoon.",
    })
    result = CohereInterpreter(client).interpret("Mujhe ek table chahiye", scene())
    assert result.actions[0].place is False
    assert result.acknowledgement


def test_normalizes_loose_place_and_missing_strings():
    client = FakeCohere({
        "actions": [{"action": "request_asset", "query": "lamp", "place": "true"}],
    })
    result = CohereInterpreter(client).interpret("Add a lamp here", scene())
    assert result.actions[0].query == "lamp"
    assert result.actions[0].place is True
    assert result.clarification is None
    assert result.acknowledgement is None


def test_repairs_malformed_json_on_second_attempt():
    client = FakeCohere([
        "not json at all",
        {
            "actions": [{"action": "request_asset", "query": "lamp", "place": False}],
            "clarification": "",
            "acknowledgement": "Lamp dhoondh raha hoon.",
        },
    ])
    result = CohereInterpreter(client).interpret("Mujhe lamp chahiye", scene())
    assert len(client.calls) == 2
    assert result.actions[0].action == "request_asset"
    assert result.actions[0].query == "lamp"


def test_soft_fails_to_clarification_after_exhausted_repairs():
    client = FakeCohere(["not json", "still broken"])
    result = CohereInterpreter(client).interpret("Mujhe lamp chahiye", scene())
    assert result.actions == []
    assert "messy" in (result.clarification or "").lower() or "try" in (result.clarification or "").lower()
    assert len(client.calls) == 2


def test_returns_clarification_for_unsupported_request():
    client = FakeCohere({
        "actions": [],
        "clarification": "That is outside my furniture remit.",
        "acknowledgement": "",
    })
    result = CohereInterpreter(client).interpret("Play some music", scene())
    assert result.actions == []
    assert result.clarification == "That is outside my furniture remit."


def test_recovers_a_valid_final_json_object_from_prefixed_provider_text():
    client = FakeCohere(
        'Provider preamble that should not execute. '
        '{"actions":[{"action":"rotate","target":"active","by":[0,45,0],'
        '"unit":"degrees"}],"clarification":"","acknowledgement":""}'
    )
    result = CohereInterpreter(client).interpret(
        "Rotate it 45 degrees", scene("sofa-1", active="sofa-1")
    )
    assert result.actions[0].action == "rotate"
    assert result.actions[0].by == (0.0, 45.0, 0.0)


def test_rejects_invented_spawn_commands_with_soft_clarification():
    client = FakeCohere({
        "actions": [{"action": "spawn", "type": "sofa", "at": "aim"}],
        "clarification": "",
        "acknowledgement": "",
    })
    result = CohereInterpreter(client).interpret("Place a sofa", scene())
    assert result.actions == []
    assert result.clarification


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        {"actions": [{"action": "fly", "target": "active"}], "clarification": "", "acknowledgement": ""},
        {"actions": [{"action": "move", "target": "ghost", "by": [1, 0, 0]}], "clarification": "", "acknowledgement": ""},
        {"actions": [{"action": "scale", "target": "active", "factor": -1}], "clarification": "", "acknowledgement": ""},
        {
            "actions": [{"action": "place_pending", "at": "aim"}],
            "clarification": "",
            "acknowledgement": "",
        },
    ],
)
def test_invalid_outputs_soft_fail_instead_of_crashing(payload):
    result = CohereInterpreter(FakeCohere(payload)).interpret(
        "Do something", scene("sofa-1", active="sofa-1")
    )
    assert result.actions == []
    assert result.clarification


def test_cancel_pending_requires_awaiting_placement():
    client = FakeCohere({
        "actions": [{"action": "cancel_pending"}],
        "clarification": "",
        "acknowledgement": "",
    })
    result = CohereInterpreter(client).interpret(
        "Cancel",
        scene(),
        world(
            status="awaiting_placement",
            pending={"id": "a", "name": "A", "query": "chair", "provider": "Poly Haven"},
        ),
    )
    assert result.actions[0].action == "cancel_pending"


def test_respond_repairs_then_returns_reply():
    client = FakeCohere([
        "nope",
        {"reply": "Lamp ready hai. Kahan rakhna hai?"},
    ])
    reply = CohereInterpreter(client).respond({
        "transcript": "lamp chahiye",
        "execution": {"success": True},
        "world_after": {"status": "awaiting_placement"},
    })
    assert "Lamp ready" in reply
    assert len(client.calls) == 2


def test_flat_schema_uses_action_enum_instead_of_action_anyof():
    client = FakeCohere({
        "actions": [{"action": "request_asset", "query": "lamp", "place": False}],
        "clarification": "",
        "acknowledgement": "Searching.",
    })
    CohereInterpreter(client).interpret("lamp", scene())
    schema = client.calls[0]["response_format"]["schema"]
    action_schema = schema["properties"]["actions"]["items"]
    assert "anyOf" not in action_schema
    assert action_schema["properties"]["action"]["enum"]
    assert "anyOf" in action_schema["properties"]["appearance"]
