import {
  attribute,
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
import { BOUNDS, bodySdf, depth01, isInside } from "./body-sdf";
import { FlushField } from "./flush";
import { surfaceNets } from "./surface-nets";

export { bodySdf } from "./body-sdf";

const BOUNDS_MIN = new THREE.Vector3(BOUNDS.min.x, BOUNDS.min.y, BOUNDS.min.z);
const BOUNDS_MAX = new THREE.Vector3(BOUNDS.max.x, BOUNDS.max.y, BOUNDS.max.z);

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
  // a second octave at ~3.5x adds the micro grain a single tile can't hold.
  // Projected and blended in REST space — immutable copies of each vertex's
  // undeformed position and normal — so the pores stay glued to the skin
  // when it moves instead of sliding through a world-space projection, and
  // the blend never flips axes inside a dent.
  const uvScale = 1.6;
  const uvScale2 = 5.6;
  const skinP = vec3(
    attribute("skinPosition", "vec3") as unknown as THREE.Node<"vec3">,
  );
  const skinN = vec3(
    attribute("skinNormal", "vec3") as unknown as THREE.Node<"vec3">,
  ).normalize();
  const w = skinN.abs().pow(4);
  const wSum = w.x.add(w.y).add(w.z);
  const wx = w.x.div(wSum);
  const wy = w.y.div(wSum);
  const wz = w.z.div(wSum);
  const tp = (map: THREE.Texture, scale: number) =>
    texture(map, skinP.zy.mul(scale))
      .mul(wx)
      .add(texture(map, skinP.xz.mul(scale)).mul(wy))
      .add(texture(map, skinP.xy.mul(scale)).mul(wz));

  // albedo: authored tonal gradients carry the HUE; the scan contributes
  // LUMINANCE detail only. Multiplying skin color by skin color squares the
  // saturation into terracotta — never do that.
  // sampled off the reference photo: warm sun tan
  const base = color(0xb27c5c);
  const flushed = color(0x9d6749);
  const pale = color(0xc59579);
  const broad = mx_fractal_noise_float(skinP.mul(1.4)).mul(0.5).add(0.5);
  const fine = mx_fractal_noise_float(skinP.mul(6.5)).mul(0.5).add(0.5);
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
    const nX = decode(texture(scanNormal, skinP.zy.mul(scale)));
    const nY = decode(texture(scanNormal, skinP.xz.mul(scale)));
    const nZ = decode(texture(scanNormal, skinP.xy.mul(scale)));
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
  // the exact SDF-gradient normals alias into a zipper along the crease;
  // smooth mesh normals from the first frame, as after any deformation
  geometry.computeVertexNormals();
  // the skin's own coordinates: what the material projects its maps in
  geometry.setAttribute("skinPosition", geometry.attributes.position.clone());
  geometry.setAttribute("skinNormal", geometry.attributes.normal.clone());
  const flush = new FlushField(geometry);
  const mesh = new THREE.Mesh(geometry, createSkinMaterial(flush));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const proxy = new THREE.Mesh(
    surfaceNets(bodySdf, BOUNDS_MIN, BOUNDS_MAX, 0.1),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  proxy.updateMatrixWorld(true);

  return {
    mesh,
    proxy,
    isInside: (p) => isInside(p.x, p.y, p.z),
    depth01: (p) => depth01(p.x, p.y, p.z),
    flush,
  };
}
