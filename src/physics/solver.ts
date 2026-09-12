import type * as THREE from "three/webgpu";
import {
  type ContactReport,
  defaultHandParams,
  Hand,
  type HandParams,
} from "./hand";
import type { Lattice } from "./lattice";
import { preserveVolume } from "./volume";

/**
 * XPBD soft body in the small-substeps style (Müller et al.): many cheap
 * substeps, one constraint iteration each. Equal unit masses everywhere;
 * attachment to the body is a graded soft pull toward rest driven by the
 * lattice's anchor field, so the free flesh jiggles and the base holds.
 *
 * Tissue, not jelly: local volume is conserved (a dent has to go
 * somewhere), skin resists stretch far more than fat resists squash, and
 * damping is between neighbours — fine shiver dies in a few frames while
 * the cheek's own slow wobble survives a couple of swings.
 */
export interface SolverParams {
  substeps: number;
  /** distance-constraint compliance; lower = stiffer flesh */
  compliance: number;
  /** compliance multiplier when an edge is stretched beyond rest (<1) */
  tensionRatio: number;
  /** local volume compliance; far lower than stretch compliance */
  volumeCompliance: number;
  /** 1/s — pull toward rest for anchored particles */
  anchorRate: number;
  /** 1/s — weak global shape memory so everything eventually settles home */
  shapeMemoryRate: number;
  /** 1/s — bulk velocity decay; sets how many wobbles survive */
  damping: number;
  /** 1/s — neighbour-relative velocity decay; kills shiver, not wobble */
  viscosity: number;
  /** hard displacement clamp, safety against heroic impulses */
  maxDisplacement: number;
}

export const defaultSolverParams: SolverParams = {
  substeps: 8,
  compliance: 1.5e-4,
  tensionRatio: 0.35,
  volumeCompliance: 1e-9,
  anchorRate: 70,
  shapeMemoryRate: 9,
  damping: 1.2,
  viscosity: 20,
  maxDisplacement: 0.55,
};

export class XpbdSolver {
  readonly lattice: Lattice;
  readonly params: SolverParams;
  readonly hand: HandParams;
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly vel: Float32Array;

  /** set on any external disturbance; the app uses it to wake the sim */
  stirred = false;
  /** fired once per slap when the palm reaches its depth */
  onContact: ((report: ContactReport) => void) | null = null;
  /** fired once per slap the moment the palm starts to peel away */
  onRelease: ((report: ContactReport) => void) | null = null;
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

  /** hands currently in the flesh */
  private hands: Hand[] = [];
  private reports = new Map<Hand, ContactReport>();

  constructor(
    lattice: Lattice,
    params: Partial<SolverParams> = {},
    hand: Partial<HandParams> = {},
  ) {
    this.lattice = lattice;
    this.params = { ...defaultSolverParams, ...params };
    this.hand = { ...defaultHandParams, ...hand };
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
    this.hands.length = 0;
    this.reports.clear();
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

  /** true while a hand is still in the flesh */
  get pressing(): boolean {
    return this.hands.length > 0;
  }

  /**
   * A slap: a palm lands at `point` travelling along `dir`, carrying the
   * swipe's tangential velocity, and the flesh does the rest — see Hand.
   * @param strength swing strength; sets arrival speed and arm push
   * @param radius nominal palm radius, world units
   */
  slap(
    point: THREE.Vector3,
    dir: THREE.Vector3,
    tangential: THREE.Vector3,
    strength: number,
    radius: number,
  ): void {
    if (dir.lengthSq() < 1e-12) return;
    this.stirred = true;
    this.hands.push(
      new Hand(
        this.lattice,
        this.hand,
        point,
        dir,
        tangential,
        strength,
        radius,
      ),
    );
  }

  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const { lattice, pos, prev, vel, params } = this;
    const n = lattice.count;
    const { rest, anchorW, cA, cB, cRest } = lattice;
    const h = dt / params.substeps;
    const velDecay = Math.exp(-params.damping * h);
    const memory = 1 - Math.exp(-params.shapeMemoryRate * h);
    const alpha = params.compliance / (h * h);
    const alphaTension = alpha * params.tensionRatio;
    const volumeAlpha = params.volumeCompliance / (h * h);
    // pairwise viscous exchange: each constraint pair shares its velocity
    // difference by this fraction per substep (halved: applied to both ends)
    const visc = 0.5 * (1 - Math.exp(-params.viscosity * h));
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

      // distance constraints, one XPBD iteration; stretched edges are
      // stiffer than squashed ones (skin vs fat)
      for (let c = 0; c < cA.length; c++) {
        const ia = cA[c] * 3;
        const ib = cB[c] * 3;
        const dx = pos[ib] - pos[ia];
        const dy = pos[ib + 1] - pos[ia + 1];
        const dz = pos[ib + 2] - pos[ia + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const r = cRest[c];
        const corr = (len - r) / ((2 + (len > r ? alphaTension : alpha)) * len);
        pos[ia] += dx * corr;
        pos[ia + 1] += dy * corr;
        pos[ia + 2] += dz * corr;
        pos[ib] -= dx * corr;
        pos[ib + 1] -= dy * corr;
        pos[ib + 2] -= dz * corr;
      }

      // hands before volume: the palm is rigid, and what the volume
      // constraint pushes back into it is the reaction the hand feels next
      for (const hand of this.hands) hand.step(h, pos, prev);

      preserveVolume(pos, lattice, volumeAlpha);

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

      // neighbour viscosity: relative velocity between linked particles is
      // shared out, which is what makes tissue dispersive rather than ringing
      if (visc > 0) {
        for (let c = 0; c < cA.length; c++) {
          const ia = cA[c] * 3;
          const ib = cB[c] * 3;
          const dvx = (vel[ib] - vel[ia]) * visc;
          const dvy = (vel[ib + 1] - vel[ia + 1]) * visc;
          const dvz = (vel[ib + 2] - vel[ia + 2]) * visc;
          vel[ia] += dvx;
          vel[ia + 1] += dvy;
          vel[ia + 2] += dvz;
          vel[ib] -= dvx;
          vel[ib + 1] -= dvy;
          vel[ib + 2] -= dvz;
        }
      }
    }

    if (this.hands.length > 0) {
      for (const hand of this.hands) {
        const report = hand.takeReport();
        if (report) {
          this.reports.set(hand, report);
          this.onContact?.(report);
        }
        if (hand.takeRelease()) {
          const r = this.reports.get(hand);
          if (r) this.onRelease?.(r);
        }
      }
      this.hands = this.hands.filter((hand) => {
        if (!hand.done) return true;
        this.reports.delete(hand);
        return false;
      });
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
   * Velocity kick with gaussian falloff around a surface point — the brush
   * and the fling, where no palm is planted.
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
