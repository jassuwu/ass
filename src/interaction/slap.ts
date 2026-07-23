import * as THREE from "three/webgpu";
import type { XpbdSolver } from "../physics/solver";

/**
 * The entire interaction vocabulary, none of it explained on screen:
 * - brush: moving the cursor across the surface drags it faintly
 * - tap: quick press -> small impulse at the cursor
 * - hold still: charge builds silently; release delivers it. The heartbeat
 *   rides this.
 * - press and DRAG: becomes a grab — a handful of flesh follows the hand,
 *   released with whatever velocity it had. The most tactile thing here.
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
  grabRadius: number;
  /** how far a grabbed handful can be pulled, world units */
  maxPull: number;
}

export const defaultSlapParams: SlapParams = {
  tapPower: 0.7,
  chargeBonus: 3.2,
  chargeTimeMs: 1100,
  tapThresholdMs: 180,
  radius: 0.45,
  chargeRadiusBonus: 0.3,
  brushPower: 0.22,
  brushRadius: 0.35,
  grabRadius: 0.55,
  maxPull: 0.5,
};

/** movement beyond this many px converts a hold into a grab */
const GRAB_SLOP_PX = 8;

export class SlapInteraction {
  readonly params: SlapParams;
  /** 0..1 while holding still, for the audio/visual layers to observe */
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
  private mode: "idle" | "pending" | "grab" = "idle";
  private holdStart = 0;
  private downX = 0;
  private downY = 0;
  private hitDist = 0;
  private readonly grabOrigin = new THREE.Vector3();
  private readonly grabOffset = new THREE.Vector3();
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
    this.charge =
      this.mode === "pending"
        ? Math.min(
            1,
            (performance.now() - this.holdStart) / this.params.chargeTimeMs,
          )
        : 0;
  }

  private setRay(clientX: number, clientY: number): void {
    this.ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -((clientY / window.innerHeight) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private cast(clientX: number, clientY: number): THREE.Intersection | null {
    this.setRay(clientX, clientY);
    const hits = this.raycaster.intersectObject(this.proxy, false);
    return hits.length > 0 ? hits[0] : null;
  }

  private onDown(e: PointerEvent): void {
    const hit = this.cast(e.clientX, e.clientY);
    if (!hit) return;
    this.mode = "pending";
    this.holdStart = performance.now();
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.hitDist = hit.distance;
    this.grabOrigin.copy(hit.point);
  }

  private onUp(e: PointerEvent): void {
    if (this.mode === "grab") {
      this.solver.endGrab();
      this.mode = "idle";
      return;
    }
    if (this.mode !== "pending") return;
    this.mode = "idle";
    const heldMs = performance.now() - this.holdStart;

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
    if (this.mode === "pending") {
      const dx = e.clientX - this.downX;
      const dy = e.clientY - this.downY;
      if (dx * dx + dy * dy > GRAB_SLOP_PX * GRAB_SLOP_PX) {
        this.mode = "grab";
        this.solver.startGrab(this.grabOrigin, this.params.grabRadius);
      }
    }

    if (this.mode === "grab") {
      // the handful follows the cursor on the plane of the original hit
      this.setRay(e.clientX, e.clientY);
      this.grabOffset
        .copy(this.raycaster.ray.origin)
        .addScaledVector(this.raycaster.ray.direction, this.hitDist)
        .sub(this.grabOrigin);
      if (this.grabOffset.length() > this.params.maxPull) {
        this.grabOffset.setLength(this.params.maxPull);
      }
      this.solver.setGrabOffset(this.grabOffset);
      return;
    }
    if (this.mode !== "idle") return;

    // brush
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
        const strength = Math.min(this.params.brushPower * speed, 0.45);
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
