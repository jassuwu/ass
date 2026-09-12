import { attribute, float, uniform } from "three/tsl";
import * as THREE from "three/webgpu";

/**
 * Accumulated spank flush — blood rising where the hand has been landing.
 * A per-vertex scalar splatted on each impact and read by the skin
 * material through `node`. Decay costs nothing per frame: the shader
 * multiplies the attribute by one uniform exponential; whenever a new
 * splat arrives, the elapsed decay is folded into the array first and the
 * uniform's clock restarts. The mesh only re-uploads on impacts.
 */
export interface FlushParams {
  /** flush added by a full-power slap */
  gain: number;
  /** splat radius relative to the impact radius — redness spreads wider */
  spread: number;
  /** seconds for accumulated redness to fade to ~37% */
  fadeS: number;
}

export const defaultFlushParams: FlushParams = {
  gain: 0.38,
  spread: 1.0,
  fadeS: 40,
};

/** a palm's frame at the moment it peeled away, rest space */
export interface PalmPrint {
  x: number;
  y: number;
  z: number;
  /** unit blow direction, into the flesh */
  nx: number;
  ny: number;
  nz: number;
  /** unit finger axis and across axis with their semi-axes */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  ra: number;
  rb: number;
  depth01: number;
}

const smooth = (v: number, lo: number, hi: number) => {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};

export class FlushField {
  readonly params: FlushParams;
  private readonly decayU = uniform(1);
  /** flush 0..1 at the shaded point, decay already applied — for TSL.
   * The cast rides the same @types lag noted in render/pipeline.ts. */
  readonly node = float(
    attribute("flush", "float") as unknown as THREE.Node<"float">,
  )
    .mul(this.decayU)
    .clamp(0, 1);

  private readonly attr: THREE.BufferAttribute;
  private readonly data: Float32Array;
  private readonly base: Float32Array;
  private readonly baseNormal: Float32Array;
  private readonly vertCount: number;
  private foldedAtS = performance.now() / 1000;

  constructor(
    geometry: THREE.BufferGeometry,
    params: Partial<FlushParams> = {},
  ) {
    this.params = { ...defaultFlushParams, ...params };
    const pos = geometry.attributes.position;
    this.vertCount = pos.count;
    this.base = new Float32Array(pos.array);
    this.baseNormal = new Float32Array(geometry.attributes.normal.array);
    this.data = new Float32Array(this.vertCount);
    this.attr = new THREE.BufferAttribute(this.data, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("flush", this.attr);
  }

  private fold(): void {
    const now = performance.now() / 1000;
    const decayed = Math.exp(-(now - this.foldedAtS) / this.params.fadeS);
    this.foldedAtS = now;
    if (decayed < 1) {
      for (let v = 0; v < this.vertCount; v++) this.data[v] *= decayed;
    }
  }

  /**
   * A hand print. A spank does not leave a blush, it leaves a hand: the
   * palm's heel strongest, four fingers fainter with skin between them,
   * an edge sharper than any gaussian, and a soft halo of blood around it
   * all. The print is stamped in the palm's own frame, on the skin that
   * faced the blow.
   */
  print(p: PalmPrint): void {
    this.fold();
    const depth = Math.min(Math.max(p.depth01, 0), 1);
    const amount = this.params.gain * (0.3 + 0.9 * depth);
    const { data, base, baseNormal } = this;
    // fingers occupy the top of the ellipse; the heel of the palm the base
    const fingerFrom = 0.18;
    const haloSigma = p.ra * this.params.spread * 0.9;
    const haloInv = 1 / (2 * haloSigma * haloSigma);
    const reach2 = (p.ra * 2.2) ** 2;
    for (let v = 0; v < this.vertCount; v++) {
      const v3 = v * 3;
      const dx = base[v3] - p.x;
      const dy = base[v3 + 1] - p.y;
      const dz = base[v3 + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > reach2) continue;
      // only skin that faced the hand; the far side of the body never sees it
      const facing = -(
        baseNormal[v3] * p.nx +
        baseNormal[v3 + 1] * p.ny +
        baseNormal[v3 + 2] * p.nz
      );
      if (facing < 0.15) continue;
      const la = (dx * p.ax + dy * p.ay + dz * p.az) / p.ra;
      const lb = (dx * p.bx + dy * p.by + dz * p.bz) / p.rb;
      const en = Math.hypot(la, lb);
      // palm mask: hard-ish edge, a little uneven
      const edge = smooth(1.04 - en, 0, 0.16);
      let print = edge;
      if (la > fingerFrom) {
        // four fingers across the width, gaps between them, thinning toward
        // the tips; the heel below stays solid
        const fingers = smooth(
          Math.abs(Math.sin(2 * Math.PI * lb)),
          0.32,
          0.72,
        );
        const along = smooth(la, fingerFrom, fingerFrom + 0.18);
        print *= 1 - along * (1 - fingers) * 0.85;
        print *= 1 - 0.25 * smooth(la, 0.6, 1.0);
      } else {
        // the heel: the centre of the palm hollows slightly
        print *= 0.82 + 0.18 * smooth(en, 0.25, 0.7);
      }
      const halo = 0.3 * Math.exp(-d2 * haloInv);
      const f = data[v] + amount * (print * facing + halo);
      data[v] = Math.min(f, 1);
    }
    this.attr.needsUpdate = true;
    this.decayU.value = 1;
  }

  /** a gentle round blush — for pats and pokes that leave no print */
  splat(point: THREE.Vector3, radius: number, power01: number): void {
    this.fold();

    const amount = this.params.gain * (0.35 + 0.65 * Math.min(power01, 1));
    const sigma = radius * this.params.spread * 0.5;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const cutoff2 = (3 * sigma) ** 2;
    const { data, base } = this;
    for (let v = 0; v < this.vertCount; v++) {
      let f = data[v];
      const dx = base[v * 3] - point.x;
      const dy = base[v * 3 + 1] - point.y;
      const dz = base[v * 3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < cutoff2) {
        f += amount * Math.exp(-d2 * inv2s2);
      }
      data[v] = Math.min(f, 1);
    }
    this.attr.needsUpdate = true;
    this.decayU.value = 1;
  }

  /** per frame: advance the shader-side decay clock (a single uniform) */
  update(): void {
    const now = performance.now() / 1000;
    this.decayU.value = Math.exp(-(now - this.foldedAtS) / this.params.fadeS);
  }
}
