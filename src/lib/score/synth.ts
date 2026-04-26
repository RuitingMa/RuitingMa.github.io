/*
 * Web Audio synth — minimal sine-voice bank optimized for the dense
 * 32nd-note workloads typical of Ravel-style writing. Each voice is
 * 2 nodes (oscillator + gain), connected through a shared lowpass
 * and a single bus-level convolution reverb into the master bus.
 *
 * Pure audio — no DOM, no Verovio, no MEI awareness. Fed MIDI
 * numbers + audioContext-time bounds by ScorePlayer's scheduler.
 *
 * Why ONE convolver at the bus and not per-voice: a ConvolverNode's
 * cost is dominated by its impulse response length, NOT by how many
 * voices feed into it (modern engines use partitioned FFT
 * convolution). Routing every voice through its own convolver was
 * what caused the per-voice stutter in earlier attempts; a single
 * shared convolver fed by ALL voices avoids that entirely.
 */

/** Tiny polyphonic sine-voice bank with shared reverb. Per voice:
 *  1 OscillatorNode + 1 GainNode (ADSR). A shared BiquadFilter
 *  shapes the timbre, a shared ConvolverNode adds room ambience,
 *  and a master gain feeds the AudioContext destination. */
export class Synth {
  private ctx: AudioContext;
  private master: GainNode;
  private active: Set<{ stop: (t: number) => void }> = new Set();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // Voice bus: gentle lowpass to soften the sine fundamental's
    // upper partials (avoid harshness on high notes).
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 5500;
    lowpass.Q.value = 0.5;

    // Reverb path. The IR is a synthesized stereo white-noise burst
    // with exponential decay — no fetch, no decode, ~30 ms to build
    // at AudioContext sampleRate. Sounds like a small-to-medium hall,
    // which suits the impressionist piano writing the scores carry.
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulseResponse(ctx, 2.2, 3.2);

    // Dry / wet split on the bus. Sine waves are pure tones with
    // minimal natural decay, so reverb adds a lot of perceptual
    // richness even at a modest wet level.
    const dry = ctx.createGain();
    dry.gain.value = 0.80;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;

    this.master = ctx.createGain();
    this.master.gain.value = 0.20;

    // Routing:
    //   voices → lowpass ─┬→ dry ─→ master → destination
    //                     └→ convolver → wet → master
    lowpass.connect(dry);
    dry.connect(this.master);
    lowpass.connect(convolver);
    convolver.connect(wet);
    wet.connect(this.master);
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

/** Stereo impulse response: white noise multiplied by an exponential
 *  decay envelope. `duration` controls tail length; higher `decay`
 *  shortens the perceived tail by curving the envelope steeper. */
function makeImpulseResponse(
  ctx: AudioContext, duration: number, decay: number,
): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}
