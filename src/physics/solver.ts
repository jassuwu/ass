import type * as THREE from "three/webgpu";
import type { Lattice } from "./lattice";

/**
 * XPBD soft body in the small-substeps style (Müller et al.): many cheap
 * substeps, one constraint iteration each. Equal unit masses everywhere;
 * attachment to the body is a graded soft pull toward rest driven by the
 * lattice's anchor field, so the free flesh jiggles and the base holds.
 */
export interface SolverParams {
  substeps: number;
  /** distance-constraint compliance; lower = stiffer flesh */
  compliance: number;
  /** 1/s — pull toward rest for anchored particles */
  anchorRate: number;
  /** 1/s — weak global shape memory so everything eventually settles home */
  shapeMemoryRate: number;
  /** 1/s — velocity decay; sets how many wobbles survive */
  damping: number;
  /** hard displacement clamp, safety against heroic impulses */
  maxDisplacement: number;
  /** contact dent depth per unit of slap strength, world units */
  pressDepthScale: number;
  /** seconds for the hand to drive in / stay planted / peel away */
  pressAttackS: number;
  pressHoldS: number;
  pressReleaseS: number;
  /** 1/s — how crisply flesh chases the hand through the press */
  pressRate: number;
  /** sideways flesh-splash velocity per unit strength */
  splashGain: number;
}

// Tuned away from "jelly": flesh is taut (low compliance), heavily damped
// (~1.5 visible oscillations, not six), and recovers its shape briskly.
export const defaultSolverParams: SolverParams = {
  substeps: 8,
  compliance: 1.5e-4,
  anchorRate: 70,
  shapeMemoryRate: 5,
  damping: 3.8,
  maxDisplacement: 0.55,
  pressDepthScale: 0.075,
  pressAttackS: 0.035,
  pressHoldS: 0.045,
  pressReleaseS: 0.11,
  pressRate: 90,
  splashGain: 0.5,
};

/**
 * A landed hand, alive for ~200ms: flesh near the contact point is DRIVEN
 * toward a dented target (not kicked), held there, then released. The dent
 * is what a slap actually looks like — the jiggle is only the recovery.
 */
interface Press {
  ids: number[];
  w: number[];
  /** REST positions — the dent is carved as an absolute target, so rapid
   * consecutive slaps re-press to the same depth instead of ratcheting the
   * flesh ever deeper (which buckles lattice cells into folded states the
   * constraints are happy with — a permanent dent) */
  base: Float32Array;
  /** unit direction of the blow, pointing into the flesh */
  ux: number;
  uy: number;
  uz: number;
  depth: number;
  age: number;
}

const smooth01 = (s: number) => s * s * (3 - 2 * s);

export class XpbdSolver {
  readonly lattice: Lattice;
  readonly params: SolverParams;
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly vel: Float32Array;

  /** set on any external disturbance; the app uses it to wake the sim */
  stirred = false;
  private maxSpeed2 = 0;
  private maxDisp2 = 0;

  // grab state: a handful of flesh follows the cursor with a soft pull
  private grabIds: number[] = [];
  private grabW: number[] = [];
  private grabBase: Float32Array | null = null;
  private readonly grabOffset = { x: 0, y: 0, z: 0 };
  private grabbing = false;
  /** 1/s — how eagerly grabbed flesh follows the hand */
  grabRate = 45;

  /** hands currently planted in the flesh (spanks in flight) */
  private presses: Press[] = [];

  constructor(lattice: Lattice, params: Partial<SolverParams> = {}) {
    this.lattice = lattice;
    this.params = { ...defaultSolverParams, ...params };
    this.pos = lattice.rest.slice();
    this.prev = lattice.rest.slice();
    this.vel = new Float32Array(lattice.count * 3);
  }

  /** true when motion has decayed below visible thresholds (<~1px) */
  get settled(): boolean {
    return this.maxSpeed2 < 1e-4 && this.maxDisp2 < 4e-6;
  }

  /** snap home — called once before sleeping so there is no drift */
  reset(): void {
    this.pos.set(this.lattice.rest);
    this.prev.set(this.lattice.rest);
    this.vel.fill(0);
    this.presses.length = 0;
    this.maxSpeed2 = 0;
    this.maxDisp2 = 0;
  }

  startGrab(point: THREE.Vector3, radius: number): void {
    this.stirred = true;
    this.grabIds.length = 0;
    this.grabW.length = 0;
    const sigma = radius * 0.6;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const cutoff2 = (radius * 1.8) ** 2;
    const { pos } = this;
    for (let i = 0; i < this.lattice.count; i++) {
      const i3 = i * 3;
      const dx = pos[i3] - point.x;
      const dy = pos[i3 + 1] - point.y;
      const dz = pos[i3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > cutoff2) continue;
      this.grabIds.push(i);
      this.grabW.push(Math.exp(-d2 * inv2s2));
    }
    this.grabBase = new Float32Array(this.grabIds.length * 3);
    for (let k = 0; k < this.grabIds.length; k++) {
      const i3 = this.grabIds[k] * 3;
      this.grabBase[k * 3] = pos[i3];
      this.grabBase[k * 3 + 1] = pos[i3 + 1];
      this.grabBase[k * 3 + 2] = pos[i3 + 2];
    }
    this.grabOffset.x = 0;
    this.grabOffset.y = 0;
    this.grabOffset.z = 0;
    this.grabbing = true;
  }

  setGrabOffset(offset: THREE.Vector3): void {
    this.stirred = true;
    this.grabOffset.x = offset.x;
    this.grabOffset.y = offset.y;
    this.grabOffset.z = offset.z;
  }

  /** release — flesh keeps its velocity and flings back on its own */
  endGrab(): void {
    this.grabbing = false;
    this.grabBase = null;
  }

  /** true while a landed hand is still in the flesh */
  get pressing(): boolean {
    return this.presses.length > 0;
  }

  /**
   * A slap, done the way a slap actually works: the hand arrives and
   * OCCUPIES SPACE. Flesh under the palm is driven inward to a dented
   * target and held for a beat (the Press), the displaced volume squirts
   * sideways around the rim (radial splash velocities), and only a small
   * follow-through kick travels along the blow itself. The rebound jiggle
   * is not injected — it is the lattice recovering once the hand leaves.
   */
  spank(
    point: THREE.Vector3,
    dir: THREE.Vector3,
    strength: number,
    radius: number,
  ): void {
    this.stirred = true;
    const { pos, vel, lattice, params } = this;
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (len < 1e-9) return;
    const ux = dir.x / len;
    const uy = dir.y / len;
    const uz = dir.z / len;
    // capped by the lattice resolution: a dent deeper than ~1.5 cells
    // crushes the grid past the point where it can unfold again
    const depth = Math.min(
      0.05 + strength * params.pressDepthScale,
      params.maxDisplacement * 0.8,
      lattice.spacing * 1.5,
    );
    const sigma = radius * 0.55;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const cutoff2 = (radius * 1.8) ** 2;
    // rim profile peaks at d = sigma (the edge of the palm), normalized to 1
    const rimNorm = Math.exp(0.5);
    const followKick = strength * 0.3;
    const splash = strength * params.splashGain;

    const ids: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < lattice.count; i++) {
      const i3 = i * 3;
      const dx = pos[i3] - point.x;
      const dy = pos[i3 + 1] - point.y;
      const dz = pos[i3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > cutoff2) continue;
      const g = Math.exp(-d2 * inv2s2);
      ids.push(i);
      w.push(g);
      // follow-through: a little momentum still travels with the blow
      vel[i3] += ux * followKick * g;
      vel[i3 + 1] += uy * followKick * g;
      vel[i3 + 2] += uz * followKick * g;
      // splash: displaced flesh squirts sideways, away from the palm,
      // strongest at the rim of contact where the volume has to go
      const axial = dx * ux + dy * uy + dz * uz;
      const lx = dx - ux * axial;
      const ly = dy - uy * axial;
      const lz = dz - uz * axial;
      const lat = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (lat > 1e-6) {
        const d = Math.sqrt(d2);
        const rim = (d / sigma) * g * rimNorm;
        const f = (splash * rim) / lat;
        vel[i3] += lx * f;
        vel[i3 + 1] += ly * f;
        vel[i3 + 2] += lz * f;
      }
    }
    if (ids.length === 0) return;
    const { rest } = lattice;
    const base = new Float32Array(ids.length * 3);
    for (let k = 0; k < ids.length; k++) {
      const i3 = ids[k] * 3;
      base[k * 3] = rest[i3];
      base[k * 3 + 1] = rest[i3 + 1];
      base[k * 3 + 2] = rest[i3 + 2];
    }
    this.presses.push({ ids, w, base, ux, uy, uz, depth, age: 0 });
  }

  /** press envelope: drive in fast, plant, peel away — 0 when spent */
  private pressEnv(age: number): number {
    const p = this.params;
    if (age < p.pressAttackS) return smooth01(age / p.pressAttackS);
    const held = age - p.pressAttackS - p.pressHoldS;
    if (held < 0) return 1;
    if (held >= p.pressReleaseS) return 0;
    return 1 - smooth01(held / p.pressReleaseS);
  }

  step(dt: number): void {
    const { lattice, pos, prev, vel, params } = this;
    const n = lattice.count;
    const { rest, anchorW, cA, cB, cRest } = lattice;
    const h = dt / params.substeps;
    const velDecay = Math.exp(-params.damping * h);
    const memory = 1 - Math.exp(-params.shapeMemoryRate * h);
    const alpha = params.compliance / (h * h);
    const maxDisp2 = params.maxDisplacement * params.maxDisplacement;

    for (let s = 0; s < params.substeps; s++) {
      // integrate
      for (let i = 0; i < n * 3; i++) {
        prev[i] = pos[i];
        vel[i] *= velDecay;
        pos[i] += vel[i] * h;
      }

      // graded attachment + shape memory
      for (let i = 0; i < n; i++) {
        const pull = Math.min(
          1,
          1 - Math.exp(-params.anchorRate * anchorW[i] * h) + memory,
        );
        const i3 = i * 3;
        pos[i3] += (rest[i3] - pos[i3]) * pull;
        pos[i3 + 1] += (rest[i3 + 1] - pos[i3 + 1]) * pull;
        pos[i3 + 2] += (rest[i3 + 2] - pos[i3 + 2]) * pull;
      }

      // grabbed flesh chases the hand (anchors below still resist, so a
      // handful near the bone simply refuses to travel far — correct)
      if (this.grabbing && this.grabBase) {
        const k = 1 - Math.exp(-this.grabRate * h);
        const o = this.grabOffset;
        for (let g = 0; g < this.grabIds.length; g++) {
          const w = this.grabW[g];
          const i3 = this.grabIds[g] * 3;
          const tx = this.grabBase[g * 3] + o.x * w;
          const ty = this.grabBase[g * 3 + 1] + o.y * w;
          const tz = this.grabBase[g * 3 + 2] + o.z * w;
          pos[i3] += (tx - pos[i3]) * k;
          pos[i3 + 1] += (ty - pos[i3 + 1]) * k;
          pos[i3 + 2] += (tz - pos[i3 + 2]) * k;
        }
      }

      // landed hands: flesh chases the dented target through the press
      // envelope. Anchored particles resist (musculature dents less), and
      // the recovery on release is the lattice's own — never scripted.
      for (const pr of this.presses) {
        pr.age += h;
        const e = this.pressEnv(pr.age);
        if (e <= 0) continue;
        const k = 1 - Math.exp(-params.pressRate * h);
        const push = pr.depth * e;
        for (let g = 0; g < pr.ids.length; g++) {
          const wg = pr.w[g] * push;
          const i3 = pr.ids[g] * 3;
          const tx = pr.base[g * 3] + pr.ux * wg;
          const ty = pr.base[g * 3 + 1] + pr.uy * wg;
          const tz = pr.base[g * 3 + 2] + pr.uz * wg;
          pos[i3] += (tx - pos[i3]) * k;
          pos[i3 + 1] += (ty - pos[i3 + 1]) * k;
          pos[i3 + 2] += (tz - pos[i3 + 2]) * k;
        }
      }

      // distance constraints, one XPBD iteration
      for (let c = 0; c < cA.length; c++) {
        const ia = cA[c] * 3;
        const ib = cB[c] * 3;
        const dx = pos[ib] - pos[ia];
        const dy = pos[ib + 1] - pos[ia + 1];
        const dz = pos[ib + 2] - pos[ia + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const corr = (len - cRest[c]) / ((2 + alpha) * len);
        pos[ia] += dx * corr;
        pos[ia + 1] += dy * corr;
        pos[ia + 2] += dz * corr;
        pos[ib] -= dx * corr;
        pos[ib + 1] -= dy * corr;
        pos[ib + 2] -= dz * corr;
      }

      // hard safety clamp against tearing the specimen apart
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const dx = pos[i3] - rest[i3];
        const dy = pos[i3 + 1] - rest[i3 + 1];
        const dz = pos[i3 + 2] - rest[i3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxDisp2) {
          const scale = params.maxDisplacement / Math.sqrt(d2);
          pos[i3] = rest[i3] + dx * scale;
          pos[i3 + 1] = rest[i3 + 1] + dy * scale;
          pos[i3 + 2] = rest[i3 + 2] + dz * scale;
        }
      }

      // velocities from positions
      const invH = 1 / h;
      for (let i = 0; i < n * 3; i++) {
        vel[i] = (pos[i] - prev[i]) * invH;
      }
    }

    if (this.presses.length > 0) {
      const spent =
        params.pressAttackS + params.pressHoldS + params.pressReleaseS;
      this.presses = this.presses.filter((pr) => pr.age < spent);
    }

    // settle detection for the sleep state
    let ms2 = 0;
    let md2 = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const v2 =
        vel[i3] * vel[i3] +
        vel[i3 + 1] * vel[i3 + 1] +
        vel[i3 + 2] * vel[i3 + 2];
      if (v2 > ms2) ms2 = v2;
      const dx = pos[i3] - rest[i3];
      const dy = pos[i3 + 1] - rest[i3 + 1];
      const dz = pos[i3 + 2] - rest[i3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > md2) md2 = d2;
    }
    this.maxSpeed2 = ms2;
    this.maxDisp2 = md2;
  }

  /**
   * Velocity kick with gaussian falloff around a surface point.
   * @param strength peak velocity change, world units/s
   */
  impulse(
    point: THREE.Vector3,
    dir: THREE.Vector3,
    strength: number,
    radius: number,
  ): void {
    this.stirred = true;
    const { pos, vel, lattice } = this;
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (len < 1e-9) return;
    const ux = dir.x / len;
    const uy = dir.y / len;
    const uz = dir.z / len;
    const sigma = radius * 0.55;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const cutoff2 = (radius * 1.6) ** 2;
    for (let i = 0; i < lattice.count; i++) {
      const i3 = i * 3;
      const dx = pos[i3] - point.x;
      const dy = pos[i3 + 1] - point.y;
      const dz = pos[i3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > cutoff2) continue;
      const f = strength * Math.exp(-d2 * inv2s2);
      vel[i3] += ux * f;
      vel[i3 + 1] += uy * f;
      vel[i3 + 2] += uz * f;
    }
  }
}
