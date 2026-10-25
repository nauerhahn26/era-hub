import { createPCM16Resampler } from './controller.js';

// The browser hands audio only to this device's session endpoint. Cloud ASR is
// never called from this module; wake routing belongs to the local worker.
export function createMicrophone({ onFrame, onError }) {
  let stream, context, source, node, active = false, generation = 0, flushed = null, resampler = null;
  async function stop() {
    generation++; active = false;
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
    resampler = createPCM16Resampler(context.sampleRate, b => { if (active) onFrame(b); });
    node = new AudioWorkletNode(context, 'chat-pcm');
    node.port.onmessage = e => {
      if (!active || mine !== generation) return;
      if (e.data?.flushed) { resampler.flush(); flushed?.(); flushed = null; }
      else resampler.push(e.data);
    };
    node.onprocessorerror = () => { if (active && mine === generation) onError(new Error('Microphone processing stopped.')); };
    source = context.createMediaStreamSource(stream); source.connect(node); node.connect(context.destination);
    active = true;
  }
  return { start, stop, flush() { return new Promise(resolve => {
    if (!active || !node) { resolve(); return; }
    flushed = resolve; node.port.postMessage('flush'); setTimeout(resolve, 200);
  }); } };
}
