from pathlib import Path
import hashlib

import httpx
import pytest

from app.asset_resolver import AssetResolver, AssetResolverError, FALLBACK_CATALOGUE
from app.pipeline_logging import PipelineLogStore


def fake_transport(handlers):
    def handler(request: httpx.Request) -> httpx.Response:
        key = (request.method, str(request.url.copy_with(query=None)))
        if key not in handlers:
            raise AssertionError(f"Unexpected request: {key}")
        value = handlers[key]
        if callable(value):
            return value(request)
        status, payload = value
        if isinstance(payload, (bytes, bytearray)):
            return httpx.Response(status, content=payload, request=request)
        return httpx.Response(status, json=payload, request=request)

    return httpx.MockTransport(handler)


def make_resolver(tmp_path: Path, handlers: dict) -> AssetResolver:
    client = httpx.Client(transport=fake_transport(handlers), follow_redirects=False)
    return AssetResolver(PipelineLogStore(), cache_root=tmp_path, http_client=client)


@pytest.fixture
def package_bytes():
    gltf = b'{"asset":{"version":"2.0"}}'
    binary = b"BINDATA" + b"\x00" * 33
    return gltf, binary


def test_resolves_and_caches_polyhaven_model(tmp_path, package_bytes):
    gltf, binary = package_bytes
    gltf_md5 = hashlib.md5(gltf).hexdigest()
    bin_md5 = hashlib.md5(binary).hexdigest()
    asset_id = "side_table_01"
    handlers = {
        ("GET", "https://api.polyhaven.com/search"): (
            200,
            {"results": [{"slug": asset_id, "score": 0.9}]},
        ),
        ("GET", f"https://api.polyhaven.com/info/{asset_id}"): (
            200,
            {
                "name": "Side Table 01",
                "type": 2,
                "dimensions": [550, 450, 550],
                "files_hash": "abc",
            },
        ),
        ("GET", f"https://api.polyhaven.com/files/{asset_id}"): (
            200,
            {
                "gltf": {
                    "1k": {
                        "gltf": {
                            "url": f"https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/{asset_id}/{asset_id}_1k.gltf",
                            "size": len(gltf),
                            "md5": gltf_md5,
                            "include": {
                                f"{asset_id}.bin": {
                                    "url": f"https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/{asset_id}/{asset_id}.bin",
                                    "size": len(binary),
                                    "md5": bin_md5,
                                }
                            },
                        }
                    }
                }
            },
        ),
        (
            "GET",
            f"https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/{asset_id}/{asset_id}_1k.gltf",
        ): (200, gltf),
        (
            "GET",
            f"https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/{asset_id}/{asset_id}.bin",
        ): (200, binary),
    }
    resolver = make_resolver(tmp_path, handlers)

    first = resolver.resolve("table", "req-1")
    assert first.provider == "Poly Haven"
    assert first.cache_hit is False
    assert first.format == "gltf"
    assert first.model_url.endswith(f"{asset_id}_1k.gltf")
    assert (tmp_path / asset_id / f"{asset_id}_1k.gltf").is_file()

    second = resolver.resolve("table", "req-2")
    assert second.cache_hit is True
    assert second.id == first.id


def test_rejects_unsafe_download_hosts(tmp_path):
    handlers = {
        ("GET", "https://api.polyhaven.com/search"): (
            200,
            {"results": [{"slug": "evil_table", "score": 1}]},
        ),
        ("GET", "https://api.polyhaven.com/info/evil_table"): (
            200,
            {"name": "Evil", "type": 2, "files_hash": "x"},
        ),
        ("GET", "https://api.polyhaven.com/files/evil_table"): (
            200,
            {
                "gltf": {
                    "1k": {
                        "gltf": {
                            "url": "https://evil.example/model.gltf",
                            "size": 10,
                            "md5": "d41d8cd98f00b204e9800998ecf8427e",
                            "include": {},
                        }
                    }
                }
            },
        ),
    }
    resolver = make_resolver(tmp_path, handlers)
    with pytest.raises(AssetResolverError):
        resolver.resolve("spaceship", "req-unsafe")


def test_falls_back_to_verified_local_catalogue(tmp_path):
    handlers = {
        ("GET", "https://api.polyhaven.com/search"): (503, {"error": "down"}),
    }
    resolver = make_resolver(tmp_path, handlers)
    result = resolver.resolve("table", "req-fallback")
    assert result.provider == "Wundro fallback"
    assert result.id == FALLBACK_CATALOGUE["table"]["id"]
    assert result.model_url == "/models/table.glb"


def test_rejects_low_confidence_search_hits_then_falls_back(tmp_path):
    handlers = {
        ("GET", "https://api.polyhaven.com/search"): (
            200,
            {"results": [{"slug": "rock_09", "score": 0.41}]},
        ),
    }
    resolver = make_resolver(tmp_path, handlers)
    result = resolver.resolve("plant", "req-low-score")
    assert result.provider == "Wundro fallback"
    assert result.id == "wundro_plant"


@pytest.mark.parametrize("query,expected", [
    ("sofa", "wundro_sofa"),
    ("chair", "wundro_chair"),
    ("plant", "wundro_plant"),
])
def test_fallback_covers_three_distinct_assets(tmp_path, query, expected):
    handlers = {
        ("GET", "https://api.polyhaven.com/search"): (500, {"error": "nope"}),
    }
    resolver = make_resolver(tmp_path, handlers)
    result = resolver.resolve(query, f"req-{query}")
    assert result.id == expected
    assert result.format == "glb"
