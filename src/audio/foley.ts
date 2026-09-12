import type { AudioGraph } from "./engine";
import type { BankName, SampleBank } from "./samples";

/**
 * Hand on flesh from real recordings, layered the way foley is cut:
 *
 *   crack — the hand itself, a recorded skin slap, at the instant of
 *           contact. Harder swings play louder and a touch lower; a
 *           glancing swipe thins it out.
 *   body  — a recorded slap on a buttock, the mass under the palm, fired
 *           when the solver says the flesh has bottomed out. Deeper and
 *           wider contact plays it louder and lower; bone tightens it.
 *   pat   — gentle pats and grabs, for taps that barely land and for a
 *           handful let go.
 *
 * Every hit is placed in the stereo field by which cheek it landed on.
 * `stretch` is the kill cam's time dilation: the recordings play at
 * 1/stretch speed, which is exactly what slow-motion sound is — and the
 * lens is right on the skin, so the room falls away and the hit is close.
 */
export interface FoleyLevels {
  /** which recording carries the crack */
  crackBank: "crack" | "leg";
  crack: number;
  body: number;
  pat: number;
  /** how much of each hit goes to the room */
  room: number;
}

export const defaultFoleyLevels: FoleyLevels = {
  crackBank: "crack",
  crack: 0.9,
  body: 0.8,
  pat: 0.7,
  room: 0.35,
};

export interface ContactSound {
  power01: number;
  radius: number;
  swipe01: number;
  stretch?: number;
  /** where it landed, world x — sets the stereo position */
  x?: number;
}

export interface BodySound {
  depth01: number;
  area: number;
  firmness: number;
  stretch?: number;
  x?: number;
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
/** a cheek at x=±0.5 sits a little off centre; the kill cam is on top of it */
const panFor = (x: number | undefined, stretch: number) =>
  x === undefined
    ? 0
    : Math.min(Math.max(x * (stretch > 1 ? 1.2 : 0.7), -0.8), 0.8);
/** in the close-up the room falls away and the hit is right at the lens */
const roomFor = (room: number, stretch: number) =>
  stretch > 1 ? room * 0.35 : room;
const closeFor = (stretch: number) => (stretch > 1 ? 1.25 : 1);

/** the crack — fire at the instant of contact */
export function playContact(
  g: AudioGraph,
  bank: SampleBank,
  lv: FoleyLevels,
  s: ContactSound,
): void {
  const p = clamp01(s.power01);
  const swipe = clamp01(s.swipe01);
  const stretch = s.stretch ?? 1;
  const pan = panFor(s.x, stretch);
  // a light tap is a pat, not a slap; the crack fades in with power
  if (p < 0.12) {
    bank.play(g, "pat", {
      gain: lv.pat * (0.5 + 2 * p),
      rate: 1 / stretch,
      wet: lv.room * 0.5,
      pan,
    });
    return;
  }
  const level =
    lv.crack * (0.22 + 0.78 * p) * (1 - 0.45 * swipe) * closeFor(stretch);
  // a bigger palm and a harder hit sit lower; a swipe skips higher
  const rate =
    (1.06 - 0.1 * p - 0.12 * (s.radius - 0.45) + 0.08 * swipe) / stretch;
  bank.play(g, lv.crackBank as BankName, {
    gain: level,
    rate,
    spread: 0.05,
    wet: roomFor(lv.room, stretch),
    pan,
  });
}

/** the body — fire when the flesh under the palm bottoms out */
export function playBody(
  g: AudioGraph,
  bank: SampleBank,
  lv: FoleyLevels,
  s: BodySound,
): void {
  const depth = clamp01(s.depth01);
  const firm = clamp01(s.firmness);
  const area = clamp01(s.area / 0.5);
  const stretch = s.stretch ?? 1;
  const level =
    lv.body *
    (0.1 + 0.9 * depth) *
    (0.5 + 0.5 * area) *
    (1 - 0.4 * firm) *
    closeFor(stretch);
  if (level < 0.03) return;
  bank.play(g, "body", {
    gain: level,
    // more tissue: lower. bone: tighter, brighter
    rate: (0.96 - 0.14 * depth + 0.12 * firm) / stretch,
    spread: 0.04,
    lowpass: firm > 0.4 ? undefined : 3200 + 3000 * (1 - depth),
    wet: roomFor(lv.room, stretch),
    pan: panFor(s.x, stretch),
  });
}

/** a handful let go: it falls back against itself with a soft pat */
export function playPat(
  g: AudioGraph,
  bank: SampleBank,
  lv: FoleyLevels,
  power01: number,
  x?: number,
): void {
  const p = clamp01(power01);
  const pan = panFor(x, 1);
  bank.play(g, "pat", {
    gain: lv.pat * (0.4 + 0.8 * p),
    rate: 0.95,
    wet: lv.room * 0.5,
    pan,
  });
  if (p > 0.5) {
    bank.play(g, "body", {
      gain: lv.body * 0.35 * p,
      rate: 0.9,
      lowpass: 1800,
      when: g.ctx.currentTime + 0.012,
      pan,
    });
  }
}
