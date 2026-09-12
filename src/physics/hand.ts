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
};

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

type Phase = "drive" | "dwell" | "peel" | "done";

/** world units ahead of the palm face that still count as touching */
const CONTACT_TOLERANCE = 0.006;

export class Hand {
  readonly params: HandParams;
  /** contact origin (rest space) and unit blow direction, into the flesh */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** palm axes: a = fingers, b = across */
  private readonly ax: number;
  private readonly ay: number;
  private readonly az: number;
  private readonly bx: number;
  private readonly by: number;
  private readonly bz: number;
  private readonly ra: number;
  private readonly rb: number;
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
  private readonly ids: Int32Array;
  /** which candidates carry mass: the dilation ring outside the skin is air */
  private readonly massive: Uint8Array;
  private readonly cellArea: number;
  private readonly cellSize: number;
  private peakDepth = 0;
  private peakTime = 0;
  private peakCount = 0;
  private firmness: number;
  private reported = false;
  private released = false;

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
    this.strength = strength;
    this.radius = radius;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    this.nx = dir.x / len;
    this.ny = dir.y / len;
    this.nz = dir.z / len;
    this.ox = point.x;
    this.oy = point.y;
    this.oz = point.z;
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
    // same footprint as a disc of the nominal radius
    const e = params.elongation;
    this.ra = radius * Math.sqrt(e);
    this.rb = radius / Math.sqrt(e);
    this.arrival = params.arrivalBase + params.arrivalSpeed * strength;
    this.v = this.arrival;
    // tangential component only — the axial part is the arrival itself
    const tn =
      tangential.x * this.nx + tangential.y * this.ny + tangential.z * this.nz;
    this.tx = tangential.x - this.nx * tn;
    this.ty = tangential.y - this.ny * tn;
    this.tz = tangential.z - this.nz * tn;
    this.maxDepth = lattice.spacing * params.maxDepthCells;
    this.cellArea = lattice.spacing * lattice.spacing;
    this.cellSize = lattice.spacing;

    // candidate particles: anything the palm could sweep through, gathered
    // once from rest positions with a margin for the smear
    const { rest, count, anchorW, inside } = lattice;
    const ids: number[] = [];
    const massive: number[] = [];
    let firm = 0;
    let firmN = 0;
    const lateralMargin = 1.4;
    const swipeReach = Math.hypot(this.tx, this.ty, this.tz) * 0.2;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const dx = rest[i3] - this.ox;
      const dy = rest[i3 + 1] - this.oy;
      const dz = rest[i3 + 2] - this.oz;
      const a = dx * this.nx + dy * this.ny + dz * this.nz;
      if (
        a < -lattice.spacing ||
        a > this.maxDepth + params.rim + 2 * lattice.spacing
      )
        continue;
      const u =
        (dx * this.ax + dy * this.ay + dz * this.az) / (this.ra + swipeReach);
      const w =
        (dx * this.bx + dy * this.by + dz * this.bz) / (this.rb + swipeReach);
      if (u * u + w * w > lateralMargin * lateralMargin) continue;
      ids.push(i);
      massive.push(inside[i]);
      if (inside[i] && u * u + w * w < 1 && a < lattice.spacing) {
        firm += anchorW[i];
        firmN++;
      }
    }
    this.ids = Int32Array.from(ids);
    this.massive = Uint8Array.from(massive);
    this.firmness = firmN > 0 ? firm / firmN : 0;
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
    } else if (this.phase === "peel") {
      // the hand rebounds off the flesh faster than the flesh can follow
      this.depth -= Math.max(p.peelSpeed, this.arrival * 2.5) * h;
      if (this.depth < -p.rim - 0.02) {
        this.phase = "done";
        return;
      }
    } else {
      return;
    }

    // the palm slides with its residual swipe while planted
    const slide = this.phase === "peel" ? 0 : 1;
    this.sx += this.tx * h * slide;
    this.sy += this.ty * h * slide;
    this.sz += this.tz * h * slide;
    const tDecay = Math.exp(-14 * h);
    this.tx *= tDecay;
    this.ty *= tDecay;
    this.tz *= tDecay;

    // front-face centre
    const cx = this.ox + this.nx * this.depth + this.sx;
    const cy = this.oy + this.ny * this.depth + this.sy;
    const cz = this.oz + this.nz * this.depth + this.sz;
    const rim = p.rim;
    // momentum bookkeeping for the reaction: the flesh the palm is touching
    // and how fast it was already moving along the blow
    let count = 0;
    let footprint = 0;
    let fleshMomentum = 0;
    const invH = 1 / h;
    const handVx = this.tx * slide + this.nx * this.v;
    const handVy = this.ty * slide + this.ny * this.v;
    const handVz = this.tz * slide + this.nz * this.v;

    for (let k = 0; k < this.ids.length; k++) {
      const i3 = this.ids[k] * 3;
      const dx = pos[i3] - cx;
      const dy = pos[i3 + 1] - cy;
      const dz = pos[i3 + 2] - cz;
      const la = dx * this.ax + dy * this.ay + dz * this.az;
      const lb = dx * this.bx + dy * this.by + dz * this.bz;
      // ellipse-normalised lateral distance, then back to world units
      const en = Math.hypot(la / this.ra, lb / this.rb);
      // the fleshy centre of the palm leads its edge: a shallow dome
      const a =
        dx * this.nx +
        dy * this.ny +
        dz * this.nz +
        p.dome * Math.min(en * en, 1);
      if (a > rim) continue;
      // footprint: skin under the face, within one cell of it (the ring
      // outside the body counts here — it is where the surface lives)
      if (en < 1 && a > -this.cellSize && a < this.cellSize) footprint++;
      const rr = (en - 1) * (en > 1e-6 ? Math.hypot(la, lb) / en : this.ra);
      let sd: number;
      let gx: number;
      let gy: number;
      let gz: number;
      if (rr <= 0) {
        sd = a;
        gx = this.nx;
        gy = this.ny;
        gz = this.nz;
      } else {
        const aa = Math.max(a + rim, 0);
        const q = Math.hypot(rr, aa);
        if (q < 1e-9) continue;
        sd = q - rim;
        // lateral direction in world space
        const ll = Math.hypot(la, lb) || 1;
        const lx = (this.ax * la + this.bx * lb) / ll;
        const ly = (this.ay * la + this.by * lb) / ll;
        const lz = (this.az * la + this.bz * lb) / ll;
        gx = (lx * rr + this.nx * aa) / q;
        gy = (ly * rr + this.ny * aa) / q;
        gz = (lz * rr + this.nz * aa) / q;
      }
      // flesh riding along with the palm sits a hair ahead of the face:
      // still in contact, still counted, just not pushed
      if (sd >= CONTACT_TOLERANCE) continue;
      if (this.massive[k]) {
        fleshMomentum +=
          ((pos[i3] - prev[i3]) * this.nx +
            (pos[i3 + 1] - prev[i3 + 1]) * this.ny +
            (pos[i3 + 2] - prev[i3 + 2]) * this.nz) *
          invH;
        count++;
      }
      if (sd >= 0) continue;
      // push out of the palm
      pos[i3] -= sd * gx;
      pos[i3 + 1] -= sd * gy;
      pos[i3 + 2] -= sd * gz;
      // sticky friction: the tangential motion of contacted flesh follows
      // the palm's — drag it along with the swipe, hold it during the dwell
      const mvx = pos[i3] - prev[i3];
      const mvy = pos[i3 + 1] - prev[i3 + 1];
      const mvz = pos[i3 + 2] - prev[i3 + 2];
      const wantX = handVx * h;
      const wantY = handVy * h;
      const wantZ = handVz * h;
      let sxv = wantX - mvx;
      let syv = wantY - mvy;
      let szv = wantZ - mvz;
      const sn = sxv * gx + syv * gy + szv * gz;
      sxv -= gx * sn;
      syv -= gy * sn;
      szv -= gz * sn;
      pos[i3] += sxv * p.friction;
      pos[i3 + 1] += syv * p.friction;
      pos[i3 + 2] += szv * p.friction;
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
}
