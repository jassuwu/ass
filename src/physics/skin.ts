import type * as THREE from "three/webgpu";
import type { Lattice } from "./lattice";
import type { XpbdSolver } from "./solver";

/**
 * Embeds the render mesh in the lattice: each vertex gets trilinear weights
 * over the 8 particles of its grid cell (renormalized when corners are
 * missing at the surface). Per frame, vertices ride the particles'
 * displacement field and normals are recomputed.
 */
export class MeshSkin {
  private readonly mesh: THREE.Mesh;
  private readonly vertCount: number;
  private readonly base: Float32Array;
  private readonly ids: Int32Array;
  private readonly weights: Float32Array;

  constructor(lattice: Lattice, mesh: THREE.Mesh) {
    this.mesh = mesh;
    const posAttr = mesh.geometry.attributes.position;
    this.vertCount = posAttr.count;
    this.base = new Float32Array(posAttr.array);
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

    // deformations are bounded; grow the bounding sphere once instead of
    // recomputing it per frame
    mesh.geometry.computeBoundingSphere();
    if (mesh.geometry.boundingSphere)
      mesh.geometry.boundingSphere.radius *= 1.4;
  }

  apply(solver: XpbdSolver): void {
    const { pos } = solver;
    const { rest } = solver.lattice;
    const attr = this.mesh.geometry.attributes.position;
    const out = attr.array as Float32Array;

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
      out[v * 3] = this.base[v * 3] + dx;
      out[v * 3 + 1] = this.base[v * 3 + 1] + dy;
      out[v * 3 + 2] = this.base[v * 3 + 2] + dz;
    }

    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    const normal = this.mesh.geometry.attributes.normal;
    if (normal) normal.needsUpdate = true;
  }
}
