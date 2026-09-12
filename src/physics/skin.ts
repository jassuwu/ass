import type { Lattice } from "./lattice";
import type { RippleField } from "./ripples";

/**
 * Embeds the render mesh in the lattice: each vertex gets trilinear weights
 * over the 8 particles of its grid cell (renormalized when corners are
 * missing at the surface). Per frame, vertices ride the particles'
 * displacement field and normals are recomputed from the deformed faces.
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
    this.ids = new Int32Array(this.vertCount * 8).fill(-1);
    this.weights = new Float32Array(this.vertCount * 8);

    const { origin, spacing, nx, ny, nz, nodeToParticle, rest, count } =
      lattice;
    const nodeIndex = (i: number, j: number, k: number) =>
      i + j * nx + k * nx * ny;

    for (let v = 0; v < this.vertCount; v++) {
      const px = this.base[v * 3];
      const py = this.base[v * 3 + 1];
      const pz = this.base[v * 3 + 2];
      const gx = (px - origin.x) / spacing;
      const gy = (py - origin.y) / spacing;
      const gz = (pz - origin.z) / spacing;
      const ci = Math.min(Math.max(Math.floor(gx), 0), nx - 2);
      const cj = Math.min(Math.max(Math.floor(gy), 0), ny - 2);
      const ck = Math.min(Math.max(Math.floor(gz), 0), nz - 2);
      const fx = Math.min(Math.max(gx - ci, 0), 1);
      const fy = Math.min(Math.max(gy - cj, 0), 1);
      const fz = Math.min(Math.max(gz - ck, 0), 1);

      let total = 0;
      for (let c = 0; c < 8; c++) {
        const dx = c & 1;
        const dy = (c >> 1) & 1;
        const dz = (c >> 2) & 1;
        const id = nodeToParticle[nodeIndex(ci + dx, cj + dy, ck + dz)];
        if (id === -1) continue;
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        this.ids[v * 8 + c] = id;
        this.weights[v * 8 + c] = w;
        total += w;
      }

      if (total > 1e-9) {
        for (let c = 0; c < 8; c++) this.weights[v * 8 + c] /= total;
      } else {
        // surface vertex fell in a cell with no particles — bind to the
        // nearest particle outright (rare; the dilation makes it rarer)
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
        this.ids[v * 8] = best;
        this.weights[v * 8] = 1;
      }
    }

    // fat map: how much free tissue sits under each vertex — the inverse of
    // the anchor field, sampled through the same trilinear weights. Ripples
    // over the sacrum/fold die; over the cheek belly they carry.
    this.capacity = new Float32Array(this.vertCount);
    for (let v = 0; v < this.vertCount; v++) {
      let anchored = 0;
      for (let c = 0; c < 8; c++) {
        const id = this.ids[v * 8 + c];
        if (id === -1) continue;
        anchored += lattice.anchorW[id] * this.weights[v * 8 + c];
      }
      this.capacity[v] = Math.min(Math.max(1 - anchored, 0), 1);
    }
  }

  /** deformed positions and normals for the current particle positions */
  apply(
    pos: Float32Array,
    rest: Float32Array,
    ripples: RippleField | null,
    outPos: Float32Array,
    outNormal: Float32Array,
  ): void {
    const rippling = ripples?.active === true;
    for (let v = 0; v < this.vertCount; v++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (let c = 0; c < 8; c++) {
        const id = this.ids[v * 8 + c];
        if (id === -1) continue;
        const w = this.weights[v * 8 + c];
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
    this.computeNormals(outPos, outNormal);
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
