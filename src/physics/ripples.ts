/**
 * Fine traveling surface waves, layered over the coarse lattice dynamics.
 * The XPBD lattice carries mass and jiggle; this carries the ring that
 * crawls outward from an impact — the detail the kill cam dives in to see.
 * Advanced on simulation time, so slow motion slows the wavefront too.
 */
export interface RippleParams {
  /** wavefront speed, world units/s */
  speed: number;
  wavelength: number;
  /** gaussian half-width of the wave packet */
  width: number;
  /** amplitude loss per world unit travelled */
  spatialDecay: number;
  /** amplitude loss per second */
  temporalDecay: number;
  /** peak amplitude at full power, world units */
  maxAmp: number;
}

export const defaultRippleParams: RippleParams = {
  speed: 2.1,
  wavelength: 0.34,
  width: 0.16,
  spatialDecay: 0.9,
  temporalDecay: 2.1,
  maxAmp: 0.045,
};

interface Ripple {
  x: number;
  y: number;
  z: number;
  age: number;
  amp: number;
}

const MAX_RIPPLES = 5;

export class RippleField {
  readonly params: RippleParams;
  private list: Ripple[] = [];

  constructor(params: Partial<RippleParams> = {}) {
    this.params = { ...defaultRippleParams, ...params };
  }

  spawn(point: { x: number; y: number; z: number }, power01: number): void {
    const amp = this.params.maxAmp * (0.25 + 0.75 * Math.min(power01, 1));
    this.list.push({ x: point.x, y: point.y, z: point.z, age: 0, amp });
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
    const { speed, wavelength, width, spatialDecay, temporalDecay } =
      this.params;
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
      sum +=
        r.amp *
        Math.exp(-u * u) *
        Math.cos(((d - front) * 2 * Math.PI) / wavelength) *
        Math.exp(-d * spatialDecay - r.age * temporalDecay);
    }
    return sum;
  }
}
