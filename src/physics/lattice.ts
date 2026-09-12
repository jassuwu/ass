/**
 * Volumetric particle lattice sampled from the specimen's inside-test.
 * Particles sit on grid nodes belonging to occupied cells (occupied = any
 * corner or center inside the surface, dilated one ring so the render mesh
 * is always embedded in complete cells).
 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  min: Vec3Like;
  max: Vec3Like;
}

const smoothstep = (x: number, lo: number, hi: number) => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Pure: no three.js, so the same lattice builds on the main thread or in
 * a worker. Inside-test and depth take plain coordinates.
 */
export interface Lattice {
  count: number;
  spacing: number;
  origin: Vec3Like;
  nx: number;
  ny: number;
  nz: number;
  /** rest positions, xyz per particle */
  rest: Float32Array;
  /** 1 where the rest position is inside the body, 0 for the dilation ring */
  inside: Uint8Array;
  /** grid node index -> particle id, -1 where no particle */
  nodeToParticle: Int32Array;
  /** distance constraints: particle pairs + rest lengths */
  cA: Uint32Array;
  cB: Uint32Array;
  cRest: Float32Array;
  /** six consistently oriented tetrahedra per occupied cell, 4 ids each */
  tetrahedra: Uint32Array;
  /** six times the rest volume of one tetrahedron (= spacing³) */
  restVolume6: number;
  /**
   * attachment strength 0..1 — how firmly a particle belongs to the body
   * behind the surface. ~1 on the far (-z) side and toward the lower back,
   * ~0 on the free camera-facing flesh.
   */
  anchorW: Float32Array;
}

/** axial + face-diagonal neighborhood; leading axis positive => no duplicate pairs */
const CONSTRAINT_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, -1, 0],
  [1, 0, 1],
  [1, 0, -1],
  [0, 1, 1],
  [0, 1, -1],
];

export function buildLattice(
  isInside: (x: number, y: number, z: number) => boolean,
  depth01: (x: number, y: number, z: number) => number,
  bounds: Bounds,
  spacing: number,
): Lattice {
  const origin = {
    x: bounds.min.x - spacing,
    y: bounds.min.y - spacing,
    z: bounds.min.z - spacing,
  };
  const size = {
    x: bounds.max.x - bounds.min.x + 2 * spacing,
    y: bounds.max.y - bounds.min.y + 2 * spacing,
    z: bounds.max.z - bounds.min.z + 2 * spacing,
  };
  const nx = Math.ceil(size.x / spacing) + 1;
  const ny = Math.ceil(size.y / spacing) + 1;
  const nz = Math.ceil(size.z / spacing) + 1;
  const cellsX = nx - 1;
  const cellsY = ny - 1;
  const cellsZ = nz - 1;
  const cellIndex = (i: number, j: number, k: number) =>
    i + j * cellsX + k * cellsX * cellsY;
  const nodeIndex = (i: number, j: number, k: number) =>
    i + j * nx + k * nx * ny;

  // occupancy per cell
  const occupied = new Uint8Array(cellsX * cellsY * cellsZ);
  for (let k = 0; k < cellsZ; k++) {
    for (let j = 0; j < cellsY; j++) {
      for (let i = 0; i < cellsX; i++) {
        let hit = isInside(
          origin.x + (i + 0.5) * spacing,
          origin.y + (j + 0.5) * spacing,
          origin.z + (k + 0.5) * spacing,
        );
        for (let c = 0; c < 8 && !hit; c++) {
          hit = isInside(
            origin.x + (i + (c & 1)) * spacing,
            origin.y + (j + ((c >> 1) & 1)) * spacing,
            origin.z + (k + ((c >> 2) & 1)) * spacing,
          );
        }
        if (hit) occupied[cellIndex(i, j, k)] = 1;
      }
    }
  }

  // dilate one ring so surface vertices always land in complete cells
  const dilated = new Uint8Array(occupied);
  for (let k = 0; k < cellsZ; k++) {
    for (let j = 0; j < cellsY; j++) {
      for (let i = 0; i < cellsX; i++) {
        if (!occupied[cellIndex(i, j, k)]) continue;
        for (let dk = -1; dk <= 1; dk++) {
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              const jj = j + dj;
              const kk = k + dk;
              if (
                ii < 0 ||
                jj < 0 ||
                kk < 0 ||
                ii >= cellsX ||
                jj >= cellsY ||
                kk >= cellsZ
              )
                continue;
              dilated[cellIndex(ii, jj, kk)] = 1;
            }
          }
        }
      }
    }
  }

  // particles = nodes of occupied cells
  const nodeToParticle = new Int32Array(nx * ny * nz).fill(-1);
  let count = 0;
  for (let k = 0; k < cellsZ; k++) {
    for (let j = 0; j < cellsY; j++) {
      for (let i = 0; i < cellsX; i++) {
        if (!dilated[cellIndex(i, j, k)]) continue;
        for (let c = 0; c < 8; c++) {
          const n = nodeIndex(
            i + (c & 1),
            j + ((c >> 1) & 1),
            k + ((c >> 2) & 1),
          );
          if (nodeToParticle[n] === -1) {
            nodeToParticle[n] = count;
            count++;
          }
        }
      }
    }
  }

  const rest = new Float32Array(count * 3);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const id = nodeToParticle[nodeIndex(i, j, k)];
        if (id === -1) continue;
        rest[id * 3] = origin.x + i * spacing;
        rest[id * 3 + 1] = origin.y + j * spacing;
        rest[id * 3 + 2] = origin.z + k * spacing;
      }
    }
  }

  const inside = new Uint8Array(count);
  for (let a = 0; a < count; a++) {
    inside[a] = isInside(rest[a * 3], rest[a * 3 + 1], rest[a * 3 + 2]) ? 1 : 0;
  }

  // anchor field: the body owns the far side and the lower back;
  // the camera-facing flesh is free to move
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  for (let a = 0; a < count; a++) {
    const z = rest[a * 3 + 2];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  // flesh layering: deep particles are musculature held by the skeleton,
  // only the outer fat layer is free — this is what separates flesh from jelly
  const CORE_HOLD = 0.5;
  const anchorW = new Float32Array(count);
  for (let a = 0; a < count; a++) {
    const zn = (rest[a * 3 + 2] - zMin) / (zMax - zMin);
    const y = rest[a * 3 + 1];
    const back = Math.max(0, 1 - zn * 1.7) ** 1.6;
    const top = 0.6 * smoothstep(y, 0.45, 1.0);
    // thighs are musculature: they carry a ripple but barely jiggle
    const bottom = 0.55 * smoothstep(-y, 0.85, 1.6);
    // the sacrum: bone right under the skin between the cheeks' upper
    // halves — that region does not wobble
    const sacrum =
      0.55 *
      Math.exp(-((rest[a * 3] / 0.4) ** 2)) *
      Math.exp(-(((y - 0.55) / 0.4) ** 2));
    const core =
      CORE_HOLD * depth01(rest[a * 3], rest[a * 3 + 1], rest[a * 3 + 2]) ** 1.5;
    anchorW[a] = Math.min(1, back + top + bottom + sacrum + core);
  }

  // distance constraints
  const a: number[] = [];
  const b: number[] = [];
  const restLen: number[] = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const pa = nodeToParticle[nodeIndex(i, j, k)];
        if (pa === -1) continue;
        for (const [di, dj, dk] of CONSTRAINT_OFFSETS) {
          const ii = i + di;
          const jj = j + dj;
          const kk = k + dk;
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz)
            continue;
          const pb = nodeToParticle[nodeIndex(ii, jj, kk)];
          if (pb === -1) continue;
          a.push(pa);
          b.push(pb);
          restLen.push(Math.sqrt(di * di + dj * dj + dk * dk) * spacing);
        }
      }
    }
  }

  // volume elements: each occupied cell split into six tetrahedra around
  // its main diagonal, so a dent has to displace tissue rather than crush it
  const tetrahedra: number[] = [];
  const corners = new Int32Array(8);
  const ring = [1, 3, 2, 6, 4, 5];
  for (let k = 0; k < cellsZ; k++) {
    for (let j = 0; j < cellsY; j++) {
      for (let i = 0; i < cellsX; i++) {
        if (!dilated[cellIndex(i, j, k)]) continue;
        for (let c = 0; c < 8; c++) {
          corners[c] =
            nodeToParticle[
              nodeIndex(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))
            ];
        }
        for (let t = 0; t < 6; t++) {
          tetrahedra.push(
            corners[0],
            corners[ring[t]],
            corners[ring[(t + 1) % 6]],
            corners[7],
          );
        }
      }
    }
  }

  return {
    count,
    spacing,
    origin,
    nx,
    ny,
    nz,
    rest,
    inside,
    nodeToParticle,
    cA: Uint32Array.from(a),
    cB: Uint32Array.from(b),
    cRest: Float32Array.from(restLen),
    tetrahedra: Uint32Array.from(tetrahedra),
    restVolume6: spacing ** 3,
    anchorW,
  };
}
