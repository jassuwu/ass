/**
 * Fine traveling surface deformation, layered over the coarse lattice
 * dynamics — and deliberately NOT a water ripple. Tissue is dispersive and
 * heavily damped: what travels is a single pushed bulge of displaced fat
 * (derivative-of-gaussian profile: pile-up behind the front, slight
 * compression dent ahead), dying fast with distance. The cheeks are
 * mechanically decoupled at the crease, and the gluteal fold blocks most
 * of what tries to travel into the thigh. Amplitude is further scaled
 * per-vertex by local fat capacity (see MeshSkin) — flesh over bone
 * barely carries it.
 *
 * Advanced on simulation time, so slow motion slows the wavefront too.
 */
export interface RippleParams {
  /** wavefront speed, world units/s — tissue is slow */
  speed: number;
  /** gaussian half-width of the traveling bulge */
  width: number;
  /** amplitude loss per world unit travelled */
  spatialDecay: number;
  /** amplitude loss per second */
  temporalDecay: number;
  /** peak amplitude at full power, world units */
  maxAmp: number;
}

export const defaultRippleParams: RippleParams = {
  speed: 1.7,
  width: 0.22,
  spatialDecay: 1.5,
  temporalDecay: 2.6,
  maxAmp: 0.055,
};

/** y of the gluteal fold — must match the glute/thigh junction in specimen.ts */
const FOLD_Y = -0.72;
/** attenuation for energy crossing the crease / the fold */
const CREASE_ATTEN = 0.12;
const FOLD_ATTEN = 0.3;

interface Ripple {
  x: number;
  y: number;
  z: number;
  /** which cheek it started on */
  side: number;
  aboveFold: boolean;
  age: number;
  amp: number;
}

const MAX_RIPPLES = 5;
/** normalizes the peak of u*exp(-u^2) to ~1 */
const BULGE_NORM = 2.33;

export class RippleField {
  readonly params: RippleParams;
  private list: Ripple[] = [];

  constructor(params: Partial<RippleParams> = {}) {
    this.params = { ...defaultRippleParams, ...params };
  }

  spawn(
    point: { x: number; y: number; z: number },
    power01: number,
    ampScale = 1,
  ): void {
    const amp =
      this.params.maxAmp * (0.25 + 0.75 * Math.min(power01, 1)) * ampScale;
    this.list.push({
      x: point.x,
      y: point.y,
      z: point.z,
      side: Math.sign(point.x) || 1,
      aboveFold: point.y > FOLD_Y,
      age: 0,
      amp,
    });
    if (this.list.length > MAX_RIPPLES) this.list.shift();
  }

  update(simDt: number): void {
    const { temporalDecay } = this.params;
    for (const r of this.list) r.age += simDt;
    this.list = this.list.filter(
      (r) => r.amp * Math.exp(-r.age * temporalDecay) > 0.0015,
    );
  }

  get active(): boolean {
    return this.list.length > 0;
  }

  /** signed surface offset at a rest-space point */
  offsetAt(px: number, py: number, pz: number): number {
    const { speed, width, spatialDecay, temporalDecay } = this.params;
    let sum = 0;
    for (const r of this.list) {
      const front = speed * r.age;
      const dMin = Math.max(0, front - 3 * width);
      const dMax = front + 3 * width;
      const dx = px - r.x;
      const dy = py - r.y;
      const dz = pz - r.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < dMin * dMin || d2 > dMax * dMax) continue;
      const d = Math.sqrt(d2);
      const u = (d - front) / width;
      // pile-up behind the front, compression dent ahead — not rings
      let contribution =
        r.amp *
        -u *
        Math.exp(-u * u) *
        BULGE_NORM *
        Math.exp(-d * spatialDecay - r.age * temporalDecay);
      // the crease decouples the cheeks
      if (Math.sign(px) !== r.side && Math.abs(px) > 0.06) {
        contribution *= CREASE_ATTEN;
      }
      // the fold blocks most of what heads into the thigh
      if (py > FOLD_Y !== r.aboveFold) contribution *= FOLD_ATTEN;
      sum += contribution;
    }
    return sum;
  }
}
