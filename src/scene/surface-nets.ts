import * as THREE from "three/webgpu";

/**
 * Naive surface nets: one vertex per sign-changing cell (centroid of edge
 * zero-crossings), quads across sign-changing grid edges. Normals come from
 * the SDF gradient — exact and smooth. Triangle winding is fixed against the
 * gradient at emission, so it can never come out inside-out.
 */
type Sdf = (x: number, y: number, z: number) => number;

const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

export function surfaceNets(
  sdf: Sdf,
  min: THREE.Vector3,
  max: THREE.Vector3,
  cellSize: number,
): THREE.BufferGeometry {
  const nx = Math.ceil((max.x - min.x) / cellSize);
  const ny = Math.ceil((max.y - min.y) / cellSize);
  const nz = Math.ceil((max.z - min.z) / cellSize);
  const gx = nx + 1;
  const gy = ny + 1;
  const vi = (i: number, j: number, k: number) => i + j * gx + k * gx * gy;
  const ci = (i: number, j: number, k: number) => i + j * nx + k * nx * ny;

  // sample the field
  const values = new Float32Array(gx * gy * (nz + 1));
  for (let k = 0; k <= nz; k++) {
    const z = min.z + k * cellSize;
    for (let j = 0; j <= ny; j++) {
      const y = min.y + j * cellSize;
      for (let i = 0; i <= nx; i++) {
        values[vi(i, j, k)] = sdf(min.x + i * cellSize, y, z);
      }
    }
  }

  // one vertex per sign-changing cell
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const corner = new Float32Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          corner[c] = values[vi(i + dx, j + dy, k + dz)];
          if (corner[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 0xff) continue;
        let px = 0;
        let py = 0;
        let pz = 0;
        let n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          px += i + ca[0] + t * (cb[0] - ca[0]);
          py += j + ca[1] + t * (cb[1] - ca[1]);
          pz += k + ca[2] + t * (cb[2] - ca[2]);
          n++;
        }
        cellVertex[ci(i, j, k)] = positions.length / 3;
        positions.push(
          min.x + (px / n) * cellSize,
          min.y + (py / n) * cellSize,
          min.z + (pz / n) * cellSize,
        );
      }
    }
  }

  // quads across sign-changing grid edges, winding fixed by the gradient
  const indices: number[] = [];
  const eps = cellSize * 0.75;
  const grad = (x: number, y: number, z: number): [number, number, number] => [
    sdf(x + eps, y, z) - sdf(x - eps, y, z),
    sdf(x, y + eps, z) - sdf(x, y - eps, z),
    sdf(x, y, z + eps) - sdf(x, y, z - eps),
  ];
  const emitQuad = (q0: number, q1: number, q2: number, q3: number): void => {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) return;
    const ax = positions[q0 * 3];
    const ay = positions[q0 * 3 + 1];
    const az = positions[q0 * 3 + 2];
    const bx = positions[q1 * 3] - ax;
    const by = positions[q1 * 3 + 1] - ay;
    const bz = positions[q1 * 3 + 2] - az;
    const cx = positions[q2 * 3] - ax;
    const cy = positions[q2 * 3 + 1] - ay;
    const cz = positions[q2 * 3 + 2] - az;
    const nxg = by * cz - bz * cy;
    const nyg = bz * cx - bx * cz;
    const nzg = bx * cy - by * cx;
    const g = grad(
      (positions[q0 * 3] + positions[q2 * 3]) / 2,
      (positions[q0 * 3 + 1] + positions[q2 * 3 + 1]) / 2,
      (positions[q0 * 3 + 2] + positions[q2 * 3 + 2]) / 2,
    );
    if (nxg * g[0] + nyg * g[1] + nzg * g[2] >= 0) {
      indices.push(q0, q1, q2, q0, q2, q3);
    } else {
      indices.push(q0, q2, q1, q0, q3, q2);
    }
  };

  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const v0 = values[vi(i, j, k)];
        // x-axis edge
        if (i < nx - 1 && v0 < 0 !== values[vi(i + 1, j, k)] < 0) {
          emitQuad(
            cellVertex[ci(i, j - 1, k - 1)],
            cellVertex[ci(i, j, k - 1)],
            cellVertex[ci(i, j, k)],
            cellVertex[ci(i, j - 1, k)],
          );
        }
        // y-axis edge
        if (j < ny - 1 && v0 < 0 !== values[vi(i, j + 1, k)] < 0) {
          emitQuad(
            cellVertex[ci(i - 1, j, k - 1)],
            cellVertex[ci(i, j, k - 1)],
            cellVertex[ci(i, j, k)],
            cellVertex[ci(i - 1, j, k)],
          );
        }
        // z-axis edge
        if (k < nz - 1 && v0 < 0 !== values[vi(i, j, k + 1)] < 0) {
          emitQuad(
            cellVertex[ci(i - 1, j - 1, k)],
            cellVertex[ci(i, j - 1, k)],
            cellVertex[ci(i, j, k)],
            cellVertex[ci(i - 1, j, k)],
          );
        }
      }
    }
  }

  // normals from the SDF gradient
  const normals = new Float32Array(positions.length);
  for (let v = 0; v < positions.length / 3; v++) {
    const g = grad(
      positions[v * 3],
      positions[v * 3 + 1],
      positions[v * 3 + 2],
    );
    const len = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1;
    normals[v * 3] = g[0] / len;
    normals[v * 3 + 1] = g[1] / len;
    normals[v * 3 + 2] = g[2] / len;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(positions), 3),
  );
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}
