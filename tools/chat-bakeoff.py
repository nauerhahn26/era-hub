#!/usr/bin/env -S uv run --python 3.12 --script
#
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "pydantic",
#     "pydantic-settings",
#     "python-dotenv",
#     "scipy",
#     "typer",
#     "websockets",
# ]
# [tool.uv]
# exclude-newer = "2026-10-13T00:00:00Z"
# ///
"""Streaming transcription bake-off: the same clips, played in real time, to N settings.

Each clip is played as 100 ms frames of 16 kHz PCM16 at wall-clock pace to every
configured transcription setting (all at once by default), the end signal is sent
at the clip's end ("release"), and per clip and setting the tool records connect
time, release to first partial, release to final, partial count, the final text,
word errors against the manifest reference, the either/or and negation meaning
checks, whether the expected names were heard, and an estimated cost. A p50/p95
summary per setting and a markdown table go to <cache>/bakeoff/<timestamp>/.

Settings are private JSON files under <cache>/bakeoff/configs/ (one per setting).
Each names a wire `protocol`, `url` or `url_env`, `model` or `model_env`, a
`token_env` read from the private env files, `keyterms` / `keyterms_file`, and a
`price`. Protocols, by wire shape:

  http-multipart-final    one WAV upload at release, JSON {text} back
  ws-realtime-events      JSON session.update, base64 24 kHz PCM append, commit
  ws-listen-query         settings as URL query, binary PCM, Results JSON with
                          channel.alternatives[0].transcript; variant "flux"
                          speaks TurnInfo events instead
  ws-streaming-turns      settings as URL query, binary PCM, Turn JSON messages
  ws-tokens-config-first  JSON config first, binary PCM, tokens[] JSON back

Usage:
    uv run tools/chat-bakeoff.py --configs all
    uv run tools/chat-bakeoff.py --configs oneshot-published,live-stream --clips child-1
    uv run tools/chat-bakeoff.py --list
    uv run tools/chat-bakeoff.py --add-synthetic
    uv run tools/chat-bakeoff.py --self-test        # offline; fake servers on loopback

Maintenance:
    uv add --script tools/chat-bakeoff.py 'package-name'
    uvx ruff format tools/chat-bakeoff.py
    uvx ruff check tools/chat-bakeoff.py

References:
    - PEP 723 (inline script metadata): https://peps.python.org/pep-0723/
    - uv scripts: https://docs.astral.sh/uv/guides/scripts/
    - Scoring helpers are shared with tools/chat-benchmark.py.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import importlib.util
import io
import json
import math
import re
import statistics
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import wave
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Annotated, Any, ClassVar, Literal

import numpy as np
import typer
from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from scipy.signal import resample_poly
from websockets.asyncio.client import ClientConnection, connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

SAMPLE_RATE = 16000
FRAME_SECONDS = 0.1
FRAME_BYTES = int(SAMPLE_RATE * FRAME_SECONDS) * 2


def _load_benchmark() -> Any:
    path = Path(__file__).with_name("chat-benchmark.py")
    spec = importlib.util.spec_from_file_location("chat_benchmark", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True  # never leave a __pycache__ in the checkout
    spec.loader.exec_module(module)
    return module


_bench = _load_benchmark()
words: Callable[[str], list[str]] = _bench.words
word_errors: Callable[[str, str], tuple[int, int]] = _bench.word_errors
meaning_ok: Callable[[dict[str, Any], str], bool] = _bench.meaning_ok
percentile: Callable[[list[float | None], float], float | None] = _bench.percentile
read_pcm: Callable[[Path], bytes] = _bench.read_pcm


# --------------------------------------------------------------------------- settings


class BakeoffSettings(BaseSettings):
    """Where the private inputs live; every path can be moved by ERA_CHAT_BAKEOFF_*."""

    model_config = SettingsConfigDict(env_prefix="ERA_CHAT_BAKEOFF_")

    cache: Path = Path.home() / ".cache/era-chat"
    env_files: list[Path] = [
        Path.home() / ".config/ai/ai.env",
        Path.home() / ".config/ai/chat-bakeoff.env",
    ]
    lexicon: Path = Path.home() / "new-era/era-family/data/personal-lexicon.json"
    espeak_root: Path = Path.home() / ".cache/era-chat/wake-comparison/synthesis"

    @property
    def root(self) -> Path:
        return self.cache / "bakeoff"

    @property
    def configs(self) -> Path:
        return self.root / "configs"

    @property
    def audio(self) -> Path:
        return self.root / "audio"

    def default_manifests(self) -> list[Path]:
        base = self.root / "base-manifest.json"
        if not base.exists():
            base = self.cache / "benchmarks/combined-manifest.json"
        found = [base, self.root / "synthetic-manifest.json"]
        return [path for path in found if path.exists()]


def load_env(
    files: list[Path], environ: dict[str, str] | None = None
) -> dict[str, str]:
    """Private env files merged in order; the process environment wins."""
    merged: dict[str, str] = {}
    for path in files:
        if path.exists():
            merged.update(
                {k: v for k, v in dotenv_values(path).items() if v is not None}
            )
    import os

    merged.update(environ if environ is not None else os.environ)
    return merged


# --------------------------------------------------------------------------- models

ProtocolName = Literal[
    "http-multipart-final",
    "ws-realtime-events",
    "ws-listen-query",
    "ws-streaming-turns",
    "ws-tokens-config-first",
]
ControlMessage = dict[str, Any] | str
QueryValue = str | int | float | bool | list[str]


class Price(BaseModel):
    """USD per minute of audio sent, or per minute the socket was open."""

    model_config = ConfigDict(extra="forbid")

    usd_per_minute: float = 0.0
    basis: Literal["audio", "connection"] = "audio"

    def cost(self, audio_seconds: float, socket_seconds: float | None) -> float:
        seconds = audio_seconds if self.basis == "audio" else (socket_seconds or 0.0)
        return round(seconds / 60 * self.usd_per_minute, 6)


class ServiceConfig(BaseModel):
    """One transcription setting under test (a private file; vendor names allowed there)."""

    model_config = ConfigDict(extra="forbid")

    id: str = ""
    protocol: ProtocolName
    url: str | None = None
    url_env: str | None = None
    model: str | None = None
    model_env: str | None = None
    token_env: str
    auth_header: str = "Authorization"
    auth_prefix: str | None = None
    auth_in_config: bool = False
    variant: Literal["v1", "flux"] = "v1"
    query: dict[str, QueryValue] = {}
    session: dict[str, Any] = {}
    fields: dict[str, str] = {}
    text_field: str = "text"
    keyterms: list[str] = []
    keyterms_file: str | None = None
    keyterms_field: str | None = None
    finalize_messages: list[ControlMessage] | None = None
    close_messages: list[ControlMessage] | None = None
    close_grace_ms: int = 1500
    timeout_seconds: float = 20.0
    connect_retries: int = 2
    connect_retry_seconds: float = 2.0
    price: Price = Price()
    enabled: bool = True
    notes: str = ""

    @model_validator(mode="after")
    def _one_url(self) -> ServiceConfig:
        if not (self.url or self.url_env):
            raise ValueError("a setting needs url or url_env")
        return self

    def resolve(self, env: dict[str, str]) -> ResolvedService | None:
        """None when the token (or an env-named url/model) is not available yet."""
        token = env.get(self.token_env, "")
        url = self.url or env.get(self.url_env or "", "")
        model = self.model or (env.get(self.model_env, "") if self.model_env else "")
        if not token or not url or (self.model_env and not model):
            return None
        return ResolvedService(
            config=self,
            url=url,
            model=model or None,
            token=token,
            keyterms=self.load_keyterms(),
        )

    def load_keyterms(self) -> list[str]:
        terms = list(self.keyterms)
        if self.keyterms_file:
            path = Path(self.keyterms_file).expanduser()
            text = path.read_text(encoding="utf8")
            if path.suffix == ".json":
                loaded = json.loads(text)
                if isinstance(loaded, dict):
                    loaded = loaded.get("keyterms")
                if not isinstance(loaded, list) or not all(
                    isinstance(x, str) for x in loaded
                ):
                    raise ValueError(
                        f"{path} must hold a JSON list of strings or {{keyterms: [...]}}"
                    )
                terms.extend(loaded)
            else:
                terms.extend(line.strip() for line in text.splitlines())
        seen: dict[str, None] = {}
        for term in terms:
            if term.strip():
                seen.setdefault(term.strip(), None)
        return list(seen)


class ResolvedService(BaseModel):
    config: ServiceConfig
    url: str
    model: str | None
    token: str
    keyterms: list[str]


class Clip(BaseModel):
    """A manifest row (the chat-benchmark manifest shape plus optional names/category)."""

    model_config = ConfigDict(extra="allow")

    id: str
    path: Path
    text: str = ""
    kind: str = "unspecified"
    category: str | None = None
    names: list[str] | None = None
    mustContain: list[str] = []
    mustNotContain: list[str] = []

    @model_validator(mode="before")
    @classmethod
    def _recorded_shape(cls, row: Any) -> Any:
        """Map the recorded-voice manifest shape onto this one.

        expected_names -> names; alternatives (either/or options) -> mustContain;
        negation true -> mustContain "not", but only when the (draft) reference
        itself carries a negative word; the row's kind doubles as its category.
        """
        if not isinstance(row, dict) or not (
            {"expected_names", "alternatives", "negation"} & row.keys()
        ):
            return row
        row = dict(row)
        row.setdefault("category", row.get("kind"))
        if row.get("names") is None and row.get("expected_names"):
            row["names"] = list(row["expected_names"])
        if not row.get("mustContain"):
            if row.get("alternatives"):
                row["mustContain"] = list(row["alternatives"])
            elif row.get("negation") and "not" in words(normalize(row.get("text", ""))):
                row["mustContain"] = ["not"]
        return row


class ClipResult(BaseModel):
    config: str
    protocol: str
    clip: str
    kind: str
    category: str | None = None
    audio_seconds: float
    connect_ms: float | None = None
    first_partial_ms: float | None = Field(None, description="from audio start")
    release_to_first_partial_ms: float | None = Field(
        None, description="signed: negative = a partial was on screen before release"
    )
    release_to_final_ms: float | None = None
    release_to_settled_ms: float | None = Field(
        None,
        description="signed: when the shown text last changed to the final's words; "
        "negative = the words were already complete before release",
    )
    partials: int = 0
    partials_before_release: int = 0
    socket_seconds: float | None = None
    reference: str = ""
    final_text: str | None = None
    word_errors: int = 0
    reference_words: int = 0
    meaning_checked: bool = False
    meaning_ok: bool | None = None
    names_expected: list[str] = []
    names_found: list[str] = []
    nonspeech_hallucinated: bool | None = None
    cost_usd: float = 0.0
    error: str | None = None


# --------------------------------------------------------------------------- scoring

_CONTRACTIONS = [
    (re.compile(r"\bcan't\b"), "can not"),
    (re.compile(r"\bcannot\b"), "can not"),
    (re.compile(r"\bwon't\b"), "will not"),
    (re.compile(r"\bain't\b"), "is not"),
    (re.compile(r"n't\b"), " not"),
]


def normalize(text: str) -> str:
    """Lower case, curly apostrophes straightened, negative contractions spelled out.

    "don't" and "do not" carry the same meaning for a partner's question, so the
    word and meaning scores do not punish a service for either spelling.
    """
    value = text.lower().replace("’", "'")
    for pattern, replacement in _CONTRACTIONS:
        value = pattern.sub(replacement, value)
    return value


def has_phrase(text: str, phrase: str) -> bool:
    return meaning_ok({"mustContain": [normalize(phrase)]}, normalize(text))


def score(result: ClipResult, clip: Clip, price: Price) -> ClipResult:
    hypothesis = result.final_text or ""
    errors, count = word_errors(normalize(clip.text), normalize(hypothesis))
    checked = bool(clip.mustContain or clip.mustNotContain)
    row = {
        "mustContain": [normalize(p) for p in clip.mustContain],
        "mustNotContain": [normalize(p) for p in clip.mustNotContain],
    }
    names = clip.names or []
    return result.model_copy(
        update={
            "reference": clip.text,
            "word_errors": errors if count else 0,
            "reference_words": count,
            "meaning_checked": checked,
            "meaning_ok": meaning_ok(row, normalize(hypothesis)) if checked else None,
            "names_expected": names,
            "names_found": [name for name in names if has_phrase(hypothesis, name)],
            "nonspeech_hallucinated": bool(words(hypothesis))
            if clip.kind == "nonspeech"
            else None,
            "cost_usd": price.cost(result.audio_seconds, result.socket_seconds),
        }
    )


def summarize(rows: list[ClipResult]) -> dict[str, Any]:
    quality = [r for r in rows if r.reference_words and r.final_text is not None]
    total_words = sum(r.reference_words for r in rows if r.reference_words)
    checked = [r for r in rows if r.meaning_checked]
    named = [r for r in rows if r.names_expected]
    nonspeech = [r for r in rows if r.nonspeech_hallucinated is not None]
    audio_minutes = sum(r.audio_seconds for r in rows) / 60

    def p(key: str) -> dict[str, float | None]:
        values = [getattr(r, key) for r in rows]
        return {"p50": percentile(values, 0.5), "p95": percentile(values, 0.95)}

    cost = round(sum(r.cost_usd for r in rows), 6)
    return {
        "clips": len(rows),
        "errors": sum(r.error is not None for r in rows),
        "wer": None
        if not total_words
        else round(
            sum(r.word_errors for r in rows if r.reference_words) / total_words, 4
        ),
        "werScoredClips": len(quality),
        "meaning": {
            "passed": sum(bool(r.meaning_ok) for r in checked),
            "total": len(checked),
        },
        "names": {
            "found": sum(len(r.names_found) for r in named),
            "expected": sum(len(r.names_expected) for r in named),
        },
        "nonspeechHallucinated": {
            "count": sum(bool(r.nonspeech_hallucinated) for r in nonspeech),
            "total": len(nonspeech),
        },
        "connectMs": p("connect_ms"),
        "releaseToFirstPartialMs": p("release_to_first_partial_ms"),
        "releaseToFinalMs": p("release_to_final_ms"),
        "releaseToSettledMs": p("release_to_settled_ms"),
        "partialsPerClip": None
        if not rows
        else round(statistics.fmean(r.partials for r in rows), 2),
        "costUsd": cost,
        "usdPerAudioMinute": None
        if not audio_minutes
        else round(cost / audio_minutes, 5),
    }


def group_wer(
    rows: list[ClipResult], key: Callable[[ClipResult], str | None]
) -> dict[str, Any]:
    groups: dict[str, list[ClipResult]] = {}
    for row in rows:
        name = key(row)
        if name:
            groups.setdefault(name, []).append(row)
    out: dict[str, Any] = {}
    for name, members in sorted(groups.items()):
        count = sum(r.reference_words for r in members)
        out[name] = {
            "clips": len(members),
            "wer": None
            if not count
            else round(sum(r.word_errors for r in members) / count, 4),
        }
    return out


# --------------------------------------------------------------------------- sessions


def now() -> float:
    return time.perf_counter()


def _query_value(value: QueryValue) -> str | list[str]:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return [str(v) for v in value]
    return str(value)


def with_query(url: str, items: list[tuple[str, str]]) -> str:
    if not items:
        return url
    joiner = "&" if urllib.parse.urlsplit(url).query else "?"
    return url + joiner + urllib.parse.urlencode(items)


def query_items(
    defaults: dict[str, QueryValue], overrides: dict[str, QueryValue]
) -> list[tuple[str, str]]:
    merged = {**defaults, **overrides}
    items: list[tuple[str, str]] = []
    for key, value in merged.items():
        converted = _query_value(value)
        if isinstance(converted, list):
            items.extend((key, v) for v in converted)
        else:
            items.append((key, converted))
    return items


class Session:
    """One clip's transcription turn against one setting."""

    finalize_default: ClassVar[list[ControlMessage]] = []
    close_default: ClassVar[list[ControlMessage]] = []
    default_auth_prefix = "Bearer "

    def __init__(self, service: ResolvedService) -> None:
        self.service = service
        self.config = service.config
        self.partials: list[tuple[float, str]] = []
        self.ready_at: float | None = None
        self.released_at: float | None = None
        self.final_at: float | None = None
        self.final_text: str | None = None
        self.error: str | None = None
        self.done = asyncio.Event()
        self.audio_bytes = 0

    @property
    def released(self) -> bool:
        return self.released_at is not None

    @property
    def finalize_messages(self) -> list[ControlMessage]:
        configured = self.config.finalize_messages
        return self.finalize_default if configured is None else configured

    @property
    def close_messages(self) -> list[ControlMessage]:
        configured = self.config.close_messages
        return self.close_default if configured is None else configured

    def auth_value(self) -> str:
        prefix = self.config.auth_prefix
        return (
            self.default_auth_prefix if prefix is None else prefix
        ) + self.service.token

    def note_partial(self, text: str) -> None:
        text = text.strip()
        if (
            text
            and (not self.partials or self.partials[-1][1] != text)
            and not self.done.is_set()
        ):
            self.partials.append((now(), text))

    def finish(self, text: str) -> None:
        if not self.done.is_set():
            self.final_text = text.strip()
            self.final_at = now()
            self.done.set()

    def fail(self, message: str) -> None:
        if not self.done.is_set():
            self.error = message
            self.done.set()

    async def open(self) -> None:
        raise NotImplementedError

    async def send_audio(self, pcm: bytes) -> None:
        raise NotImplementedError

    async def release(self) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        raise NotImplementedError

    async def wait_final(self, timeout: float) -> None:
        try:
            await asyncio.wait_for(self.done.wait(), timeout)
        except TimeoutError:
            self.fail(f"no final within {timeout:g} s")


def wav_bytes(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(pcm)
    return buffer.getvalue()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class MultipartSession(Session):
    """http-multipart-final: the whole turn uploaded as one WAV at release."""

    def __init__(self, service: ResolvedService) -> None:
        super().__init__(service)
        self.buffer = bytearray()
        self.task: asyncio.Task[None] | None = None

    async def open(self) -> None:
        self.buffer.clear()

    async def send_audio(self, pcm: bytes) -> None:
        self.buffer.extend(pcm)
        self.audio_bytes += len(pcm)

    def _post(self) -> str:
        fields = dict(self.config.fields)
        if self.service.model:
            fields["model"] = self.service.model
        if self.config.keyterms_field and self.service.keyterms:
            fields[self.config.keyterms_field] = (
                "Names and words you may hear: " + ", ".join(self.service.keyterms)
            )
        boundary = uuid.uuid4().hex
        body = bytearray()
        for name, value in fields.items():
            body.extend(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            )
        body.extend(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                'filename="question.wav"\r\nContent-Type: audio/wav\r\n\r\n'
            ).encode()
        )
        body.extend(wav_bytes(bytes(self.buffer)))
        body.extend(f"\r\n--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            self.service.url,
            data=bytes(body),
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                self.config.auth_header: self.auth_value(),
            },
        )
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=self.config.timeout_seconds) as response:
            value = json.loads(response.read(1_000_000))
        text = value.get(self.config.text_field)
        if not isinstance(text, str):
            raise TypeError("response carries no text field")
        return text

    async def _upload(self) -> None:
        try:
            self.finish(await asyncio.to_thread(self._post))
        except Exception as exc:  # noqa: BLE001 - recorded on the row
            self.fail(f"{type(exc).__name__}: {exc}"[:300])

    async def release(self) -> None:
        self.released_at = now()
        self.task = asyncio.create_task(self._upload())

    async def close(self) -> None:
        if self.task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    asyncio.shield(self.task), self.config.timeout_seconds
                )


class WsSession(Session):
    """Shared WebSocket lifecycle: open, read loop, finalize, grace, close.

    At release the protocol's finalize messages go out. When nothing is pending
    (no open turn) the close messages follow at once; otherwise they follow the
    final, or `close_grace_ms` after release if the service never answers the
    finalize, so a silent clip still ends with the service's own close reply.
    """

    def __init__(self, service: ResolvedService) -> None:
        super().__init__(service)
        self.ws: ClientConnection | None = None
        self.reader: asyncio.Task[None] | None = None
        self.grace: asyncio.Task[None] | None = None
        self.close_sent = False
        self.close_reason = ""

    def build_url(self) -> str:
        return self.service.url

    def headers(self) -> dict[str, str]:
        return {self.config.auth_header: self.auth_value()}

    async def startup(self) -> None:
        """Runs after the handshake, before audio; ready time is taken after it."""

    def on_message(self, message: dict[str, Any]) -> None:
        raise NotImplementedError

    def text_so_far(self) -> str:
        raise NotImplementedError

    def has_pending(self) -> bool:
        return True

    async def recv_json(self) -> dict[str, Any]:
        assert self.ws is not None
        while True:
            raw = await self.ws.recv()
            if isinstance(raw, str):
                with contextlib.suppress(ValueError):
                    value = json.loads(raw)
                    if isinstance(value, dict):
                        return value

    async def open(self) -> None:
        self.ws = await connect(
            self.build_url(),
            additional_headers=self.headers(),
            open_timeout=15,
            max_size=2**22,
            proxy=None,
        )
        await asyncio.wait_for(self.startup(), 15)
        self.ready_at = now()
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        assert self.ws is not None
        try:
            async for raw in self.ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    self.on_message(message)
        except ConnectionClosed as exc:
            received = exc.rcvd
            self.close_reason = (
                f"socket closed {received.code} {received.reason}"
                if received
                else "socket lost"
            )
        except Exception as exc:  # noqa: BLE001 - a malformed reply fails the turn
            self.close_reason = f"reply handling failed: {type(exc).__name__}: {exc}"[
                :300
            ]
        finally:
            if not self.done.is_set():
                if self.released and not self.close_reason:
                    self.finish(self.text_so_far())
                else:
                    code = self.ws.close_code
                    self.fail(
                        self.close_reason
                        or f"socket closed {code} {self.ws.close_reason or ''}".strip()
                    )

    async def send_audio(self, pcm: bytes) -> None:
        assert self.ws is not None
        await self.ws.send(pcm)
        self.audio_bytes += len(pcm)

    async def send_control(self, messages: list[ControlMessage]) -> None:
        assert self.ws is not None
        for message in messages:
            await self.ws.send(
                message if isinstance(message, str) else json.dumps(message)
            )

    async def send_close(self) -> None:
        if self.close_sent:
            return
        self.close_sent = True
        with contextlib.suppress(ConnectionClosed):
            await self.send_control(self.close_messages)

    async def _grace(self) -> None:
        await asyncio.sleep(self.config.close_grace_ms / 1000)
        if not self.done.is_set():
            await self.send_close()

    async def release(self) -> None:
        self.released_at = now()
        pending = self.has_pending()
        await self.send_control(self.finalize_messages)
        if not pending:
            await self.send_close()
        else:
            self.grace = asyncio.create_task(self._grace())

    async def close(self) -> None:
        if self.grace is not None:
            self.grace.cancel()
        if self.ws is None:
            return
        await self.send_close()
        if self.reader is not None and self.close_messages:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(self.reader), 3)
        await self.ws.close()
        if self.reader is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.reader, 3)


class RealtimeEventsSession(WsSession):
    """ws-realtime-events: JSON session.update, base64 24 kHz PCM appends, commit at release."""

    finalize_default: ClassVar[list[ControlMessage]] = [
        {"type": "input_audio_buffer.commit"}
    ]

    def __init__(self, service: ResolvedService) -> None:
        super().__init__(service)
        self.text = ""

    async def startup(self) -> None:
        assert self.ws is not None
        transcription: dict[str, Any] = dict(self.config.session)
        if self.config.keyterms_field and self.service.keyterms:
            field = self.config.keyterms_field
            transcription[field] = (
                list(self.service.keyterms)
                if field != "prompt"
                else "Names and words you may hear: " + ", ".join(self.service.keyterms)
            )
        if self.service.model:
            transcription["model"] = self.service.model
        await self.ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                "format": {"type": "audio/pcm", "rate": 24000},
                                "transcription": transcription,
                                "turn_detection": None,
                            }
                        },
                    },
                }
            )
        )
        while True:
            event = await self.recv_json()
            kind = event.get("type", "")
            if kind in ("session.updated", "transcription_session.updated"):
                return
            if kind == "error":
                raise ValueError(
                    f"session configuration refused: {json.dumps(event)[:200]}"
                )

    async def send_audio(self, pcm: bytes) -> None:
        assert self.ws is not None
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        converted = resample_poly(samples, 3, 2)
        payload = np.clip(converted * 32768, -32768, 32767).astype("<i2").tobytes()
        await self.ws.send(
            json.dumps(
                {
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(payload).decode(),
                }
            )
        )
        self.audio_bytes += len(pcm)

    def on_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type", "")
        if kind.endswith("input_audio_transcription.delta"):
            self.text += message.get("delta", "")
            self.note_partial(self.text)
        elif kind.endswith("input_audio_transcription.completed"):
            self.finish(message.get("transcript", ""))
        elif kind == "error" or kind.endswith("input_audio_transcription.failed"):
            self.fail(f"service error: {json.dumps(message)[:200]}")

    def text_so_far(self) -> str:
        return self.text


class ListenQuerySession(WsSession):
    """ws-listen-query: settings in the URL query, binary PCM, JSON results.

    Variant v1: `Results` with channel.alternatives[0].transcript, is_final and
    from_finalize; release sends Finalize, close sends CloseStream (answered with
    Metadata). Variant flux: `Connected` first, then `TurnInfo` events whose
    EndOfTurn commits a turn; release sends ForceEndTurn and CloseStream together
    and the final is every committed turn when the service closes the socket (a
    forced end of turn can land before queued audio is done and split the turn).
    """

    default_auth_prefix = "Token "

    def __init__(self, service: ResolvedService) -> None:
        super().__init__(service)
        self.committed: list[str] = []
        self.interim = ""

    @property
    def flux(self) -> bool:
        return self.config.variant == "flux"

    @property
    def finalize_messages(self) -> list[ControlMessage]:
        if self.config.finalize_messages is not None:
            return self.config.finalize_messages
        if self.flux:
            return [{"type": "ForceEndTurn"}, {"type": "CloseStream"}]
        return [{"type": "Finalize"}]

    @property
    def close_messages(self) -> list[ControlMessage]:
        if self.config.close_messages is not None:
            return self.config.close_messages
        return [] if self.flux else [{"type": "CloseStream"}]

    def build_url(self) -> str:
        defaults: dict[str, QueryValue] = {
            "encoding": "linear16",
            "sample_rate": SAMPLE_RATE,
        }
        if self.service.model:
            defaults = {"model": self.service.model, **defaults}
        if not self.flux:
            defaults |= {"channels": 1, "interim_results": True}
        items = query_items(defaults, self.config.query)
        items += [("keyterm", term) for term in self.service.keyterms]
        return with_query(self.service.url, items)

    async def startup(self) -> None:
        if not self.flux:
            return
        while True:
            event = await self.recv_json()
            if event.get("type") == "Connected":
                return
            if event.get("type") in ("Error", "FatalError"):
                raise ValueError(f"service refused: {json.dumps(event)[:200]}")

    def text_so_far(self) -> str:
        return " ".join(t for t in self.committed if t).strip()

    def _shown(self) -> str:
        return " ".join(t for t in [*self.committed, self.interim] if t)

    def on_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind in ("Error", "FatalError"):
            self.fail(f"service error: {json.dumps(message)[:200]}")
        elif self.flux and kind == "TurnInfo":
            text = (message.get("transcript") or "").strip()
            if message.get("event") == "EndOfTurn":
                if text:
                    self.committed.append(text)
                self.interim = ""
                self.note_partial(self._shown())
            else:
                self.interim = text
                self.note_partial(self._shown())
        elif not self.flux and kind == "Results":
            alternatives = (message.get("channel") or {}).get("alternatives") or [{}]
            text = (alternatives[0].get("transcript") or "").strip()
            if message.get("is_final"):
                if text:
                    self.committed.append(text)
                self.interim = ""
            else:
                self.interim = text
            self.note_partial(self._shown())
            if message.get("from_finalize") and self.released:
                self.finish(self.text_so_far())
        elif kind == "Metadata" and self.released:
            self.finish(self.text_so_far())


class StreamingTurnsSession(WsSession):
    """ws-streaming-turns: query settings, header key, binary PCM, `Turn` messages.

    With format_turns on, a turn ends twice (plain, then formatted); the
    formatted one counts. Release sends ForceEndpoint and Terminate together: the
    service applies the endpoint before it has finished audio already queued, so
    the question's last words can arrive as a further turn. The final is every
    turn joined when Termination arrives; release_to_settled_ms says when the
    words themselves were complete.
    """

    default_auth_prefix = ""
    finalize_default: ClassVar[list[ControlMessage]] = [
        {"type": "ForceEndpoint"},
        {"type": "Terminate"},
    ]

    def __init__(self, service: ResolvedService) -> None:
        super().__init__(service)
        self.turns: dict[int, str] = {}
        self.open_turn: tuple[int, str] | None = None

    @property
    def formatted(self) -> bool:
        value = self.config.query.get("format_turns", True)
        return value is True or str(value).lower() == "true"

    def build_url(self) -> str:
        defaults: dict[str, QueryValue] = {
            "sample_rate": SAMPLE_RATE,
            "encoding": "pcm_s16le",
            "format_turns": True,
        }
        if self.service.model:
            defaults["speech_model"] = self.service.model
        if self.service.keyterms:
            defaults["keyterms_prompt"] = json.dumps(self.service.keyterms)
        return with_query(self.service.url, query_items(defaults, self.config.query))

    async def startup(self) -> None:
        while True:
            event = await self.recv_json()
            if event.get("type") == "Begin":
                return
            if "error" in event:
                raise ValueError(f"service refused: {json.dumps(event)[:200]}")

    def has_pending(self) -> bool:
        return self.open_turn is not None

    def text_so_far(self) -> str:
        return " ".join(
            self.turns[k] for k in sorted(self.turns) if self.turns[k]
        ).strip()

    def on_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if "error" in message:
            self.fail(f"service error: {json.dumps(message)[:200]}")
        elif kind == "Turn":
            order = int(message.get("turn_order", 0))
            text = (message.get("transcript") or "").strip()
            ended = bool(message.get("end_of_turn"))
            if ended and (message.get("turn_is_formatted") or not self.formatted):
                self.turns[order] = text
                self.open_turn = None
                self.note_partial(self.text_so_far())
                return
            if text:
                self.open_turn = (order, text)
            shown = [self.turns[k] for k in sorted(self.turns) if k != order] + [text]
            self.note_partial(" ".join(t for t in shown if t))
        elif kind == "Termination" and self.released:
            if self.open_turn is not None and self.open_turn[0] not in self.turns:
                self.turns[self.open_turn[0]] = self.open_turn[1]
            self.finish(self.text_so_far())


class TokensConfigFirstSession(WsSession):
    """ws-tokens-config-first: JSON config first, binary PCM, `tokens[]` results.

    Final tokens accumulate; the non-final set is replaced by each message.
    Release sends {"type": "finalize"}, answered by a final "<fin>" token; close
    sends an empty text frame, answered by {"finished": true}. "<end>" (endpoint
    detection) is a marker, never text.
    """

    finalize_default: ClassVar[list[ControlMessage]] = [{"type": "finalize"}]
    close_default: ClassVar[list[ControlMessage]] = [""]
    markers = ("<fin>", "<end>")

    def __init__(self, service: ResolvedService) -> None:
        super().__init__(service)
        self.final = ""
        self.nonfinal = ""

    def build_url(self) -> str:
        return with_query(self.service.url, query_items({}, self.config.query))

    def headers(self) -> dict[str, str]:
        return {} if self.config.auth_in_config else super().headers()

    async def startup(self) -> None:
        assert self.ws is not None
        message: dict[str, Any] = {
            "audio_format": "pcm_s16le",
            "sample_rate": SAMPLE_RATE,
            "num_channels": 1,
            "enable_endpoint_detection": False,
        }
        if self.service.model:
            message["model"] = self.service.model
        if self.config.auth_in_config:
            message["api_key"] = self.service.token
        session = dict(self.config.session)
        context = dict(session.pop("context", {}) or {})
        if self.service.keyterms:
            context["terms"] = [*context.get("terms", []), *self.service.keyterms]
        message |= session
        if context:
            message["context"] = context
        await self.ws.send(json.dumps(message))

    def text_so_far(self) -> str:
        return self.final

    def on_message(self, message: dict[str, Any]) -> None:
        if message.get("error_code") or message.get("error_message"):
            self.fail(
                f"service error {message.get('error_code')}: {message.get('error_message')}"[
                    :300
                ]
            )
            return
        fin = False
        nonfinal = []
        for token in message.get("tokens") or []:
            text = token.get("text", "")
            if text in self.markers:
                fin = fin or text == "<fin>"
                continue
            if token.get("is_final"):
                self.final += text
            else:
                nonfinal.append(text)
        self.nonfinal = "".join(nonfinal)
        self.note_partial(self.final + self.nonfinal)
        if (fin and self.released) or message.get("finished"):
            self.finish(self.final)


SESSIONS: dict[str, type[Session]] = {
    "http-multipart-final": MultipartSession,
    "ws-realtime-events": RealtimeEventsSession,
    "ws-listen-query": ListenQuerySession,
    "ws-streaming-turns": StreamingTurnsSession,
    "ws-tokens-config-first": TokensConfigFirstSession,
}


# --------------------------------------------------------------------------- runner


async def sleep_until(moment: float) -> None:
    delay = moment - now()
    if delay > 0:
        await asyncio.sleep(delay)


def load_clip_pcm(clip: Clip) -> bytes:
    return read_pcm(clip.path)


async def run_clip(service: ResolvedService, clip: Clip, pcm: bytes) -> ClipResult:
    """Play one clip in real time to one setting and measure the turn."""
    config = service.config
    session = SESSIONS[config.protocol](service)
    audio_seconds = len(pcm) / (SAMPLE_RATE * 2)
    connect_started = now()
    released_at: float | None = None
    audio_started: float | None = None
    connect_ms: float | None = None
    try:
        for attempt in range(config.connect_retries + 1):
            connect_started = now()
            try:
                await session.open()
                break
            except Exception:
                # Refused before any audio (a session limit, a busy edge): the
                # turn has not begun, so a fresh session after a pause is fair.
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(session.close(), 5)
                if attempt == config.connect_retries:
                    raise
                await asyncio.sleep(config.connect_retry_seconds * (attempt + 1))
                session = SESSIONS[config.protocol](service)
        if session.ready_at is not None:
            connect_ms = round((session.ready_at - connect_started) * 1000, 1)
        audio_started = now()
        for index, offset in enumerate(range(0, len(pcm), FRAME_BYTES)):
            await sleep_until(audio_started + index * FRAME_SECONDS)
            if session.done.is_set():
                break
            await session.send_audio(pcm[offset : offset + FRAME_BYTES])
        await sleep_until(audio_started + audio_seconds)
        released_at = now()
        await session.release()
        await session.wait_final(config.timeout_seconds)
    except Exception as exc:  # noqa: BLE001 - a failed turn is a result, not a crash
        session.fail(f"{type(exc).__name__}: {exc}"[:300])
    finally:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(session.close(), 10)
    closed_at = now()

    def ms(moment: float | None, origin: float | None) -> float | None:
        if moment is None or origin is None:
            return None
        return round((moment - origin) * 1000, 1)

    first = session.partials[0][0] if session.partials else None
    settled = settled_at(session)
    return ClipResult(
        config=config.id,
        protocol=config.protocol,
        clip=clip.id,
        kind=clip.kind,
        category=clip.category,
        audio_seconds=round(audio_seconds, 3),
        connect_ms=connect_ms,
        first_partial_ms=ms(first, audio_started),
        release_to_first_partial_ms=ms(first, released_at),
        release_to_final_ms=ms(session.final_at, released_at)
        if session.error is None
        else None,
        release_to_settled_ms=ms(settled, released_at)
        if session.error is None
        else None,
        partials=len(session.partials),
        partials_before_release=sum(
            1 for at, _ in session.partials if released_at and at < released_at
        ),
        socket_seconds=None
        if config.protocol == "http-multipart-final"
        else round(closed_at - connect_started, 3),
        final_text=session.final_text if session.error is None else None,
        error=session.error,
    )


def settled_at(session: Session) -> float | None:
    """When the shown text last became the final's words (a final with no partials: its own time).

    Turn services end a session with a teardown reply; the words are often ready
    earlier, and this is the moment a hub that watched the text would have had them.
    """
    if session.final_at is None or session.final_text is None:
        return None
    target = words(normalize(session.final_text))
    moment = session.final_at
    for at, text in reversed(session.partials):
        if words(normalize(text)) != target:
            break
        moment = at
    return moment


def load_manifests(paths: list[Path]) -> list[Clip]:
    clips: dict[str, Clip] = {}
    for path in paths:
        for row in json.loads(path.read_text(encoding="utf8")):
            clip = Clip.model_validate(row)
            clips[clip.id] = clip
    return list(clips.values())


def lexicon_proper_nouns(path: Path) -> list[str]:
    """Single capitalised entries of the private lexicon (never copied into the repo)."""
    if not path.exists():
        return []
    entries = json.loads(path.read_text(encoding="utf8"))
    if not isinstance(entries, list):
        return []
    return [
        e for e in entries if isinstance(e, str) and e[:1].isupper() and " " not in e
    ]


def fill_names(clips: list[Clip], proper_nouns: list[str]) -> list[Clip]:
    """A clip without explicit names expects every lexicon proper noun in its reference."""
    out = []
    for clip in clips:
        if clip.names is None and clip.text:
            found = [n for n in proper_nouns if has_phrase(clip.text, n)]
            clip = clip.model_copy(update={"names": found or None})
        out.append(clip)
    return out


def load_configs(directory: Path) -> list[ServiceConfig]:
    configs = []
    for path in sorted(directory.glob("*.json")):
        config = ServiceConfig.model_validate_json(path.read_text(encoding="utf8"))
        configs.append(config.model_copy(update={"id": config.id or path.stem}))
    return configs


def override_keyterms(
    config: ServiceConfig, keyterms_file: Path | None, label: str
) -> ServiceConfig:
    """Swap every setting's keyterms for one file's (or none) and label the run."""
    return config.model_copy(
        update={
            "id": config.id + label,
            "keyterms": [],
            "keyterms_file": str(keyterms_file) if keyterms_file else None,
        }
    )


def select_configs(configs: list[ServiceConfig], wanted: str) -> list[ServiceConfig]:
    if wanted == "all":
        return [c for c in configs if c.enabled]
    names = [w.strip() for w in wanted.split(",") if w.strip()]
    known = {c.id: c for c in configs}
    missing = [n for n in names if n not in known]
    if missing:
        raise typer.BadParameter(
            f"unknown setting(s): {', '.join(missing)}; known: {', '.join(known)}"
        )
    return [known[n] for n in names]


async def run_bakeoff(
    services: list[ResolvedService],
    clips: list[Clip],
    *,
    sequential: bool = False,
    progress: Callable[[ClipResult], None] | None = None,
) -> list[ClipResult]:
    rows: list[ClipResult] = []
    for clip in clips:
        pcm = load_clip_pcm(clip)

        async def one(
            service: ResolvedService, clip: Clip = clip, pcm: bytes = pcm
        ) -> ClipResult:
            measured = await run_clip(service, clip, pcm)
            scored = score(measured, clip, service.config.price)
            if progress:
                progress(scored)
            return scored

        async def in_turn(group: list[ResolvedService]) -> list[ClipResult]:
            return [await one(s) for s in group]

        if sequential:
            rows.extend(await in_turn(services))
        else:
            # Settings on one account share its session limit, so they take
            # turns; different accounts still hear the clip at the same time.
            groups: dict[str, list[ResolvedService]] = {}
            for s in services:
                groups.setdefault(s.token, []).append(s)
            for block in await asyncio.gather(*(in_turn(g) for g in groups.values())):
                rows.extend(block)
    return rows


# --------------------------------------------------------------------------- report


def fmt_pair(pair: dict[str, float | None]) -> str:
    def one(value: float | None) -> str:
        return "-" if value is None else f"{value:.0f}"

    return f"{one(pair['p50'])} / {one(pair['p95'])}"


def write_report(
    out_dir: Path,
    rows: list[ClipResult],
    configs: list[ServiceConfig],
    skipped: dict[str, str],
    clips: list[Clip],
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    summaries: dict[str, Any] = {}
    for config in configs:
        mine = [r for r in rows if r.config == config.id]
        if not mine:
            continue
        summaries[config.id] = {
            "protocol": config.protocol,
            "price": config.price.model_dump(),
            "summary": summarize(mine),
            "byKind": group_wer(mine, lambda r: r.kind),
            "byCategory": group_wer(mine, lambda r: r.category),
        }
    result = {
        "createdAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "pacing": "real time, 100 ms PCM16 16 kHz frames, release at clip end",
        "clips": len(clips),
        "skipped": skipped,
        "configs": summaries,
        "rows": [r.model_dump() for r in rows],
    }
    lines = [
        f"# Streaming transcription bake-off, {result['createdAt']}",
        "",
        (
            f"{len(clips)} clips, {result['pacing']}. Latency in ms as p50 / p95. "
            "Release to first partial is signed: negative means a partial arrived "
            "while the partner was still holding. Release to final is the service's own "
            "completion reply; release to text settled is when the shown words last "
            "changed to the final's words (negative: complete before release). WER uses "
            "contraction-normalized text."
        ),
        "",
        (
            "| setting | protocol | clips | failed | WER | meaning ok | names right | "
            "nonspeech hallucinated | connect | release→first partial | release→final | "
            "release→text settled | partials/clip | cost USD | USD per audio min |"
        ),
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, block in summaries.items():
        s = block["summary"]
        lines.append(
            f"| {name} | {block['protocol']} | {s['clips']} | {s['errors']} | "
            f"{'-' if s['wer'] is None else f'{s["wer"]:.3f}'} | "
            f"{s['meaning']['passed']}/{s['meaning']['total']} | "
            f"{s['names']['found']}/{s['names']['expected']} | "
            f"{s['nonspeechHallucinated']['count']}/{s['nonspeechHallucinated']['total']} | "
            f"{fmt_pair(s['connectMs'])} | {fmt_pair(s['releaseToFirstPartialMs'])} | "
            f"{fmt_pair(s['releaseToFinalMs'])} | {fmt_pair(s['releaseToSettledMs'])} | "
            f"{s['partialsPerClip']} | "
            f"{s['costUsd']:.4f} | {s['usdPerAudioMinute']} |"
        )
    kinds = sorted({k for b in summaries.values() for k in b["byKind"]})
    if kinds:
        lines += [
            "",
            "## WER by clip kind",
            "",
            "| setting | " + " | ".join(kinds) + " |",
        ]
        lines.append("|---|" + "---|" * len(kinds))
        for name, block in summaries.items():
            cells = []
            for kind in kinds:
                cell = block["byKind"].get(kind)
                cells.append(
                    "-" if not cell or cell["wer"] is None else f"{cell['wer']:.3f}"
                )
            lines.append(f"| {name} | " + " | ".join(cells) + " |")
    by_kind: dict[tuple[str, str], list[ClipResult]] = {}
    for r in rows:
        by_kind.setdefault((r.config, r.category or r.kind), []).append(r)
    if by_kind:
        lines += [
            "",
            "## By kind",
            "",
            (
                "| setting | kind | clips | names right | meaning ok | release→final p50 | "
                "release→settled p50 | WER |"
            ),
            "|---|---|---|---|---|---|---|---|",
        ]
        for (name, kind), members in sorted(by_kind.items()):
            s = summarize(members)
            names = s["names"]
            meaning = s["meaning"]
            lines.append(
                f"| {name} | {kind} | {s['clips']} | "
                f"{f'{names["found"]}/{names["expected"]}' if names['expected'] else '-'} | "
                f"{f'{meaning["passed"]}/{meaning["total"]}' if meaning['total'] else '-'} | "
                f"{fmt_pair(s['releaseToFinalMs']).split(' / ')[0]} | "
                f"{fmt_pair(s['releaseToSettledMs']).split(' / ')[0]} | "
                f"{'-' if s['wer'] is None else f'{s["wer"]:.3f}'} |"
            )
    settings_seen = list(summaries)
    if settings_seen:
        cell = {(r.clip, r.config): r for r in rows}
        lines += [
            "",
            "## WER per clip",
            "",
            "Word errors / reference words per clip and setting (x = failed turn).",
            "",
            "| clip | " + " | ".join(settings_seen) + " |",
            "|---|" + "---|" * len(settings_seen),
        ]
        for clip in clips:
            values = []
            for name in settings_seen:
                r = cell.get((clip.id, name))
                if r is None:
                    values.append("")
                elif r.error:
                    values.append("x")
                else:
                    values.append(f"{r.word_errors}/{r.reference_words}")
            lines.append(f"| {clip.id} | " + " | ".join(values) + " |")
    misses = [
        r
        for r in rows
        if r.error
        or r.meaning_ok is False
        or len(r.names_found) < len(r.names_expected)
        or r.nonspeech_hallucinated
    ]
    if misses:
        lines += [
            "",
            "## Misses",
            "",
            "| setting | clip | what | reference | heard |",
            "|---|---|---|---|---|",
        ]
        for r in misses:
            what = []
            if r.error:
                what.append("error: " + r.error.replace("|", "/"))
            if r.meaning_ok is False:
                what.append("meaning")
            if len(r.names_found) < len(r.names_expected):
                what.append(
                    "names " + ",".join(set(r.names_expected) - set(r.names_found))
                )
            if r.nonspeech_hallucinated:
                what.append("text on nonspeech")
            lines.append(
                f"| {r.config} | {r.clip} | {'; '.join(what)} | {r.reference} | {r.final_text or ''} |"
            )
    if skipped:
        lines += ["", "## Skipped settings", ""]
        lines += [f"- {name}: {why}" for name, why in skipped.items()]
    report = "\n".join(lines) + "\n"
    for name, content in (
        ("results.json", json.dumps(result, indent=2)),
        ("report.md", report),
    ):
        path = out_dir / name
        path.write_text(content, encoding="utf8")
        path.chmod(0o600)
    return result


# --------------------------------------------------------------------------- synthetic clips

SYNTH_PROFILES = [
    ("en-us", 145),
    ("en-us+f3", 180),
    ("en-gb", 145),
    ("en-gb+f3", 180),
    ("en-sc", 145),
    ("en-sc+f3", 180),
]
NAME_TEMPLATES = [
    "Do you want to play with {name} today?",
    "Is {name} coming to the party?",
    "Did {name} read a book with you?",
    "Should we call {name} after dinner?",
    "Can {name} sit next to you?",
    "Was {name} at school today?",
    "Do you miss {name}?",
    "Shall we make a card for {name}?",
]
FALLBACK_NAMES = ["Sam", "Maya", "Leo", "Nora", "Theo", "Ava", "Max", "Ruby"]
NEGATIONS: list[tuple[str, list[str], list[str]]] = [
    ("Don't you want to go outside?", ["not", "outside"], []),
    ("Not the red one, the blue one.", ["not the red"], []),
    ("You don't like the loud music, do you?", ["not like"], []),
    ("I am not going to the park today.", ["not going"], []),
    ("We can't go swimming right now.", ["not go"], []),
    ("Don't you want some ice cream?", ["not", "ice cream"], []),
    ("That is not your cup.", ["not your"], []),
    ("It isn't time for bed yet.", ["not time"], []),
]
EITHER_OR: list[tuple[str, list[str]]] = [
    ("Do you want the red cup or the blue cup?", ["red", "blue"]),
    ("Should we read a book or watch a movie?", ["book", "movie"]),
    ("Apples or grapes?", ["apples", "grapes"]),
    ("Do you want to swim or go to the park?", ["swim", "park"]),
    ("Is it a dog or a cat?", ["dog", "cat"]),
    ("Pink shoes or purple shoes?", ["pink", "purple"]),
    ("Do you want music or quiet time?", ["music", "quiet"]),
    ("Should we go now or later?", ["now", "later"]),
]
REMARKS = [
    "That was so funny!",
    "Good job, you did it.",
    "I love that picture.",
    "Look at the big elephant.",
    "Time for lunch.",
    "Wow, that is really cool.",
]


class SyntheticSentence(BaseModel):
    id: str
    category: str
    text: str
    names: list[str] | None = None
    mustContain: list[str] = []
    mustNotContain: list[str] = []


def synthetic_sentences(proper_nouns: list[str]) -> list[SyntheticSentence]:
    names = proper_nouns or FALLBACK_NAMES
    out = [
        SyntheticSentence(
            id=f"syn-name-{i + 1:02d}",
            category="name",
            text=template.format(name=names[i % len(names)]),
            names=[names[i % len(names)]],
        )
        for i, template in enumerate(NAME_TEMPLATES)
    ]
    out += [
        SyntheticSentence(
            id=f"syn-negation-{i + 1:02d}",
            category="negation",
            text=t,
            mustContain=c,
            mustNotContain=n,
        )
        for i, (t, c, n) in enumerate(NEGATIONS)
    ]
    out += [
        SyntheticSentence(
            id=f"syn-either-{i + 1:02d}", category="either_or", text=t, mustContain=c
        )
        for i, (t, c) in enumerate(EITHER_OR)
    ]
    out += [
        SyntheticSentence(id=f"syn-remark-{i + 1:02d}", category="remark", text=t)
        for i, t in enumerate(REMARKS)
    ]
    return out


def espeak(root: Path, voice: str, speed: int, text: str) -> np.ndarray:
    import subprocess

    libs = root / "usr/lib/x86_64-linux-gnu"
    env = {"LD_LIBRARY_PATH": f"{libs}:{libs / 'pulseaudio'}", "PATH": "/usr/bin:/bin"}
    with tempfile.TemporaryDirectory(prefix="era-bakeoff-synth-") as scratch:
        out = Path(scratch) / "segment.wav"
        subprocess.run(
            [
                str(root / "usr/bin/espeak-ng"),
                f"--path={libs}",
                "-v",
                voice,
                "-s",
                str(speed),
                "-w",
                str(out),
                text,
            ],
            env=env,
            check=True,
            capture_output=True,
        )
        with wave.open(str(out), "rb") as source:
            rate = source.getframerate()
            raw = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    samples = raw.astype(np.float32) / 32768
    samples = resample_poly(samples, SAMPLE_RATE, rate).astype(np.float32)
    active = np.where(np.abs(samples) > 0.003)[0]
    if len(active):
        samples = samples[max(0, active[0] - 320) : active[-1] + 321]
    return samples


def write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = np.clip(samples * 32768, -32768, 32767).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(pcm)


def add_noise(samples: np.ndarray, snr_db: float, seed: int) -> np.ndarray:
    """Additive Gaussian noise at snr_db below the speech RMS (the wake-comparison recipe)."""
    rms = float(np.sqrt(np.mean(samples * samples))) or 1e-4
    rng = np.random.default_rng(seed)
    return samples + rng.normal(0, rms / (10 ** (snr_db / 20)), len(samples)).astype(
        np.float32
    )


def add_synthetic(settings: BakeoffSettings) -> Path:
    settings.audio.mkdir(parents=True, exist_ok=True)
    proper = lexicon_proper_nouns(settings.lexicon)
    rows: list[dict[str, Any]] = []
    lead = np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32)
    tail = np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32)
    for index, sentence in enumerate(synthetic_sentences(proper)):
        voice, speed = SYNTH_PROFILES[index % len(SYNTH_PROFILES)]
        speech = espeak(settings.espeak_root, voice, speed, sentence.text)
        clean = np.concatenate([lead, speech, tail])
        noisy = add_noise(clean, 10, 1000 + index)
        for suffix, samples, kind in (
            ("", clean, "synthetic"),
            ("-noisy", noisy, "synthetic_noise"),
        ):
            path = settings.audio / f"{sentence.id}{suffix}.wav"
            write_wav(path, samples)
            rows.append(
                {
                    **sentence.model_dump(exclude={"id"}),
                    "id": sentence.id + suffix,
                    "path": str(path),
                    "kind": kind,
                    "voice": voice,
                    "speed": speed,
                    "snrDb": 10 if suffix else None,
                    "source": "locally synthesized with espeak-ng (six voice/speed profiles)",
                    "license": "self-created synthetic test sentences",
                }
            )
    manifest = settings.root / "synthetic-manifest.json"
    manifest.write_text(json.dumps(rows, indent=2), encoding="utf8")
    manifest.chmod(0o600)
    return manifest


# --------------------------------------------------------------------------- self-test (offline)

TEST_TOKEN = "test-token-not-secret"


class FakeRecord(BaseModel):
    path: str = ""
    headers: dict[str, str] = {}
    binary_frames: list[int] = []
    texts: list[Any] = []


def _query(path: str) -> dict[str, list[str]]:
    return urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)


async def fake_listen_v1(ws: ServerConnection, record: FakeRecord) -> None:
    def results(text: str, *, final: bool, from_finalize: bool = False) -> str:
        return json.dumps(
            {
                "type": "Results",
                "is_final": final,
                "speech_final": final,
                "from_finalize": from_finalize,
                "channel": {"alternatives": [{"transcript": text, "confidence": 0.9}]},
            }
        )

    async for message in ws:
        if isinstance(message, bytes):
            record.binary_frames.append(len(message))
            if len(record.binary_frames) == 2:
                await ws.send(results("do you", final=False))
            if len(record.binary_frames) == 3:
                await ws.send(results("do you want", final=True))
            continue
        event = json.loads(message)
        record.texts.append(event)
        if event.get("type") == "Finalize":
            await ws.send(results("music or a story", final=True, from_finalize=True))
        elif event.get("type") == "CloseStream":
            await ws.send(
                json.dumps({"type": "Metadata", "request_id": "x", "duration": 0.5})
            )
            return


async def fake_listen_flux(ws: ServerConnection, record: FakeRecord) -> None:
    await ws.send(
        json.dumps({"type": "Connected", "request_id": "x", "sequence_id": 0})
    )
    async for message in ws:
        if isinstance(message, bytes):
            record.binary_frames.append(len(message))
            if len(record.binary_frames) == 2:
                await ws.send(
                    json.dumps(
                        {
                            "type": "TurnInfo",
                            "event": "StartOfTurn",
                            "transcript": "not",
                        }
                    )
                )
            if len(record.binary_frames) == 3:
                await ws.send(
                    json.dumps(
                        {
                            "type": "TurnInfo",
                            "event": "Update",
                            "transcript": "not the red",
                        }
                    )
                )
            continue
        event = json.loads(message)
        record.texts.append(event)
        if event.get("type") == "ForceEndTurn":
            await ws.send(
                json.dumps(
                    {
                        "type": "TurnInfo",
                        "event": "EndOfTurn",
                        "trigger": "manual",
                        "transcript": "Not the red one, the blue one.",
                    }
                )
            )
        elif event.get("type") == "CloseStream":
            return


async def fake_streaming_turns(ws: ServerConnection, record: FakeRecord) -> None:
    await ws.send(json.dumps({"type": "Begin", "id": "x", "expires_at": 0}))

    def turn(text: str, *, end: bool, formatted: bool, order: int = 0) -> str:
        return json.dumps(
            {
                "type": "Turn",
                "turn_order": order,
                "end_of_turn": end,
                "turn_is_formatted": formatted,
                "transcript": text,
            }
        )

    async for message in ws:
        if isinstance(message, bytes):
            record.binary_frames.append(len(message))
            if len(record.binary_frames) == 2:
                await ws.send(turn("", end=False, formatted=False))
            if len(record.binary_frames) == 3:
                await ws.send(turn("is ellie coming", end=False, formatted=False))
            continue
        event = json.loads(message)
        record.texts.append(event)
        if event.get("type") == "ForceEndpoint":
            # The real service applies the endpoint before it has finished the
            # audio already queued, so the end of the question lands as a new turn.
            await ws.send(turn("is ellie coming to the", end=True, formatted=False))
            await ws.send(turn("Is Ellie coming to the", end=True, formatted=True))
            await ws.send(turn("party", end=False, formatted=False, order=1))
            await ws.send(turn("party?", end=True, formatted=True, order=1))
        elif event.get("type") == "Terminate":
            await ws.send(
                json.dumps({"type": "Termination", "audio_duration_seconds": 1})
            )
            return


async def fake_tokens_config_first(ws: ServerConnection, record: FakeRecord) -> None:
    final = ""
    async for message in ws:
        if isinstance(message, bytes):
            record.binary_frames.append(len(message))
            if len(record.binary_frames) == 2:
                await ws.send(
                    json.dumps({"tokens": [{"text": "App", "is_final": False}]})
                )
            if len(record.binary_frames) == 3:
                await ws.send(
                    json.dumps(
                        {
                            "tokens": [
                                {"text": "Apples", "is_final": True},
                                {"text": " or", "is_final": False},
                            ]
                        }
                    )
                )
                final = "Apples"
            continue
        if message == "":
            record.texts.append("")
            await ws.send(json.dumps({"tokens": [], "finished": True}))
            return
        event = json.loads(message)
        record.texts.append(event)
        if event.get("type") == "finalize":
            await ws.send(
                json.dumps(
                    {
                        "tokens": [
                            {"text": " or", "is_final": True},
                            {"text": " grapes?", "is_final": True},
                            {"text": "<fin>", "is_final": True},
                        ]
                    }
                )
            )
            assert final


async def fake_realtime_events(ws: ServerConnection, record: FakeRecord) -> None:
    appended = 0
    async for message in ws:
        event = json.loads(message)
        kind = event.get("type")
        if kind == "input_audio_buffer.append":
            appended += 1
            record.binary_frames.append(len(base64.b64decode(event["audio"])))
            if appended == 2:
                await ws.send(
                    json.dumps(
                        {
                            "type": "conversation.item.input_audio_transcription.delta",
                            "delta": "That was",
                        }
                    )
                )
            continue
        record.texts.append(event)
        if kind == "session.update":
            await ws.send(json.dumps({"type": "session.updated"}))
        elif kind == "input_audio_buffer.commit":
            await ws.send(
                json.dumps(
                    {
                        "type": "conversation.item.input_audio_transcription.delta",
                        "delta": " so funny",
                    }
                )
            )
            await ws.send(
                json.dumps(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "transcript": "That was so funny!",
                    }
                )
            )


async def fake_refuses(ws: ServerConnection, record: FakeRecord) -> None:
    await ws.close(code=4001, reason="unauthorized")


FakeHandler = Callable[[ServerConnection, FakeRecord], Awaitable[None]]


@contextlib.asynccontextmanager
async def fake_ws(handler: FakeHandler) -> Any:
    record = FakeRecord()

    async def entry(ws: ServerConnection) -> None:
        record.path = ws.request.path if ws.request else ""
        record.headers = dict(ws.request.headers.raw_items()) if ws.request else {}
        with contextlib.suppress(ConnectionClosed):
            await handler(ws, record)

    async with serve(entry, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        yield f"ws://127.0.0.1:{port}/stream", record


@contextlib.contextmanager
def fake_http(reply: str) -> Any:
    record = FakeRecord()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            record.path = self.path
            record.headers = dict(self.headers.items())
            record.texts.append(body)
            payload = json.dumps({"text": reply}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/transcribe", record
    finally:
        server.shutdown()
        server.server_close()


def tone_clip(
    directory: Path, clip_id: str, text: str, seconds: float = 0.5, **extra: Any
) -> tuple[Clip, bytes]:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    samples = (0.2 * np.sin(2 * math.pi * 220 * t)).astype(np.float32)
    path = directory / f"{clip_id}.wav"
    write_wav(path, samples)
    clip = Clip(id=clip_id, path=path, text=text, **extra)
    return clip, load_clip_pcm(clip)


def service(protocol: ProtocolName, url: str, **fields: Any) -> ResolvedService:
    config = ServiceConfig(
        id=f"fake-{protocol}",
        protocol=protocol,
        url=url,
        token_env="FAKE_TOKEN",
        **fields,
    )
    resolved = config.resolve({"FAKE_TOKEN": TEST_TOKEN})
    assert resolved is not None
    return resolved


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def expect_turn(
    result: ClipResult, final: str, *, partials: int = 1, ws: bool = True
) -> None:
    check(result.error is None, f"error: {result.error}")
    check(result.final_text == final, f"final {result.final_text!r} != {final!r}")
    check(result.partials >= partials, f"partials {result.partials} < {partials}")
    check(
        result.release_to_final_ms is not None and result.release_to_final_ms >= 0,
        "release to final",
    )
    settled = result.release_to_settled_ms
    check(
        settled is not None and settled <= result.release_to_final_ms,
        f"settled {settled} after final {result.release_to_final_ms}",
    )
    if ws:
        check(result.connect_ms is not None and result.connect_ms >= 0, "connect ms")
        check(
            result.socket_seconds is not None and result.socket_seconds > 0,
            "socket seconds",
        )
    if partials:
        check(
            result.release_to_first_partial_ms is not None, "release to first partial"
        )


def expect_frames(
    record: FakeRecord, pcm: bytes, frame_bytes: int = FRAME_BYTES
) -> None:
    expected = math.ceil(len(pcm) / FRAME_BYTES)
    check(
        len(record.binary_frames) == expected,
        f"frames {len(record.binary_frames)} != {expected}",
    )
    check(
        all(0 < n <= frame_bytes for n in record.binary_frames),
        f"frame sizes {record.binary_frames}",
    )


async def case_listen_v1(scratch: Path) -> None:
    clip, pcm = tone_clip(
        scratch, "v1", "Do you want music or a story?", mustContain=["music", "story"]
    )
    async with fake_ws(fake_listen_v1) as (url, record):
        svc = service(
            "ws-listen-query",
            url,
            model="m-test",
            keyterms=["Ellie", "ice cream"],
            query={"endpointing": 300, "smart_format": True},
            price=Price(usd_per_minute=0.6),
        )
        result = score(await run_clip(svc, clip, pcm), clip, svc.config.price)
    expect_turn(result, "do you want music or a story")
    q = _query(record.path)
    check(q["model"] == ["m-test"] and q["encoding"] == ["linear16"], f"query {q}")
    check(
        q["sample_rate"] == ["16000"] and q["interim_results"] == ["true"], f"query {q}"
    )
    check(q["endpointing"] == ["300"] and q["smart_format"] == ["true"], f"query {q}")
    check(q["keyterm"] == ["Ellie", "ice cream"], f"keyterm {q.get('keyterm')}")
    check(record.headers.get("Authorization") == "Token " + TEST_TOKEN, "auth header")
    check(
        [t["type"] for t in record.texts] == ["Finalize", "CloseStream"],
        f"control {record.texts}",
    )
    expect_frames(record, pcm)
    check(result.meaning_ok is True and result.word_errors == 0, "scored")
    check(
        abs(result.cost_usd - round(0.5 / 60 * 0.6, 6)) < 1e-9,
        f"audio cost {result.cost_usd}",
    )


async def case_listen_flux(scratch: Path) -> None:
    clip, pcm = tone_clip(
        scratch, "flux", "Not the red one, the blue one.", mustContain=["not the red"]
    )
    async with fake_ws(fake_listen_flux) as (url, record):
        svc = service(
            "ws-listen-query",
            url,
            variant="flux",
            model="flux-test",
            keyterms=["Ellie"],
            query={"eot_threshold": 0.8},
        )
        result = score(await run_clip(svc, clip, pcm), clip, svc.config.price)
    expect_turn(result, "Not the red one, the blue one.", partials=2)
    q = _query(record.path)
    check(q["model"] == ["flux-test"] and q["encoding"] == ["linear16"], f"query {q}")
    check("interim_results" not in q and q["eot_threshold"] == ["0.8"], f"query {q}")
    check(q["keyterm"] == ["Ellie"], f"keyterm {q}")
    check(
        [t["type"] for t in record.texts] == ["ForceEndTurn", "CloseStream"],
        f"control {record.texts}",
    )
    expect_frames(record, pcm)
    check(result.meaning_ok is True, "flux meaning")


async def case_streaming_turns(scratch: Path) -> None:
    clip, pcm = tone_clip(
        scratch, "turns", "Is Ellie coming to the party?", names=["Ellie"]
    )
    async with fake_ws(fake_streaming_turns) as (url, record):
        svc = service(
            "ws-streaming-turns",
            url,
            model="turns-test",
            keyterms=["Ellie", "ice cream"],
            price=Price(usd_per_minute=0.0025, basis="connection"),
        )
        result = score(await run_clip(svc, clip, pcm), clip, svc.config.price)
    expect_turn(result, "Is Ellie coming to the party?")
    q = _query(record.path)
    check(
        q["sample_rate"] == ["16000"] and q["encoding"] == ["pcm_s16le"], f"query {q}"
    )
    check(
        q["format_turns"] == ["true"] and q["speech_model"] == ["turns-test"],
        f"query {q}",
    )
    check(
        json.loads(q["keyterms_prompt"][0]) == ["Ellie", "ice cream"], f"keyterms {q}"
    )
    check(
        record.headers.get("Authorization") == TEST_TOKEN, "auth header has no prefix"
    )
    check(
        [t["type"] for t in record.texts] == ["ForceEndpoint", "Terminate"],
        f"control {record.texts}",
    )
    expect_frames(record, pcm)
    check(result.names_found == ["Ellie"], f"names {result.names_found}")
    expected_cost = round((result.socket_seconds or 0) / 60 * 0.0025, 6)
    check(abs(result.cost_usd - expected_cost) < 1e-9, "connection cost")


async def case_tokens_config_first(scratch: Path) -> None:
    clip, pcm = tone_clip(
        scratch, "tokens", "Apples or grapes?", mustContain=["apples", "grapes"]
    )
    async with fake_ws(fake_tokens_config_first) as (url, record):
        svc = service(
            "ws-tokens-config-first",
            url,
            model="tokens-test",
            keyterms=["Ellie"],
            session={"enable_endpoint_detection": True, "language_hints": ["en"]},
        )
        result = score(await run_clip(svc, clip, pcm), clip, svc.config.price)
    expect_turn(result, "Apples or grapes?", partials=2)
    first = record.texts[0]
    check(isinstance(first, dict), "config message first")
    check(
        first.get("model") == "tokens-test"
        and first.get("audio_format") == "pcm_s16le"
        and first.get("sample_rate") == SAMPLE_RATE
        and first.get("num_channels") == 1
        and first.get("enable_endpoint_detection") is True
        and first.get("context", {}).get("terms") == ["Ellie"],
        f"config {first}",
    )
    check("api_key" not in first, "key stays in the header by default")
    check(record.headers.get("Authorization") == "Bearer " + TEST_TOKEN, "auth header")
    check(record.texts[1:] == [{"type": "finalize"}, ""], f"control {record.texts[1:]}")
    expect_frames(record, pcm)
    check(result.meaning_ok is True, "either/or meaning")


async def case_tokens_key_in_config(scratch: Path) -> None:
    clip, pcm = tone_clip(scratch, "tokens2", "Apples or grapes?")
    async with fake_ws(fake_tokens_config_first) as (url, record):
        svc = service(
            "ws-tokens-config-first", url, model="tokens-test", auth_in_config=True
        )
        result = await run_clip(svc, clip, pcm)
    check(result.error is None, f"error {result.error}")
    check(record.texts[0].get("api_key") == TEST_TOKEN, "api_key in the config message")
    check(
        "Authorization" not in record.headers,
        "no header when the key rides in the config",
    )


async def case_realtime_events(scratch: Path) -> None:
    clip, pcm = tone_clip(scratch, "rt", "That was so funny!")
    async with fake_ws(fake_realtime_events) as (url, record):
        svc = service(
            "ws-realtime-events",
            url,
            model="rt-test",
            keyterms=["Ellie"],
            keyterms_field="keywords",
            session={"languages": ["en"]},
        )
        result = score(await run_clip(svc, clip, pcm), clip, svc.config.price)
    expect_turn(result, "That was so funny!")
    update = record.texts[0]
    settings = update["session"]["audio"]["input"]
    check(
        settings["format"] == {"type": "audio/pcm", "rate": 24000}, f"format {settings}"
    )
    check(
        settings["transcription"]
        == {"languages": ["en"], "keywords": ["Ellie"], "model": "rt-test"},
        f"{settings}",
    )
    check(settings["turn_detection"] is None, "no server turn detection")
    check(
        record.texts[-1] == {"type": "input_audio_buffer.commit"}, "commit at release"
    )
    check(record.headers.get("Authorization") == "Bearer " + TEST_TOKEN, "auth header")
    expect_frames(record, pcm, frame_bytes=FRAME_BYTES * 3 // 2)
    check(result.word_errors == 0, "wer")


async def case_multipart(scratch: Path) -> None:
    clip, pcm = tone_clip(scratch, "mp", "Good job, you did it.")
    with fake_http("Good job, you did it.") as (url, record):
        svc = service(
            "http-multipart-final",
            url,
            model="mp-test",
            fields={"language": "en"},
            keyterms=["Ellie"],
            keyterms_field="prompt",
        )
        result = score(await run_clip(svc, clip, pcm), clip, svc.config.price)
    expect_turn(result, "Good job, you did it.", partials=0, ws=False)
    body = record.texts[0]
    check(
        b'name="model"\r\n\r\nmp-test' in body and b'name="language"\r\n\r\nen' in body,
        "fields",
    )
    check(b'name="prompt"' in body and b"Ellie" in body, "keyterm prompt")
    check(b"RIFF" in body and len(pcm) <= len(body), "wav upload")
    check(record.headers.get("Authorization") == "Bearer " + TEST_TOKEN, "auth header")
    check(
        result.connect_ms is None and result.socket_seconds is None,
        "no socket for one-shot",
    )


async def case_refused(scratch: Path) -> None:
    clip, pcm = tone_clip(scratch, "refused", "hello")
    async with fake_ws(fake_refuses) as (url, _record):
        svc = service("ws-streaming-turns", url, timeout_seconds=3, connect_retries=0)
        result = await run_clip(svc, clip, pcm)
    check(
        result.error is not None and "4001" in result.error,
        f"refusal recorded: {result.error}",
    )
    check(
        result.final_text is None and result.release_to_final_ms is None,
        "no final on refusal",
    )


async def case_scoring(scratch: Path) -> None:
    check(
        normalize("Don't you WANT it? I can't, won't")
        == "do not you want it? i can not, will not",
        "normalize",
    )
    clip = Clip(
        id="n",
        path=scratch / "n.wav",
        text="Don't you want to go outside?",
        mustContain=["not"],
    )
    row = ClipResult(
        config="c",
        protocol="p",
        clip="n",
        kind="synthetic",
        audio_seconds=60,
        final_text="Do not you want to go outside",
    )
    scored = score(row, clip, Price(usd_per_minute=0.01))
    check(
        scored.word_errors == 0
        and scored.meaning_ok is True
        and scored.cost_usd == 0.01,
        f"{scored}",
    )
    flipped = score(
        row.model_copy(update={"final_text": "Do you want to go outside"}),
        clip,
        Price(),
    )
    check(flipped.meaning_ok is False and flipped.word_errors == 1, f"{flipped}")
    silent = Clip(id="s", path=scratch / "s.wav", text="", kind="nonspeech")
    heard = score(
        row.model_copy(update={"final_text": "thank you", "kind": "nonspeech"}),
        silent,
        Price(),
    )
    check(
        heard.nonspeech_hallucinated is True and heard.reference_words == 0, "nonspeech"
    )
    named = fill_names(
        [Clip(id="x", path=scratch / "x.wav", text="Is Ellie here?")], ["Ellie", "Sam"]
    )
    check(named[0].names == ["Ellie"], f"names {named[0].names}")
    summary = summarize([scored, flipped, heard])
    check(
        summary["meaning"] == {"passed": 1, "total": 2}
        and summary["wer"] == round(1 / 14, 4),
        f"{summary}",
    )
    config = ServiceConfig(
        id="c", protocol="ws-listen-query", url="ws://x", token_env="T"
    )
    out = write_report(
        scratch / "report",
        [scored, flipped, heard],
        [config],
        {"later": "token missing"},
        [clip],
    )
    report = (scratch / "report/report.md").read_text()
    check(
        "| c | ws-listen-query | 3 |" in report and "later: token missing" in report,
        report,
    )
    check(out["configs"]["c"]["byKind"]["synthetic"]["clips"] == 2, "by kind")
    check(config.resolve({}) is None, "missing token skips")
    sentences = synthetic_sentences(["Ellie"])
    counts = {
        c: sum(s.category == c for s in sentences)
        for c in ("name", "negation", "either_or", "remark")
    }
    check(
        counts == {"name": 8, "negation": 8, "either_or": 8, "remark": 6}, f"{counts}"
    )
    check(
        all(s.names == ["Ellie"] for s in sentences if s.category == "name"),
        "names from lexicon",
    )
    noisy = add_noise(np.ones(16000, dtype=np.float32) * 0.1, 10, 1) - 0.1
    ratio = 20 * math.log10(0.1 / float(np.sqrt(np.mean(noisy * noisy))))
    check(abs(ratio - 10) < 0.5, f"snr {ratio}")


async def case_recorded_set_shape(scratch: Path) -> None:
    """The recorded-voice manifest shape and a keyterms object both load."""
    rows = [
        {
            "id": "a",
            "path": "a.wav",
            "text": "Is Sam here?",
            "kind": "name_question",
            "expected_names": ["Sam"],
            "alternatives": None,
            "negation": False,
        },
        {
            "id": "b",
            "path": "b.wav",
            "text": "Don't you want it?",
            "kind": "negation",
            "expected_names": [],
            "alternatives": None,
            "negation": True,
        },
        {
            "id": "c",
            "path": "c.wav",
            "text": "You sure you're done?",
            "kind": "negation",
            "expected_names": [],
            "alternatives": None,
            "negation": True,
        },
        {
            "id": "d",
            "path": "d.wav",
            "text": "Juice or water?",
            "kind": "either_or",
            "expected_names": [],
            "alternatives": ["Juice", "water"],
            "negation": False,
        },
    ]
    a, b, c, d = (Clip.model_validate(r) for r in rows)
    check(a.names == ["Sam"] and a.category == "name_question", f"names {a}")
    check(b.mustContain == ["not"], f"negation check {b.mustContain}")
    check(
        c.mustContain == [], "a negation reference with no negative word is not checked"
    )
    check(d.mustContain == ["Juice", "water"] and d.category == "either_or", f"{d}")
    terms = scratch / "terms.json"
    terms.write_text(json.dumps({"keyterms": ["Sam", "Sam", "Nora"]}))
    config = ServiceConfig(
        protocol="ws-listen-query",
        url="ws://x",
        token_env="T",
        keyterms_file=str(terms),
    )
    check(config.load_keyterms() == ["Sam", "Nora"], f"{config.load_keyterms()}")
    swapped = override_keyterms(
        config.model_copy(update={"keyterms": ["X"]}), None, "-nk"
    )
    check(swapped.keyterms == [] and swapped.keyterms_file is None, "no keyterms")
    check(swapped.id.endswith("-nk"), f"label {swapped.id}")
    rows_out = [
        ClipResult(
            config="s",
            protocol="p",
            clip=x.id,
            kind=x.kind,
            category=x.category,
            audio_seconds=1,
            release_to_final_ms=100.0,
            final_text=x.text,
        )
        for x in (a, b, d)
    ]
    scored = [score(r, x, Price()) for r, x in zip(rows_out, (a, b, d), strict=True)]
    config_s = ServiceConfig(
        id="s", protocol="ws-listen-query", url="ws://x", token_env="T"
    )
    write_report(scratch / "kinds", scored, [config_s], {}, [a, b, d])
    report = (scratch / "kinds/report.md").read_text()
    check(
        "## By kind" in report and "| s | name_question | 1 | 1/1 |" in report, report
    )
    check("## WER per clip" in report and "| a | 0/3 |" in report, report)


async def case_shared_token_and_retry(scratch: Path) -> None:
    """Settings on one token never overlap; a refusal before audio is retried."""
    clip, _pcm = tone_clip(scratch, "share", "Is Ellie coming to the party?")
    state = {"open": 0, "peak": 0, "refused": 0}

    async def counting(ws: ServerConnection, record: FakeRecord) -> None:
        if state["refused"] == 0:
            state["refused"] += 1
            await ws.send(json.dumps({"type": "Error", "error": "Too many sessions"}))
            await ws.close(code=1008, reason="too many")
            return
        state["open"] += 1
        state["peak"] = max(state["peak"], state["open"])
        try:
            await fake_streaming_turns(ws, record)
        finally:
            state["open"] -= 1

    async with fake_ws(counting) as (url, _record):
        one = service("ws-streaming-turns", url, model="a", connect_retries=1)
        two = service("ws-streaming-turns", url, model="b", connect_retries=1)
        two = two.model_copy(
            update={"config": two.config.model_copy(update={"id": "two"})}
        )
        rows = await run_bakeoff([one, two], [clip])
    check(all(r.error is None for r in rows), f"{[r.error for r in rows]}")
    check(state["refused"] == 1 and state["peak"] == 1, f"{state}")


SELF_TESTS: list[Callable[[Path], Awaitable[None]]] = [
    case_shared_token_and_retry,
    case_scoring,
    case_recorded_set_shape,
    case_multipart,
    case_realtime_events,
    case_listen_v1,
    case_listen_flux,
    case_streaming_turns,
    case_tokens_config_first,
    case_tokens_key_in_config,
    case_refused,
]


async def self_test() -> int:
    print("self-test: start", flush=True)
    failures = 0
    with tempfile.TemporaryDirectory(prefix="era-bakeoff-selftest-") as scratch:
        for case in SELF_TESTS:
            started = now()
            try:
                await asyncio.wait_for(case(Path(scratch)), 30)
                print(f"ok - {case.__name__} ({now() - started:.2f} s)", flush=True)
            except Exception as exc:  # noqa: BLE001 - report every case
                failures += 1
                print(
                    f"not ok - {case.__name__}: {type(exc).__name__}: {exc}", flush=True
                )
    print(
        f"self-test: {len(SELF_TESTS) - failures} passed, {failures} failed", flush=True
    )
    return 1 if failures else 0


# --------------------------------------------------------------------------- cli

app = typer.Typer(add_completion=False)


@app.command()
def main(
    configs: Annotated[
        str,
        typer.Option(help="'all' (enabled settings) or comma-separated setting ids"),
    ] = "all",
    manifest: Annotated[
        list[Path] | None,
        typer.Option(help="clip manifest(s); default: base + synthetic"),
    ] = None,
    clips: Annotated[
        str, typer.Option(help="comma-separated clip ids to keep (default: every clip)")
    ] = "",
    sequential: Annotated[
        bool, typer.Option(help="one setting at a time instead of all at once")
    ] = False,
    out_dir: Annotated[
        Path | None, typer.Option(help="default <cache>/bakeoff/<timestamp>")
    ] = None,
    list_configs: Annotated[
        bool, typer.Option("--list", help="show settings and whether each can run")
    ] = False,
    synthetic: Annotated[
        bool,
        typer.Option(
            "--add-synthetic", help="generate the synthetic clip set and exit"
        ),
    ] = False,
    keyterms_file: Annotated[
        Path | None,
        typer.Option(help="replace every setting's keyterms with this file's"),
    ] = None,
    no_keyterms: Annotated[
        bool, typer.Option("--no-keyterms", help="run every setting without keyterms")
    ] = False,
    label: Annotated[
        str, typer.Option(help="suffix for setting ids in this run, e.g. -nokeyterms")
    ] = "",
    run_self_test: Annotated[
        bool, typer.Option("--self-test", help="offline protocol tests and exit")
    ] = False,
) -> None:
    """Play every clip in real time to each setting and write report.md + results.json."""
    if run_self_test:
        raise typer.Exit(asyncio.run(self_test()))
    settings = BakeoffSettings()
    if synthetic:
        path = add_synthetic(settings)
        typer.echo(f"wrote {len(json.loads(path.read_text()))} clips; manifest {path}")
        return
    env = load_env(settings.env_files)
    available = load_configs(settings.configs)
    if list_configs:
        for config in available:
            state = (
                "ready" if config.resolve(env) else f"waiting for {config.token_env}"
            )
            typer.echo(
                f"{config.id:28} {config.protocol:24} {'enabled' if config.enabled else 'disabled':9} {state}"
            )
        return
    chosen = select_configs(available, configs)
    if keyterms_file or no_keyterms:
        source = None if no_keyterms else keyterms_file
        chosen = [override_keyterms(c, source, label) for c in chosen]
    elif label:
        chosen = [c.model_copy(update={"id": c.id + label}) for c in chosen]
    services: list[ResolvedService] = []
    skipped: dict[str, str] = {}
    for config in chosen:
        resolved = config.resolve(env)
        if resolved is None:
            skipped[config.id] = f"token or endpoint missing ({config.token_env})"
        else:
            services.append(resolved)
    clip_rows = fill_names(
        load_manifests(manifest or settings.default_manifests()),
        lexicon_proper_nouns(settings.lexicon),
    )
    if clips:
        keep = {c.strip() for c in clips.split(",")}
        clip_rows = [c for c in clip_rows if c.id in keep]
    if not services:
        typer.echo("no runnable settings: " + json.dumps(skipped))
        raise typer.Exit(2)
    typer.echo(
        f"{len(clip_rows)} clips x {len(services)} settings; skipped: {', '.join(skipped) or 'none'}"
    )

    def progress(row: ClipResult) -> None:
        state = (
            row.error
            or f"final {row.release_to_final_ms} ms, {row.word_errors}/{row.reference_words} errs"
        )
        typer.echo(f"  {row.config:24} {row.clip:22} {state}")

    rows = asyncio.run(
        run_bakeoff(services, clip_rows, sequential=sequential, progress=progress)
    )
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = out_dir or settings.root / stamp
    write_report(target, rows, chosen, skipped, clip_rows)
    typer.echo((target / "report.md").read_text())
    typer.echo(f"wrote {target}/report.md and results.json")


if __name__ == "__main__":
    app()
