import { AudioEngine, type AudioGraph, noiseBuffer } from "./engine";
import { defaultFoleyLevels, playBody, playContact, playPat } from "./foley";
import { SampleBank } from "./samples";

/**
 * Owns the soundscape, all of it diegetic and unexplained:
 * - room tone: barely-there brown noise + mains hum, faded in after the
 *   first gesture. The void is a place, not an absence.
 * - heartbeat: a recorded beat that creeps in while the visitor holds a
 *   charge, accelerating and swelling with it; the room dips alongside.
 * - contact: recorded slaps — the crack at the instant of the slap, the
 *   body of the flesh when the physics says the palm has bottomed out.
 * - brush: a recorded hand over bare skin, gated by the hand's speed.
 */
export class AudioDirector {
  readonly levels = { ...defaultFoleyLevels };
  /** brush loop level at full speed; 0 silences the brush entirely */
  brushLevel = 0.32;
  heartLevel = 0.55;
  private engine = new AudioEngine();
  private bank = new SampleBank();
  private roomGain: GainNode | null = null;
  private nextBeat = 0;
  private brushGain: GainNode | null = null;
  private brushFilter: BiquadFilterNode | null = null;
  private brushStarted = false;
  private cinemaUntil = 0;

  constructor() {
    window.addEventListener("pointerdown", () => this.wake());
  }

  private wake(): void {
    const g = this.engine.ensure();
    if (!g) return;
    this.bank.load(g);
    if (!this.roomGain) this.startRoomTone(g);
  }

  /** the tab is hidden: silence costs nothing and the heartbeat resets */
  pause(): void {
    this.nextBeat = 0;
    this.engine.suspend();
  }

  resume(): void {
    this.engine.resume();
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

  /** the recorded caress, looping silently until the hand moves */
  private startBrush(g: AudioGraph): boolean {
    const buffer = this.bank.pick("rub");
    if (!buffer) return false;
    const { ctx, dry } = g;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0.05;
    src.loopEnd = buffer.duration - 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 4000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(lp).connect(gain).connect(dry);
    src.start();
    this.brushGain = gain;
    this.brushFilter = lp;
    this.brushStarted = true;
    return true;
  }

  /**
   * the dive has begun but nothing has hit yet: the room goes silent fast.
   * impactCinema (fired at delivery) owns bringing it back.
   */
  holdBreath(): void {
    const g = this.engine.current;
    if (!g || !this.roomGain) return;
    this.roomGain.gain.setTargetAtTime(0.02, g.ctx.currentTime, 0.08);
  }

  /** the palm meets the skin; power01 in 0..1, radius in world units */
  impact(power01: number, radius: number, swipe01: number, x?: number): void {
    const g = this.engine.current;
    if (!g) return;
    this.nextBeat = 0;
    playContact(g, this.bank, this.levels, { power01, radius, swipe01, x });
  }

  /**
   * the flesh under the palm bottoms out — reported by the solver, so in
   * the kill cam it arrives as late as the slow motion makes it
   */
  contact(
    depth01: number,
    area: number,
    firmness: number,
    stretch = 1,
    x?: number,
  ): void {
    const g = this.engine.current;
    if (!g) return;
    playBody(g, this.bank, this.levels, {
      depth01,
      area,
      firmness,
      stretch,
      x,
    });
  }

  /** a grabbed handful let go at speed */
  fling(power01: number, x?: number): void {
    const g = this.engine.current;
    if (!g) return;
    playPat(g, this.bank, this.levels, power01, x);
  }

  /**
   * kill-cam impact: the crack at quarter speed, dropped into the abyss,
   * the room gone silent, a sub swell underneath — then the world fades back.
   * @param durationS real-time length of the slow-motion sequence
   */
  impactCinema(power01: number, durationS: number, x?: number): void {
    const g = this.engine.current;
    if (!g) return;
    this.nextBeat = 0;
    const { ctx, dry } = g;
    const t = ctx.currentTime;
    this.cinemaUntil = t + durationS;

    playContact(g, this.bank, this.levels, {
      power01,
      radius: 0.6,
      swipe01: 0,
      stretch: 4,
      x,
    });

    if (this.roomGain) {
      this.roomGain.gain.setTargetAtTime(0.03, t, 0.12);
      this.roomGain.gain.setTargetAtTime(1, t + durationS, 0.4);
    }

    // sub swell under the held moment — with an audible octave riding the
    // 28Hz fundamental, because phone speakers cannot reproduce it
    for (const [freq, peak] of [
      [28, 0.16],
      [56, 0.08],
    ]) {
      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.value = freq;
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.0001, t);
      subGain.gain.exponentialRampToValueAtTime(peak, t + durationS * 0.4);
      subGain.gain.exponentialRampToValueAtTime(0.0001, t + durationS);
      sub.connect(subGain).connect(dry);
      sub.start(t);
      sub.stop(t + durationS + 0.1);
    }
  }

  /**
   * call every frame with the current hold charge (0..1) and the brush
   * speed over the skin (world units/s)
   */
  update(charge: number, brushSpeed = 0): void {
    const g = this.engine.current;
    if (!g) return;
    const t = g.ctx.currentTime;

    if (!this.brushStarted && brushSpeed > 0) this.startBrush(g);
    if (this.brushGain && this.brushFilter) {
      const s = Math.min(1, brushSpeed / 2.5);
      this.brushGain.gain.setTargetAtTime(this.brushLevel * s ** 1.4, t, 0.04);
      this.brushFilter.frequency.setTargetAtTime(2200 + 3500 * s, t, 0.06);
    }

    // the cinema envelope owns the room until the shot ends
    if (t < this.cinemaUntil) return;

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
      this.bank.play(g, "heart", {
        gain: this.heartLevel * (0.25 + 0.75 * charge),
        // the beat itself quickens a little with the pulse
        rate: 0.95 + 0.25 * charge,
        spread: 0.02,
        when: this.nextBeat,
        lowpass: 900,
      });
      this.nextBeat += interval;
    }
  }
}
