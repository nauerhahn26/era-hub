// No microphone samples are persisted. Each transferred block is consumed once.
class ChatPCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.alive = true; this.capturing = false; this.turn = 0; this.buffer = new Float32Array(2048); this.index = 0;
    this.port.onmessage = e => {
      if (e.data === 'stop') this.alive = false;
      if (e.data?.type === 'capture') {
        this.turn = e.data.turn; this.index = 0; this.capturing = true;
      }
      if (e.data?.type === 'flush' && e.data.turn === this.turn && this.capturing) {
        this.capturing = false;
        if (this.index) { const tail = this.buffer.slice(0, this.index); this.port.postMessage({ turn: this.turn, samples: tail }, [tail.buffer]); this.index = 0; }
        this.port.postMessage({ turn: this.turn, flushed: true });
      }
      if (e.data?.type === 'cancel') {
        this.capturing = false; this.index = 0;
      }
    };
  }
  process(inputs) {
    if (!this.alive) return false;
    const channels = inputs[0];
    if (!this.capturing || !channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.index++] = sample / channels.length;
      if (this.index === this.buffer.length) {
        this.port.postMessage({ turn: this.turn, samples: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.index = 0;
      }
    }
    return true;
  }
}
registerProcessor('chat-pcm', ChatPCM);
