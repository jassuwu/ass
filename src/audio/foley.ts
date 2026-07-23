import { type AudioGraph, noiseBuffer } from "./engine";

/**
 * Flesh slap, three layers: the crack (band-passed noise burst — skin on
 * skin), the thump (low sine drop — mass moving), and a short mid knock
 * (body cavity). Center frequency and gains scale with impact power;
 * slight randomization so consecutive slaps never sound copy-pasted.
 */
export function playSlap(g: AudioGraph, power01: number, stretch = 1): void {
  const { ctx, dry, wet } = g;
  const t = ctx.currentTime;
  const p = Math.min(Math.max(power01, 0), 1);
  const jitter = 0.9 + Math.random() * 0.2;
  // time dilation: durations stretch, frequencies fall into the abyss
  const fDrop = 1 / Math.sqrt(stretch);

  // crack
  const crack = ctx.createBufferSource();
  crack.buffer = noiseBuffer(ctx, 0.06 * stretch);
  crack.playbackRate.value = fDrop;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = (750 + 1700 * p) * jitter * fDrop;
  bp.Q.value = 0.8;
  const crackGain = ctx.createGain();
  crackGain.gain.setValueAtTime(0.12 + 0.42 * p, t);
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09 * stretch);
  crack.connect(bp).connect(crackGain);
  crackGain.connect(dry);
  crackGain.connect(wet);
  crack.start(t);

  // thump
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime((90 + 35 * p) * jitter * fDrop, t);
  thump.frequency.exponentialRampToValueAtTime(44 * fDrop, t + 0.14 * stretch);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.22 + 0.34 * p, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.24 * stretch);
  thump.connect(thumpGain);
  thumpGain.connect(dry);
  thumpGain.connect(wet);
  thump.start(t);
  thump.stop(t + 0.26 * stretch);

  // knock
  const knock = ctx.createOscillator();
  knock.type = "triangle";
  knock.frequency.value = 175 * jitter * fDrop;
  const knockGain = ctx.createGain();
  knockGain.gain.setValueAtTime(0.05 + 0.09 * p, t);
  knockGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09 * stretch);
  knock.connect(knockGain).connect(dry);
  knock.start(t);
  knock.stop(t + 0.1 * stretch);
}
