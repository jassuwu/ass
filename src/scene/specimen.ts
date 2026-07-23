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
import { surfaceNets } from "./surface-nets";

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
 * The body as a signed distance field: pelvis + torso + two gluteal masses
 * + two SEPARATE thighs, blended with smooth-min so the crevices — the
 * crease between the cheeks, the gluteal fold where cheek meets thigh, the
 * gap between the legs — emerge from the geometry itself rather than being
 * carved grooves. Meshed by surface nets with exact SDF-gradient normals.
 *
 * Orientation: +z faces the camera (rear elevation), +y up.
 */
const CORE_DEPTH = 0.5;

const BOUNDS_MIN = new THREE.Vector3(-1.6, -2.45, -1.2);
const BOUNDS_MAX = new THREE.Vector3(1.6, 2.2, 1.4);

function smin(a: number, b: number, k: number): number {
  const h = Math.min(Math.max(0.5 + (0.5 * (b - a)) / k, 0), 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

function sdEllipsoid(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const qx = (px - cx) / rx;
  const qy = (py - cy) / ry;
  const qz = (pz - cz) / rz;
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  if (k0 < 1e-9) return -Math.min(rx, ry, rz);
  const k1 = Math.sqrt(
    (qx / rx) * (qx / rx) + (qy / ry) * (qy / ry) + (qz / rz) * (qz / rz),
  );
  return (k0 * (k0 - 1)) / k1;
}

/** capsule with linearly varying radius — a thigh */
function sdThigh(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r1: number,
  r2: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const h = Math.min(
    Math.max(
      (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz),
      0,
    ),
    1,
  );
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (r1 + (r2 - r1) * h);
}

export function bodySdf(x: number, y: number, z: number): number {
  const pelvis = sdEllipsoid(x, y, z, 0, 0.5, -0.15, 1.25, 0.75, 0.9);
  const torso = sdEllipsoid(x, y, z, 0, 1.7, -0.18, 1.0, 1.3, 0.8);
  const gluteL = sdEllipsoid(x, y, z, -0.62, -0.05, 0.3, 0.78, 0.78, 0.82);
  const gluteR = sdEllipsoid(x, y, z, 0.62, -0.05, 0.3, 0.78, 0.78, 0.82);
  const thighL = sdThigh(
    x,
    y,
    z,
    -0.58,
    -0.7,
    0.02,
    -0.66,
    -2.5,
    -0.05,
    0.5,
    0.4,
  );
  const thighR = sdThigh(
    x,
    y,
    z,
    0.58,
    -0.7,
    0.02,
    0.66,
    -2.5,
    -0.05,
    0.5,
    0.4,
  );

  // waist emerges from the pelvis/torso blend
  let d = smin(pelvis, torso, 0.4);
  // tight blend between the cheeks keeps the crease a real valley
  d = smin(d, smin(gluteL, gluteR, 0.08), 0.32);
  // small blend radius at the thigh junction forms the gluteal fold;
  // plain min between the thighs keeps the legs separate
  d = smin(d, Math.min(thighL, thighR), 0.13);
  return d;
}

function depth01(p: THREE.Vector3): number {
  if (
    p.x < BOUNDS_MIN.x ||
    p.x > BOUNDS_MAX.x ||
    p.y < BOUNDS_MIN.y ||
    p.y > BOUNDS_MAX.y ||
    p.z < BOUNDS_MIN.z ||
    p.z > BOUNDS_MAX.z
  ) {
    return 0;
  }
  return THREE.MathUtils.clamp(-bodySdf(p.x, p.y, p.z) / CORE_DEPTH, 0, 1);
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
  const mesh = new THREE.Mesh(
    surfaceNets(bodySdf, BOUNDS_MIN, BOUNDS_MAX, 0.032),
    createSkinMaterial(),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const proxy = new THREE.Mesh(
    surfaceNets(bodySdf, BOUNDS_MIN, BOUNDS_MAX, 0.1),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  proxy.updateMatrixWorld(true);

  return { mesh, proxy, isInside, depth01 };
}
