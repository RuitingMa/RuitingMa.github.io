/*
 * Web Audio synth — minimal sine-voice bank optimized for the dense
 * 32nd-note workloads typical of Ravel-style writing. Each voice is
 * 2 nodes (oscillator + gain), connected through a single shared
 * lowpass into a master dry bus. No per-note filter, no bell
 * oscillator, no convolution reverb — those tripled per-voice node
 * creation/teardown cost and were the main source of audio-side
 * stutter on dense passages.
 *
 * Pure audio — no DOM, no Verovio, no MEI awareness. Fed MIDI
 * numbers + audioContext-time bounds by ScorePlayer's scheduler.
 */

/** Tiny polyphonic sine-voice bank. Per voice: 1 OscillatorNode + 1
 *  GainNode for the amplitude envelope. A single shared BiquadFilter
 *  on the master bus shapes the timbre, and the master gain feeds
 *  the AudioContext destination directly. */
export class Synth {
  private ctx: AudioContext;
  private master: GainNode;
  private active: Set<{ stop: (t: number) => void }> = new Set();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // Shared bus: gentle lowpass to soften the sine fundamental's
    // upper partials (avoid harshness on high notes) into a master
    // gain. One filter for the whole synth — cheap.
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 5500;
    lowpass.Q.value = 0.5;
    this.master = ctx.createGain();
    this.master.gain.value = 0.22;
    lowpass.connect(this.master);
    this.master.connect(ctx.destination);
    // Expose the lowpass as the per-voice connect target via a closure
    // (kept private; voices read it through `this` below).
    (this as unknown as { _voiceBus: AudioNode })._voiceBus = lowpass;
  }

  play(midi: number, startT: number, endT: number) {
    const ctx = this.ctx;
    if (endT <= startT) endT = startT + 0.05;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const bus = (this as unknown as { _voiceBus: AudioNode })._voiceBus;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.value = 0;
    osc.connect(env);
    env.connect(bus);

    // ADSR envelope — short attack, modest decay-to-sustain, gentle
    // release. Same shape as the prior synth's voice envelope so the
    // perceived note shape stays close.
    const A = 0.006, D = 0.22, S = 0.48, R = 0.18, peak = 0.55;
    const sustain = peak * S;
    const sustainUntil = Math.max(startT + A + D, endT - R);
    env.gain.setValueAtTime(0, startT);
    env.gain.linearRampToValueAtTime(peak, startT + A);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), startT + A + D);
    env.gain.setValueAtTime(sustain, sustainUntil);
    env.gain.exponentialRampToValueAtTime(0.0001, sustainUntil + R);

    const stopAt = sustainUntil + R + 0.02;
    osc.start(startT);
    osc.stop(stopAt);

    const handle = {
      stop: (t: number) => {
        try {
          env.gain.cancelScheduledValues(t);
          env.gain.setValueAtTime(env.gain.value, t);
          env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
          osc.stop(t + 0.07);
        } catch {}
      },
    };
    this.active.add(handle);
    osc.onended = () => {
      try { env.disconnect(); } catch {}
      this.active.delete(handle);
    };
  }

  /** Cancel all pending/sounding voices — used on pause. */
  panic() {
    const t = this.ctx.currentTime;
    for (const v of this.active) v.stop(t);
    this.active.clear();
  }
}
