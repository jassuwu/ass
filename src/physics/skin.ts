import type { PalmFrame } from "./hand";
import type { Lattice } from "./lattice";
import type { RippleField } from "./ripples";

/**
 * Embeds the render mesh in the lattice: each vertex gets quadratic
 * B-spline weights over the 27 particles around it (renormalized where
 * particles are missing at the surface). Per frame, vertices ride the
 * particles' displacement field and normals are recomputed from the
 * deformed faces.
 *
 * Pure arrays in, pure arrays out — this runs wherever the solver runs.
 */
export class MeshSkin {
  private readonly vertCount: number;
  private readonly base: Float32Array;
  private readonly baseNormal: Float32Array;
  private readonly index: ArrayLike<number>;
  private readonly ids: Int32Array;
  private readonly weights: Float32Array;
  /** per-vertex jiggle capacity: 1 over deep free fat, ~0 over bone */
  private readonly capacity: Float32Array;

  constructor(
    lattice: Lattice,
    base: Float32Array,
    baseNormal: Float32Array,
    index: ArrayLike<number>,
  ) {
    this.vertCount = base.length / 3;
    this.base = base;
    this.baseNormal = baseNormal;
    this.index = index;
    // Quadratic B-spline embedding: each vertex reads the displacement of
    // the 27 particles around it with C1 weights, so the deformation field
    // has no slope breaks at cell faces. Trilinear over 8 shows every cell
    // as a box the moment the lattice moves; this cannot.
    this.ids = new Int32Array(this.vertCount * 27).fill(-1);
    this.weights = new Float32Array(this.vertCount * 27);

    const { origin, spacing, nx, ny, nz, nodeToParticle, rest, count } =
      lattice;
    const nodeIndex = (i: number, j: number, k: number) =>
      i + j * nx + k * nx * ny;
    const spline = (d: number, out: Float32Array) => {
      // d: offset from the nearest node, in cells, in [-0.5, 0.5]
      out[0] = 0.5 * (0.5 - d) * (0.5 - d);
      out[1] = 0.75 - d * d;
      out[2] = 0.5 * (0.5 + d) * (0.5 + d);
    };
    const wx = new Float32Array(3);
    const wy = new Float32Array(3);
    const wz = new Float32Array(3);

    for (let v = 0; v < this.vertCount; v++) {
      const px = this.base[v * 3];
      const py = this.base[v * 3 + 1];
      const pz = this.base[v * 3 + 2];
      const gx = (px - origin.x) / spacing;
      const gy = (py - origin.y) / spacing;
      const gz = (pz - origin.z) / spacing;
      const ci = Math.min(Math.max(Math.round(gx), 1), nx - 2);
      const cj = Math.min(Math.max(Math.round(gy), 1), ny - 2);
      const ck = Math.min(Math.max(Math.round(gz), 1), nz - 2);
      spline(Math.min(Math.max(gx - ci, -0.5), 0.5), wx);
      spline(Math.min(Math.max(gy - cj, -0.5), 0.5), wy);
      spline(Math.min(Math.max(gz - ck, -0.5), 0.5), wz);

      let total = 0;
      let c = 0;
      for (let dk = -1; dk <= 1; dk++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++, c++) {
            const id = nodeToParticle[nodeIndex(ci + di, cj + dj, ck + dk)];
            if (id === -1) continue;
            const w = wx[di + 1] * wy[dj + 1] * wz[dk + 1];
            this.ids[v * 27 + c] = id;
            this.weights[v * 27 + c] = w;
            total += w;
          }
        }
      }

      if (total > 1e-9) {
        for (let k = 0; k < 27; k++) this.weights[v * 27 + k] /= total;
      } else {
        // surface vertex fell outside every particle's support — bind to
        // the nearest particle outright (rare; the dilation makes it rarer)
        let best = 0;
        let bestD2 = Number.POSITIVE_INFINITY;
        for (let i = 0; i < count; i++) {
          const dx = rest[i * 3] - px;
          const dy = rest[i * 3 + 1] - py;
          const dz = rest[i * 3 + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
        this.ids[v * 27] = best;
        this.weights[v * 27] = 1;
      }
    }

    // fat map: how much free tissue sits under each vertex — the inverse of
    // the anchor field, sampled through the same trilinear weights. Ripples
    // over the sacrum/fold die; over the cheek belly they carry.
    this.capacity = new Float32Array(this.vertCount);
    for (let v = 0; v < this.vertCount; v++) {
      let anchored = 0;
      for (let c = 0; c < 27; c++) {
        const id = this.ids[v * 27 + c];
        if (id === -1) continue;
        anchored += lattice.anchorW[id] * this.weights[v * 27 + c];
      }
      this.capacity[v] = Math.min(Math.max(1 - anchored, 0), 1);
    }
  }

  /**
   * deformed positions and normals for the current particle positions.
   * `palms` are the hands in the flesh right now: the lattice carries their
   * bulk, and here the skin is pushed out of the palm's exact shape at
   * mesh resolution, so the print is a hand and not a stack of cells.
   */
  apply(
    pos: Float32Array,
    rest: Float32Array,
    ripples: RippleField | null,
    outPos: Float32Array,
    outNormal: Float32Array,
    palms: PalmFrame[] = [],
  ): void {
    const rippling = ripples?.active === true;
    for (let v = 0; v < this.vertCount; v++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (let c = 0; c < 27; c++) {
        const id = this.ids[v * 27 + c];
        if (id === -1) continue;
        const w = this.weights[v * 27 + c];
        const i3 = id * 3;
        dx += (pos[i3] - rest[i3]) * w;
        dy += (pos[i3 + 1] - rest[i3 + 1]) * w;
        dz += (pos[i3 + 2] - rest[i3 + 2]) * w;
      }
      const bx = this.base[v * 3];
      const by = this.base[v * 3 + 1];
      const bz = this.base[v * 3 + 2];
      if (rippling && ripples) {
        // fine traveling wave rides on top, along the rest normal,
        // scaled by how much free fat actually sits under this vertex
        const off = ripples.offsetAt(bx, by, bz) * this.capacity[v];
        if (off !== 0) {
          dx += this.baseNormal[v * 3] * off;
          dy += this.baseNormal[v * 3 + 1] * off;
          dz += this.baseNormal[v * 3 + 2] * off;
        }
      }
      outPos[v * 3] = bx + dx;
      outPos[v * 3 + 1] = by + dy;
      outPos[v * 3 + 2] = bz + dz;
    }
    for (const palm of palms) this.refine(palm, outPos);
    this.computeNormals(outPos, outNormal);
  }

  /**
   * Conform the skin to the palm at mesh resolution. Vertices under the
   * face are lifted to it along the blow axis only — never sideways, so
   * nothing piles up on the palm's side into a wall — and the lift is
   * feathered over a band around the edge, so the surface slopes into the
   * print the way skin under tension does instead of stepping.
   */
  private refine(palm: PalmFrame, outPos: Float32Array): void {
    const reach = Math.max(palm.ra, palm.rb) + palm.feather + 0.15;
    const reach2 = reach * reach;
    // feather widths in ellipse-normalised units
    const inner = 1 - palm.rim / Math.min(palm.ra, palm.rb);
    const outer = 1 + palm.feather / Math.min(palm.ra, palm.rb);
    for (let v = 0; v < this.vertCount; v++) {
      const i = v * 3;
      let dx = this.base[i] - palm.cx;
      let dy = this.base[i + 1] - palm.cy;
      let dz = this.base[i + 2] - palm.cz;
      if (dx * dx + dy * dy + dz * dz > reach2) continue;
      dx = outPos[i] - palm.cx;
      dy = outPos[i + 1] - palm.cy;
      dz = outPos[i + 2] - palm.cz;
      const la = dx * palm.ax + dy * palm.ay + dz * palm.az;
      const lb = dx * palm.bx + dy * palm.by + dz * palm.bz;
      const en = Math.hypot(la / palm.ra, lb / palm.rb);
      if (en >= outer) continue;
      // the face, domed: deeper at the centre than the edge
      const a =
        dx * palm.nx +
        dy * palm.ny +
        dz * palm.nz +
        palm.dome * Math.min(en * en, 1);
      if (a >= 0) continue;
      let w = 1;
      if (en > inner) {
        const t = (en - inner) / (outer - inner);
        w = 1 - t * t * (3 - 2 * t);
      }
      const lift = -a * w;
      outPos[i] += palm.nx * lift;
      outPos[i + 1] += palm.ny * lift;
      outPos[i + 2] += palm.nz * lift;
    }
  }

  /** the rest pose straight through: positions and the authored normals */
  rest(outPos: Float32Array, outNormal: Float32Array): void {
    outPos.set(this.base);
    outNormal.set(this.baseNormal);
  }

  /** area-weighted vertex normals, the same recipe as three's */
  private computeNormals(pos: Float32Array, out: Float32Array): void {
    out.fill(0);
    const index = this.index;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t] * 3;
      const b = index[t + 1] * 3;
      const c = index[t + 2] * 3;
      const abx = pos[b] - pos[a];
      const aby = pos[b + 1] - pos[a + 1];
      const abz = pos[b + 2] - pos[a + 2];
      const acx = pos[c] - pos[a];
      const acy = pos[c + 1] - pos[a + 1];
      const acz = pos[c + 2] - pos[a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      out[a] += nx;
      out[a + 1] += ny;
      out[a + 2] += nz;
      out[b] += nx;
      out[b + 1] += ny;
      out[b + 2] += nz;
      out[c] += nx;
      out[c + 1] += ny;
      out[c + 2] += nz;
    }
    for (let v = 0; v < out.length; v += 3) {
      const inv = 1 / (Math.hypot(out[v], out[v + 1], out[v + 2]) || 1);
      out[v] *= inv;
      out[v + 1] *= inv;
      out[v + 2] *= inv;
    }
  }
}
