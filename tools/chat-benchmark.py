#!/usr/bin/env python3
"""Replay externally supplied, attributed audio through the actual speech worker.

Example: python chat-benchmark.py --manifest /private/set.json --output /private/result.json
Use --paced for 100 ms wall-clock audio batches; unpaced results measure throughput.
The manifest is a JSON list with id,path,text,kind,source,license and optional
mode (ask/wake/negative_wake), mustContain, mustNotContain, autoEndpoint.
Detailed transcripts are written only to the explicitly requested output path.
"""
import argparse
import base64
import json
import math
import os
import pathlib
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave


def words(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower())


def word_errors(reference, hypothesis):
    ref, hyp = words(reference), words(hypothesis)
    previous = list(range(len(hyp) + 1))
    for i, token in enumerate(ref, 1):
        current = [i]
        for j, other in enumerate(hyp, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (token != other)))
        previous = current
    return previous[-1], len(ref)


def meaning_ok(row, text):
    normalized = " " + " ".join(words(text)) + " "
    has = lambda phrase: " " + " ".join(words(phrase)) + " " in normalized
    return all(has(p) for p in row.get("mustContain", [])) and not any(
        has(p) for p in row.get("mustNotContain", []))


def percentile(values, fraction):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    index = (len(values) - 1) * fraction
    low, high = math.floor(index), math.ceil(index)
    return round(values[low] + (values[high] - values[low]) * (index - low), 3)


def read_pcm(path):
    with wave.open(str(path), "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
            raise ValueError("Dataset audio must be mono 16 kHz 16-bit PCM WAV")
        return source.readframes(source.getnframes())


class Process:
    def __init__(self, config, interpreter):
        env = dict(os.environ, ERA_CHAT_SPEECH_CONFIG=str(config), PYTHONDONTWRITEBYTECODE="1")
        before = time.perf_counter()
        worker = pathlib.Path(__file__).with_name("chat-speech-worker.py")
        self.process = subprocess.Popen([interpreter, str(worker)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1, env=env)
        self.events = queue.Queue()
        def read():
            for line in self.process.stdout:
                try:
                    self.events.put((time.perf_counter(), json.loads(line)))
                except ValueError:
                    pass
        threading.Thread(target=read, daemon=True).start()
        _, event = self.events.get(timeout=90)
        if event.get("type") != "ready":
            self.close()
            raise RuntimeError("Speech runtime did not become ready")
        self.cold_ms = (time.perf_counter() - before) * 1000

    def send(self, kind, generation, **fields):
        self.process.stdin.write(json.dumps({"type": kind, "generation": generation, **fields}) + "\n")
        self.process.stdin.flush()

    def run(self, row, generation, paced=False):
        data = read_pcm(row["path"])
        mode = row.get("mode", "ask")
        while not self.events.empty():
            self.events.get_nowait()
        if mode == "ask":
            self.send("ask", generation, endpoint="automatic" if row.get("autoEndpoint") else "release")
        else:
            self.send("arm", generation, enabled=True)
        started = time.perf_counter()
        audio_end = started + len(data) / 32000
        for index, start in enumerate(range(0, len(data), 3200)):
            if paced:
                delay = started + index * .1 - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
            self.send("audio", generation, pcm=base64.b64encode(data[start:start + 3200]).decode())
        if paced:
            delay = audio_end - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
        finished = time.perf_counter()
        if row.get("autoEndpoint"):
            for index in range(16):
                if paced:
                    delay = finished + index * .1 - time.perf_counter()
                    if delay > 0:
                        time.sleep(delay)
                self.send("audio", generation, pcm=base64.b64encode(bytes(3200)).decode())
        else:
            self.send("finish", generation)
        observed = []
        timeout = .8 if mode == "negative_wake" else 90
        deadline = time.perf_counter() + timeout
        terminal = None
        while time.perf_counter() < deadline:
            try:
                at, event = self.events.get(timeout=min(.2, max(.001, deadline - time.perf_counter())))
            except queue.Empty:
                continue
            if event.get("generation") != generation:
                continue
            observed.append((at, event))
            if event.get("type") in ("final", "error"):
                terminal = event
                break
        self.send("cancel", generation + 1)
        hypothesis = terminal.get("text", "") if terminal else ""
        errors, count = word_errors(row.get("text", ""), hypothesis)
        first = next((at for at, e in observed if e["type"] == "partial"), None)
        final = next((at for at, e in observed if e["type"] == "final"), None)
        wake = next((at for at, e in observed if e["type"] == "wake"), None)
        return {"id": row["id"], "kind": row["kind"], "mode": mode, "paced": paced,
                "negativeType": row.get("negativeType", "unspecified"),
                "reference": row.get("text", ""), "hypothesis": hypothesis,
                "wordErrors": errors, "referenceWords": count,
                "meaningOk": meaning_ok(row, hypothesis),
                "meaningChecksProvided": bool(row.get("mustContain") or row.get("mustNotContain")),
                "wakeDetected": wake is not None,
                "wakeMs": None if wake is None else round((wake - started) * 1000, 2),
                "firstPartialMs": None if first is None else round((first - started) * 1000, 2),
                "partialBeforeAudioEnd": first is not None and first < finished,
                "finalAfterFinishMs": None if final is None else round((final - finished) * 1000, 2),
                "audioMs": round(len(data) / 32, 2),
                "terminal": terminal.get("type") if terminal else "none",
                "error": terminal.get("message") if terminal else None,
                "workerTimings": terminal.get("timings", {}) if terminal else {},
                "events": [{"atMs": round((at - started) * 1000, 2), **event} for at, event in observed]}

    def close(self):
        if self.process.poll() is None:
            try:
                self.send("close", 1000000000)
                self.process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.terminate()
                self.process.wait(timeout=5)


def summarize(rows):
    quality = [r for r in rows if r["mode"] != "negative_wake" and r["referenceWords"]]
    count = sum(r["referenceWords"] for r in quality)
    summary = {"cases": len(rows), "wordErrorRate": None if not count else round(
        sum(r["wordErrors"] for r in quality) / count, 4)}
    for key in ("firstPartialMs", "finalAfterFinishMs"):
        summary[key] = {"p50": percentile([r[key] for r in rows], .5),
                        "p95": percentile([r[key] for r in rows], .95)}
    checked = [r for r in quality if r["meaningChecksProvided"]]
    summary["meaningChecks"] = {"passed": sum(r["meaningOk"] for r in checked), "total": len(checked)}
    negatives = [r for r in rows if r["mode"] == "negative_wake"]
    acoustic = [r for r in negatives if r.get("negativeType") == "phonetic"]
    mentions = [r for r in negatives if r.get("negativeType") == "name_mention"]
    summary["negativeWakeChecks"] = {
        "acousticFalseActivations": sum(r["wakeDetected"] for r in acoustic),
        "acousticTrials": len(acoustic),
        "nameMentionActivations": sum(r["wakeDetected"] for r in mentions),
        "nameMentionTrials": len(mentions),
        "unclassifiedTrials": len(negatives) - len(acoustic) - len(mentions)}
    summary["partialBeforeEnd"] = sum(r["partialBeforeAudioEnd"] for r in quality)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", default=os.environ.get("ERA_CHAT_SPEECH_CONFIG"))
    parser.add_argument("--interpreter", default=sys.executable)
    parser.add_argument("--paced", action="store_true")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--engines", nargs="+", choices=["streaming", "reference", "hosted"],
                        default=["streaming", "reference", "hosted"])
    args = parser.parse_args()
    manifest = json.loads(pathlib.Path(args.manifest).read_text())
    config = json.loads(pathlib.Path(args.config).read_text())
    for row in manifest:
        if not all(row.get(key) for key in ("id", "path", "kind", "source", "license")):
            parser.error("Every case needs an id, path, kind, source and license")
    result = {"platform": sys.platform, "paced": args.paced,
              "note": "Host measurement; synthetic and recorded speech are distinct groups.", "engines": {}}
    with tempfile.TemporaryDirectory(prefix="era-chat-bench-") as scratch:
        for label in args.engines:
            if label == "reference" and not config.get("reference"):
                continue
            if label == "hosted" and not (config.get("cloud_reference") or config.get("cloud_stream")):
                continue
            settings = dict(config)
            if label != "hosted":
                settings.pop("cloud_reference", None)
                settings.pop("cloud_stream", None)
            if label == "streaming":
                settings.pop("reference", None)
            path = pathlib.Path(scratch) / "runtime.json"
            path.write_text(json.dumps(settings))
            worker = Process(path, args.interpreter)
            rows = []
            try:
                for repeat in range(args.repeat):
                    for row in manifest:
                        measured = worker.run(row, 2 * len(rows) + 1, args.paced)
                        measured["repeat"] = repeat
                        rows.append(measured)
                        print(json.dumps({"engine": label, "id": row["id"],
                                          "finalAfterFinishMs": measured["finalAfterFinishMs"]}), flush=True)
            finally:
                worker.close()
            result["engines"][label] = {"coldInitializationMs": round(worker.cold_ms, 2),
                "summary": summarize(rows),
                "groups": {kind: summarize([r for r in rows if r["kind"] == kind])
                           for kind in sorted({r["kind"] for r in rows})}, "rows": rows}
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2))
    output.chmod(0o600)
    print(json.dumps({k: v["summary"] for k, v in result["engines"].items()}, indent=2))


if __name__ == "__main__":
    main()
