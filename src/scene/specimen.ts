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
 * Procedural stand-in for the sculpted asset: a continuous body column so the
 * flesh exits the authored frame — lower back out the top, thighs out the
 * bottom — instead of terminating visibly inside it. Landmarks: waist
 * narrowing, gluteal mass (side fullness + posterior projection), vertical
 * crease continuing into the inner-thigh separation, gluteal fold under each
 * cheek, faint back groove above.
 *
 * Orientation: +z faces the camera (rear elevation), +y up.
 */
const Y_MIN = -2.45;
const Y_MAX = 2.1;
/** absolute depth (world units) considered fully "core" */
const CORE_DEPTH = 0.5;

/** cross-section radius at height y along direction (sx, cz) = (sin, cos) of
 * the azimuth from the +z (camera) axis */
function bodyRadius(y: number, sx: number, cz: number): number {
  const s = THREE.MathUtils.smoothstep;
  // base elliptical column, narrowing to the waist above and thighs below
  const ax = 1.12 - 0.32 * s(y, 0.45, 1.6) - 0.27 * s(-y, 0.7, 1.7);
  const az = 0.88 - 0.18 * s(y, 0.45, 1.6) - 0.16 * s(-y, 0.7, 1.7);
  const denom = Math.sqrt((az * sx) ** 2 + (ax * cz) ** 2);
  let r = (ax * az) / Math.max(denom, 1e-6);

  // gluteal mass: sideways fullness + posterior projection toward the camera
  const cheekY = Math.exp(-(((y + 0.05) / 0.85) ** 2));
  r += 0.4 * Math.abs(sx) ** 1.35 * cheekY;
  r += 0.34 * Math.max(0, cz) ** 1.6 * Math.exp(-(((y + 0.15) / 0.7) ** 2));

  const facing = s(cz, 0.05, 0.6);
  // vertical crease: deepest through the cheeks, continuing as the
  // inner-thigh separation below and a faint back groove above
  const valley = Math.exp(-((sx * 4.0) ** 2));
  const creaseDepth =
    0.3 * Math.exp(-(((y + 0.35) / 0.8) ** 2)) +
    0.22 * s(-y, 0.7, 1.1) * (1 - s(-y, 1.7, 2.1)) +
    0.05 * s(y, 0.5, 1.1);
  r -= valley * facing * creaseDepth;

  // gluteal fold: the horizontal tuck under each cheek
  const foldSide =
    s(Math.abs(sx), 0.1, 0.35) * (1 - s(Math.abs(sx), 0.75, 0.95));
  r -= 0.11 * Math.exp(-(((y + 0.8) / 0.12) ** 2)) * foldSide * facing;

  // pinch closed far outside the frame
  const taper = (1 - s(y, 1.55, 2.05)) * (1 - s(-y, 1.9, 2.4));
  return Math.max(r * taper, 0.02);
}

function buildGeometry(
  radialSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  const raw = new THREE.CylinderGeometry(
    1,
    1,
    Y_MAX - Y_MIN,
    radialSegments,
    heightSegments,
    true,
  );
  raw.translate(0, (Y_MAX + Y_MIN) / 2, 0);
  // weld the wrap-around seam so averaged normals don't draw a vertical line
  raw.deleteAttribute("uv");
  raw.deleteAttribute("normal");
  const geometry = mergeVertices(raw);
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const theta = Math.atan2(v.x, v.z);
    const sx = Math.sin(theta);
    const cz = Math.cos(theta);
    const r = bodyRadius(v.y, sx, cz);
    pos.setXYZ(i, r * sx, v.y, r * cz);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function depth01(p: THREE.Vector3): number {
  if (p.y < Y_MIN || p.y > Y_MAX) return 0;
  const h = Math.sqrt(p.x * p.x + p.z * p.z);
  if (h < 1e-6) return 1;
  const r = bodyRadius(p.y, p.x / h, p.z / h);
  return THREE.MathUtils.clamp((r - h) / CORE_DEPTH, 0, 1);
}

function isInside(p: THREE.Vector3): boolean {
  return depth01(p) > 0;
}

export function createPlaceholderSpecimen(): Specimen {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x9c8a7d,
    roughness: 0.55,
    sheen: 0.25,
    sheenRoughness: 0.6,
  });
  const mesh = new THREE.Mesh(buildGeometry(192, 200), material);

  const proxy = new THREE.Mesh(
    buildGeometry(48, 60),
    new THREE.MeshBasicMaterial(),
  );
  proxy.updateMatrixWorld(true);

  return { mesh, proxy, isInside, depth01 };
}
