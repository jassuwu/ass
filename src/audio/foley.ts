import { type AudioGraph, noiseBuffer } from "./engine";

/**
 * Flesh slap, five layers — the anatomy of a satisfying impact:
 *   1. click — a near-instant broadband transient. The ear reads "contact"
 *      from the first 5ms; without it everything else is just a whump.
 *   2. crack — band-passed noise burst, skin on skin.
 *   3. thump — the mass moving: a hard pitch drop into the 40s, doubled by
 *      a detuned partial for weight.
 *   4. sub — chest pressure, power-gated (only meaningful slaps earn it).
 *   5. tail — low-passed noise wash into the room, the mass settling.
 * Gains and center frequencies scale with power; slight randomization so
 * consecutive slaps never sound copy-pasted.
 *
 * `stretch` is time dilation for the kill cam: durations stretch and
 * frequencies fall into the abyss — but the click keeps most of its edge
 * (sqrt of the dilation), because even in slow motion contact is sharp.
 */
export function playSlap(g: AudioGraph, power01: number, stretch = 1): void {
  const { ctx, dry, wet } = g;
  const t = ctx.currentTime;
  const p = Math.min(Math.max(power01, 0), 1);
  const jitter = 0.9 + Math.random() * 0.2;
  const fDrop = 1 / Math.sqrt(stretch);
  const clickStretch = Math.sqrt(stretch);

  // click — the contact transient
  const click = ctx.createBufferSource();
  click.buffer = noiseBuffer(ctx, 0.01 * clickStretch);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1800 * fDrop;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.09 + 0.28 * p, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.012 * clickStretch);
  click.connect(hp).connect(clickGain).connect(dry);
  click.start(t);

  // crack — skin
  const crack = ctx.createBufferSource();
  crack.buffer = noiseBuffer(ctx, 0.08 * stretch);
  crack.playbackRate.value = fDrop;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = (750 + 1700 * p) * jitter * fDrop;
  bp.Q.value = 0.9;
  const crackGain = ctx.createGain();
  crackGain.gain.setValueAtTime(0.15 + 0.45 * p, t);
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1 * stretch);
  crack.connect(bp).connect(crackGain);
  crackGain.connect(dry);
  crackGain.connect(wet);
  crack.start(t);

  // thump — the mass. Hard pitch drop + a detuned partial for weight.
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime((140 + 60 * p) * jitter * fDrop, t);
  thump.frequency.exponentialRampToValueAtTime(38 * fDrop, t + 0.16 * stretch);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.3 + 0.45 * p, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28 * stretch);
  thump.connect(thumpGain);
  thumpGain.connect(dry);
  thumpGain.connect(wet);
  thump.start(t);
  thump.stop(t + 0.3 * stretch);

  const partial = ctx.createOscillator();
  partial.type = "sine";
  partial.frequency.setValueAtTime((140 + 60 * p) * 1.5 * jitter * fDrop, t);
  partial.frequency.exponentialRampToValueAtTime(
    57 * fDrop,
    t + 0.16 * stretch,
  );
  const partialGain = ctx.createGain();
  partialGain.gain.setValueAtTime((0.3 + 0.45 * p) * 0.35, t);
  partialGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2 * stretch);
  partial.connect(partialGain).connect(dry);
  partial.start(t);
  partial.stop(t + 0.22 * stretch);

  // knock — body cavity
  const knock = ctx.createOscillator();
  knock.type = "triangle";
  knock.frequency.value = 175 * jitter * fDrop;
  const knockGain = ctx.createGain();
  knockGain.gain.setValueAtTime(0.05 + 0.09 * p, t);
  knockGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09 * stretch);
  knock.connect(knockGain).connect(dry);
  knock.start(t);
  knock.stop(t + 0.1 * stretch);

  // sub — chest pressure, earned by power (p² gate: taps carry none)
  const subLevel = 0.45 * p * p;
  if (subLevel > 0.02) {
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(65 * fDrop, t);
    sub.frequency.exponentialRampToValueAtTime(30 * fDrop, t + 0.4 * stretch);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subLevel, t + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5 * stretch);
    sub.connect(subGain).connect(dry);
    sub.start(t);
    sub.stop(t + 0.55 * stretch);
  }

  // tail — the mass settling into the room, mostly wet
  const tail = ctx.createBufferSource();
  tail.buffer = noiseBuffer(ctx, 0.5 * stretch);
  tail.playbackRate.value = fDrop;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 700 * fDrop;
  const tailGain = ctx.createGain();
  tailGain.gain.setValueAtTime(0.08 + 0.22 * p, t + 0.01);
  tailGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5 * stretch);
  const tailDry = ctx.createGain();
  tailDry.gain.value = 0.35;
  tail.connect(lp).connect(tailGain);
  tailGain.connect(tailDry).connect(dry);
  tailGain.connect(wet);
  tail.start(t);
}
