from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Vector3 = tuple[float, float, float]
ContextTarget = str
InteractionStatus = Literal[
    "idle", "searching", "downloading", "awaiting_placement", "placed", "error"
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TransformSnapshot(StrictModel):
    position: Vector3
    rotation: Vector3
    scale: Vector3


class SceneObjectSnapshot(StrictModel):
    id: str
    type: str
    transform: TransformSnapshot
    properties: dict[str, Any] = Field(default_factory=dict)


class SceneSnapshot(StrictModel):
    version: str
    activeId: str | None = None
    objects: list[SceneObjectSnapshot] = Field(default_factory=list)


class PendingAssetState(StrictModel):
    id: str
    name: str
    query: str
    provider: str = "Poly Haven"
    source_url: str | None = None


class WorldState(StrictModel):
    status: InteractionStatus = "idle"
    pending: PendingAssetState | None = None
    lastPlacedId: str | None = None
    error: str | None = None


class InterpretRequest(StrictModel):
    instruction: str = Field(min_length=1, max_length=1000)
    scene: SceneSnapshot
    world: WorldState = Field(default_factory=WorldState)

    @field_validator("instruction")
    @classmethod
    def strip_instruction(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("instruction cannot be blank")
        return value


class RequestAssetCommand(StrictModel):
    action: Literal["request_asset"]
    query: str = Field(min_length=1, max_length=100)
    place: bool = False

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("asset query cannot be blank")
        return value


class PlacePendingCommand(StrictModel):
    action: Literal["place_pending"]
    at: Literal["aim"] = "aim"


class CancelPendingCommand(StrictModel):
    action: Literal["cancel_pending"]


class SpawnCommand(StrictModel):
    action: Literal["spawn"]
    type: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_-]+$")
    at: Literal["aim"] = "aim"
    properties: dict[str, Any] | None = None


class MoveCommand(StrictModel):
    action: Literal["move"]
    target: ContextTarget
    by: Vector3


class ScaleCommand(StrictModel):
    action: Literal["scale"]
    target: ContextTarget
    factor: float

    @field_validator("factor")
    @classmethod
    def positive_factor(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("scale factor must be greater than zero")
        return value


class RotateCommand(StrictModel):
    action: Literal["rotate"]
    target: ContextTarget
    by: Vector3
    unit: Literal["degrees"] = "degrees"


class Appearance(StrictModel):
    color: str | None = None
    opacity: float | None = None
    visible: bool | None = None
    wireframe: bool | None = None

    @model_validator(mode="after")
    def has_change(self) -> "Appearance":
        if all(value is None for value in (self.color, self.opacity, self.visible, self.wireframe)):
            raise ValueError("appearance must contain at least one supported property")
        if self.opacity is not None and not 0 <= self.opacity <= 1:
            raise ValueError("opacity must be between zero and one")
        return self

    @field_validator("color")
    @classmethod
    def supported_color_format(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip().lower()
        named = {
            "black", "blue", "cyan", "gray", "green", "grey", "magenta",
            "orange", "pink", "purple", "red", "white", "yellow",
        }
        valid_hex = len(value) in (4, 7) and value.startswith("#")
        if not valid_hex and value not in named:
            raise ValueError("color must be a #RGB/#RRGGBB value or supported color name")
        return value


class AppearanceCommand(StrictModel):
    action: Literal["appearance"]
    target: ContextTarget
    appearance: Appearance


class RemoveCommand(StrictModel):
    action: Literal["remove"]
    target: ContextTarget


SceneCommand = Annotated[
    Union[SpawnCommand, MoveCommand, ScaleCommand, RotateCommand, AppearanceCommand, RemoveCommand],
    Field(discriminator="action"),
]

PlanningAction = Annotated[
    Union[
        RequestAssetCommand, PlacePendingCommand, CancelPendingCommand,
        SpawnCommand, MoveCommand, ScaleCommand, RotateCommand, AppearanceCommand, RemoveCommand,
    ],
    Field(discriminator="action"),
]


class ModelInterpretation(StrictModel):
    actions: list[PlanningAction]
    clarification: str
    acknowledgement: str = ""


class InterpretResponse(StrictModel):
    instruction: str
    actions: list[PlanningAction]
    clarification: str | None = None
    acknowledgement: str | None = None
    model: str


class VoicePlanResponse(StrictModel):
    request_id: str
    transcript: str
    detected_language: str | None = None
    actions: list[PlanningAction]
    clarification: str | None = None
    acknowledgement: str | None = None
    model: str


class VoiceCompleteRequest(StrictModel):
    request_id: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    transcript: str
    actions: list[PlanningAction]
    clarification: str | None = None
    execution: dict[str, Any] | None = None
    scene_after: SceneSnapshot
    world_after: WorldState = Field(default_factory=WorldState)
    detected_language: str | None = Field(default=None, max_length=16)


class VoiceSpeakRequest(StrictModel):
    request_id: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    text: str = Field(min_length=1, max_length=240)
    kind: Literal["intermediate"] = "intermediate"
    detected_language: str | None = Field(default=None, max_length=16)


class VoiceCompleteResponse(StrictModel):
    request_id: str
    spoken_text: str
    audio_mime: str
    audio_base64: str


class VoiceClientEvent(StrictModel):
    request_id: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    stage: Literal[
        "microphone", "execution", "playback", "pipeline", "frontend", "asset", "state"
    ]
    event: str = Field(min_length=1, max_length=100)
    status: Literal["info", "success", "error"] = "info"
    metadata: dict[str, Any] = Field(default_factory=dict)


class AssetResolveRequest(StrictModel):
    request_id: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    query: str = Field(min_length=1, max_length=100)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        return " ".join(value.split())


class AssetResolveResponse(StrictModel):
    id: str
    name: str
    query: str
    provider: Literal["Poly Haven", "Wundro fallback"]
    license: Literal["CC0"]
    source_url: str
    model_url: str
    format: Literal["gltf", "glb"]
    dimensions_mm: tuple[float, float, float] | None = None
    cache_hit: bool
    total_bytes: int
