import { AudioEngine, type AudioGraph, noiseBuffer } from "./engine";
import { playSlap } from "./foley";

/**
 * Owns the soundscape, all of it diegetic and unexplained:
 * - room tone: barely-there brown noise + mains hum, faded in after the
 *   first gesture. The void is a place, not an absence.
 * - heartbeat: creeps in while the visitor holds a charge, accelerating
 *   and swelling with it; the room dips alongside. No meter, no UI —
 *   the tension is entirely in the ears.
 * - slap foley on impact, power-scaled.
 */
export class AudioDirector {
  private engine = new AudioEngine();
  private roomGain: GainNode | null = null;
  private nextBeat = 0;

  constructor() {
    window.addEventListener("pointerdown", () => this.wake());
  }

  private wake(): void {
    const g = this.engine.ensure();
    if (!this.roomGain) this.startRoomTone(g);
  }

  private startRoomTone(g: AudioGraph): void {
    const { ctx, dry } = g;
    const t = ctx.currentTime;

    const room = ctx.createGain();
    room.gain.setValueAtTime(0.0001, t);
    room.gain.exponentialRampToValueAtTime(1, t + 3);
    room.connect(dry);
    this.roomGain = room;

    // brown-ish noise, heavily low-passed: HVAC in another room
    const noise = ctx.createBufferSource();
    const buf = noiseBuffer(ctx, 2.5);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * data[i]) / 1.02;
      data[i] = last * 3.5;
    }
    noise.buffer = buf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 150;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.05;
    noise.connect(lp).connect(noiseGain).connect(room);
    noise.start();

    // faint mains hum
    for (const [freq, gain] of [
      [50, 0.012],
      [100, 0.005],
    ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const oscGain = ctx.createGain();
      oscGain.gain.value = gain;
      osc.connect(oscGain).connect(room);
      osc.start();
    }
  }

  /** impact from the interaction layer; power01 in 0..1 */
  impact(power01: number): void {
    const g = this.engine.current;
    if (!g) return;
    this.nextBeat = 0;
    playSlap(g, power01);
  }

  /** call every frame with the current hold charge (0..1) */
  update(charge: number): void {
    const g = this.engine.current;
    if (!g) return;
    const t = g.ctx.currentTime;

    // the room holds its breath as the charge builds
    if (this.roomGain) {
      this.roomGain.gain.setTargetAtTime(1 - 0.6 * charge, t, 0.15);
    }

    if (charge <= 0) {
      this.nextBeat = 0;
      return;
    }
    if (this.nextBeat === 0) this.nextBeat = t + 0.05;
    const interval = 60 / (52 + 68 * charge);
    while (this.nextBeat < t + 0.12) {
      this.playBeat(g, this.nextBeat, charge);
      this.nextBeat += interval;
    }
  }

  private playBeat(g: AudioGraph, when: number, charge: number): void {
    const peak = 0.05 + 0.13 * charge;
    this.thud(g, when, peak);
    this.thud(g, when + 0.17, peak * 0.65);
  }

  private thud(g: AudioGraph, when: number, peak: number): void {
    const { ctx, dry } = g;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(62, when);
    osc.frequency.exponentialRampToValueAtTime(38, when + 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    osc.connect(gain).connect(dry);
    osc.start(when);
    osc.stop(when + 0.14);
  }
}
