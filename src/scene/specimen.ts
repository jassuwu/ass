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
import { FlushField } from "./flush";
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
  /** accumulated spank redness — splatted by the app on every impact */
  flush: FlushField;
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

const BOUNDS_MIN = new THREE.Vector3(-1.25, -2.45, -1.1);
const BOUNDS_MAX = new THREE.Vector3(1.25, 2.2, 1.1);

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
    side * 0.46,
    -0.6,
    0.02,
    side * 0.52,
    -2.4,
    -0.06,
    0.44,
    0.3,
  );
  const hamstring = sdEllipsoid(
    x,
    y,
    z,
    side * 0.44,
    -0.9,
    0.1,
    0.36,
    0.5,
    0.34,
  );
  const adductor = sdEllipsoid(
    x,
    y,
    z,
    side * 0.3,
    -0.8,
    0.0,
    0.28,
    0.45,
    0.28,
  );
  return smin(smin(core, hamstring, 0.18), adductor, 0.15);
}

/**
 * Proportions taken from photographic reference, not imagination:
 * teardrop glutes (volume in the lower third), a flat sacral triangle
 * above a SHORT cleft (middle third only), a barely-there fold, hips
 * ~1.25x the waist, modest projection.
 */
export function bodySdf(x: number, y: number, z: number): number {
  const pelvis = sdEllipsoid(x, y, z, 0, 0.45, -0.1, 1.05, 0.7, 0.8);
  const torso = sdEllipsoid(x, y, z, 0, 1.65, -0.15, 0.8, 1.3, 0.7);
  // each cheek: an upper mass + a lower teardrop fullness — rounder and
  // more projected per reference, still anchored by the flat sacral triangle
  const upperL = sdEllipsoid(x, y, z, -0.44, -0.05, 0.28, 0.64, 0.7, 0.66);
  const upperR = sdEllipsoid(x, y, z, 0.44, -0.05, 0.28, 0.64, 0.7, 0.66);
  const lowerL = sdEllipsoid(x, y, z, -0.42, -0.38, 0.32, 0.54, 0.52, 0.6);
  const lowerR = sdEllipsoid(x, y, z, 0.42, -0.38, 0.32, 0.54, 0.52, 0.6);
  const gluteL = smin(upperL, lowerL, 0.18);
  const gluteR = smin(upperR, lowerR, 0.18);

  // waist emerges from the pelvis/torso blend
  let d = smin(pelvis, torso, 0.4);
  // generous blend into the pelvis creates the flat sacral triangle;
  // crease blend must stay >= ~2 mesh cells or the seam aliases into a zipper
  d = smin(d, smin(gluteL, gluteR, 0.06), 0.28);
  // defined fold at the thigh junction — reference shows a real crease line
  d = smin(d, Math.min(sdLeg(x, y, z, -1), sdLeg(x, y, z, 1)), 0.13);

  // faint pressure swell beside the cleft (zero on the seam), gated low —
  // in the reference the crease darkens gently, it does not trench
  const ring =
    Math.exp(-((x / 0.22) ** 2)) * (1 - Math.exp(-((x / 0.06) ** 2)));
  const press =
    0.05 *
    ring *
    Math.exp(-(((y + 0.25) / 0.5) ** 2)) *
    THREE.MathUtils.smoothstep(z, 0.1, 0.5);
  return d - press;
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
function createSkinMaterial(flush: FlushField): THREE.MeshPhysicalNodeMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial({
    sheen: 0.2,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xffdcc8),
    // the thin oily top layer of skin: sun-kissed sheen per reference —
    // present, but short of "wet"
    clearcoat: 0.12,
    clearcoatRoughness: 0.3,
  });

  const loader = new THREE.TextureLoader();
  const load = (name: string, srgb = false): THREE.Texture => {
    const t = loader.load(`/textures/skin/${name}`);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 16;
    return t;
  };
  const scanColor = load("skin_0001_color_4k.jpg", true);
  const scanNormal = load("skin_0001_normal_4k.jpg");
  const scanRough = load("skin_0001_roughness_4k.jpg");
  const scanSss = load("skin_0001_subsurface_4k.jpg");

  // ~0.6 world units (~8cm) per tile matches the scan's real-world scale;
  // a second octave at ~3.5x adds the micro grain a single tile can't hold
  const uvScale = 1.6;
  const uvScale2 = 5.6;
  const w = normalWorld.abs().pow(4);
  const wSum = w.x.add(w.y).add(w.z);
  const wx = w.x.div(wSum);
  const wy = w.y.div(wSum);
  const wz = w.z.div(wSum);
  const tp = (map: THREE.Texture, scale: number) =>
    texture(map, positionWorld.zy.mul(scale))
      .mul(wx)
      .add(texture(map, positionWorld.xz.mul(scale)).mul(wy))
      .add(texture(map, positionWorld.xy.mul(scale)).mul(wz));

  // albedo: authored tonal gradients carry the HUE; the scan contributes
  // LUMINANCE detail only. Multiplying skin color by skin color squares the
  // saturation into terracotta — never do that.
  // sampled off the reference photo: warm sun tan
  const base = color(0xb27c5c);
  const flushed = color(0x9d6749);
  const pale = color(0xc59579);
  const broad = mx_fractal_noise_float(positionWorld.mul(1.4))
    .mul(0.5)
    .add(0.5);
  const fine = mx_fractal_noise_float(positionWorld.mul(6.5)).mul(0.5).add(0.5);
  const tint = mix(mix(base, pale, broad.mul(0.35)), flushed, fine.mul(0.22));
  // spank flush: blood rising under repeated impacts, mottled by the fine
  // noise — real irritation is blotchy, never an even airbrush. The
  // 0.55..1.15 range keeps the mottle alive even where accumulation has
  // saturated the attribute.
  const flushAmt = flush.node.mul(fine.mul(0.6).add(0.55)).clamp(0, 1);
  // the scan samples in LINEAR space here — its average sits near 0.35,
  // so the normalization factor is ~2.8, not ~1.5 (getting this wrong
  // darkens the albedo 40% and the whole frame collapses into deep red)
  const scanLum = tp(scanColor, uvScale).rgb.dot(vec3(0.299, 0.587, 0.114));
  const lumF = scanLum.mul(2.8).clamp(0.65, 1.4);
  // flushed skin goes toward a BRIGHT saturated red (darker mixes read as
  // bruise, not slap) and FLATTENS the scan's tile-scale luminance swings —
  // blood evens out surface tone, and unflattened they amplify into
  // blocky chroma patches under the red
  const flushedSkin = color(0xd0472e).mul(lumF.mul(0.35).add(0.65));
  material.colorNode = mix(tint.mul(lumF), flushedSkin, flushAmt.mul(0.6));

  // scanned normals, UDN triplanar blend, two octaves
  const decode = (t: ReturnType<typeof texture>) => t.xy.mul(2).sub(1);
  const octave = (scale: number, strength: number) => {
    const nX = decode(texture(scanNormal, positionWorld.zy.mul(scale)));
    const nY = decode(texture(scanNormal, positionWorld.xz.mul(scale)));
    const nZ = decode(texture(scanNormal, positionWorld.xy.mul(scale)));
    return vec3(float(0), nX.y, nX.x)
      .mul(wx)
      .add(vec3(nY.x, float(0), nY.y).mul(wy))
      .add(vec3(nZ.x, nZ.y, float(0)).mul(wz))
      .mul(strength);
  };
  material.normalNode = transformNormalToView(
    normalWorld
      .add(octave(uvScale, 0.65))
      .add(octave(uvScale2, 0.3))
      .normalize(),
  );

  // inflamed skin swells slightly shiny — a small flush-driven tightening
  material.roughnessNode = tp(scanRough, uvScale)
    .r.mul(0.42)
    .add(tp(scanRough, uvScale2).r.mul(0.24))
    .add(0.14)
    .sub(flushAmt.mul(0.06));

  // faked subsurface: deep red bleeding out at grazing angles, gated by the
  // scan's subsurface/thickness map so it varies like real tissue — and
  // deepening where the flush pools
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const fresnel = normalWorld.dot(viewDir).clamp(0, 1).oneMinus().pow(3);
  const sssMask = tp(scanSss, uvScale).r.mul(0.8).add(0.2);
  material.emissiveNode = color(0x3d0d05)
    .mul(fresnel)
    .mul(sssMask)
    .mul(flushAmt.mul(0.45).add(0.35));

  return material;
}

export function createPlaceholderSpecimen(): Specimen {
  const geometry = surfaceNets(bodySdf, BOUNDS_MIN, BOUNDS_MAX, 0.026);
  const flush = new FlushField(geometry);
  const mesh = new THREE.Mesh(geometry, createSkinMaterial(flush));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const proxy = new THREE.Mesh(
    surfaceNets(bodySdf, BOUNDS_MIN, BOUNDS_MAX, 0.1),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  proxy.updateMatrixWorld(true);

  return { mesh, proxy, isInside, depth01, flush };
}
