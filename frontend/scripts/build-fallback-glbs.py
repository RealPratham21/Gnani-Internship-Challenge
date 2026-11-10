"""Create minimal verified geometric GLB fallbacks for Wundro offline use."""

from __future__ import annotations

import json
import struct
from pathlib import Path


def build_glb(positions: list[tuple[float, float, float]], indices: list[int], name: str) -> bytes:
    pos_bytes = b"".join(struct.pack("<fff", *point) for point in positions)
    idx_bytes = b"".join(struct.pack("<H", index) for index in indices)
    if len(idx_bytes) % 4:
        idx_bytes += b"\x00" * (4 - len(idx_bytes) % 4)
    bin_blob = pos_bytes + idx_bytes
    if len(bin_blob) % 4:
        bin_blob += b"\x00" * (4 - len(bin_blob) % 4)

    mins = [min(point[axis] for point in positions) for axis in range(3)]
    maxs = [max(point[axis] for point in positions) for axis in range(3)]
    gltf = {
        "asset": {"version": "2.0", "generator": "Wundro fallback"},
        "scenes": [{"nodes": [0], "name": name}],
        "scene": 0,
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{
            "name": name,
            "primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}],
        }],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": len(positions),
                "type": "VEC3",
                "max": maxs,
                "min": mins,
            },
            {
                "bufferView": 1,
                "componentType": 5123,
                "count": len(indices),
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes), "target": 34962},
            {
                "buffer": 0,
                "byteOffset": len(pos_bytes),
                "byteLength": len(indices) * 2,
                "target": 34963,
            },
        ],
        "buffers": [{"byteLength": len(bin_blob)}],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_blob)
    header = struct.pack("<III", 0x46546C67, 2, total)
    json_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    bin_chunk = struct.pack("<II", len(bin_blob), 0x004E4942) + bin_blob
    return header + json_chunk + bin_chunk


def box(width: float, height: float, depth: float, y0: float = 0.0):
    x, y, z = width / 2, height / 2, depth / 2
    cy = y0 + y
    points = [
        (-x, cy - y, -z), (x, cy - y, -z), (x, cy + y, -z), (-x, cy + y, -z),
        (-x, cy - y, z), (x, cy - y, z), (x, cy + y, z), (-x, cy + y, z),
    ]
    faces = [
        0, 1, 2, 0, 2, 3,
        5, 4, 7, 5, 7, 6,
        4, 0, 3, 4, 3, 7,
        1, 5, 6, 1, 6, 2,
        3, 2, 6, 3, 6, 7,
        4, 5, 1, 4, 1, 0,
    ]
    return points, faces


def merge(parts):
    positions: list[tuple[float, float, float]] = []
    indices: list[int] = []
    for points, faces in parts:
        base = len(positions)
        positions.extend(points)
        indices.extend(index + base for index in faces)
    return positions, indices


def offset(points, dx=0.0, dy=0.0, dz=0.0):
    return [(x + dx, y + dy, z + dz) for x, y, z in points]


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "public" / "models"
    out.mkdir(parents=True, exist_ok=True)

    table_parts = [box(1.2, 0.06, 0.7, 0.72)]
    for sx, sz in [(-0.5, -0.28), (0.5, -0.28), (-0.5, 0.28), (0.5, 0.28)]:
        points, faces = box(0.08, 0.72, 0.08, 0)
        table_parts.append((offset(points, sx, 0, sz), faces))
    (out / "table.glb").write_bytes(build_glb(*merge(table_parts), "fallback-table"))

    chair_parts = [box(0.45, 0.06, 0.45, 0.42)]
    back_points, back_faces = box(0.45, 0.45, 0.06, 0.48)
    chair_parts.append((offset(back_points, 0, 0, -0.195), back_faces))
    for sx, sz in [(-0.18, -0.18), (0.18, -0.18), (-0.18, 0.18), (0.18, 0.18)]:
        points, faces = box(0.05, 0.42, 0.05, 0)
        chair_parts.append((offset(points, sx, 0, sz), faces))
    (out / "chair.glb").write_bytes(build_glb(*merge(chair_parts), "fallback-chair"))

    plant_parts = [
        box(0.22, 0.18, 0.22, 0),
        box(0.04, 0.35, 0.04, 0.18),
        box(0.35, 0.3, 0.35, 0.45),
    ]
    (out / "plant.glb").write_bytes(build_glb(*merge(plant_parts), "fallback-plant"))

    for name in ("table.glb", "chair.glb", "plant.glb"):
        print(name, (out / name).stat().st_size)


if __name__ == "__main__":
    main()
