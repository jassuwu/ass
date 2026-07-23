import * as THREE from "three/webgpu";

/**
 * Skin micro-detail, baked once at startup: a tileable height field of
 * micro-folds (fbm value noise) pitted with pores (worley points), turned
 * into a tangent-space normal map plus a detail map (R: albedo/ao
 * multiplier, G: roughness offset). Deterministic — same skin every visit.
 * Sampled triplanar in the material, so no UVs are needed.
 */
export interface SkinTextures {
  normalMap: THREE.DataTexture;
  detailMap: THREE.DataTexture;
}

const SIZE = 512;
/** pore cells per tile */
const PORE_GRID = 48;

function hash2(ix: number, iy: number, salt: number): number {
  let h = (ix * 374761393 + iy * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** tileable value noise at integer frequency f */
function valueNoise(u: number, v: number, f: number, salt: number): number {
  const x = u * f;
  const y = v * f;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const i0 = ((ix % f) + f) % f;
  const j0 = ((iy % f) + f) % f;
  const i1 = (i0 + 1) % f;
  const j1 = (j0 + 1) % f;
  const a = hash2(i0, j0, salt + f);
  const b = hash2(i1, j0, salt + f);
  const c = hash2(i0, j1, salt + f);
  const d = hash2(i1, j1, salt + f);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** distance to nearest pore point, wrapped */
function poreF1(u: number, v: number): number {
  const x = u * PORE_GRID;
  const y = v * PORE_GRID;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let best = Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const ci = cx + di;
      const cj = cy + dj;
      const wi = ((ci % PORE_GRID) + PORE_GRID) % PORE_GRID;
      const wj = ((cj % PORE_GRID) + PORE_GRID) % PORE_GRID;
      const px = ci + hash2(wi, wj, 777);
      const py = cj + hash2(wi, wj, 888);
      const dx = x - px;
      const dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

export function bakeSkinTextures(): SkinTextures {
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // micro-folds: several octaves of tileable noise
      let h =
        0.5 * valueNoise(u, v, 8, 11) +
        0.25 * valueNoise(u, v, 16, 23) +
        0.15 * valueNoise(u, v, 32, 37) +
        0.1 * valueNoise(u, v, 64, 53);
      // pores: pits at worley points
      const pore = Math.max(0, 1 - poreF1(u, v) * 1.5) ** 2;
      h -= 0.45 * pore;
      height[y * SIZE + x] = h;
    }
  }

  const normalData = new Uint8Array(SIZE * SIZE * 4);
  const detailData = new Uint8Array(SIZE * SIZE * 4);
  const S = 2.4; // baked bump strength
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const xm = height[y * SIZE + ((x - 1 + SIZE) % SIZE)];
      const xp = height[y * SIZE + ((x + 1) % SIZE)];
      const ym = height[((y - 1 + SIZE) % SIZE) * SIZE + x];
      const yp = height[((y + 1) % SIZE) * SIZE + x];
      const nx = -(xp - xm) * S;
      const ny = -(yp - ym) * S;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      normalData[i * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      normalData[i * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      normalData[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      normalData[i * 4 + 3] = 255;

      const u = x / SIZE;
      const v = y / SIZE;
      const pore = Math.max(0, 1 - poreF1(u, v) * 1.5) ** 2;
      const fold = height[i];
      // R: albedo/ao multiplier (pores sit in slight shadow)
      const ao = 1 - pore * 0.5 - Math.max(0, 0.55 - fold) * 0.25;
      // G: roughness offset around 0.5 (pores and folds scatter more)
      const rough = 0.5 + pore * 0.3 + (fold - 0.5) * 0.25;
      detailData[i * 4] = Math.round(Math.min(Math.max(ao, 0), 1) * 255);
      detailData[i * 4 + 1] = Math.round(Math.min(Math.max(rough, 0), 1) * 255);
      detailData[i * 4 + 2] = 0;
      detailData[i * 4 + 3] = 255;
    }
  }

  const make = (data: Uint8Array): THREE.DataTexture => {
    const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };

  return { normalMap: make(normalData), detailMap: make(detailData) };
}
