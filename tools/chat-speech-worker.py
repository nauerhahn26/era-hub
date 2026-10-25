#!/usr/bin/env python3
"""Local, one-turn speech worker. JSONL only; never persist captured audio.

Models and the optional final decoder factory are configured outside the checkout
through ERA_CHAT_SPEECH_CONFIG. Audio is mono 16 kHz signed little-endian PCM.
"""
import array
import base64
import collections
import importlib
import io
import json
import os
import sys
import threading
import time
import urllib.request
import uuid
import wave

SAMPLE_RATE = 16000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class RemoteFinal:
    """Optional multipart final decoder; credentials and endpoint stay external."""

    def __init__(self, config):
        self.config = config

    def transcribe(self, samples):
        config = self.config
        pcm = array.array("h", (max(-32768, min(32767, int(x * 32768))) for x in samples))
        if sys.byteorder != "little":
            pcm.byteswap()
        audio = io.BytesIO()
        with wave.open(audio, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            output.writeframes(pcm.tobytes())
        boundary = uuid.uuid4().hex
        fields = {**config.get("fields", {}), "model": os.environ[config["model_env"]]}
        body = bytearray()
        for name, value in fields.items():
            body.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
                         f'{value}\r\n').encode())
        body.extend((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                     'filename="question.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode())
        body.extend(audio.getvalue())
        body.extend(f'\r\n--{boundary}--\r\n'.encode())
        request = urllib.request.Request(os.environ[config["url_env"]], data=bytes(body), headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            config.get("auth_header", "Authorization"):
                config.get("auth_prefix", "Bearer ") + os.environ[config["token_env"]],
        })
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(request, timeout=config.get("timeout_seconds", 20)) as response:
            value = json.loads(response.read(1000000))
        text = value.get(config.get("text_field", "text"))
        if not isinstance(text, str):
            raise ValueError("Invalid transcription response")
        return text.strip()


class RemoteStream:
    """One explicitly activated network transcription turn; never auto-rearm."""

    def __init__(self, config):
        self.config = config
        connector = importlib.import_module("websocket")
        self.socket = connector.create_connection(os.environ[config["url_env"]], timeout=10, redirect_limit=0,
            header={config.get("auth_header", "Authorization"):
                    config.get("auth_prefix", "Bearer ") + os.environ[config["token_env"]]})
        self.text = ""
        self.result = ""
        self.failed = False
        self.closed = False
        self.done = threading.Event()
        self.send_guard = threading.Lock()
        settings = {**config.get("transcription", {}), "model": os.environ[config["model_env"]]}
        try:
            self._send({"type": "session.update", "session": {"type": "transcription", "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": 24000},
                          "transcription": settings, "turn_detection": None}}}})
            while True:
                event = json.loads(self.socket.recv())
                if event.get("type") in ("session.updated", "transcription_session.updated"):
                    break
                if event.get("type") == "error":
                    raise ValueError("Session configuration failed")
        except Exception:
            self.close()
            raise
        self.reader = threading.Thread(target=self._receive, daemon=True)
        self.reader.start()

    def _send(self, event):
        with self.send_guard:
            self.socket.send(json.dumps(event))

    def _receive(self):
        try:
            while not self.closed:
                raw = self.socket.recv()
                if not raw:
                    break
                event = json.loads(raw)
                kind = event.get("type", "")
                if kind.endswith("input_audio_transcription.delta"):
                    self.text += event.get("delta", "")
                elif kind.endswith("input_audio_transcription.completed"):
                    self.result = event.get("transcript", "")
                    self.done.set()
                    return
                elif kind == "error" or kind.endswith("input_audio_transcription.failed"):
                    self.failed = True
                    self.done.set()
                    return
        except Exception:
            self.failed = True
        self.done.set()

    def feed_pcm(self, pcm):
        if self.closed or self.failed:
            raise ValueError("Transcription stream closed")
        self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()})

    def finish(self):
        try:
            self._send({"type": "input_audio_buffer.commit"})
            if not self.done.wait(self.config.get("timeout_seconds", 20)) or self.failed:
                raise ValueError("Transcription did not complete")
            return self.result.strip()
        finally:
            self.close()

    def close(self):
        self.closed = True
        self.failed = True
        self.done.set()
        self.socket.close(timeout=0)


class LocalRuntime:
    """Streaming keyword/recognition with an optional higher-quality final pass."""

    def __init__(self, config):
        import numpy as np
        import sherpa_onnx
        self.np = np
        self.stream_config = config.get("cloud_stream")
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(**config["streaming"])
        self.spotter = sherpa_onnx.KeywordSpotter(**config["keyword"])
        activity = sherpa_onnx.VadModelConfig()
        activity.silero_vad.model = config["activity_model"]
        activity.silero_vad.min_silence_duration = .15
        activity.silero_vad.min_speech_duration = .1
        activity.sample_rate = SAMPLE_RATE
        activity.num_threads = 1
        self.vad = sherpa_onnx.VoiceActivityDetector(activity, buffer_size_in_seconds=30)
        self.reference = None
        self.remote = RemoteFinal(config["cloud_reference"]) if config.get("cloud_reference") else None
        self.reference_decode = {}
        ref = config.get("reference")
        if ref and self.remote is None and not self.stream_config:
            module, factory = os.environ[ref["factory_env"]].split(":", 1)
            constructor = getattr(importlib.import_module(module), factory)
            self.reference = constructor(os.environ[ref["model_env"]], **ref.get("kwargs", {}))
            self.reference_decode = ref.get("decode", {})
        self.final_lock = threading.Lock()
        self.reset_keyword()
        self.reset_vad()

    def reset_keyword(self):
        self.keyword_stream = self.spotter.create_stream()

    def keyword(self, samples):
        self.keyword_stream.accept_waveform(SAMPLE_RATE, self.np.asarray(samples, dtype="float32"))
        while self.spotter.is_ready(self.keyword_stream):
            self.spotter.decode_stream(self.keyword_stream)
        return bool(self.spotter.get_result(self.keyword_stream))

    def reset_vad(self):
        self.vad.reset()
        self.vad_pending = []

    def voiced(self, samples):
        self.vad_pending.extend(samples)
        voiced = False
        while len(self.vad_pending) >= 512:
            frame, self.vad_pending = self.vad_pending[:512], self.vad_pending[512:]
            self.vad.accept_waveform(self.np.asarray(frame, dtype="float32"))
            voiced = self.vad.is_speech_detected() or voiced
            while not self.vad.empty():
                self.vad.pop()
        return voiced

    def new_stream(self):
        return {"local": self.recognizer.create_stream(),
                "remote": RemoteStream(self.stream_config) if self.stream_config else None}

    def close_stream(self, stream):
        if stream and stream.get("remote"):
            try:
                stream["remote"].close()
            except Exception:
                pass

    def feed(self, stream, samples):
        if stream["remote"]:
            from scipy.signal import resample_poly
            converted = resample_poly(self.np.asarray(samples, dtype="float32"), 3, 2)
            pcm = self.np.clip(converted * 32768, -32768, 32767).astype("<i2").tobytes()
            stream["remote"].feed_pcm(pcm)
        else:
            stream["local"].accept_waveform(SAMPLE_RATE, self.np.asarray(samples, dtype="float32"))
            while self.recognizer.is_ready(stream["local"]):
                self.recognizer.decode_stream(stream["local"])

    def partial(self, stream):
        if stream["remote"]:
            return stream["remote"].text.strip()
        return self.recognizer.get_result(stream["local"]).strip()

    def final(self, stream, samples):
        if stream["remote"]:
            return stream["remote"].finish()
        if self.remote is not None:
            return self.remote.transcribe(samples)
        if self.reference is not None:
            with self.final_lock:
                segments, _ = self.reference.transcribe(
                    self.np.asarray(samples, dtype="float32"), **self.reference_decode)
                return " ".join(segment.text.strip() for segment in segments).strip()
        stream["local"].accept_waveform(SAMPLE_RATE, self.np.zeros(int(.4 * SAMPLE_RATE), dtype="float32"))
        stream["local"].input_finished()
        while self.recognizer.is_ready(stream["local"]):
            self.recognizer.decode_stream(stream["local"])
        return self.partial(stream)


class Worker:
    def __init__(self, runtime, emit, config=None):
        config = config or {}
        self.runtime = runtime
        self.emit = emit
        self.generation = 0
        self.epoch = 0
        self.armed = False
        self.capturing = False
        self.preroll = collections.deque(maxlen=int(SAMPLE_RATE * config.get("preroll_seconds", 1)))
        self.silence_seconds = config.get("silence_seconds", .9)
        self.max_seconds = config.get("max_seconds", 20)
        self.no_speech_seconds = config.get("no_speech_seconds", 5)
        self.closed = False
        self.final_guard = threading.Lock()
        self.final_thread = None
        self.pending_final = None
        self.pending_stream = None
        self.finalizing_stream = None
        self._clear_capture()

    def _clear_capture(self):
        self.samples = []
        self.stream = None
        self.saw_speech = False
        self.silence_samples = 0
        self.last_partial = ""
        self.first_partial_ms = None
        self.started = None

    def _event(self, kind, **fields):
        self.emit({"type": kind, "generation": self.generation, **fields})

    def _abort(self):
        with self.final_guard:
            streams = (self.stream, self.pending_stream, self.finalizing_stream)
            self.pending_final = None
            self.pending_stream = None
        if hasattr(self.runtime, "close_stream"):
            for stream in streams:
                self.runtime.close_stream(stream)
        self.epoch += 1
        self.armed = self.capturing = False
        self.preroll.clear()
        self._clear_capture()
        self.runtime.reset_keyword()
        self.runtime.reset_vad()

    def _begin(self):
        self.epoch += 1
        self.armed = False
        self.capturing = True
        self._clear_capture()
        try:
            self.runtime.reset_vad()
            self.stream = self.runtime.new_stream()
        except Exception:
            self._abort()
            self._event("error", message="capture_start_failed")
            return False
        self.started = time.perf_counter()
        return True

    def _audio(self, message):
        if not (self.armed or self.capturing):
            return
        try:
            encoded = message["pcm"]
            if not isinstance(encoded, str) or len(encoded) > 90000:
                raise ValueError()
            raw = base64.b64decode(encoded, validate=True)
            if not raw or len(raw) % 2 or len(raw) > SAMPLE_RATE * 4:
                raise ValueError()
            pcm = array.array("h")
            pcm.frombytes(raw)
            if sys.byteorder != "little":
                pcm.byteswap()
            samples = [x / 32768 for x in pcm]
        except (KeyError, ValueError, TypeError):
            self._event("error", message="invalid_audio")
            return
        if self.armed:
            self.preroll.extend(samples)
            if not self.runtime.keyword(samples):
                return
            buffered = list(self.preroll)
            self.preroll.clear()
            self._event("wake")
            if not self._begin():
                return
            samples = buffered
        self.samples.extend(samples)
        if self.runtime.voiced(samples):
            self.saw_speech = True
            self.silence_samples = 0
        else:
            self.silence_samples += len(samples)
        self.runtime.feed(self.stream, samples)
        text = self.runtime.partial(self.stream)
        if text and text != self.last_partial:
            self.last_partial = text
            if self.first_partial_ms is None:
                self.first_partial_ms = (time.perf_counter() - self.started) * 1000
            self._event("partial", text=text)
        if len(self.samples) >= self.max_seconds * SAMPLE_RATE:
            self._abort()
            self._event("error", message="capture_limit")
        elif not self.saw_speech and len(self.samples) >= self.no_speech_seconds * SAMPLE_RATE:
            self._finish()
        elif self.saw_speech and self.silence_samples >= self.silence_seconds * SAMPLE_RATE:
            self._finish()

    def _finish(self):
        if not self.capturing:
            return
        self.capturing = False
        samples, stream = self.samples, self.stream
        generation, epoch = self.generation, self.epoch
        started, partial_ms = self.started, self.first_partial_ms
        capture_ms = (time.perf_counter() - started) * 1000
        self.samples, self.stream = [], None
        if not self.saw_speech:
            if hasattr(self.runtime, "close_stream"):
                self.runtime.close_stream(stream)
            self._event("error", message="no_speech")
            return

        def finish():
            before = time.perf_counter()
            try:
                text = self.runtime.final(stream, samples).strip()
                if self.closed or generation != self.generation or epoch != self.epoch:
                    return
                if not text:
                    self.emit({"type": "error", "message": "no_transcript", "generation": generation})
                    return
                self.emit({"type": "final", "generation": generation, "text": text, "timings": {
                    "audioMs": round(len(samples) / SAMPLE_RATE * 1000, 2),
                    "captureWallMs": round(capture_ms, 2),
                    "firstPartialMs": None if partial_ms is None else round(partial_ms, 2),
                    "finalDecodeMs": round((time.perf_counter() - before) * 1000, 2),
                    "turnMs": round((time.perf_counter() - started) * 1000, 2),
                }})
            except Exception:
                if generation == self.generation and epoch == self.epoch and not self.closed:
                    self.emit({"type": "error", "message": "decode_failed", "generation": generation})
        with self.final_guard:
            self.pending_final = (generation, epoch, finish)
            self.pending_stream = stream
            if self.final_thread is None:
                self.final_thread = threading.Thread(target=self._drain_finals, daemon=True)
                self.final_thread.start()

    @property
    def pending_final_count(self):
        with self.final_guard:
            return int(self.pending_final is not None)

    def _drain_finals(self):
        while True:
            with self.final_guard:
                job, self.pending_final = self.pending_final, None
                self.finalizing_stream, self.pending_stream = self.pending_stream, None
                if job is None:
                    self.final_thread = None
                    return
            generation, epoch, finish = job
            if not self.closed and generation == self.generation and epoch == self.epoch:
                finish()
            with self.final_guard:
                self.finalizing_stream = None

    def wait_final(self, seconds):
        with self.final_guard:
            thread = self.final_thread
        if thread is not None:
            thread.join(seconds)

    def handle(self, message):
        if not isinstance(message, dict):
            self._event("error", message="invalid_command")
            return
        kind = message.get("type")
        generation = message.get("generation", self.generation)
        if not isinstance(generation, int) or isinstance(generation, bool) or generation < self.generation:
            return
        if generation > self.generation:
            self._abort()
            self.generation = generation
        if kind == "close":
            self.closed = True
            self._abort()
        elif kind in ("cancel", "pause"):
            self._abort()
        elif kind == "arm":
            self._abort()
            self.armed = message.get("enabled") is True
        elif kind == "ask":
            self._abort()
            self._begin()
        elif kind == "audio":
            self._audio(message)
        elif kind == "finish":
            self._finish()
        else:
            self._event("error", message="invalid_command")


def main():
    lock = threading.Lock()

    def emit(event):
        with lock:
            print(json.dumps(event, separators=(",", ":")), flush=True)

    try:
        started = time.perf_counter()
        with open(os.environ["ERA_CHAT_SPEECH_CONFIG"], encoding="utf8") as source:
            config = json.load(source)
        runtime = LocalRuntime(config)
        worker = Worker(runtime, emit, config)
        emit({"type": "ready", "sampleRate": SAMPLE_RATE,
              "capabilities": {"wake": True, "partial": True, "automaticEndpoint": True,
                               "referenceFinal": runtime.reference is not None or runtime.remote is not None or bool(runtime.stream_config),
                               "remoteFinal": runtime.remote is not None or bool(runtime.stream_config),
                               "remoteStreaming": bool(runtime.stream_config)},
              "initializationMs": round((time.perf_counter() - started) * 1000, 2)})
    except Exception:
        emit({"type": "error", "generation": 0, "message": "runtime_unavailable"})
        return 1
    for line in sys.stdin:
        try:
            if len(line) > 100000:
                raise ValueError()
            message = json.loads(line)
            worker.handle(message)
            if worker.closed:
                break
        except Exception:
            worker._abort()
            worker._event("error", message="invalid_command")
    worker.closed = True
    worker._abort()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
