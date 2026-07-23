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
};

export class XpbdSolver {
  readonly lattice: Lattice;
  readonly params: SolverParams;
  readonly pos: Float32Array;
  private readonly prev: Float32Array;
  private readonly vel: Float32Array;

  constructor(lattice: Lattice, params: Partial<SolverParams> = {}) {
    this.lattice = lattice;
    this.params = { ...defaultSolverParams, ...params };
    this.pos = lattice.rest.slice();
    this.prev = lattice.rest.slice();
    this.vel = new Float32Array(lattice.count * 3);
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
