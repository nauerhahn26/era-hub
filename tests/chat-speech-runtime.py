"""Protocol and cancellation checks; deterministic doubles are not ASR benchmarks."""
import array
import base64
import importlib.util
import http.server
import io
import pathlib
import queue
import os
import subprocess
import sys
import threading
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("speech_worker", ROOT / "tools/chat-speech-worker.py")


class RuntimeDouble:
    def __init__(self):
        self.received = []
        self.release = threading.Event()
        self.block = False
        self.entered = threading.Event()

    def keyword(self, samples):
        return any(x > .8 for x in samples)

    def reset_keyword(self):
        pass

    def reset_vad(self):
        pass

    def voiced(self, samples):
        return any(abs(x) > .1 for x in samples)

    def new_stream(self):
        return []

    def feed(self, stream, samples):
        stream.extend(samples)

    def partial(self, stream):
        return "a question" if any(abs(x) > .1 for x in stream) else ""

    def final(self, stream, samples):
        self.received.append(list(samples))
        self.entered.set()
        if self.block:
            self.release.wait(2)
        return "a question"


def audio(value, seconds=.1):
    return base64.b64encode(array.array("h", [int(value * 32767)] * int(16000 * seconds))).decode()


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(cls.module)

    def setUp(self):
        self.runtime = RuntimeDouble()
        self.output = []
        self.worker = self.module.Worker(self.runtime, self.output.append,
                                         {"silence_seconds": .2, "max_seconds": 2})

    def send(self, kind, generation=1, **kw):
        self.worker.handle({"type": kind, "generation": generation, **kw})

    def finish(self):
        self.send("finish")
        self.worker.wait_final(3)

    def test_audio_ignored_until_explicit_activation(self):
        self.send("audio", pcm=audio(.3))
        self.finish()
        self.assertFalse(self.runtime.received)
        self.assertFalse(any(e["type"] == "final" for e in self.output))

    def test_ask_partials_and_final_are_generation_scoped(self):
        self.send("ask")
        self.send("audio", pcm=audio(.3))
        self.finish()
        self.assertEqual([e["type"] for e in self.output], ["partial", "final"])
        self.assertTrue(all(e["generation"] == 1 for e in self.output))
        self.assertGreater(self.output[-1]["timings"]["audioMs"], 0)

    def test_wake_preserves_audio_from_before_detection(self):
        self.send("arm", enabled=True)
        self.send("audio", pcm=audio(.2))
        self.send("audio", pcm=audio(.9))
        self.send("audio", pcm=audio(.4))
        self.finish()
        self.assertEqual(self.output[0]["type"], "wake")
        self.assertEqual(len(self.runtime.received[0]), 4800)
        self.assertAlmostEqual(self.runtime.received[0][0], .2, places=3)

    def test_silence_never_invents_a_transcript(self):
        self.send("ask")
        self.send("audio", pcm=audio(0))
        self.finish()
        self.assertEqual(self.output[-1]["type"], "error")
        self.assertEqual(self.output[-1]["message"], "no_speech")
        self.assertFalse(self.runtime.received)

    def test_auto_endpoint_does_not_rearm_or_record_next_turn(self):
        self.send("ask")
        self.send("audio", pcm=audio(.3))
        self.send("audio", pcm=audio(0, .3))
        self.worker.wait_final(3)
        self.send("audio", pcm=audio(.9))
        self.assertEqual(sum(e["type"] == "final" for e in self.output), 1)
        self.assertEqual(len(self.runtime.received), 1)

    def test_cancel_during_slow_final_drops_late_output(self):
        self.runtime.block = True
        self.send("ask")
        self.send("audio", pcm=audio(.3))
        self.send("finish")
        self.send("cancel", generation=2)
        self.runtime.release.set()
        self.worker.wait_final(3)
        self.assertFalse(any(e["type"] == "final" for e in self.output))

    def test_stale_audio_and_stale_controls_cannot_replace_turn(self):
        self.send("ask", generation=3)
        self.send("audio", generation=2, pcm=audio(.3))
        self.send("cancel", generation=2)
        self.send("audio", generation=3, pcm=audio(.4))
        self.send("finish", generation=3)
        self.worker.wait_final(3)
        self.assertEqual(self.output[-1]["generation"], 3)
        self.assertEqual(len(self.runtime.received[0]), 1600)

    def test_pause_clears_buffer_and_disarms(self):
        self.send("arm", enabled=True)
        self.send("audio", pcm=audio(.2))
        self.send("pause", generation=2)
        self.send("audio", generation=2, pcm=audio(.9))
        self.assertFalse(self.output)
        self.assertEqual(len(self.worker.preroll), 0)

    def test_invalid_audio_error_is_sanitized(self):
        self.send("ask")
        self.send("audio", pcm="private invalid audio")
        self.assertEqual(self.output[-1]["message"], "invalid_audio")
        self.assertNotIn("private", str(self.output))

    def test_slow_decodes_keep_only_running_and_latest_job(self):
        self.runtime.block = True
        for generation in (1, 2, 3):
            self.send("ask", generation=generation)
            self.send("audio", generation=generation, pcm=audio(.3))
            self.send("finish", generation=generation)
            if generation == 1:
                self.assertTrue(self.runtime.entered.wait(1))
        self.assertLessEqual(self.worker.pending_final_count, 1)
        self.runtime.release.set()
        self.worker.wait_final(3)
        self.assertEqual(len(self.runtime.received), 2)
        self.assertEqual([e["generation"] for e in self.output if e["type"] == "final"], [3])

    def test_remote_final_sends_bounded_wav_and_configured_fields(self):
        environment = {"TEST_SPEECH_URL": "https://example.invalid/transcribe",
                       "TEST_SPEECH_TOKEN": "test-secret", "TEST_SPEECH_ENGINE": "configured-engine"}
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"text":"not today"}'
        config = {"url_env": "TEST_SPEECH_URL", "token_env": "TEST_SPEECH_TOKEN",
                  "model_env": "TEST_SPEECH_ENGINE", "timeout_seconds": 10}
        opener = mock.MagicMock()
        opener.open.return_value = response
        with mock.patch.dict(self.module.os.environ, environment), mock.patch.object(
                self.module.urllib.request, "build_opener", return_value=opener):
            decoder = self.module.RemoteFinal(config)
            self.assertEqual(decoder.transcribe([0.0] * 1600), "not today")
            sent = opener.open.call_args.args[0]
            self.assertIn(b'RIFF', sent.data)
            self.assertIn(b'configured-engine', sent.data)
            self.assertNotIn(b'test-secret', sent.data)
            self.assertEqual(opener.open.call_args.kwargs["timeout"], 10)

    def test_remote_stream_commits_one_turn_and_closes(self):
        import json
        socket = mock.MagicMock()
        incoming = queue.Queue()
        incoming.put(json.dumps({"type": "session.updated"}))
        socket.recv.side_effect = lambda: incoming.get(timeout=1)
        sent = []
        def send(raw):
            event = json.loads(raw)
            sent.append(event)
            if event["type"] == "input_audio_buffer.commit":
                incoming.put(json.dumps({"type": "conversation.item.input_audio_transcription.delta", "delta": "not "}))
                incoming.put(json.dumps({"type": "conversation.item.input_audio_transcription.completed", "transcript": "not today"}))
        socket.send.side_effect = send
        connector = mock.MagicMock()
        connector.create_connection.return_value = socket
        config = {"url_env": "TEST_URL", "token_env": "TEST_TOKEN", "model_env": "TEST_ENGINE"}
        with mock.patch.dict(self.module.os.environ, {"TEST_URL": "wss://example.invalid", "TEST_TOKEN": "secret", "TEST_ENGINE": "configured"}), mock.patch.object(
                self.module.importlib, "import_module", return_value=connector):
            stream = self.module.RemoteStream(config)
            stream.feed_pcm(bytes(4800))
            self.assertEqual(stream.finish(), "not today")
            self.assertEqual(sum(e["type"] == "input_audio_buffer.commit" for e in sent), 1)
            self.assertEqual(sent[1]["type"], "input_audio_buffer.append")
            self.assertEqual(connector.create_connection.call_args.kwargs["redirect_limit"], 0)
            socket.close.assert_called()

    def test_authenticated_redirect_is_refused_and_failure_sanitized(self):
        paths = []
        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/credential-target")
                self.end_headers()

            def do_GET(self):
                paths.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"text":"unexpected redirect"}')

            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("localhost", 0), Redirect)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = {"url_env": "TEST_URL", "token_env": "TEST_TOKEN", "model_env": "TEST_ENGINE"}
        env = {"TEST_URL": f"http://localhost:{server.server_address[1]}/redirect",
               "TEST_TOKEN": "private-credential", "TEST_ENGINE": "configured"}
        try:
            with mock.patch.dict(self.module.os.environ, env):
                decoder = self.module.RemoteFinal(config)
                self.runtime.final = lambda stream, samples: decoder.transcribe(samples)
                self.send("ask")
                self.send("audio", pcm=audio(.3))
                self.finish()
            self.assertEqual(paths, ["/redirect"])
            self.assertEqual(self.output[-1]["message"], "decode_failed")
            self.assertNotIn("credential", str(self.output))
            self.assertNotIn("redirect", str(self.output))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(1)

    def test_failed_capture_start_disarms_and_discards_audio(self):
        self.runtime.new_stream = mock.Mock(side_effect=RuntimeError("private endpoint secret"))
        self.send("ask")
        self.send("audio", pcm=audio(.3))
        self.send("finish")
        self.assertFalse(self.worker.capturing)
        self.assertFalse(self.worker.armed)
        self.assertIsNone(self.worker.stream)
        self.assertEqual(self.output, [{"type": "error", "generation": 1,
                                       "message": "capture_start_failed"}])

    def test_failed_live_setup_closes_open_socket(self):
        socket = mock.MagicMock()
        socket.send.side_effect = RuntimeError("private header detail")
        connector = mock.MagicMock()
        connector.create_connection.return_value = socket
        config = {"url_env": "TEST_URL", "token_env": "TEST_TOKEN", "model_env": "TEST_ENGINE"}
        with mock.patch.dict(self.module.os.environ, {"TEST_URL": "wss://example.invalid", "TEST_TOKEN": "secret", "TEST_ENGINE": "configured"}), mock.patch.object(
                self.module.importlib, "import_module", return_value=connector):
            with self.assertRaises(RuntimeError):
                self.module.RemoteStream(config)
        socket.close.assert_called()

    def test_startup_failure_has_generation_zero_and_no_path(self):
        import json
        result = subprocess.run([sys.executable, str(ROOT / "tools/chat-speech-worker.py")],
            input="", capture_output=True, text=True,
            env={**os.environ, "ERA_CHAT_SPEECH_CONFIG": "/unavailable/private-runtime-config"}, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"type": "error", "generation": 0,
                                                   "message": "runtime_unavailable"})


if __name__ == "__main__":
    unittest.main()
