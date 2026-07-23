import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";

export interface Specimen {
  mesh: THREE.Mesh;
  /** low-res invisible stand-in for cheap pointer raycasts (not in scene) */
  proxy: THREE.Mesh;
  /** analytic inside-test used to seed the physics lattice */
  isInside: (p: THREE.Vector3) => boolean;
  /**
   * normalized interior depth: 0 at/outside the surface, 1 deep in the core.
   * Drives the flesh layering — firm musculature inside, soft fat outside.
   */
  depth01: (p: THREE.Vector3) => number;
}

/**
 * Procedural stand-in for the sculpted asset: a displaced sphere with the
 * right silhouette for composition and lighting work. Deliberately rendered
 * as neutral clay — skin shading is its own phase. The physics lattice binds
 * to whatever mesh lives here, so the swap later is contained.
 *
 * Orientation: +z faces the camera (rear elevation), +y up.
 */
const SCALE = new THREE.Vector3(1.18, 0.98, 0.88);

/** radius of the surface along unit direction n, before axis scaling */
function shapeRadius(n: THREE.Vector3): number {
  // side fullness — the two lobes
  const lobe = 0.42 * Math.abs(n.x) ** 1.35;
  // vertical crease on the camera-facing half, deepening toward the bottom
  const valley = Math.exp(-((n.x * 4.2) ** 2));
  const facing = THREE.MathUtils.smoothstep(n.z, 0.05, 0.65);
  const lower = THREE.MathUtils.smoothstep(-n.y, -0.35, 0.75);
  // release the crease before the bottom pole so it fades out instead of
  // terminating in a hard wedge
  const release = 1 - THREE.MathUtils.smoothstep(-n.y, 0.72, 0.95);
  const crease = valley * facing * release * (0.16 + 0.3 * lower);
  // gentle flattening up toward the lower back
  const backTaper = 1 - 0.18 * THREE.MathUtils.smoothstep(n.y, 0.35, 1);
  return (1 + lobe - crease) * backTaper;
}

function buildGeometry(
  widthSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  // Drop UVs and weld the sphere's wrap-around seam, otherwise averaged
  // normals split down the middle and draw a visible vertical line.
  const raw = new THREE.SphereGeometry(1, widthSegments, heightSegments);
  raw.deleteAttribute("uv");
  raw.deleteAttribute("normal");
  const geometry = mergeVertices(raw);
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();
    const r = shapeRadius(n);
    pos.setXYZ(i, n.x * r * SCALE.x, n.y * r * SCALE.y, n.z * r * SCALE.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function isInside(p: THREE.Vector3): boolean {
  return depth01(p) > 0;
}

/** fraction of the (unit-space) radius considered fully "core" */
const CORE_DEPTH = 0.55;

function depth01(p: THREE.Vector3): number {
  const qx = p.x / SCALE.x;
  const qy = p.y / SCALE.y;
  const qz = p.z / SCALE.z;
  const len = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (len < 1e-6) return 1;
  const n = new THREE.Vector3(qx / len, qy / len, qz / len);
  const depth = shapeRadius(n) - len;
  return THREE.MathUtils.clamp(depth / CORE_DEPTH, 0, 1);
}

export function createPlaceholderSpecimen(): Specimen {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x9c8a7d,
    roughness: 0.55,
    sheen: 0.25,
    sheenRoughness: 0.6,
  });
  const mesh = new THREE.Mesh(buildGeometry(192, 128), material);

  const proxy = new THREE.Mesh(
    buildGeometry(48, 32),
    new THREE.MeshBasicMaterial(),
  );
  proxy.updateMatrixWorld(true);

  return { mesh, proxy, isInside, depth01 };
}
