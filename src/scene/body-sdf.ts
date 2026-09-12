/**
 * The body as a signed distance field: pelvis + torso + two gluteal masses
 * + two SEPARATE thighs, blended with smooth-min so the crevices — the
 * crease between the cheeks, the gluteal fold where cheek meets thigh, the
 * gap between the legs — emerge from the geometry itself rather than being
 * carved grooves. Meshed by surface nets with exact SDF-gradient normals.
 *
 * Orientation: +z faces the camera (rear elevation), +y up.
 * Pure functions, no three.js: the physics worker evaluates these too.
 */
export const CORE_DEPTH = 0.5;

export const BOUNDS = {
  min: { x: -1.25, y: -2.45, z: -1.1 },
  max: { x: 1.25, y: 2.2, z: 1.1 },
};

const smoothstep = (x: number, lo: number, hi: number) => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};

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
    smoothstep(z, 0.1, 0.5);
  return d - press;
}

/**
 * normalized interior depth: 0 at/outside the surface, 1 deep in the core.
 * Drives the flesh layering — firm musculature inside, soft fat outside.
 */
export function depth01(x: number, y: number, z: number): number {
  if (
    x < BOUNDS.min.x ||
    x > BOUNDS.max.x ||
    y < BOUNDS.min.y ||
    y > BOUNDS.max.y ||
    z < BOUNDS.min.z ||
    z > BOUNDS.max.z
  ) {
    return 0;
  }
  return Math.min(Math.max(-bodySdf(x, y, z) / CORE_DEPTH, 0), 1);
}

export function isInside(x: number, y: number, z: number): boolean {
  return depth01(x, y, z) > 0;
}
