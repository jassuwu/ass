import type { Lattice } from "./lattice";

/**
 * A hand as a body in the simulation, not a scripted dent. The palm is an
 * elliptical disc with a rounded rim (fingers along the long axis). It
 * arrives at the skin with the swing's velocity, the arm keeps pushing with
 * a force that dies over the swing, and the flesh pushes back through the
 * contact constraint — so the depth it reaches is an outcome: a hard slap
 * on a soft cheek sinks, a tap on the sacrum barely marks it. Then the hand
 * dwells for a beat and peels away, and the tissue recovers on its own.
 *
 * Friction is sticky: flesh under the palm travels with it, which is how
 * a swiped slap smears the cheek sideways instead of only denting it.
 */
export interface HandParams {
  /** mass of hand + forearm, in lattice particle masses */
  handMass: number;
  /** arrival speed along the blow, u/s, per unit of slap strength */
  arrivalSpeed: number;
  arrivalBase: number;
  /** arm push at the start of the swing, u/s² per unit strength */
  armAccel: number;
  /** seconds the arm keeps pushing after contact */
  driveS: number;
  /** seconds the hand stays planted once the drive ends */
  dwellS: number;
  /** minimum withdrawal speed, u/s — a hard slap bounces off harder */
  peelSpeed: number;
  /** fraction of tangential slip removed per substep contact */
  friction: number;
  /** rim rounding, world units */
  rim: number;
  /** long axis over short axis */
  elongation: number;
  /** how much deeper the palm's centre sits than its edge, world units */
  dome: number;
  /** depth ceiling in lattice cells — past this the grid cannot unfold */
  maxDepthCells: number;
  /** a fingertip drawn over the skin: pad radius, press depth, follow rate */
  fingerRadius: number;
  fingerDepth: number;
  fingerRate: number;
  fingerRim: number;
  /** how far beyond the edge the skin still slopes into the print */
  feather: number;
  fingerFeather: number;
}

export const defaultHandParams: HandParams = {
  handMass: 18,
  arrivalSpeed: 0.55,
  arrivalBase: 0.9,
  armAccel: 24,
  driveS: 0.04,
  dwellS: 0.02,
  peelSpeed: 3,
  friction: 0.85,
  rim: 0.07,
  elongation: 1.5,
  dome: 0.03,
  maxDepthCells: 1.3,
  fingerRadius: 0.1,
  fingerDepth: 0.018,
  fingerRate: 40,
  fingerRim: 0.03,
  feather: 0.11,
  fingerFeather: 0.035,
};

/**
 * The exact shape of a palm's front face at one instant: centre, blow
 * direction, finger and across axes with their semi-axes, rim rounding
 * and dome. The lattice collides with a softened version of it; the skin
 * is pushed out of the exact one at mesh resolution.
 */
export interface PalmFrame {
  cx: number;
  cy: number;
  cz: number;
  nx: number;
  ny: number;
  nz: number;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  ra: number;
  rb: number;
  rim: number;
  dome: number;
  feather: number;
}

export interface PalmHit {
  /** signed distance to the palm solid; negative = inside */
  sd: number;
  gx: number;
  gy: number;
  gz: number;
  /** ellipse-normalised lateral distance and axial coordinate */
  en: number;
  a: number;
}

/**
 * Signed distance from a point to the palm solid, with its gradient.
 * Returns false when the point is clearly ahead of the face.
 */
export function palmDistance(
  f: PalmFrame,
  px: number,
  py: number,
  pz: number,
  out: PalmHit,
): boolean {
  const dx = px - f.cx;
  const dy = py - f.cy;
  const dz = pz - f.cz;
  const la = dx * f.ax + dy * f.ay + dz * f.az;
  const lb = dx * f.bx + dy * f.by + dz * f.bz;
  const en = Math.hypot(la / f.ra, lb / f.rb);
  // the fleshy centre of the palm leads its edge: a shallow dome
  const a = dx * f.nx + dy * f.ny + dz * f.nz + f.dome * Math.min(en * en, 1);
  out.en = en;
  out.a = a;
  if (a > f.rim) return false;
  const rr = (en - 1) * (en > 1e-6 ? Math.hypot(la, lb) / en : f.ra);
  if (rr <= 0) {
    out.sd = a;
    out.gx = f.nx;
    out.gy = f.ny;
    out.gz = f.nz;
    return true;
  }
  const aa = Math.max(a + f.rim, 0);
  const q = Math.hypot(rr, aa);
  if (q < 1e-9) return false;
  out.sd = q - f.rim;
  const ll = Math.hypot(la, lb) || 1;
  const lx = (f.ax * la + f.bx * lb) / ll;
  const ly = (f.ay * la + f.by * lb) / ll;
  const lz = (f.az * la + f.bz * lb) / ll;
  out.gx = (lx * rr + f.nx * aa) / q;
  out.gy = (ly * rr + f.ny * aa) / q;
  out.gz = (lz * rr + f.nz * aa) / q;
  return true;
}

export interface ContactReport {
  /** depth the front of the palm reached, world units */
  depth: number;
  /** particles in contact at peak, times cell area — world units² */
  area: number;
  /** speed of arrival along the blow, u/s */
  arrival: number;
  /** mean anchor weight under the palm: 0 free fat, 1 bone */
  firmness: number;
  /** seconds from contact to peak depth (simulation time) */
  driveTime: number;
  /** contact origin on the skin and the direction of the blow */
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** the palm's nominal radius */
  radius: number;
  /** palm frame: unit finger axis, unit across axis, and the semi-axes */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  ra: number;
  rb: number;
}

type Phase = "drive" | "dwell" | "slide" | "peel" | "done";

/** world units ahead of the palm face that still count as touching */
const CONTACT_TOLERANCE = 0.006;

export class Hand {
  readonly params: HandParams;
  /** contact origin (rest space) and unit blow direction, into the flesh */
  ox: number;
  oy: number;
  oz: number;
  nx = 0;
  ny = 0;
  nz = 1;
  /** palm axes: a = fingers, b = across */
  private ax = 0;
  private ay = 1;
  private az = 0;
  private bx = 1;
  private by = 0;
  private bz = 0;
  private readonly ra: number;
  private readonly rb: number;
  /** a sliding fingertip chases this offset from its origin */
  private readonly goal = { x: 0, y: 0, z: 0 };
  private readonly lattice: Lattice;
  readonly radius: number;
  /** depth of the palm's front face along n; < 0 is outside the skin */
  depth = 0;
  private v: number;
  private readonly arrival: number;
  private readonly strength: number;
  /** tangential palm velocity carried in from the swipe, decays in contact */
  private tx: number;
  private ty: number;
  private tz: number;
  /** tangential offset the palm has travelled since contact */
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private phase: Phase = "drive";
  private age = 0;
  private phaseAge = 0;
  private readonly maxDepth: number;
  private ids: Int32Array = new Int32Array(0);
  /** which candidates carry mass: the dilation ring outside the skin is air */
  private massive: Uint8Array = new Uint8Array(0);
  /** where the candidate set was last gathered, for a travelling finger */
  private gatherX = 0;
  private gatherY = 0;
  private gatherZ = 0;
  private readonly cellArea: number;
  private readonly cellSize: number;
  private peakDepth = 0;
  private peakTime = 0;
  private peakCount = 0;
  private firmness = 0;
  private reported = false;
  private released = false;
  readonly isFinger: boolean;
  private readonly latticeFrame: PalmFrame = {
    cx: 0,
    cy: 0,
    cz: 0,
    nx: 0,
    ny: 0,
    nz: 1,
    ax: 0,
    ay: 1,
    az: 0,
    bx: 1,
    by: 0,
    bz: 0,
    ra: 1,
    rb: 1,
    rim: 0,
    dome: 0,
    feather: 0,
  };
  private readonly hit: PalmHit = { sd: 0, gx: 0, gy: 0, gz: 0, en: 0, a: 0 };

  constructor(
    lattice: Lattice,
    params: HandParams,
    point: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    tangential: { x: number; y: number; z: number },
    strength: number,
    radius: number,
  ) {
    this.params = params;
    this.lattice = lattice;
    this.strength = strength;
    this.radius = radius;
    this.isFinger = strength <= 0;
    this.ox = point.x;
    this.oy = point.y;
    this.oz = point.z;
    this.setFrame(dir);
    // same footprint as a disc of the nominal radius; a fingertip is round
    const e = this.isFinger ? 1 : params.elongation;
    this.ra = radius * Math.sqrt(e);
    this.rb = radius / Math.sqrt(e);
    this.arrival = params.arrivalBase + params.arrivalSpeed * strength;
    this.v = this.arrival;
    if (this.isFinger) {
      // resting on the skin, never reporting. The lattice is too coarse to
      // dent under a fingertip: it only carries the drag, and the skin
      // takes the dimple itself at mesh resolution (see frame()).
      this.phase = "slide";
      this.depth = 0;
      this.v = 0;
      this.reported = true;
      this.released = true;
    }
    // tangential component only — the axial part is the arrival itself
    const tn =
      tangential.x * this.nx + tangential.y * this.ny + tangential.z * this.nz;
    this.tx = tangential.x - this.nx * tn;
    this.ty = tangential.y - this.ny * tn;
    this.tz = tangential.z - this.nz * tn;
    this.maxDepth = lattice.spacing * params.maxDepthCells;
    this.cellArea = lattice.spacing * lattice.spacing;
    this.cellSize = lattice.spacing;
    this.gather(this.ox, this.oy, this.oz);
  }

  /** the blow direction and the palm axes that hang off it */
  private setFrame(dir: { x: number; y: number; z: number }): void {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    this.nx = dir.x / len;
    this.ny = dir.y / len;
    this.nz = dir.z / len;
    // fingers point along world up projected onto the palm plane
    let ax = 0 - this.nx * this.ny;
    let ay = 1 - this.ny * this.ny;
    let az = 0 - this.nz * this.ny;
    let al = Math.hypot(ax, ay, az);
    if (al < 1e-4) {
      ax = 1 - this.nx * this.nx;
      ay = 0 - this.ny * this.nx;
      az = 0 - this.nz * this.nx;
      al = Math.hypot(ax, ay, az);
    }
    this.ax = ax / al;
    this.ay = ay / al;
    this.az = az / al;
    this.bx = this.ny * this.az - this.nz * this.ay;
    this.by = this.nz * this.ax - this.nx * this.az;
    this.bz = this.nx * this.ay - this.ny * this.ax;
  }

  /**
   * candidate particles: anything the palm could sweep through, gathered
   * from rest positions around a centre with a margin for the smear. A
   * travelling fingertip re-gathers as it goes.
   */
  private gather(cx: number, cy: number, cz: number): void {
    const { rest, count, anchorW, inside, spacing } = this.lattice;
    const p = this.params;
    const ids: number[] = [];
    const massive: number[] = [];
    let firm = 0;
    let firmN = 0;
    const lateralMargin = this.isFinger ? 3.5 : 1.4;
    const swipeReach = Math.hypot(this.tx, this.ty, this.tz) * 0.2;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const dx = rest[i3] - cx;
      const dy = rest[i3 + 1] - cy;
      const dz = rest[i3 + 2] - cz;
      const a = dx * this.nx + dy * this.ny + dz * this.nz;
      if (a < -spacing || a > this.maxDepth + p.rim + 2 * spacing) continue;
      const u =
        (dx * this.ax + dy * this.ay + dz * this.az) / (this.ra + swipeReach);
      const w =
        (dx * this.bx + dy * this.by + dz * this.bz) / (this.rb + swipeReach);
      if (u * u + w * w > lateralMargin * lateralMargin) continue;
      ids.push(i);
      massive.push(inside[i]);
      if (inside[i] && u * u + w * w < 1 && a < spacing) {
        firm += anchorW[i];
        firmN++;
      }
    }
    this.ids = Int32Array.from(ids);
    this.massive = Uint8Array.from(massive);
    this.firmness = firmN > 0 ? firm / firmN : 0;
    this.gatherX = cx;
    this.gatherY = cy;
    this.gatherZ = cz;
  }

  /** a sliding fingertip: where the skin is under the cursor now */
  moveTo(
    point: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ): void {
    if (this.phase !== "slide") return;
    this.setFrame(dir);
    this.goal.x = point.x - this.ox;
    this.goal.y = point.y - this.oy;
    this.goal.z = point.z - this.oz;
    const gx = point.x - this.gatherX;
    const gy = point.y - this.gatherY;
    const gz = point.z - this.gatherZ;
    if (gx * gx + gy * gy + gz * gz > (this.ra * 1.5) ** 2)
      this.gather(point.x, point.y, point.z);
  }

  /** the fingertip lifts off */
  lift(): void {
    if (this.phase === "slide") {
      this.phase = "peel";
      this.phaseAge = 0;
    }
  }

  get done(): boolean {
    return this.phase === "done";
  }

  /** true from the moment the palm starts to leave */
  get peeling(): boolean {
    return this.phase === "peel" || this.phase === "done";
  }

  /** ready once the drive has ended; consumed by the solver's callback */
  takeReport(): ContactReport | null {
    if (this.reported || this.phase === "drive") return null;
    this.reported = true;
    return {
      depth: this.peakDepth,
      area: this.peakCount * this.cellArea,
      arrival: this.arrival,
      firmness: this.firmness,
      driveTime: this.peakTime,
      x: this.ox,
      y: this.oy,
      z: this.oz,
      nx: this.nx,
      ny: this.ny,
      nz: this.nz,
      radius: this.radius,
      ax: this.ax,
      ay: this.ay,
      az: this.az,
      bx: this.bx,
      by: this.by,
      bz: this.bz,
      ra: this.ra,
      rb: this.rb,
    };
  }

  /** fires once, at the moment the palm begins to peel */
  takeRelease(): boolean {
    if (this.released || !this.peeling) return false;
    this.released = true;
    return true;
  }

  /**
   * One substep: move the hand, then keep the flesh out of it. Returns
   * nothing; the reaction is folded into the hand's velocity in place.
   */
  step(h: number, pos: Float32Array, prev: Float32Array): void {
    const p = this.params;
    this.age += h;
    this.phaseAge += h;

    if (this.phase === "drive") {
      // arm force fades over the swing; the hand cannot be driven backward
      const arm =
        p.armAccel * this.strength * Math.max(0, 1 - this.phaseAge / p.driveS);
      this.v += arm * h;
      this.depth += this.v * h;
      if (this.depth > this.maxDepth) {
        this.depth = this.maxDepth;
        this.v = 0;
      }
      if (this.phaseAge >= p.driveS || (this.v <= 0 && this.phaseAge > 0.008)) {
        this.phase = "dwell";
        this.phaseAge = 0;
        this.v = 0;
      }
    } else if (this.phase === "dwell") {
      if (this.phaseAge >= p.dwellS) {
        this.phase = "peel";
        this.phaseAge = 0;
      }
    } else if (this.phase === "slide") {
      // the pad chases the cursor; its velocity is what friction hands on
      const k = 1 - Math.exp(-p.fingerRate * h);
      const dx = (this.goal.x - this.sx) * k;
      const dy = (this.goal.y - this.sy) * k;
      const dz = (this.goal.z - this.sz) * k;
      this.sx += dx;
      this.sy += dy;
      this.sz += dz;
      this.tx = dx / h;
      this.ty = dy / h;
      this.tz = dz / h;
    } else if (this.phase === "peel") {
      // the hand rebounds off the flesh faster than the flesh can follow
      this.depth -= Math.max(p.peelSpeed, this.arrival * 2.5) * h;
      if (this.depth < -Math.max(p.rim, p.fingerRim + p.fingerDepth) - 0.02) {
        this.phase = "done";
        return;
      }
    } else {
      return;
    }

    // the palm slides with its residual swipe while planted
    const slide = this.phase === "peel" ? 0 : 1;
    if (this.phase !== "slide") {
      this.sx += this.tx * h * slide;
      this.sy += this.ty * h * slide;
      this.sz += this.tz * h * slide;
      const tDecay = Math.exp(-14 * h);
      this.tx *= tDecay;
      this.ty *= tDecay;
      this.tz *= tDecay;
    }

    // the face the lattice sees: rounded off to the cell size, so its
    // coarse dent is smooth at the scale the lattice can express
    const f = this.latticeFrame;
    f.cx = this.ox + this.nx * this.depth + this.sx;
    f.cy = this.oy + this.ny * this.depth + this.sy;
    f.cz = this.oz + this.nz * this.depth + this.sz;
    f.nx = this.nx;
    f.ny = this.ny;
    f.nz = this.nz;
    f.ax = this.ax;
    f.ay = this.ay;
    f.az = this.az;
    f.bx = this.bx;
    f.by = this.by;
    f.bz = this.bz;
    f.ra = this.ra;
    f.rb = this.rb;
    f.rim = Math.max(p.rim, this.cellSize * 0.9);
    f.dome = this.isFinger ? 0 : p.dome;
    const hit = this.hit;
    const handVx = this.tx * slide + this.nx * this.v;
    const handVy = this.ty * slide + this.ny * this.v;
    const handVz = this.tz * slide + this.nz * this.v;

    if (this.isFinger) {
      // a fingertip cannot dent the lattice; it drags it. Sticky friction
      // weighted over a soft footprint wider than the pad, so several
      // particles move together instead of one cell at a time.
      for (let k = 0; k < this.ids.length; k++) {
        const i3 = this.ids[k] * 3;
        const dx = pos[i3] - f.cx;
        const dy = pos[i3 + 1] - f.cy;
        const dz = pos[i3 + 2] - f.cz;
        const a = dx * this.nx + dy * this.ny + dz * this.nz;
        if (a < -this.cellSize || a > this.cellSize * 1.5) continue;
        const la = dx * this.ax + dy * this.ay + dz * this.az;
        const lb = dx * this.bx + dy * this.by + dz * this.bz;
        const en = Math.hypot(la, lb) / (this.ra * 2.2);
        if (en > 1.6) continue;
        const w = Math.exp(-en * en * 2) * p.friction;
        this.drag(pos, prev, i3, handVx, handVy, handVz, h, w);
      }
      return;
    }

    // momentum bookkeeping for the reaction: the flesh the palm is touching
    // and how fast it was already moving along the blow
    let count = 0;
    let footprint = 0;
    let fleshMomentum = 0;
    const invH = 1 / h;

    for (let k = 0; k < this.ids.length; k++) {
      const i3 = this.ids[k] * 3;
      if (!palmDistance(f, pos[i3], pos[i3 + 1], pos[i3 + 2], hit)) continue;
      // footprint: skin under the face, within one cell of it (the ring
      // outside the body counts here — it is where the surface lives)
      if (hit.en < 1 && hit.a > -this.cellSize && hit.a < this.cellSize)
        footprint++;
      // flesh riding along with the palm sits a hair ahead of the face:
      // still in contact, still counted, just not pushed
      if (hit.sd >= CONTACT_TOLERANCE) continue;
      if (this.massive[k]) {
        fleshMomentum +=
          ((pos[i3] - prev[i3]) * this.nx +
            (pos[i3 + 1] - prev[i3 + 1]) * this.ny +
            (pos[i3 + 2] - prev[i3 + 2]) * this.nz) *
          invH;
        count++;
      }
      if (hit.sd < 0) {
        // push out of the palm
        pos[i3] -= hit.sd * hit.gx;
        pos[i3 + 1] -= hit.sd * hit.gy;
        pos[i3 + 2] -= hit.sd * hit.gz;
      }
      // sticky friction: the tangential motion of contacted flesh follows
      // the palm's — drag it along with the swipe, hold it during the dwell
      this.drag(pos, prev, i3, handVx, handVy, handVz, h, p.friction, hit);
    }

    if (this.phase === "drive") {
      // reaction: an inelastic merge with the flesh under the palm. Tissue
      // that was already travelling with the hand costs nothing; tissue the
      // constraints are pushing back into the palm slows it.
      if (count > 0) {
        this.v = Math.max(
          0,
          (p.handMass * this.v + fleshMomentum) / (p.handMass + count),
        );
      }
      if (this.depth > this.peakDepth) {
        this.peakDepth = this.depth;
        this.peakTime = this.age;
      }
      if (footprint > this.peakCount) this.peakCount = footprint;
    }
  }

  /** bring a particle's tangential motion toward the hand's, by weight */
  private drag(
    pos: Float32Array,
    prev: Float32Array,
    i3: number,
    vx: number,
    vy: number,
    vz: number,
    h: number,
    weight: number,
    hit?: PalmHit,
  ): void {
    let sx = vx * h - (pos[i3] - prev[i3]);
    let sy = vy * h - (pos[i3 + 1] - prev[i3 + 1]);
    let sz = vz * h - (pos[i3 + 2] - prev[i3 + 2]);
    const gx = hit ? hit.gx : this.nx;
    const gy = hit ? hit.gy : this.ny;
    const gz = hit ? hit.gz : this.nz;
    const sn = sx * gx + sy * gy + sz * gz;
    sx -= gx * sn;
    sy -= gy * sn;
    sz -= gz * sn;
    pos[i3] += sx * weight;
    pos[i3 + 1] += sy * weight;
    pos[i3 + 2] += sz * weight;
  }

  /**
   * the exact palm for the skin to conform to, or null once it has left.
   * A fingertip's visible press is entirely here — the lattice never saw it.
   */
  frame(): PalmFrame | null {
    if (this.phase === "done") return null;
    const p = this.params;
    const depth = this.isFinger ? p.fingerDepth + this.depth : this.depth;
    const rim = this.isFinger ? p.fingerRim : p.rim;
    if (depth < -rim) return null;
    return {
      cx: this.ox + this.nx * depth + this.sx,
      cy: this.oy + this.ny * depth + this.sy,
      cz: this.oz + this.nz * depth + this.sz,
      nx: this.nx,
      ny: this.ny,
      nz: this.nz,
      ax: this.ax,
      ay: this.ay,
      az: this.az,
      bx: this.bx,
      by: this.by,
      bz: this.bz,
      ra: this.ra,
      rb: this.rb,
      rim,
      // a fingertip's face is a bowl as deep as its press: it meets the
      // surface at its own edge instead of cutting a disc into it
      dome: this.isFinger ? p.fingerDepth : p.dome,
      feather: this.isFinger ? p.fingerFeather : p.feather,
    };
  }
}
