import * as THREE from "three/webgpu";
import type { XpbdSolver } from "../physics/solver";

/**
 * The entire interaction vocabulary, none of it explained on screen:
 * - tap: quick press -> small impulse at the cursor
 * - hold: press and keep holding -> charge builds silently; release delivers
 *   it where the cursor is. The heartbeat (audio phase) will ride this.
 * - brush: moving the cursor across the surface drags it faintly, so the
 *   very first idle mouse movement already answers "is this thing live?"
 */
export interface SlapParams {
  tapPower: number;
  /** extra power at full charge */
  chargeBonus: number;
  chargeTimeMs: number;
  /** press shorter than this is a tap */
  tapThresholdMs: number;
  radius: number;
  /** extra impulse radius at full charge */
  chargeRadiusBonus: number;
  brushPower: number;
  brushRadius: number;
}

export const defaultSlapParams: SlapParams = {
  tapPower: 0.7,
  chargeBonus: 3.2,
  chargeTimeMs: 1100,
  tapThresholdMs: 180,
  radius: 0.45,
  chargeRadiusBonus: 0.3,
  brushPower: 0.12,
  brushRadius: 0.3,
};

export class SlapInteraction {
  readonly params: SlapParams;
  /** 0..1 while holding, for the audio/visual layers to observe */
  charge = 0;
  /** fired on delivered impact with normalized power 0..1, point and direction */
  onImpact:
    | ((power01: number, point: THREE.Vector3, dir: THREE.Vector3) => void)
    | null = null;

  private readonly camera: THREE.Camera;
  private readonly proxy: THREE.Mesh;
  private readonly solver: XpbdSolver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private holdStart: number | null = null;
  private lastBrush: { point: THREE.Vector3; time: number } | null = null;

  constructor(
    dom: HTMLElement,
    camera: THREE.Camera,
    proxy: THREE.Mesh,
    solver: XpbdSolver,
    params: Partial<SlapParams> = {},
  ) {
    this.camera = camera;
    this.proxy = proxy;
    this.solver = solver;
    this.params = { ...defaultSlapParams, ...params };

    dom.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
  }

  update(): void {
    if (this.holdStart !== null) {
      this.charge = Math.min(
        1,
        (performance.now() - this.holdStart) / this.params.chargeTimeMs,
      );
    } else {
      this.charge = 0;
    }
  }

  private cast(clientX: number, clientY: number): THREE.Intersection | null {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -((clientY / window.innerHeight) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.proxy, false);
    return hits.length > 0 ? hits[0] : null;
  }

  private onDown(e: PointerEvent): void {
    if (this.cast(e.clientX, e.clientY)) {
      this.holdStart = performance.now();
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.holdStart === null) return;
    const heldMs = performance.now() - this.holdStart;
    this.holdStart = null;

    const hit = this.cast(e.clientX, e.clientY);
    if (!hit) return;

    const p = this.params;
    const charge =
      heldMs <= p.tapThresholdMs ? 0 : Math.min(1, heldMs / p.chargeTimeMs);
    // ease-in so a lazy half-hold doesn't already feel like a haymaker
    const curve = charge * charge;
    const power = p.tapPower + curve * p.chargeBonus;
    const radius = p.radius + curve * p.chargeRadiusBonus;
    this.solver.impulse(hit.point, this.raycaster.ray.direction, power, radius);
    this.onImpact?.(
      power / (p.tapPower + p.chargeBonus),
      hit.point,
      this.raycaster.ray.direction,
    );
  }

  private onMove(e: PointerEvent): void {
    if (this.holdStart !== null) return; // no brushing mid-ritual
    const now = performance.now();
    if (this.lastBrush && now - this.lastBrush.time < 16) return;

    const hit = this.cast(e.clientX, e.clientY);
    if (!hit) {
      this.lastBrush = null;
      return;
    }
    if (this.lastBrush) {
      const dtS = (now - this.lastBrush.time) / 1000;
      const delta = hit.point.clone().sub(this.lastBrush.point);
      const dist = delta.length();
      if (dist > 1e-3 && dtS > 0) {
        const speed = dist / dtS;
        const strength = Math.min(this.params.brushPower * speed, 0.4);
        this.solver.impulse(
          hit.point,
          delta,
          strength,
          this.params.brushRadius,
        );
      }
    }
    this.lastBrush = { point: hit.point.clone(), time: now };
  }
}
