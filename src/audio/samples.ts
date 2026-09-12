import type { AudioGraph } from "./engine";

/**
 * Recorded foley, sliced into single hits (see docs/sfx-sources.md).
 * Banks are fetched after the first gesture and decoded once. A bank plays
 * round-robin, never the same slice twice in a row, with a little random
 * pitch so consecutive hits are never copies.
 */
export const BANKS = {
  /** bare-skin thigh slaps: the crack of the hand */
  crack: 8,
  /** open hand on leg: an alternative crack, a touch heavier */
  leg: 6,
  /** a slap on the buttock: the body under the crack */
  body: 7,
  /** gentle pats and grabs */
  pat: 5,
  heart: 1,
  rub: 1,
} as const;

export type BankName = keyof typeof BANKS;

export interface PlayOptions {
  gain?: number;
  /** playback rate; 1 = as recorded */
  rate?: number;
  /** random rate spread, ± fraction */
  spread?: number;
  when?: number;
  /** one-pole low-pass cutoff, Hz — for dulling a layer */
  lowpass?: number;
  /** reverb send, 0..1 of the gain */
  wet?: number;
}

export class SampleBank {
  private buffers = new Map<BankName, AudioBuffer[]>();
  private last = new Map<BankName, number>();
  private loading = false;

  /** kick off decoding; safe to call repeatedly */
  load(g: AudioGraph): void {
    if (this.loading) return;
    this.loading = true;
    for (const [name, count] of Object.entries(BANKS) as [BankName, number][]) {
      const slots: AudioBuffer[] = [];
      this.buffers.set(name, slots);
      for (let i = 1; i <= count; i++) {
        fetch(`/sfx/${name}-${i}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
          .then((data) => g.ctx.decodeAudioData(data))
          .then((buffer) => slots.push(buffer))
          .catch(() => {
            /* a missing slice only thins the bank */
          });
      }
    }
  }

  get ready(): boolean {
    return (this.buffers.get("crack")?.length ?? 0) > 0;
  }

  /** a slice from the bank, or null if nothing has decoded yet */
  pick(name: BankName): AudioBuffer | null {
    const slots = this.buffers.get(name);
    if (!slots || slots.length === 0) return null;
    if (slots.length === 1) return slots[0];
    let i = Math.floor(Math.random() * slots.length);
    if (i === this.last.get(name)) i = (i + 1) % slots.length;
    this.last.set(name, i);
    return slots[i];
  }

  play(
    g: AudioGraph,
    name: BankName,
    o: PlayOptions = {},
  ): AudioBufferSourceNode | null {
    const buffer = this.pick(name);
    if (!buffer) return null;
    const { ctx, dry, wet } = g;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const spread = o.spread ?? 0.06;
    src.playbackRate.value =
      (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * spread);
    const gain = ctx.createGain();
    gain.gain.value = o.gain ?? 1;
    let tail: AudioNode = src;
    if (o.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = o.lowpass;
      tail.connect(lp);
      tail = lp;
    }
    tail.connect(gain);
    gain.connect(dry);
    if (o.wet && o.wet > 0) {
      const send = ctx.createGain();
      send.gain.value = o.wet;
      gain.connect(send).connect(wet);
    }
    src.start(o.when ?? ctx.currentTime);
    return src;
  }
}
