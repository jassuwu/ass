import type { Lattice } from "./lattice";

/**
 * Local volume conservation makes a press displace tissue instead of
 * crushing it. One XPBD projection per small substep, equal unit masses.
 * C = 6(V - Vrest); gradients are opposite-face cross products.
 * https://matthias-research.github.io/pages/tenMinutePhysics/09-xpbd.pdf
 */
export function preserveVolume(
  pos: Float32Array,
  lattice: Lattice,
  alpha: number,
): void {
  const { tetrahedra: ids, restVolume6 } = lattice;
  for (let t = 0; t < ids.length; t += 4) {
    const a = ids[t] * 3,
      b = ids[t + 1] * 3,
      c = ids[t + 2] * 3,
      d = ids[t + 3] * 3;
    const ux = pos[b] - pos[a],
      uy = pos[b + 1] - pos[a + 1],
      uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a],
      vy = pos[c + 1] - pos[a + 1],
      vz = pos[c + 2] - pos[a + 2];
    const wx = pos[d] - pos[a],
      wy = pos[d + 1] - pos[a + 1],
      wz = pos[d + 2] - pos[a + 2];
    const bx = vy * wz - vz * wy,
      by = vz * wx - vx * wz,
      bz = vx * wy - vy * wx;
    const cx = wy * uz - wz * uy,
      cy = wz * ux - wx * uz,
      cz = wx * uy - wy * ux;
    const dx = uy * vz - uz * vy,
      dy = uz * vx - ux * vz,
      dz = ux * vy - uy * vx;
    const ax = -bx - cx - dx,
      ay = -by - cy - dy,
      az = -bz - cz - dz;
    const denom =
      ax * ax +
      ay * ay +
      az * az +
      bx * bx +
      by * by +
      bz * bz +
      cx * cx +
      cy * cy +
      cz * cz +
      dx * dx +
      dy * dy +
      dz * dz +
      alpha;
    if (denom < 1e-15) continue;
    const lambda = -(ux * bx + uy * by + uz * bz - restVolume6) / denom;
    pos[a] += lambda * ax;
    pos[a + 1] += lambda * ay;
    pos[a + 2] += lambda * az;
    pos[b] += lambda * bx;
    pos[b + 1] += lambda * by;
    pos[b + 2] += lambda * bz;
    pos[c] += lambda * cx;
    pos[c + 1] += lambda * cy;
    pos[c + 2] += lambda * cz;
    pos[d] += lambda * dx;
    pos[d + 1] += lambda * dy;
    pos[d + 2] += lambda * dz;
  }
}
