/**
 * Lazy WebAudio graph. Nothing is constructed until the first user gesture
 * (autoplay policy), then: sources -> dry/wet busses -> compressor (safety
 * limiter) -> destination. The wet bus runs through a synthetic small-room
 * impulse response — a dead, close room, not a hall.
 */
export interface AudioGraph {
  ctx: AudioContext;
  /** direct bus */
  dry: GainNode;
  /** reverb send */
  wet: GainNode;
}

function makeRoomIR(ctx: AudioContext): AudioBuffer {
  const seconds = 0.55;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 11);
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

  /** call from a user gesture; idempotent */
  ensure(): AudioGraph {
    if (this.graph) {
      if (this.graph.ctx.state === "suspended") void this.graph.ctx.resume();
      return this.graph;
    }
    const ctx = new AudioContext();
    const compressor = ctx.createDynamicsCompressor();
    compressor.connect(ctx.destination);

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(compressor);

    const convolver = ctx.createConvolver();
    convolver.buffer = makeRoomIR(ctx);
    convolver.connect(compressor);
    const wet = ctx.createGain();
    wet.gain.value = 0.25;
    wet.connect(convolver);

    this.graph = { ctx, dry, wet };
    return this.graph;
  }

  get current(): AudioGraph | null {
    return this.graph;
  }
}
