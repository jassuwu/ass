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

/** smooth subtraction — carves b out of a with soft edges */
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
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

/**
 * A leg is not a rod: a tapered core, a hamstring mass carrying the fold's
 * rear fullness into the leg, and an adductor mass keeping the inner gap
 * narrow high up. All per-side, mirrored by `side` = ±1.
 */
function sdLeg(x: number, y: number, z: number, side: number): number {
  const core = sdThigh(
    x,
    y,
    z,
    side * 0.6,
    -0.55,
    0.02,
    side * 0.64,
    -2.5,
    -0.08,
    0.52,
    0.34,
  );
  const hamstring = sdEllipsoid(
    x,
    y,
    z,
    side * 0.58,
    -0.95,
    0.14,
    0.42,
    0.55,
    0.4,
  );
  const adductor = sdEllipsoid(
    x,
    y,
    z,
    side * 0.4,
    -0.85,
    0.0,
    0.34,
    0.5,
    0.34,
  );
  return smin(smin(core, hamstring, 0.18), adductor, 0.15);
}

export function bodySdf(x: number, y: number, z: number): number {
  const pelvis = sdEllipsoid(x, y, z, 0, 0.5, -0.15, 1.25, 0.75, 0.9);
  const torso = sdEllipsoid(x, y, z, 0, 1.7, -0.18, 1.0, 1.3, 0.8);
  const gluteL = sdEllipsoid(x, y, z, -0.62, -0.05, 0.3, 0.78, 0.78, 0.82);
  const gluteR = sdEllipsoid(x, y, z, 0.62, -0.05, 0.3, 0.78, 0.78, 0.82);

  // waist emerges from the pelvis/torso blend
  let d = smin(pelvis, torso, 0.4);
  // tight blend between the cheeks keeps the crease a real valley
  d = smin(d, smin(gluteL, gluteR, 0.08), 0.32);
  // small blend radius at the thigh junction forms the gluteal fold;
  // plain min between the legs keeps them separate
  d = smin(d, Math.min(sdLeg(x, y, z, -1), sdLeg(x, y, z, 1)), 0.13);

  // the cleft: a deep narrow carve along the midline of the camera side.
  // The depth is the concealment — the interior sits in full shadow
  // (shadow map + GTAO), so it reads real while showing nothing at all.
  const cleft = sdEllipsoid(x, y, z, 0, -0.25, 0.9, 0.075, 0.7, 0.6);
  d = smax(d, -cleft, 0.05);
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
 * Skin from a real scan (TextureCan skin_0001, 2K: color/normal/roughness/
 * ao/subsurface), triplanar-sampled since the SDF mesh has no UVs — which
 * also means the maps survive deformation without stretching. Our broad
 * procedural tonal gradients tint the scan so the hue stays authored while
 * the pore-level structure is photographic.
 */
function createSkinMaterial(): THREE.MeshPhysicalNodeMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial({
    sheen: 0.2,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xffdcc8),
  });

  const loader = new THREE.TextureLoader();
  const load = (name: string, srgb = false): THREE.Texture => {
    const t = loader.load(`/textures/skin/${name}`);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const scanColor = load("skin_0001_color_2k.jpg", true);
  const scanNormal = load("skin_0001_normal_2k.jpg");
  const scanRough = load("skin_0001_roughness_2k.jpg");
  const scanSss = load("skin_0001_subsurface_2k.jpg");

  // ~0.6 world units (~8cm) per tile matches the scan's real-world scale
  const uvScale = 1.6;
  const w = normalWorld.abs().pow(4);
  const wSum = w.x.add(w.y).add(w.z);
  const wx = w.x.div(wSum);
  const wy = w.y.div(wSum);
  const wz = w.z.div(wSum);
  const tp = (map: THREE.Texture) =>
    texture(map, positionWorld.zy.mul(uvScale))
      .mul(wx)
      .add(texture(map, positionWorld.xz.mul(uvScale)).mul(wy))
      .add(texture(map, positionWorld.xy.mul(uvScale)).mul(wz));

  // albedo: authored tonal gradients tint the scan's photographic detail.
  // Skin is never one color, and never near-white.
  const base = color(0xb98a70);
  const flushed = color(0xa76b59);
  const pale = color(0xc9a184);
  const broad = mx_fractal_noise_float(positionWorld.mul(1.4))
    .mul(0.5)
    .add(0.5);
  const fine = mx_fractal_noise_float(positionWorld.mul(6.5)).mul(0.5).add(0.5);
  const tint = mix(mix(base, pale, broad.mul(0.35)), flushed, fine.mul(0.22));
  material.colorNode = tint.mul(tp(scanColor).rgb).mul(1.6);

  // scanned normals, UDN triplanar blend
  const decode = (t: ReturnType<typeof texture>) => t.xy.mul(2).sub(1);
  const nX = decode(texture(scanNormal, positionWorld.zy.mul(uvScale)));
  const nY = decode(texture(scanNormal, positionWorld.xz.mul(uvScale)));
  const nZ = decode(texture(scanNormal, positionWorld.xy.mul(uvScale)));
  const perturb = vec3(float(0), nX.y, nX.x)
    .mul(wx)
    .add(vec3(nY.x, float(0), nY.y).mul(wy))
    .add(vec3(nZ.x, nZ.y, float(0)).mul(wz))
    .mul(0.5);
  material.normalNode = transformNormalToView(
    normalWorld.add(perturb).normalize(),
  );

  material.roughnessNode = tp(scanRough).r.mul(0.6).add(0.22);

  // faked subsurface: deep red bleeding out at grazing angles, gated by the
  // scan's subsurface/thickness map so it varies like real tissue
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const fresnel = normalWorld.dot(viewDir).clamp(0, 1).oneMinus().pow(3);
  const sssMask = tp(scanSss).r.mul(0.8).add(0.2);
  material.emissiveNode = color(0x3d0d05).mul(fresnel).mul(sssMask).mul(0.55);

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
