// No microphone samples are persisted. Each transferred block is consumed once.
class ChatPCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.alive = true; this.buffer = new Float32Array(2048); this.index = 0;
    this.port.onmessage = e => {
      if (e.data === 'stop') this.alive = false;
      if (e.data === 'flush') {
        if (this.index) { const tail = this.buffer.slice(0, this.index); this.port.postMessage(tail, [tail.buffer]); this.index = 0; }
        this.port.postMessage({ flushed: true });
      }
    };
  }
  process(inputs) {
    if (!this.alive) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.index++] = sample / channels.length;
      if (this.index === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.index = 0;
      }
    }
    return true;
  }
}
registerProcessor('chat-pcm', ChatPCM);
