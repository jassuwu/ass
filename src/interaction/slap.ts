import * as THREE from "three/webgpu";
import type { XpbdSolver } from "../physics/solver";

/**
 * The entire interaction vocabulary, none of it explained on screen:
 * - brush: moving the cursor across the surface drags it faintly
 * - tap: quick press -> small impulse at the cursor. A tap thrown from a
 *   MOVING cursor smears in the direction of travel — a real slap has
 *   follow-through, not just a poke along the view ray.
 * - hold still: charge builds silently; release delivers it, tilted by
 *   whatever the hand was doing at release. Past ~1/3 charge the hand is
 *   cocked: movement no longer converts to a grab, so a wound-up swipe
 *   lands as a directional haymaker. The heartbeat rides the charge.
 * - press and DRAG (early in a hold): becomes a grab — a handful of flesh
 *   follows the hand, and letting go flings it with the hand's velocity.
 *   The most tactile thing here.
 * (Pressing the VOID and dragging orbits the camera instead — see
 * OrbitControl. The two layers share the pointer via `blocked`/`cancel`.)
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
  /** how strongly cursor motion tilts a slap off the view ray */
  swipeInfluence: number;
  /** cursor speed (px/s) that counts as a full swipe */
  swipeRefSpeed: number;
  /** extra power multiplier at full swipe — a moving slap stings more */
  swipePowerBonus: number;
  /** released-grab fling: hand velocity (u/s) -> impulse strength */
  flingGain: number;
  flingMax: number;
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
  swipeInfluence: 0.85,
  swipeRefSpeed: 1400,
  swipePowerBonus: 0.3,
  flingGain: 0.6,
  flingMax: 2.5,
};

/** movement beyond this many px converts a hold into a grab */
const GRAB_SLOP_PX = 8;
/** past this charge the hand is cocked — movement no longer grabs */
const GRAB_CHARGE_LIMIT = 0.35;
/** pointer samples older than this contribute nothing to the swipe */
const SWIPE_WINDOW_MS = 100;

export class SlapInteraction {
  readonly params: SlapParams;
  /** 0..1 while holding still, for the audio/visual layers to observe */
  charge = 0;
  /** while false, input is ignored — time has been taken from the visitor */
  enabled = true;
  /** when set and true, another gesture owns the pointer — no new presses
   * or brushes (the void-drag orbit uses this) */
  blocked: (() => boolean) | null = null;
  /** fired on delivered impact: normalized power 0..1, point, direction,
   * and the contact radius */
  onImpact:
    | ((
        power01: number,
        point: THREE.Vector3,
        dir: THREE.Vector3,
        radius: number,
        swipe01: number,
      ) => void)
    | null = null;
  /**
   * asked before a release is applied. Returning true claims the impact:
   * no impulse is applied and no onImpact fires — the interceptor owns
   * delivery (the kill cam uses this to land the hit on camera, later).
   * `tangential` is the palm's sideways velocity at contact, world u/s.
   */
  onIntercept:
    | ((
        power01: number,
        point: THREE.Vector3,
        dir: THREE.Vector3,
        power: number,
        radius: number,
        tangential: THREE.Vector3,
      ) => boolean)
    | null = null;
  /** smoothed brush speed over the skin, world u/s — for the friction sound */
  brushSpeed = 0;
  /** a grabbed handful let go at speed; power01 in 0..1 */
  onFling: ((power01: number) => void) | null = null;

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
  /** rolling pointer trail for swipe velocity, ~SWIPE_WINDOW_MS deep */
  private readonly trail: { x: number; y: number; t: number }[] = [];
  /** smoothed world-space hand velocity while grabbing */
  private readonly handVel = new THREE.Vector3();
  private readonly lastGrabOffset = new THREE.Vector3();
  private lastGrabT = 0;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

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

  /** true while a press or grab is in flight — the sim must not sleep */
  get engaged(): boolean {
    return this.mode !== "idle";
  }

  /** abandon the gesture in flight without delivering anything — used when
   * a pinch claims the pointers mid-press */
  cancel(): void {
    if (this.mode === "grab") this.solver.endGrab();
    this.mode = "idle";
    this.charge = 0;
    this.handVel.set(0, 0, 0);
  }

  update(): void {
    this.charge =
      this.mode === "pending"
        ? Math.min(
            1,
            (performance.now() - this.holdStart) / this.params.chargeTimeMs,
          )
        : 0;
    // a stopped cursor emits no events: let the brush speed fall off itself
    const now = performance.now();
    if (!this.lastBrush || now - this.lastBrush.time > 70) {
      this.brushSpeed *= 0.8;
      if (this.brushSpeed < 1e-3) this.brushSpeed = 0;
    }
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

  private track(x: number, y: number): void {
    const t = performance.now();
    this.trail.push({ x, y, t });
    while (this.trail.length > 0 && t - this.trail[0].t > SWIPE_WINDOW_MS) {
      this.trail.shift();
    }
  }

  /** screen-space cursor velocity over the trail window, px/s */
  private swipe(): { vx: number; vy: number; speed: number } {
    const n = this.trail.length;
    const newest = this.trail[n - 1];
    // a stopped cursor emits no events — stale trail means no swipe
    if (n < 2 || performance.now() - newest.t > 80) {
      return { vx: 0, vy: 0, speed: 0 };
    }
    const oldest = this.trail[0];
    const dt = (newest.t - oldest.t) / 1000;
    if (dt < 8e-3) return { vx: 0, vy: 0, speed: 0 };
    const vx = (newest.x - oldest.x) / dt;
    const vy = (newest.y - oldest.y) / dt;
    return { vx, vy, speed: Math.hypot(vx, vy) };
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled || this.blocked?.()) return;
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
      // the handful leaves with the hand's velocity — but only if the hand
      // was actually still moving (a paused hand releases gently)
      const p = this.params;
      const speed = this.handVel.length();
      if (speed > 0.25 && performance.now() - this.lastGrabT < 90) {
        this.tmpA.copy(this.grabOrigin).add(this.grabOffset);
        const strength = Math.min(p.flingMax, speed * p.flingGain);
        this.solver.impulse(this.tmpA, this.handVel, strength, p.grabRadius);
        this.onFling?.(strength / p.flingMax);
      }
      this.handVel.set(0, 0, 0);
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
    const radius = p.radius + curve * p.chargeRadiusBonus;
    // cloned: the raycaster's direction is reused by every later cast
    const point = hit.point.clone();
    const dir = this.raycaster.ray.direction.clone();

    // follow-through: tilt the blow toward where the cursor is headed, and
    // carry the swipe into the palm as real sideways velocity
    const { vx, vy, speed } = this.swipe();
    const swipe01 = Math.min(1, speed / p.swipeRefSpeed);
    let power = p.tapPower + curve * p.chargeBonus;
    const tangential = new THREE.Vector3();
    if (swipe01 > 0.02) {
      power *= 1 + p.swipePowerBonus * swipe01;
      // world direction of the swipe: re-cast a few px ahead along the
      // cursor's travel and take the delta on the hit-distance plane
      const ahead = 24 / speed;
      this.setRay(e.clientX + vx * ahead, e.clientY + vy * ahead);
      this.tmpA
        .copy(this.raycaster.ray.origin)
        .addScaledVector(this.raycaster.ray.direction, hit.distance)
        .sub(point);
      if (this.tmpA.lengthSq() > 1e-12) {
        // world speed of the cursor on the hit plane: the re-cast moved
        // 24px, so scale by the swipe's px/s over that
        tangential.copy(this.tmpA).multiplyScalar(speed / 24);
        dir
          .addScaledVector(this.tmpA.normalize(), p.swipeInfluence * swipe01)
          .normalize();
      }
    }
    const power01 = Math.min(1, power / (p.tapPower + p.chargeBonus));
    if (this.onIntercept?.(power01, point, dir, power, radius, tangential))
      return;
    // a landed hand: the palm arrives and the flesh answers
    this.solver.slap(point, dir, tangential, power, radius);
    this.onImpact?.(power01, point, dir, radius, swipe01);
  }

  private onMove(e: PointerEvent): void {
    this.track(e.clientX, e.clientY);
    if (this.mode === "pending") {
      const dx = e.clientX - this.downX;
      const dy = e.clientY - this.downY;
      const heldMs = performance.now() - this.holdStart;
      // quick flicks stay slaps (they land with follow-through); a
      // deliberate hold-and-drag grabs; a deep charge means the hand is
      // cocked and movement is just aiming
      if (
        dx * dx + dy * dy > GRAB_SLOP_PX * GRAB_SLOP_PX &&
        heldMs > this.params.tapThresholdMs &&
        this.charge < GRAB_CHARGE_LIMIT
      ) {
        this.mode = "grab";
        this.solver.startGrab(this.grabOrigin, this.params.grabRadius);
        this.handVel.set(0, 0, 0);
        this.lastGrabOffset.set(0, 0, 0);
        this.lastGrabT = performance.now();
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
      // smoothed hand velocity, for the fling on release
      const now = performance.now();
      const gdt = (now - this.lastGrabT) / 1000;
      if (gdt > 4e-3) {
        this.tmpB
          .copy(this.grabOffset)
          .sub(this.lastGrabOffset)
          .divideScalar(gdt);
        this.handVel.lerp(this.tmpB, 0.35);
        this.lastGrabOffset.copy(this.grabOffset);
        this.lastGrabT = now;
      }
      return;
    }
    if (this.mode !== "idle" || !this.enabled || this.blocked?.()) return;

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
        this.brushSpeed += (speed - this.brushSpeed) * 0.4;
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
