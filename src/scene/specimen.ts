import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import {
  cameraPosition,
  color,
  float,
  mix,
  mx_fractal_noise_float,
  normalWorld,
  positionWorld,
  texture,
  transformNormalToView,
  vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { bakeSkinTextures } from "../render/skin-textures";

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

/**
 * Skin, procedurally: no UVs exist yet (they arrive with the sculpted
 * asset), so every map is a function of world position — which conveniently
 * also survives deformation without stretching.
 */
function createSkinMaterial(): THREE.MeshPhysicalNodeMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial({
    sheen: 0.3,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0xffe4d6),
  });

  // albedo: warm base with two scales of mottling — broad tonal drift and
  // a finer capillary flush. Skin is never one color.
  const base = color(0xc79b83);
  const flushed = color(0xb27866);
  const pale = color(0xd7b49e);
  const broad = mx_fractal_noise_float(positionWorld.mul(1.4))
    .mul(0.5)
    .add(0.5);
  const fine = mx_fractal_noise_float(positionWorld.mul(6.5)).mul(0.5).add(0.5);
  material.colorNode = mix(
    mix(base, pale, broad.mul(0.35)),
    flushed,
    fine.mul(0.22),
  );

  // micro-detail: baked pore/fold maps, sampled triplanar (no UVs needed).
  // ~0.55 world units per tile puts pore spacing at believable screen scale.
  const detail = bakeSkinTextures();
  const uvScale = 1.8;
  const w = normalWorld.abs().pow(4);
  const wSum = w.x.add(w.y).add(w.z);
  const wx = w.x.div(wSum);
  const wy = w.y.div(wSum);
  const wz = w.z.div(wSum);

  const decode = (t: ReturnType<typeof texture>) => t.xy.mul(2).sub(1);
  const nX = decode(texture(detail.normalMap, positionWorld.zy.mul(uvScale)));
  const nY = decode(texture(detail.normalMap, positionWorld.xz.mul(uvScale)));
  const nZ = decode(texture(detail.normalMap, positionWorld.xy.mul(uvScale)));
  // UDN-style triplanar blend: each projection perturbs its own plane axes
  const perturb = vec3(float(0), nX.y, nX.x)
    .mul(wx)
    .add(vec3(nY.x, float(0), nY.y).mul(wy))
    .add(vec3(nZ.x, nZ.y, float(0)).mul(wz))
    .mul(0.55);
  material.normalNode = transformNormalToView(
    normalWorld.add(perturb).normalize(),
  );

  const dX = texture(detail.detailMap, positionWorld.zy.mul(uvScale));
  const dY = texture(detail.detailMap, positionWorld.xz.mul(uvScale));
  const dZ = texture(detail.detailMap, positionWorld.xy.mul(uvScale));
  const det = dX.mul(wx).add(dY.mul(wy)).add(dZ.mul(wz));

  // pores sit in slight shadow — modulate albedo by the baked ao
  material.colorNode = material.colorNode?.mul(det.r.mul(0.3).add(0.7));

  // spec breakup: baked micro-roughness over broad procedural drift
  material.roughnessNode = float(0.42)
    .add(mx_fractal_noise_float(positionWorld.mul(22)).mul(0.07))
    .add(det.g.sub(0.5).mul(0.3));

  // faked subsurface: deep red bleeding out at grazing angles, strongest
  // where the silhouette thins against the rim lights
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const fresnel = normalWorld.dot(viewDir).clamp(0, 1).oneMinus().pow(3);
  material.emissiveNode = color(0x3d0d05).mul(fresnel).mul(0.55);

  return material;
}

export function createPlaceholderSpecimen(): Specimen {
  const mesh = new THREE.Mesh(buildGeometry(192, 200), createSkinMaterial());

  const proxy = new THREE.Mesh(
    buildGeometry(48, 60),
    new THREE.MeshBasicMaterial(),
  );
  proxy.updateMatrixWorld(true);

  return { mesh, proxy, isInside, depth01 };
}
