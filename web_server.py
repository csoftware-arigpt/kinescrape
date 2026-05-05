from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import threading
import zipfile
from html import unescape as html_unescape
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse

import requests
from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from requests import RequestException
from starlette.exceptions import HTTPException as StarletteHTTPException

from kinescrape.const import (
    DEFAULT_REFERER,
    KINESCOPE_BASE_URL,
    KINESCOPE_CLEARKEY_LICENSE_URL,
    KINESCOPE_MASTER_PLAYLIST_URL,
    KINESCOPE_OEMBED_URL,
)


WEB_ROOT = Path(__file__).resolve().parent / "web"
LEGACY_MASTER_PLAYLIST_URL = "https://kinescope.io/{video_id}/master.mpd"
REQUEST_TIMEOUT = 30
SEGMENT_TIMEOUT = 120
VENDOR_TIMEOUT = 60
MAX_JSON_BODY = 20 * 1024 * 1024
MAX_TEXT_RESPONSE = 8 * 1024 * 1024
MAX_SEGMENT_RESPONSE = 512 * 1024 * 1024
MAX_VENDOR_RESPONSE = 64 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_MUX_SEGMENTS = 20_000
SERVER_SEGMENT_CONCURRENCY = 8
SERVER_SEGMENT_PREFETCH = SERVER_SEGMENT_CONCURRENCY * 2
FFMPEG_TIMEOUT = 2 * 60 * 60
MP4DECRYPT_TIMEOUT = 2 * 60 * 60

FFMPEG_VERSION = "0.12.15"
FFMPEG_CORE_VERSION = "0.12.10"
VENDOR_ASSETS: dict[str, tuple[str, str]] = {
    "/vendor/ffmpeg/index.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/index.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/classes.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/classes.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/const.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/const.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/errors.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/errors.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/types.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/types.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/utils.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/utils.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/worker.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/esm/worker.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/ffmpeg-core.js": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/core@{FFMPEG_CORE_VERSION}/dist/esm/ffmpeg-core.js",
        "text/javascript; charset=utf-8",
    ),
    "/vendor/ffmpeg/ffmpeg-core.wasm": (
        f"https://cdn.jsdelivr.net/npm/@ffmpeg/core@{FFMPEG_CORE_VERSION}/dist/esm/ffmpeg-core.wasm",
        "application/wasm",
    ),
}
_VENDOR_CACHE: dict[str, bytes] = {}
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,}$")
KINESCOPE_RESERVED_IDS = {"embed", "oembed", "player", "new-manifest", "master", "master.mpd", "video"}
VIDEO_ID_PATTERNS = (
    re.compile(r"\bid:\s*[\"']([A-Za-z0-9_-]{6,})[\"']"),
    re.compile(r"data-kinescope-id=[\"']([A-Za-z0-9_-]{6,})[\"']"),
    re.compile(r"(?:https?:)?//(?:[^\s\"'<>/@]+(?::[^\s\"'<>/@]*)?@)?(?:[^/\s\"'<>]+\.)?kinescope\.io/(?:embed/|player/|new-manifest/|video/)?([A-Za-z0-9_-]{6,})"),
)


class ApiError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class SourceRequest(BaseModel):
    source: str = Field(..., description="Kinescope link, video ID, embed code, or page HTML.")
    referer: str = Field(default="", description="Optional Referer to send upstream.")


class ManifestRequest(BaseModel):
    videoId: str = Field(default="", description="Kinescope video ID.")
    manifestUrl: str = Field(default="", description="Direct Kinescope manifest URL.")
    referer: str = Field(default="", description="Optional Referer to send upstream.")


class TitleRequest(BaseModel):
    videoId: str = Field(..., description="Kinescope video ID.")
    referer: str = Field(default="", description="Optional Referer to send upstream.")


class LicenseRequest(BaseModel):
    videoId: str = Field(..., description="Kinescope video ID.")
    kid: str = Field(..., description="ClearKey KID as hex or dashed UUID.")
    referer: str = Field(default="", description="Optional Referer to send upstream.")


class SegmentPayload(BaseModel):
    url: str = Field(..., description="Absolute segment URL.")
    range: str = Field(default="", description="Optional byte range without the bytes= prefix.")


class SegmentRequest(SegmentPayload):
    referer: str = Field(default="", description="Optional Referer to send upstream.")


class MuxRequest(BaseModel):
    filename: str = Field(default="kinescope.mp4", description="Output MP4 filename.")
    referer: str = Field(default="", description="Optional Referer to send upstream.")
    videoSegments: list[SegmentPayload] = Field(..., description="Ordered video init/media segments.")
    audioSegments: list[SegmentPayload] = Field(default_factory=list, description="Ordered audio init/media segments.")
    decryptionKey: str = Field(default="", description="Optional 16-byte ClearKey key in hex.")
    encryptionKid: str = Field(default="", description="Optional 16-byte ClearKey KID in hex.")


class ZipItemRequest(BaseModel):
    filename: str = Field(default="kinescope.mp4", description="MP4 filename inside the ZIP.")
    videoSegments: list[SegmentPayload] = Field(..., description="Ordered video init/media segments.")
    audioSegments: list[SegmentPayload] = Field(default_factory=list, description="Ordered audio init/media segments.")
    decryptionKey: str = Field(default="", description="Optional 16-byte ClearKey key in hex.")
    encryptionKid: str = Field(default="", description="Optional 16-byte ClearKey KID in hex.")


class ZipRequest(BaseModel):
    filename: str = Field(default="kinescrape-videos.zip", description="Archive filename.")
    referer: str = Field(default="", description="Optional Referer to send upstream.")
    items: list[ZipItemRequest] = Field(..., description="Videos to mux and write into the archive.")


app = FastAPI(
    title="Kinescrape API",
    version="1.0.0",
    description="Resolve Kinescope videos, proxy manifests and segments, and stream MP4 or ZIP downloads.",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)


@app.middleware("http")
async def guard_api_requests(request: Request, call_next):
    origin = request.headers.get("origin", "")
    host = request.headers.get("host", "")
    if request.url.path.startswith("/api/"):
        if origin and not is_same_origin(origin, host):
            return JSONResponse({"error": "Cross-origin API calls are not allowed."}, status_code=HTTPStatus.FORBIDDEN)
        if request.method in {"POST", "PUT", "PATCH"}:
            length = int(request.headers.get("content-length") or "0")
            if length > MAX_JSON_BODY:
                return JSONResponse({"error": "Request body is too large."}, status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        if request.method == "OPTIONS":
            response = Response(status_code=HTTPStatus.NO_CONTENT)
        else:
            response = await call_next(request)
        if origin and is_same_origin(origin, host):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    return await call_next(request)


@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, error: ApiError):
    return JSONResponse({"error": error.message}, status_code=int(error.status))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, error: RequestValidationError):
    return JSONResponse(
        {"error": "Invalid request body.", "details": error.errors()},
        status_code=HTTPStatus.UNPROCESSABLE_ENTITY,
    )


@app.exception_handler(StarletteHTTPException)
async def starlette_error_handler(request: Request, error: StarletteHTTPException):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": str(error.detail)}, status_code=error.status_code)
    return await http_exception_handler(request, error)


@app.get("/api/health", tags=["system"], summary="Health check")
def health_check():
    return {"ok": True, "mode": "fastapi"}


@app.get("/vendor/ffmpeg/{asset_path:path}", include_in_schema=False)
def serve_vendor(asset_path: str):
    path = f"/vendor/ffmpeg/{asset_path}"
    entry = VENDOR_ASSETS.get(path)
    if not entry:
        raise ApiError(HTTPStatus.NOT_FOUND, "Unknown vendor asset.")

    upstream_url, mime = entry
    data = vendor_fetch(path, upstream_url)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@app.post("/api/extract", tags=["kinescope"], summary="Extract Kinescope video candidates")
def api_extract(payload: SourceRequest):
    return {"candidates": extract_candidates(payload.source, payload.referer)}


@app.post("/api/resolve", tags=["kinescope"], summary="Resolve a source to a Kinescope video ID")
def api_resolve(payload: SourceRequest):
    return {"videoId": resolve_video_id(payload.source, payload.referer)}


@app.post("/api/manifest", tags=["kinescope"], summary="Fetch a DASH or HLS manifest")
def api_manifest(payload: ManifestRequest):
    manifest_url = payload.manifestUrl.strip()
    if manifest_url:
        return fetch_manifest_url(manifest_url, payload.referer)
    if not payload.videoId.strip():
        raise ApiError(HTTPStatus.BAD_REQUEST, "Missing required field: videoId")
    return fetch_manifest(payload.videoId, payload.referer)


@app.post("/api/title", tags=["kinescope"], summary="Fetch video title and thumbnail")
def api_title(payload: TitleRequest):
    return fetch_title(payload.videoId, payload.referer)


@app.post("/api/license", tags=["kinescope"], summary="Fetch a ClearKey decryption key")
def api_license(payload: LicenseRequest):
    key = fetch_clearkey(payload.videoId, payload.kid, payload.referer)
    return {"key": key}


@app.post("/api/segment", tags=["download"], summary="Proxy a single media segment")
def api_segment(payload: SegmentRequest):
    return proxy_segment_response(payload)


@app.post("/api/server-mux", tags=["download"], summary="Stream a server-muxed MP4")
def api_server_mux(payload: MuxRequest):
    return server_mux_response(payload)


@app.post("/api/server-zip", tags=["download"], summary="Stream a ZIP archive of server-muxed MP4 files")
def api_server_zip(payload: ZipRequest):
    return server_zip_response(payload)


def proxy_segment_response(payload: SegmentRequest) -> StreamingResponse:
    headers = request_headers(payload.referer or DEFAULT_REFERER, byte_range=payload.range)

    try:
        response = request_public("GET", payload.url, headers=headers, timeout=SEGMENT_TIMEOUT, stream=True)
    except RequestException as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Segment proxy failed: {error}") from error

    if response.status_code not in (HTTPStatus.OK, HTTPStatus.PARTIAL_CONTENT):
        response.close()
        raise ApiError(
            HTTPStatus.BAD_GATEWAY,
            f"Upstream segment request failed with HTTP {response.status_code}.",
        )

    content_length = response.headers.get("Content-Length")
    if content_length and int(content_length) > MAX_SEGMENT_RESPONSE:
        response.close()
        raise ApiError(HTTPStatus.BAD_GATEWAY, "Upstream segment is too large.")

    output_headers = {"X-Upstream-Status": str(response.status_code)}
    if content_length:
        output_headers["Content-Length"] = content_length
    return StreamingResponse(
        iter_upstream_segment(response),
        media_type=response.headers.get("Content-Type", "application/octet-stream"),
        headers=output_headers,
    )


def iter_upstream_segment(response) -> Iterator[bytes]:
    received = 0
    try:
        for chunk in response.iter_content(chunk_size=1024 * 256):
            if not chunk:
                continue
            received += len(chunk)
            if received > MAX_SEGMENT_RESPONSE:
                break
            yield chunk
    finally:
        response.close()


def server_mux_response(payload: MuxRequest) -> StreamingResponse:
    filename = sanitize_download_filename(payload.filename or "kinescope.mp4")
    referer = payload.referer or DEFAULT_REFERER
    video_segments = parse_segments(segment_payloads(payload.videoSegments), "videoSegments")
    audio_segments = parse_segments(segment_payloads(payload.audioSegments), "audioSegments")
    decryption_key = normalize_hex_128(payload.decryptionKey, "decryptionKey")
    encryption_kid = normalize_hex_128(payload.encryptionKid, "encryptionKid")

    return StreamingResponse(
        stream_with_writer(
            lambda output: write_muxed_video_to_stream(
                output,
                referer,
                video_segments,
                audio_segments,
                decryption_key,
                encryption_kid,
            )
        ),
        media_type="video/mp4",
        headers=attachment_headers(filename),
    )


def server_zip_response(payload: ZipRequest) -> StreamingResponse:
    zip_filename = sanitize_zip_filename(payload.filename or "kinescrape-videos.zip")
    referer = payload.referer or DEFAULT_REFERER
    if not payload.items:
        raise ApiError(HTTPStatus.BAD_REQUEST, "items must be a non-empty list.")
    if len(payload.items) > 100:
        raise ApiError(HTTPStatus.BAD_REQUEST, "items has too many videos.")

    parsed_items = []
    used_names: set[str] = set()
    for index, item in enumerate(payload.items):
        filename = unique_filename(
            sanitize_download_filename(item.filename or f"kinescrape-{index + 1}.mp4"),
            used_names,
        )
        parsed_items.append(
            {
                "filename": filename,
                "video_segments": parse_segments(segment_payloads(item.videoSegments), f"items[{index}].videoSegments"),
                "audio_segments": parse_segments(segment_payloads(item.audioSegments), f"items[{index}].audioSegments"),
                "decryption_key": normalize_hex_128(item.decryptionKey, f"items[{index}].decryptionKey"),
                "encryption_kid": normalize_hex_128(item.encryptionKid, f"items[{index}].encryptionKid"),
            }
        )

    def write_archive(output_stream):
        with zipfile.ZipFile(output_stream, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for item in parsed_items:
                info = zipfile.ZipInfo(item["filename"])
                info.compress_type = zipfile.ZIP_STORED
                with archive.open(info, mode="w", force_zip64=True) as entry:
                    write_muxed_video_to_stream(
                        entry,
                        referer,
                        item["video_segments"],
                        item["audio_segments"],
                        item["decryption_key"],
                        item["encryption_kid"],
                    )

    return StreamingResponse(
        stream_with_writer(write_archive),
        media_type="application/zip",
        headers=attachment_headers(zip_filename),
    )


def segment_payloads(segments: list[SegmentPayload]) -> list[dict[str, str]]:
    return [{"url": segment.url, "range": segment.range} for segment in segments]


def attachment_headers(filename: str) -> dict[str, str]:
    ascii_name = filename.encode("ascii", errors="ignore").decode("ascii") or "kinescrape-download"
    return {
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
    }


def stream_with_writer(write_fn: Callable[[Any], None]) -> Iterator[bytes]:
    chunks: queue.Queue[bytes | object] = queue.Queue(maxsize=16)
    sentinel = object()
    errors: list[BaseException] = []

    class QueueWriter:
        def write(self, chunk: bytes | bytearray | memoryview):
            data = bytes(chunk)
            if data:
                chunks.put(data)
            return len(data)

        def flush(self):
            return None

    def worker():
        try:
            write_fn(QueueWriter())
        except BaseException as error:
            errors.append(error)
        finally:
            chunks.put(sentinel)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    while True:
        chunk = chunks.get()
        if chunk is sentinel:
            break
        yield chunk
    thread.join()
    if errors:
        raise errors[0]


def is_same_origin(origin: str, host: str) -> bool:
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and parsed.netloc == host


def parse_segments(value: Any, field_name: str) -> list[dict[str, str]]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field_name} must be a list.")
    if len(value) > MAX_MUX_SEGMENTS:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field_name} has too many segments.")

    segments = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{field_name}[{index}] must be an object.")
        url = str(item.get("url") or "").strip()
        if not url:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{field_name}[{index}] is missing url.")
        byte_range = str(item.get("range") or "").strip()
        segments.append({"url": url, "range": byte_range})

    if field_name.endswith("videoSegments") and not segments:
        raise ApiError(HTTPStatus.BAD_REQUEST, "videoSegments cannot be empty.")
    return segments


def sanitize_download_filename(filename: str) -> str:
    cleaned = re.sub(r"[\\/\0\r\n]+", "_", filename).strip().strip(".")
    if not cleaned:
        cleaned = "kinescope.mp4"
    if not cleaned.lower().endswith(".mp4"):
        cleaned = f"{cleaned}.mp4"
    return cleaned[:180]


def sanitize_zip_filename(filename: str) -> str:
    cleaned = re.sub(r"[\\/\0\r\n]+", "_", filename).strip().strip(".")
    if not cleaned:
        cleaned = "kinescrape-videos.zip"
    if not cleaned.lower().endswith(".zip"):
        cleaned = f"{cleaned}.zip"
    return cleaned[:180]


def unique_filename(filename: str, used: set[str]) -> str:
    candidate = filename
    counter = 1
    while candidate in used:
        dot = filename.rfind(".")
        stem = filename[:dot] if dot > 0 else filename
        ext = filename[dot:] if dot > 0 else ""
        counter += 1
        candidate = f"{stem}-{counter}{ext}"
    used.add(candidate)
    return candidate


def write_muxed_video_to_stream(
    output_stream,
    referer: str,
    video_segments: list[dict[str, str]],
    audio_segments: list[dict[str, str]],
    decryption_key: str,
    encryption_kid: str,
):
    if decryption_key:
        write_decrypted_mux_to_stream(
            output_stream,
            referer,
            video_segments,
            audio_segments,
            decryption_key,
            encryption_kid,
        )
        return

    write_unencrypted_mux_to_stream(output_stream, referer, video_segments, audio_segments)


def write_unencrypted_mux_to_stream(
    output_stream,
    referer: str,
    video_segments: list[dict[str, str]],
    audio_segments: list[dict[str, str]],
):
    video_read, video_write = os.pipe()
    audio_read = audio_write = None
    if audio_segments:
        audio_read, audio_write = os.pipe()

    process: subprocess.Popen | None = None
    stderr_chunks: list[bytes] = []
    try:
        process = start_streaming_ffmpeg(video_read, audio_read)
        os.close(video_read)
        video_read = -1
        if audio_read is not None:
            os.close(audio_read)
            audio_read = -1

        stderr_thread = threading.Thread(
            target=drain_process_stream,
            args=(process.stderr, stderr_chunks),
            daemon=True,
        )
        stderr_thread.start()

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(download_track_to_fd, video_segments, video_write, referer)]
            video_write = -1
            if audio_segments and audio_write is not None:
                futures.append(executor.submit(download_track_to_fd, audio_segments, audio_write, referer))
                audio_write = -1

            assert process.stdout is not None
            for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                write_stream_chunk(output_stream, chunk)

            writer_error = None
            for future in futures:
                try:
                    future.result()
                except Exception as error:
                    writer_error = error
            if writer_error:
                process.kill()
                raise writer_error

        try:
            return_code = process.wait(timeout=FFMPEG_TIMEOUT)
        except subprocess.TimeoutExpired as error:
            process.kill()
            raise ApiError(HTTPStatus.BAD_GATEWAY, "ffmpeg timed out while muxing the stream.") from error

        if return_code != 0:
            detail = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
            raise ApiError(
                HTTPStatus.BAD_GATEWAY,
                f"ffmpeg failed while muxing the stream{f': {detail}' if detail else ''}.",
            )
    finally:
        for fd in (video_read, video_write, audio_read, audio_write):
            if isinstance(fd, int) and fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if process and process.poll() is None:
            process.kill()


def write_decrypted_mux_to_stream(
    output_stream,
    referer: str,
    video_segments: list[dict[str, str]],
    audio_segments: list[dict[str, str]],
    decryption_key: str,
    encryption_kid: str,
):
    video_fd = -1
    audio_fd = -1
    process: subprocess.Popen | None = None
    stderr_chunks: list[bytes] = []
    try:
        first_error: Exception | None = None
        with ThreadPoolExecutor(max_workers=2) as executor:
            decrypt_futures = {
                executor.submit(
                    decrypt_track_to_memfd,
                    video_segments,
                    referer,
                    encryption_kid,
                    decryption_key,
                    "video",
                ): "video",
            }
            if audio_segments:
                decrypt_futures[
                    executor.submit(
                        decrypt_track_to_memfd,
                        audio_segments,
                        referer,
                        encryption_kid,
                        decryption_key,
                        "audio",
                    )
                ] = "audio"

            for future, track_type in decrypt_futures.items():
                try:
                    fd = future.result()
                except Exception as error:
                    first_error = error
                    continue

                if track_type == "video":
                    video_fd = fd
                else:
                    audio_fd = fd

        if first_error:
            raise first_error

        process = start_streaming_ffmpeg(video_fd, audio_fd if audio_fd >= 0 else None, input_mode="fdpath")
        os.close(video_fd)
        video_fd = -1
        if audio_fd >= 0:
            os.close(audio_fd)
            audio_fd = -1

        stderr_thread = threading.Thread(
            target=drain_process_stream,
            args=(process.stderr, stderr_chunks),
            daemon=True,
        )
        stderr_thread.start()

        assert process.stdout is not None
        for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
            write_stream_chunk(output_stream, chunk)

        try:
            return_code = process.wait(timeout=FFMPEG_TIMEOUT)
        except subprocess.TimeoutExpired as error:
            process.kill()
            raise ApiError(HTTPStatus.BAD_GATEWAY, "ffmpeg timed out while muxing the decrypted stream.") from error

        if return_code != 0:
            detail = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
            raise ApiError(
                HTTPStatus.BAD_GATEWAY,
                f"ffmpeg failed while muxing the decrypted stream{f': {detail}' if detail else ''}.",
            )
    finally:
        for fd in (video_fd, audio_fd):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if process and process.poll() is None:
            process.kill()


def write_stream_chunk(output_stream, chunk: bytes):
    output_stream.write(chunk)
    flush = getattr(output_stream, "flush", None)
    if callable(flush):
        flush()


def normalize_hex_128(value: Any, field_name: str) -> str:
    cleaned = str(value or "").strip().replace("-", "").lower()
    if not cleaned:
        return ""
    if not re.fullmatch(r"[0-9a-f]{32}", cleaned):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field_name} must be a 16-byte hexadecimal value.")
    return cleaned


def download_track_to_fd(segments: list[dict[str, str]], write_fd: int, referer: str):
    with os.fdopen(write_fd, "wb") as output:
        with ThreadPoolExecutor(max_workers=SERVER_SEGMENT_CONCURRENCY) as executor:
            next_submit = 0
            next_write = 0
            futures = {}

            def submit_next():
                nonlocal next_submit
                futures[next_submit] = executor.submit(fetch_segment_bytes, segments[next_submit], referer)
                next_submit += 1

            for _ in range(min(SERVER_SEGMENT_PREFETCH, len(segments))):
                submit_next()

            while next_write < len(segments):
                data = futures.pop(next_write).result()
                output.write(data)
                next_write += 1
                while next_submit < len(segments) and len(futures) < SERVER_SEGMENT_PREFETCH:
                    submit_next()


def fetch_segment_bytes(segment: dict[str, str], referer: str) -> bytes:
    url = segment["url"]
    byte_range = segment.get("range", "")
    validate_http_url(url)
    headers = request_headers(referer or DEFAULT_REFERER, byte_range=byte_range)

    try:
        with request_public("GET", url, headers=headers, timeout=SEGMENT_TIMEOUT, stream=True) as response:
            if response.status_code not in (HTTPStatus.OK, HTTPStatus.PARTIAL_CONTENT):
                raise ApiError(
                    HTTPStatus.BAD_GATEWAY,
                    f"Upstream segment request failed with HTTP {response.status_code}.",
                )

            return read_limited_response(response, MAX_SEGMENT_RESPONSE)
    except RequestException as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Segment download failed: {error}") from error


def decrypt_track_to_memfd(
    segments: list[dict[str, str]],
    referer: str,
    kid: str,
    key: str,
    label: str,
) -> int:
    encrypted_fd = create_anonymous_fd(f"{label}.encrypted.mp4")
    decrypted_fd = create_anonymous_fd(f"{label}.decrypted.mp4")
    try:
        download_track_to_fd(segments, os.dup(encrypted_fd), referer)
        os.lseek(encrypted_fd, 0, os.SEEK_SET)
        run_mp4decrypt(encrypted_fd, decrypted_fd, kid, key)
        os.lseek(decrypted_fd, 0, os.SEEK_SET)
        return decrypted_fd
    except Exception:
        try:
            os.close(decrypted_fd)
        except OSError:
            pass
        raise
    finally:
        try:
            os.close(encrypted_fd)
        except OSError:
            pass


def create_anonymous_fd(name: str) -> int:
    if not hasattr(os, "memfd_create"):
        raise ApiError(
            HTTPStatus.INTERNAL_SERVER_ERROR,
            "Encrypted server decrypt requires Linux memfd support.",
        )
    return os.memfd_create(name, flags=0)


def run_mp4decrypt(input_fd: int, output_fd: int, kid: str, key: str):
    mp4decrypt_path = find_mp4decrypt()
    key_id = kid or "1"
    args = [
        mp4decrypt_path,
        "--key",
        f"{key_id}:{key}",
        f"/proc/self/fd/{input_fd}",
        f"/proc/self/fd/{output_fd}",
    ]
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(input_fd, output_fd),
            timeout=MP4DECRYPT_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "mp4decrypt timed out while decrypting the stream.") from error

    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ApiError(
            HTTPStatus.BAD_GATEWAY,
            f"mp4decrypt failed{f': {detail}' if detail else '.'}",
        )


def find_mp4decrypt() -> str:
    configured = os.environ.get("MP4DECRYPT_PATH", "").strip()
    if configured:
        if os.path.isfile(configured) and os.access(configured, os.X_OK):
            return configured
        raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "MP4DECRYPT_PATH does not point to an executable file.")

    path = shutil.which("mp4decrypt")
    if path:
        return path

    raise ApiError(
        HTTPStatus.INTERNAL_SERVER_ERROR,
        "mp4decrypt is not installed. Install Bento4 or set MP4DECRYPT_PATH.",
    )


def start_streaming_ffmpeg(video_fd: int, audio_fd: int | None, input_mode: str = "pipe") -> subprocess.Popen:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "Native ffmpeg is not installed in the server image.")

    def input_arg(fd: int) -> str:
        if input_mode == "fdpath":
            return f"/proc/self/fd/{fd}"
        return f"pipe:{fd}"

    args = [
        ffmpeg_path,
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        input_arg(video_fd),
    ]
    pass_fds = [video_fd]
    if audio_fd is not None:
        args.extend(["-i", input_arg(audio_fd), "-map", "0:v:0", "-map", "1:a:0"])
        pass_fds.append(audio_fd)
    else:
        args.extend(["-map", "0:v:0"])
    args.extend([
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ])

    return subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pass_fds=tuple(pass_fds),
        bufsize=0,
    )


def drain_process_stream(stream, chunks: list[bytes]):
    if stream is None:
        return
    for chunk in iter(lambda: stream.read(8192), b""):
        if sum(len(item) for item in chunks) < 64 * 1024:
            chunks.append(chunk)


def resolve_video_id(source: str, referer: str) -> str:
    source = source.strip()
    if is_valid_video_id(source) and "://" not in source:
        return source

    parsed = validate_http_url(source)
    inferred = infer_video_id_from_url(parsed)
    if inferred:
        return inferred

    html = fetch_text(source, referer)
    extracted = extract_video_id(html)
    if extracted:
        return extracted

    raise ApiError(HTTPStatus.BAD_REQUEST, "Could not find a Kinescope video ID in the supplied URL.")


def extract_candidates(source: str, referer: str) -> list[dict[str, str]]:
    source = source.strip()
    fetch_page = should_fetch_source_page(source)
    candidates = [] if fetch_page else candidates_from_text(source)

    if fetch_page:
        html = fetch_text(source, referer)
        candidates.extend(candidates_from_text(html))
        candidates.extend(candidates_from_html_attributes(html, source))
    elif looks_like_html(source):
        candidates.extend(candidates_from_html_attributes(source, ""))

    if not candidates:
        try:
            video_id = resolve_video_id(source, referer)
            candidates.append({"videoId": video_id, "label": video_id, "source": "resolved", "url": ""})
        except ApiError:
            pass

    return normalize_candidates(candidates)


def should_fetch_source_page(source: str) -> bool:
    if not is_http_url(source):
        return False

    parsed = urlparse(source)
    hostname = parsed.hostname or ""
    if not hostname.endswith("kinescope.io"):
        return True

    first_part = next((part for part in parsed.path.split("/") if part), "")
    if first_part in KINESCOPE_RESERVED_IDS:
        return False
    if parsed.path.endswith((".mpd", ".m3u8")):
        return False
    return True


def candidates_from_text(text: str) -> list[dict[str, str]]:
    candidates = []
    stripped = text.strip()
    if is_valid_video_id(stripped) and "://" not in stripped:
        candidates.append({"videoId": stripped, "label": stripped, "source": "video-id", "url": ""})

    for manifest_url in hls_manifest_urls_from_text(text):
        video_id = infer_video_id_from_value(manifest_url)
        if video_id:
            candidates.append({
                "videoId": video_id,
                "label": label_for_candidate(video_id, manifest_url),
                "source": "hls",
                "url": manifest_url,
                "manifestUrl": manifest_url,
                "manifestType": "hls",
            })

    for pattern in VIDEO_ID_PATTERNS:
        for match in pattern.finditer(text):
            video_id = match.group(1)
            candidates.append({
                "videoId": video_id,
                "label": label_for_candidate(video_id, match.group(0)),
                "source": "text",
                "url": match.group(0),
            })
    return candidates


def hls_manifest_urls_from_text(text: str) -> list[str]:
    urls = []
    for match in re.finditer(r"""https://kinescope\.io/[A-Za-z0-9_-]+/master\.m3u8\?[^"'<\s]+""", text):
        url = decode_embedded_url(match.group(0))
        if url not in urls:
            urls.append(url)
    return urls


def decode_embedded_url(value: str) -> str:
    return html_unescape(value).replace("\\u0026", "&")


def candidates_from_html_attributes(html: str, base_url: str) -> list[dict[str, str]]:
    candidates = []
    attr_re = re.compile(
        r"""(?:href|src|data-kinescope-id|data-video-id|data-id)\s*=\s*["']([^"']+)["']""",
        re.IGNORECASE,
    )
    for match in attr_re.finditer(html):
        raw_value = match.group(1)
        value = resolve_maybe_url(raw_value, base_url)
        video_id = infer_video_id_from_value(value or raw_value)
        if video_id:
            candidates.append({
                "videoId": video_id,
                "label": label_for_candidate(video_id, value or raw_value),
                "source": "html",
                "url": value or raw_value,
            })
    return candidates


def infer_video_id_from_url(parsed_url) -> str:
    query = parse_qs(parsed_url.query)
    for key in ("video_id", "videoId", "video", "id"):
        value = query.get(key, [""])[0]
        if is_valid_video_id(value):
            return value

    if not parsed_url.hostname or not parsed_url.hostname.endswith("kinescope.io"):
        return ""

    parts = [part for part in parsed_url.path.split("/") if part and part not in KINESCOPE_RESERVED_IDS]
    return next((part for part in parts if is_valid_video_id(part)), "")


def extract_video_id(html: str) -> str:
    for pattern in VIDEO_ID_PATTERNS:
        match = pattern.search(html)
        if match and is_valid_video_id(match.group(1)):
            return match.group(1)
    return ""


def normalize_candidates(candidates: list[dict[str, str]]) -> list[dict[str, str]]:
    result = []
    by_id: dict[str, dict[str, str]] = {}
    for candidate in candidates:
        video_id = candidate.get("videoId", "").strip()
        if not is_valid_video_id(video_id):
            continue
        existing = by_id.get(video_id)
        if existing:
            for key in ("manifestUrl", "manifestType", "title", "thumbnail", "url"):
                if not existing.get(key) and candidate.get(key):
                    existing[key] = candidate[key]
            if existing.get("source") != "hls" and candidate.get("source") == "hls":
                existing["source"] = "hls"
                existing["label"] = candidate.get("label") or existing["label"]
            continue

        url = candidate.get("url", "")
        item = {
            "videoId": video_id,
            "label": candidate.get("label") or label_for_candidate(video_id, url),
            "source": candidate.get("source", "source"),
            "url": url,
        }
        for key in ("manifestUrl", "manifestType", "title", "thumbnail"):
            value = candidate.get(key, "")
            if value:
                item[key] = value
        by_id[video_id] = item
        result.append(item)
    return result


def infer_video_id_from_value(value: str) -> str:
    value = unquote(value.strip())
    if is_valid_video_id(value) and "://" not in value:
        return value

    if value.startswith("//"):
        value = f"https:{value}"

    try:
        return infer_video_id_from_url(validate_http_url(value))
    except ApiError:
        return ""


def is_valid_video_id(value: str) -> bool:
    return bool(VIDEO_ID_RE.fullmatch(value or "")) and value not in KINESCOPE_RESERVED_IDS


def label_for_candidate(video_id: str, url: str) -> str:
    try:
        parsed = urlparse(f"https:{url}" if url.startswith("//") else url)
        return f"{video_id} - {parsed.hostname}" if parsed.hostname else video_id
    except (TypeError, ValueError):
        return video_id


def resolve_maybe_url(value: str, base_url: str) -> str:
    if value.startswith("//"):
        return f"https:{value}"
    if is_http_url(value):
        return value
    if base_url and is_http_url(base_url):
        return urljoin(base_url, value)
    return ""


def looks_like_html(value: str) -> bool:
    return bool(re.search(r"<[a-z][\s\S]*>", value, re.IGNORECASE))


def is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def fetch_manifest(video_id: str, referer: str) -> dict[str, str]:
    templates = dedupe([KINESCOPE_MASTER_PLAYLIST_URL, LEGACY_MASTER_PLAYLIST_URL])
    last_error = ""

    for template in templates:
        url = template.format(video_id=video_id)
        try:
            text = fetch_text(url, referer or DEFAULT_REFERER)
        except ApiError as error:
            last_error = error.message
            continue

        if text.strip():
            return {"url": url, "text": text}

    signed = fetch_signed_manifest_from_share_page(video_id, referer)
    if signed:
        return signed

    raise ApiError(HTTPStatus.BAD_GATEWAY, last_error or "The manifest could not be loaded.")


def fetch_signed_manifest_from_share_page(video_id: str, referer: str) -> dict[str, str] | None:
    page_url = f"{KINESCOPE_BASE_URL}/{video_id}"
    try:
        html = fetch_text(page_url, referer or DEFAULT_REFERER)
    except ApiError:
        return None

    for candidate in candidates_from_text(html):
        manifest_url = candidate.get("manifestUrl", "")
        if manifest_url:
            return fetch_manifest_url(manifest_url, referer or page_url)
    return None


def fetch_manifest_url(url: str, referer: str) -> dict[str, str]:
    parsed = validate_http_url(url)
    if not parsed.hostname or not parsed.hostname.endswith("kinescope.io"):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Only Kinescope manifest URLs are supported.")

    text = fetch_text(url, referer or DEFAULT_REFERER)
    manifest_type = "hls" if parsed.path.endswith(".m3u8") or text.lstrip().startswith("#EXTM3U") else "dash"
    return {"url": url, "text": text, "type": manifest_type}


def fetch_title(video_id: str, referer: str) -> dict[str, str]:
    url = KINESCOPE_OEMBED_URL.format(video_id=video_id)
    headers = request_headers(referer or DEFAULT_REFERER)

    try:
        response = request_public("GET", url, headers=headers, timeout=REQUEST_TIMEOUT, stream=True)
    except RequestException:
        return {"title": "", "thumbnail": ""}

    if not response.ok:
        response.close()
        return {"title": "", "thumbnail": ""}

    body = read_limited_response(response, MAX_TEXT_RESPONSE)
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"title": "", "thumbnail": ""}

    return {
        "title": str(data.get("title") or "").strip(),
        "thumbnail": str(data.get("thumbnail_url") or "").strip(),
    }


def fetch_clearkey(video_id: str, kid: str, referer: str) -> str:
    kid_hex = kid.replace("-", "")
    try:
        kid_token = base64_url_encode(bytes.fromhex(kid_hex))
    except ValueError as error:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid ClearKey KID.") from error

    url = KINESCOPE_CLEARKEY_LICENSE_URL.format(video_id=video_id)
    headers = request_headers(referer or DEFAULT_REFERER, origin=KINESCOPE_BASE_URL)

    try:
        response = request_public(
            "POST",
            url,
            headers=headers,
            json={"kids": [kid_token], "type": "temporary"},
            timeout=REQUEST_TIMEOUT,
        )
    except RequestException as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"License request failed: {error}") from error

    if not response.ok:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"License request failed with HTTP {response.status_code}.")

    try:
        key = response.json()["keys"][0]["k"]
        return base64_url_decode(key).hex()
    except (KeyError, IndexError, ValueError) as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, "The license response did not include a usable key.") from error


def vendor_fetch(path: str, upstream_url: str) -> bytes:
    cached = _VENDOR_CACHE.get(path)
    if cached is not None:
        return cached

    headers = {
        "Accept": "*/*",
        "User-Agent": "kinescrape/1.0",
    }
    try:
        response = requests.get(upstream_url, headers=headers, timeout=VENDOR_TIMEOUT, stream=True)
    except RequestException as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Vendor fetch failed: {error}") from error

    if not response.ok:
        response.close()
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Vendor upstream HTTP {response.status_code}.")

    body = read_limited_response(response, MAX_VENDOR_RESPONSE)
    _VENDOR_CACHE[path] = body
    return body


def fetch_text(url: str, referer: str) -> str:
    try:
        response = request_public("GET", url, headers=request_headers(referer), timeout=REQUEST_TIMEOUT, stream=True)
    except RequestException as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Request failed for {url}: {error}") from error

    if not response.ok:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Request failed with HTTP {response.status_code} for {url}.")

    body = read_limited_response(response, MAX_TEXT_RESPONSE)
    return body.decode(response.encoding or "utf-8", errors="replace")


def validate_http_url(url: str):
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Expected an absolute HTTP or HTTPS URL.")
    return parsed


def validate_public_http_url(url: str):
    parsed = validate_http_url(url)
    hostname = parsed.hostname
    if not hostname:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Expected a URL hostname.")

    if hostname.lower() == "localhost" or hostname.lower().endswith(".localhost"):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Localhost URLs are not allowed.")

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as error:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid URL port.") from error
    try:
        addresses = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ApiError(HTTPStatus.BAD_GATEWAY, f"Could not resolve hostname: {hostname}") from error

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Private, loopback, and link-local URLs are not allowed.")

    return parsed


def request_public(method: str, url: str, **kwargs):
    current_url = url
    for _ in range(MAX_REDIRECTS + 1):
        validate_public_http_url(current_url)
        response = requests.request(
            method,
            current_url,
            allow_redirects=False,
            **kwargs,
        )
        if response.is_redirect:
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise ApiError(HTTPStatus.BAD_GATEWAY, "Upstream redirect did not include a location.")
            current_url = urljoin(current_url, location)
            continue
        return response

    raise ApiError(HTTPStatus.BAD_GATEWAY, "Too many upstream redirects.")


def read_limited_response(response, byte_limit: int) -> bytes:
    chunks = []
    total = 0
    try:
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > byte_limit:
                raise ApiError(HTTPStatus.BAD_GATEWAY, "Upstream response is too large.")
            chunks.append(chunk)
    finally:
        response.close()
    return b"".join(chunks)


def request_headers(referer: str = "", origin: str = "", byte_range: str = "") -> dict[str, str]:
    headers = {
        "Accept": "*/*",
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
    }
    if referer:
        headers["Referer"] = clean_header_value(referer)
    if origin:
        headers["Origin"] = clean_header_value(origin)
    if byte_range:
        headers["Range"] = clean_header_value(f"bytes={byte_range}")
    return headers


def clean_header_value(value: str) -> str:
    value = value.strip()
    if "\r" in value or "\n" in value or len(value) > 2048:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid header value.")
    return value


def base64_url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def base64_url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def dedupe(values: list[str]) -> list[str]:
    result = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


app.mount("/", StaticFiles(directory=str(WEB_ROOT), html=True), name="web")


def main():
    parser = argparse.ArgumentParser(description="Serve the Kinescrape FastAPI app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()

    import uvicorn

    print(f"Serving Kinescrape at http://{args.host}:{args.port}/")
    print(f"API docs are available at http://{args.host}:{args.port}/docs")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
