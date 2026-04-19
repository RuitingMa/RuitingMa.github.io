/*
 * Modal-synthesis bell / porcelain-bowl voice bank.
 *
 * Each strike produces a brief attack → exponential-decay sum of four
 * inharmonic sine partials, mixed through a master voice bus → dry/wet
 * → compressor → destination. A short convolution reverb (noise IR, 1.7 s)
 * provides spatial glue without sounding like a cathedral.
 *
 * Lifecycle:
 *   const synth = new ModalBellSynth();
 *   // ...user gesture (pointerdown):
 *   await synth.wake();
 *   // any time thereafter:
 *   synth.strike({ pitch: 440, velocity: 0.7, size: 0.5 });
 *   // navigation / cleanup:
 *   synth.dispose();
 *
 * Browsers block AudioContext creation + resume until a user gesture has
 * fired in the page. `wake()` handles both — it's a no-op if called a
 * second time, so it's safe to invoke from every pointerdown.
 *
 * Design notes:
 *   - Partials are hand-tuned for "porcelain" character rather than a
 *     cathedral clang: a dominant fundamental, a near-perfect octave with
 *     slight detune (warmth), one classic inharmonic "bell" partial
 *     (2.76), and a thin high sparkle (4.13). Real bells have denser
 *     spectra; a pond isn't a bell tower.
 *   - `size` parameter stretches sustain — bigger bowls store more energy,
 *     ring longer. Only the fundamental and low octaves get the full
 *     stretch; higher partials die fast regardless.
 *   - Per-strike micro-detune (±6 cents) prevents two same-radius lanterns
 *     from ringing in phase lock-step.
 */

export interface BellStrike {
  /** Fundamental frequency in Hz. */
  pitch: number;
  /** Loudness, 0..1. Values near 0 will still produce a quiet audible note. */
  velocity: number;
  /** Normalized "bigness", 0..1. Bigger → longer sustain on low partials. */
  size: number;
}

type Partial = {
  /** Multiplier of fundamental: the partial's frequency = pitch × ratio. */
  ratio: number;
  /** Relative amplitude of this partial (1.0 = fundamental). */
  amp: number;
  /** Minimum decay time at size=0, seconds. */
  decayBase: number;
  /** Additional decay time at size=1, seconds. */
  decaySpan: number;
};

// Tuned for crisp porcelain/ceramic character (not a cathedral bell):
//   - Fundamental decays quickly (1-2.5s), not the multi-second tail of a
//     large tuned bell.
//   - Higher partials bumped up so the initial "tink" reads as percussive,
//     not as a dull thud. They still die fast.
//   - Keep the inharmonic 2.76 partial for the bell/bowl signature, but
//     the near-octave 2.01 adds warmth that reads as ceramic rather than
//     as a church bell.
const PARTIALS: Partial[] = [
  { ratio: 1.00, amp: 1.00, decayBase: 1.0, decaySpan: 1.4 },
  { ratio: 2.01, amp: 0.50, decayBase: 0.7, decaySpan: 0.7 },
  { ratio: 2.76, amp: 0.32, decayBase: 0.45, decaySpan: 0.4 },
  { ratio: 4.13, amp: 0.18, decayBase: 0.25, decaySpan: 0.2 },
];

const ATTACK = 0.003;        // seconds — slightly faster for a crisper onset
const DETUNE_CENTS = 6;
const MASTER_GAIN = 0.38;    // voice bus
// Reverb: pushed hard into "large open space" territory. Strikes now
// carry a long shimmering tail — a koi pond in a stone courtyard, with
// air above it — rather than the earlier pavilion. Wet nearly matches
// dry, and a high-shelf brightener + HP-biased IR keep the tail
// shimmering instead of turning into low-end wash.
const DRY_GAIN = 0.58;
const WET_GAIN = 0.78;
const REVERB_SECONDS = 6.5;
const REVERB_DECAY = 1.5;    // lower → longer tail; 1.5 ≈ 5 s audible decay
const REVERB_SHIMMER_HZ = 2500;
const REVERB_SHIMMER_DB = 7;

export class ModalBellSynth {
  private ctx: AudioContext | null = null;
  private voiceBus: GainNode | null = null;

  /** True once wake() has successfully created an AudioContext. */
  get ready(): boolean { return this.ctx !== null; }

  /**
   * Create the AudioContext + master chain. Must be called from inside a
   * user-gesture event handler (pointerdown/click/keydown). Idempotent:
   * subsequent calls are cheap no-ops.
   */
  async wake(): Promise<void> {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      console.warn('[modal-bell] Web Audio API not available.');
      return;
    }
    const ctx = new AudioCtx();
    // Some browsers start the context suspended even inside a gesture.
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }

    const voiceBus = ctx.createGain();
    voiceBus.gain.value = MASTER_GAIN;

    const dry = ctx.createGain();
    dry.gain.value = DRY_GAIN;

    const wet = ctx.createGain();
    wet.gain.value = WET_GAIN;

    const conv = ctx.createConvolver();
    conv.buffer = this.buildReverbIR(ctx, REVERB_SECONDS, REVERB_DECAY);

    // High-shelf "shimmer" on the wet path. Raw convolution of bell
    // partials with a white-noise IR ends up dominated by the lower
    // partials because they decay slowest in the source — so the wet
    // tail reads dark. Boosting everything above ~2.5 kHz on the wet
    // bus restores a fine, air-like ring without touching dry clarity.
    const shimmer = ctx.createBiquadFilter();
    shimmer.type = 'highshelf';
    shimmer.frequency.value = REVERB_SHIMMER_HZ;
    shimmer.gain.value = REVERB_SHIMMER_DB;

    // Compressor catches the peaks when many voices sum; settings chosen
    // to be transparent on single strikes and only squeeze chords/piles.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;

    // Signal graph:  voiceBus ─┬─→ dry ──────────────────→ comp → destination
    //                          └─→ conv → shimmer → wet ─↗
    voiceBus.connect(dry);
    voiceBus.connect(conv);
    conv.connect(shimmer);
    shimmer.connect(wet);
    dry.connect(comp);
    wet.connect(comp);
    comp.connect(ctx.destination);

    this.ctx = ctx;
    this.voiceBus = voiceBus;
  }

  /**
   * Play a single bell/bowl strike. No-op if the synth isn't awake yet or
   * velocity is non-positive.
   */
  strike({ pitch, velocity, size }: BellStrike): void {
    const ctx = this.ctx;
    const bus = this.voiceBus;
    if (!ctx || !bus) return;
    if (velocity <= 0) return;

    const now = ctx.currentTime;
    const detuneRatio = Math.pow(2, ((Math.random() * 2 - 1) * DETUNE_CENTS) / 1200);
    const clampedVel = Math.min(1, velocity);
    const clampedSize = Math.min(1, Math.max(0, size));

    for (const P of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = pitch * P.ratio * detuneRatio;

      const g = ctx.createGain();
      const peak = clampedVel * P.amp * 0.32;
      const decay = P.decayBase + clampedSize * P.decaySpan;

      // Linear attack → exponential decay to near-zero (exp ramp requires
      // a positive target, so we aim for 0.0001, inaudible).
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peak, now + ATTACK);
      g.gain.exponentialRampToValueAtTime(0.0001, now + ATTACK + decay);

      osc.connect(g);
      g.connect(bus);

      osc.start(now);
      // Stop a frame after the envelope ends so the node gets GC'd and
      // doesn't keep the audio graph alive forever.
      osc.stop(now + ATTACK + decay + 0.05);
    }
  }

  /** Freeze all audio. Called on stage:pause. Cheap. */
  suspend(): void {
    this.ctx?.suspend().catch(() => { /* ignore */ });
  }

  /** Unfreeze. Called on stage unpause. */
  resume(): void {
    this.ctx?.resume().catch(() => { /* ignore */ });
  }

  /** Tear down the AudioContext. Called on page navigation / component unmount. */
  dispose(): void {
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.voiceBus = null;
  }

  /**
   * Build an exponentially-decaying noise impulse response with a
   * first-order high-pass bias on the noise source. The HP differencing
   * (n - 0.6·prev) shifts the noise energy toward HF so the convolved
   * tail reads as shimmer/air, not rumble — complementing the wet-path
   * high-shelf filter. Still a toy reverb, but plenty to glue strikes
   * into a shared space.
   */
  private buildReverbIR(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(seconds * sr));
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = Math.random() * 2 - 1;
        const hp = n - 0.6 * prev;
        prev = n;
        data[i] = hp * Math.pow(1 - t, decay);
      }
    }
    return ir;
  }
}
