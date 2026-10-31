import { createPCM16Resampler } from './controller.js';

// Start warms the graph without retaining audio. Only an explicit hold begins
// collection; release flushes that hold and leaves the graph idle again.
export function createMicrophone({ onFrame, onError }) {
  let stream, context, source, node, active = false, generation = 0, captureTurn = 0, collecting = false, flushed = null, resampler = null;
  async function stop() {
    generation++; captureTurn++; active = false; collecting = false;
    node?.port.postMessage('stop'); node?.disconnect(); source?.disconnect();
    if (node) { node.port.onmessage = null; node.onprocessorerror = null; node.port.close(); }
    flushed?.(); flushed = null; resampler = null;
    stream?.getTracks().forEach(t => t.stop());
    const old = context; context = null; node = null; source = null; stream = null;
    if (old && old.state !== 'closed') await old.close().catch(() => {});
  }
  async function start() {
    const mine = ++generation;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Microphone capture is unavailable in this browser.');
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume();
    const incoming = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    if (mine !== generation) { incoming.getTracks().forEach(t => t.stop()); return; }
    stream = incoming;
    await context.audioWorklet.addModule('./pcm-worklet.js');
    if (mine !== generation || !context) return;
    node = new AudioWorkletNode(context, 'chat-pcm');
    node.port.onmessage = e => {
      if (!active || mine !== generation || e.data?.turn !== captureTurn || !resampler) return;
      if (e.data.flushed) { resampler.flush(); collecting = false; flushed?.(); flushed = null; }
      else if (e.data.samples) resampler.push(e.data.samples);
    };
    node.onprocessorerror = () => { if (active && mine === generation) onError(new Error('Microphone processing stopped.')); };
    source = context.createMediaStreamSource(stream); source.connect(node); node.connect(context.destination);
    active = true;
  }
  return {
    start, stop,
    begin() {
      if (!active || !node || !context || collecting) return false;
      captureTurn++; collecting = true;
      resampler = createPCM16Resampler(context.sampleRate, b => { if (active) onFrame(b); });
      node.port.postMessage({ type: 'capture', turn: captureTurn }); return true;
    },
    // The device's own audio path, in ms: output (what plays reaches the speaker
    // late) and input (the microphone's samples reach the page late). 0 when unknown.
    latencyMs() {
      const seconds = (context?.baseLatency || 0) + (context?.outputLatency || 0) + (stream?.getAudioTracks?.()[0]?.getSettings?.().latency || 0);
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    },
    cancel() { captureTurn++; collecting = false; resampler = null; flushed?.(); flushed = null; node?.port.postMessage({ type: 'cancel' }); },
    flush() { return new Promise((resolve, reject) => {
      if (!active || !node || !collecting) { resolve(); return; }
      const timer = setTimeout(() => { flushed = null; reject(new Error('Microphone did not finish the held question.')); }, 1000);
      flushed = () => { clearTimeout(timer); resolve(); };
      node.port.postMessage({ type: 'flush', turn: captureTurn });
    }); },
  };
}
