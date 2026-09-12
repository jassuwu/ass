/**
 * Lazy WebAudio graph. Nothing is constructed until the first user gesture
 * (autoplay policy), then: sources -> dry/wet busses -> compressor (safety
 * limiter) -> destination. The wet bus is a small dead room: a handful of
 * early reflections off nearby walls, then a short diffuse tail whose top
 * end closes as it decays — the way plaster and air actually absorb.
 */
export interface AudioGraph {
  ctx: AudioContext;
  /** direct bus */
  dry: GainNode;
  /** reverb send */
  wet: GainNode;
}

function makeRoomIR(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = 0.42;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  // early reflections: delay ms, gain, pan (-1..1). A near wall to one
  // side, the floor, and the far walls arriving later and weaker.
  const taps: [number, number, number][] = [
    [3.9, 0.62, -0.5],
    [6.8, 0.48, 0.6],
    [10.4, 0.4, -0.2],
    [14.9, 0.31, 0.35],
    [19.6, 0.24, -0.7],
    [25.3, 0.18, 0.15],
    [31.7, 0.13, 0.5],
    [39.2, 0.09, -0.35],
  ];
  const tailStart = 0.021;
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (const [ms, gain, pan] of taps) {
      const side = ch === 0 ? 1 - Math.max(0, pan) : 1 - Math.max(0, -pan);
      const at = Math.floor((ms / 1000) * sr);
      // each reflection is a smeared blip, not a delta: walls are rough
      const blipLen = Math.floor(sr * 0.0007);
      for (let i = 0; i < blipLen && at + i < len; i++) {
        data[at + i] +=
          (Math.random() * 2 - 1) *
          gain *
          side *
          Math.exp(-i / (blipLen * 0.4));
      }
    }
    // diffuse tail: white noise decaying at ~-60 dB in 0.35 s, through a
    // one-pole low-pass whose cutoff falls with time (air + soft surfaces)
    let lp = 0;
    for (let i = Math.floor(tailStart * sr); i < len; i++) {
      const t = i / sr - tailStart;
      const env = Math.exp(-t * 19.7) * 0.5;
      const cutoff = 6000 * Math.exp(-t * 6) + 900;
      const k = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      lp += (Math.random() * 2 - 1 - lp) * k;
      data[i] += lp * env;
    }
  }
  // normalise to a sane peak so the send level means the same everywhere
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak > 0) {
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] /= peak;
    }
  }
  return buf;
}

export function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export class AudioEngine {
  private graph: AudioGraph | null = null;

  /** call from a user gesture; idempotent; null where WebAudio is absent */
  ensure(): AudioGraph | null {
    if (typeof AudioContext === "undefined") return null;
    if (this.graph) {
      if (this.graph.ctx.state === "suspended")
        void this.graph.ctx.resume().catch(() => {});
      return this.graph;
    }
    const ctx = new AudioContext();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.12;
    compressor.connect(ctx.destination);

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(compressor);

    // the room hears a band-limited version of the source: no sub in the
    // reflections, and the top end never survives the first bounce
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    const wetHp = ctx.createBiquadFilter();
    wetHp.type = "highpass";
    wetHp.frequency.value = 140;
    const wetLp = ctx.createBiquadFilter();
    wetLp.type = "lowpass";
    wetLp.frequency.value = 5200;
    const convolver = ctx.createConvolver();
    convolver.buffer = makeRoomIR(ctx);
    wet.connect(wetHp).connect(wetLp).connect(convolver).connect(compressor);

    this.graph = { ctx, dry, wet };
    return this.graph;
  }

  get current(): AudioGraph | null {
    return this.graph;
  }

  suspend(): void {
    if (this.graph?.ctx.state === "running")
      void this.graph.ctx.suspend().catch(() => {});
  }

  resume(): void {
    if (this.graph?.ctx.state === "suspended")
      void this.graph.ctx.resume().catch(() => {});
  }
}
