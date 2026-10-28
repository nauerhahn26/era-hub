// The partner's two short sounds for a button-press window (design 2026-10-27
// §4.6; plan T2.4, decision 7): a rising listening tone when listening
// actually starts and a falling done tone when the window closes. Quiet
// (gain 0.15), 180 ms each, drawn by an oscillator on the page's own audio
// context: no audio files, nothing spoken, distinct from the dwell chime.
// The kiosk's autoplay flag lets them play with no gesture. A tone never
// blocks or breaks listening: any failure is silent and resolves.
export const TONE_MS = 180;
const GAIN = 0.15;
const SHAPES = { listening: [660, 880], done: [880, 660] };

export function createTones({ AudioContextClass = globalThis.AudioContext } = {}) {
  let context = null;
  function audio() {
    if (!context || context.state === 'closed') context = new AudioContextClass({ latencyHint: 'interactive' });
    return context;
  }
  async function play(kind) {
    const [from, to] = SHAPES[kind];
    try {
      const c = audio();
      if (c.state === 'suspended') await Promise.race([c.resume().catch(() => {}), new Promise(resolve => setTimeout(resolve, 300))]);
      const osc = c.createOscillator(), gain = c.createGain(), start = c.currentTime, end = start + TONE_MS / 1000;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(from, start);
      osc.frequency.linearRampToValueAtTime(to, end);
      // Short fades at both ends: no click.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(GAIN, start + 0.01);
      gain.gain.setValueAtTime(GAIN, end - 0.02);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(start); osc.stop(end);
      // Resolves when the tone has ended (or a little after, if the end event never comes).
      await new Promise(resolve => {
        const timer = setTimeout(resolve, TONE_MS + 80);
        osc.onended = () => { clearTimeout(timer); resolve(); };
      });
      osc.disconnect(); gain.disconnect();
    } catch { /* a tone is a courtesy, never a step listening waits on */ }
  }
  return { listening: () => play('listening'), done: () => play('done') };
}
