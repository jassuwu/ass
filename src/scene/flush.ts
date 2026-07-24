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
    this.data = new Float32Array(this.vertCount);
    this.attr = new THREE.BufferAttribute(this.data, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("flush", this.attr);
  }

  /** an impact lands: fold elapsed decay in, then add a gaussian of blood */
  splat(point: THREE.Vector3, radius: number, power01: number): void {
    const now = performance.now() / 1000;
    const decayed = Math.exp(-(now - this.foldedAtS) / this.params.fadeS);
    this.foldedAtS = now;

    const amount = this.params.gain * (0.35 + 0.65 * Math.min(power01, 1));
    const sigma = radius * this.params.spread * 0.5;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const cutoff2 = (3 * sigma) ** 2;
    const { data, base } = this;
    for (let v = 0; v < this.vertCount; v++) {
      let f = data[v] * decayed;
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
