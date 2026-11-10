from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path, PurePosixPath
from threading import Lock
from time import perf_counter
from typing import Any
from urllib.parse import urlparse

import httpx

from .models import AssetResolveResponse
from .pipeline_logging import PipelineLogStore


POLYHAVEN_API = "https://api.polyhaven.com"
USER_AGENT = "Wundro/0.7 (local WebXR asset resolver)"
SAFE_DOWNLOAD_HOSTS = {"dl.polyhaven.org"}
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ASSET_BYTES = 18 * 1024 * 1024
MAX_ASSET_FILES = 12
MAX_CACHE_BYTES = 160 * 1024 * 1024
MIN_SEARCH_SCORE = 0.52
SLUG = re.compile(r"^[A-Za-z0-9_-]+$")

FALLBACK_CATALOGUE = {
    "sofa": {
        "id": "wundro_sofa",
        "name": "Sofa",
        "queries": {"sofa", "couch", "सोफा", "sofha"},
        "model_url": "/models/sofa.glb",
        "source_url": "/models/sofa.glb",
        "dimensions_mm": (1800.0, 850.0, 900.0),
    },
    "table": {
        "id": "wundro_table",
        "name": "Table",
        "queries": {"table", "desk", "टेबल", "mez", "मेज़"},
        "model_url": "/models/table.glb",
        "source_url": "/models/table.glb",
        "dimensions_mm": (1200.0, 750.0, 700.0),
    },
    "chair": {
        "id": "wundro_chair",
        "name": "Chair",
        "queries": {"chair", "seat", "कुर्सी", "kursi"},
        "model_url": "/models/chair.glb",
        "source_url": "/models/chair.glb",
        "dimensions_mm": (450.0, 900.0, 450.0),
    },
    "plant": {
        "id": "wundro_plant",
        "name": "Plant",
        "queries": {"plant", "pot", "पौधा", "paudha"},
        "model_url": "/models/plant.glb",
        "source_url": "/models/plant.glb",
        "dimensions_mm": (350.0, 750.0, 350.0),
    },
}


class AssetResolverError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


class AssetResolver:
    def __init__(
        self,
        logs: PipelineLogStore,
        cache_root: Path | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        configured = (
            os.getenv("WUNDRO_ASSET_CACHE", "").strip()
            or os.getenv("SHABDVERSE_ASSET_CACHE", "").strip()
        )
        self.cache_root = cache_root or (
            Path(configured) if configured else Path(__file__).resolve().parents[1] / ".asset-cache"
        )
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self.logs = logs
        self.http = http_client or httpx.Client(
            timeout=httpx.Timeout(30, connect=10),
            headers={"User-Agent": USER_AGENT},
            follow_redirects=False,
        )
        self._lock = Lock()

    def cached_file(self, asset_id: str, relative_path: str) -> Path:
        if not SLUG.fullmatch(asset_id):
            raise AssetResolverError("Invalid cached asset id.", 404)
        safe_path = self._safe_relative_path(relative_path)
        asset_root = (self.cache_root / asset_id).resolve()
        target = (asset_root / Path(*PurePosixPath(safe_path).parts)).resolve()
        if asset_root not in target.parents or not target.is_file():
            raise AssetResolverError("Cached asset file was not found.", 404)
        return target

    def resolve(self, query: str, request_id: str) -> AssetResolveResponse:
        query = " ".join(query.split())
        if not query:
            raise AssetResolverError("Asset query cannot be blank.", 422)
        self.logs.emit(request_id, "asset", "discovery_started", query=query, provider="Poly Haven")
        started = perf_counter()
        try:
            candidate = self._discover(query, request_id)
            result = self._download(candidate, query, request_id)
            self.logs.emit(
                request_id,
                "asset",
                "resolver_completed",
                "success",
                asset_id=result.id,
                asset_name=result.name,
                cache_hit=result.cache_hit,
                total_bytes=result.total_bytes,
                latency_ms=round((perf_counter() - started) * 1000),
            )
            return result
        except (httpx.HTTPError, AssetResolverError) as error:
            fallback = self._fallback(query)
            if fallback:
                self.logs.emit(
                    request_id,
                    "asset",
                    "fallback_selected",
                    "success",
                    query=query,
                    asset_id=fallback.id,
                    reason=str(error),
                )
                return fallback
            self.logs.emit(
                request_id,
                "asset",
                "resolver_failed",
                "error",
                query=query,
                error=str(error),
                latency_ms=round((perf_counter() - started) * 1000),
            )
            if isinstance(error, AssetResolverError):
                raise
            raise AssetResolverError("Could not reach the Poly Haven asset service.", 503) from error

    def _discover(self, query: str, request_id: str) -> dict[str, Any]:
        response = self.http.get(f"{POLYHAVEN_API}/search", params={"q": query, "t": "models"})
        if response.status_code != 200:
            raise AssetResolverError(f"Poly Haven search failed ({response.status_code}).", 502)
        payload = self._object_json(response, "Poly Haven search")
        results = payload.get("results")
        if not isinstance(results, list):
            raise AssetResolverError("Poly Haven search returned an invalid response.")
        for item in results[:8]:
            if not isinstance(item, dict):
                continue
            slug = item.get("slug")
            score = item.get("score")
            if not isinstance(slug, str) or not SLUG.fullmatch(slug):
                continue
            if not isinstance(score, (int, float)) or score < MIN_SEARCH_SCORE:
                continue
            info_response = self.http.get(f"{POLYHAVEN_API}/info/{slug}")
            if info_response.status_code != 200:
                continue
            info = self._object_json(info_response, "Poly Haven asset metadata")
            if info.get("type") != 2:
                continue
            files_response = self.http.get(f"{POLYHAVEN_API}/files/{slug}")
            if files_response.status_code != 200:
                continue
            files = self._object_json(files_response, "Poly Haven file list")
            package = self._select_package(files)
            if package:
                self.logs.emit(
                    request_id,
                    "asset",
                    "discovery_completed",
                    "success",
                    query=query,
                    asset_id=slug,
                    asset_name=info.get("name") or slug,
                    score=item.get("score"),
                    resolution=package["resolution"],
                    format="gltf",
                    declared_bytes=package["total_bytes"],
                )
                return {"id": slug, "info": info, "package": package}
        raise AssetResolverError(f'No compatible, mobile-sized 3D model found for "{query}".', 404)

    def _select_package(self, files: dict[str, Any]) -> dict[str, Any] | None:
        gltf = files.get("gltf")
        if not isinstance(gltf, dict):
            return None
        for resolution in ("1k", "2k"):
            descriptor = gltf.get(resolution, {}).get("gltf")
            if not isinstance(descriptor, dict):
                continue
            main = self._file_descriptor(descriptor, default_name=None)
            includes = descriptor.get("include", {})
            if not main or not isinstance(includes, dict) or len(includes) + 1 > MAX_ASSET_FILES:
                continue
            declared: list[dict[str, Any]] = [main]
            valid = True
            for relative_name, value in includes.items():
                item = self._file_descriptor(value, default_name=relative_name)
                if not item:
                    valid = False
                    break
                declared.append(item)
            if not valid:
                continue
            total = sum(item["size"] for item in declared)
            if total <= 0 or total > MAX_ASSET_BYTES:
                continue
            return {
                "resolution": resolution,
                "main": declared[0],
                "files": declared,
                "total_bytes": total,
            }
        return None

    def _file_descriptor(self, value: Any, default_name: str | None) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        url, size, md5 = value.get("url"), value.get("size"), value.get("md5")
        if not isinstance(url, str) or not self._safe_download_url(url):
            return None
        if not isinstance(size, int) or size <= 0 or size > MAX_FILE_BYTES:
            return None
        if not isinstance(md5, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", md5):
            return None
        path_name = default_name or PurePosixPath(urlparse(url).path).name
        safe_path = self._safe_relative_path(path_name)
        return {"url": url, "size": size, "md5": md5.lower(), "path": safe_path}

    def _download(
        self, candidate: dict[str, Any], query: str, request_id: str
    ) -> AssetResolveResponse:
        asset_id = candidate["id"]
        info = candidate["info"]
        package = candidate["package"]
        asset_dir = self.cache_root / asset_id
        manifest_path = asset_dir / "manifest.json"
        with self._lock:
            manifest = self._read_manifest(manifest_path)
            if manifest and self._cache_valid(asset_dir, package):
                self.logs.emit(
                    request_id, "asset", "cache_hit", "success",
                    asset_id=asset_id, total_bytes=package["total_bytes"],
                )
                return self._response(candidate, query, True)

            self._prune_cache(package["total_bytes"], keep=asset_id)
            if asset_dir.exists():
                shutil.rmtree(asset_dir)
            asset_dir.mkdir(parents=True)
            self.logs.emit(
                request_id, "asset", "download_started",
                asset_id=asset_id, file_count=len(package["files"]),
                declared_bytes=package["total_bytes"],
            )
            downloaded = 0
            try:
                for item in package["files"]:
                    target = asset_dir / Path(*PurePosixPath(item["path"]).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    data = self._download_file(item)
                    target.write_bytes(data)
                    downloaded += len(data)
                manifest_path.write_text(
                    json.dumps({
                        "id": asset_id,
                        "name": info.get("name") or asset_id,
                        "main": package["main"]["path"],
                        "files_hash": info.get("files_hash"),
                        "total_bytes": downloaded,
                    }, separators=(",", ":")),
                    encoding="utf-8",
                )
            except Exception:
                shutil.rmtree(asset_dir, ignore_errors=True)
                raise
            self.logs.emit(
                request_id, "asset", "download_completed", "success",
                asset_id=asset_id, downloaded_bytes=downloaded,
            )
        return self._response(candidate, query, False)

    def _download_file(self, item: dict[str, Any]) -> bytes:
        response = self.http.get(item["url"])
        if response.status_code != 200:
            raise AssetResolverError(f"Asset download failed ({response.status_code}).", 502)
        data = response.content
        if len(data) != item["size"] or len(data) > MAX_FILE_BYTES:
            raise AssetResolverError("Downloaded asset file size did not match its manifest.")
        if hashlib.md5(data).hexdigest() != item["md5"]:  # nosec: provider integrity checksum
            raise AssetResolverError("Downloaded asset checksum did not match its manifest.")
        return data

    def _response(
        self, candidate: dict[str, Any], query: str, cache_hit: bool
    ) -> AssetResolveResponse:
        info, package, asset_id = candidate["info"], candidate["package"], candidate["id"]
        dimensions = info.get("dimensions")
        if not (
            isinstance(dimensions, list)
            and len(dimensions) == 3
            and all(isinstance(value, (int, float)) and value > 0 for value in dimensions)
        ):
            dimensions = None
        return AssetResolveResponse(
            id=asset_id,
            name=str(info.get("name") or asset_id),
            query=query,
            provider="Poly Haven",
            license="CC0",
            source_url=f"https://polyhaven.com/a/{asset_id}",
            model_url=f"/api/assets/files/{asset_id}/{package['main']['path']}",
            format="gltf",
            dimensions_mm=tuple(dimensions) if dimensions else None,
            cache_hit=cache_hit,
            total_bytes=package["total_bytes"],
        )

    def _fallback(self, query: str) -> AssetResolveResponse | None:
        normalized = query.casefold()
        tokens = set(re.findall(r"[\w'-]+", normalized, flags=re.UNICODE))
        for value in FALLBACK_CATALOGUE.values():
            aliases = {item.casefold() for item in value["queries"]}
            if normalized in aliases or tokens & aliases:
                return AssetResolveResponse(
                    id=value["id"],
                    name=value["name"],
                    query=query,
                    provider="Wundro fallback",
                    license="CC0",
                    source_url=value["source_url"],
                    model_url=value["model_url"],
                    format="glb",
                    dimensions_mm=value["dimensions_mm"],
                    cache_hit=True,
                    total_bytes=0,
                )
        return None

    def _cache_valid(self, asset_dir: Path, package: dict[str, Any]) -> bool:
        for item in package["files"]:
            target = asset_dir / Path(*PurePosixPath(item["path"]).parts)
            if not target.is_file() or target.stat().st_size != item["size"]:
                return False
            if hashlib.md5(target.read_bytes()).hexdigest() != item["md5"]:  # nosec
                return False
        return True

    def _prune_cache(self, required: int, keep: str) -> None:
        directories = [item for item in self.cache_root.iterdir() if item.is_dir() and item.name != keep]
        sizes = {
            item: sum(file.stat().st_size for file in item.rglob("*") if file.is_file())
            for item in directories
        }
        current = sum(sizes.values())
        for directory in sorted(directories, key=lambda item: item.stat().st_mtime):
            if current + required <= MAX_CACHE_BYTES:
                break
            current -= sizes[directory]
            shutil.rmtree(directory, ignore_errors=True)

    @staticmethod
    def _safe_download_url(url: str) -> bool:
        parsed = urlparse(url)
        return (
            parsed.scheme == "https"
            and parsed.hostname in SAFE_DOWNLOAD_HOSTS
            and parsed.username is None
            and parsed.password is None
            and parsed.port in (None, 443)
        )

    @staticmethod
    def _safe_relative_path(value: str) -> str:
        path = PurePosixPath(value.replace("\\", "/"))
        if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
            raise AssetResolverError("Provider returned an unsafe asset path.")
        if path.suffix.lower() not in {".gltf", ".glb", ".bin", ".jpg", ".jpeg", ".png", ".webp"}:
            raise AssetResolverError(f"Unsupported asset dependency format: {path.suffix}")
        return path.as_posix()

    @staticmethod
    def _object_json(response: httpx.Response, label: str) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as error:
            raise AssetResolverError(f"{label} returned invalid JSON.") from error
        if not isinstance(payload, dict):
            raise AssetResolverError(f"{label} returned an invalid response shape.")
        return payload

    @staticmethod
    def _read_manifest(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None
