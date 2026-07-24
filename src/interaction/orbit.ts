import * as THREE from "three/webgpu";
import type { CameraRig } from "../scene/camera-rig";

/**
 * Discovered navigation, never explained: presses that land on the
 * specimen belong to SlapInteraction — but press the VOID and drag, and
 * the camera is yours (within the rig's clamps). Wheel zooms anywhere;
 * on touch, a second finger turns the gesture into pinch-zoom + orbit
 * regardless of where the fingers landed.
 */
export class OrbitControl {
  /** while false, input is ignored (the kill cam owns the camera) */
  enabled = true;
  /** fired when a pinch claims the pointers — the slap layer must let go */
  onPinchStart: (() => void) | null = null;

  private readonly rig: CameraRig;
  private readonly proxy: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private mode: "idle" | "drag" | "pinch" = "idle";
  private lastPinchDist = 0;

  constructor(dom: HTMLElement, rig: CameraRig, proxy: THREE.Mesh) {
    this.rig = rig;
    this.proxy = proxy;
    dom.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointercancel", (e) => this.onUp(e));
    dom.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
  }

  /** true while a void-drag or pinch owns the pointer(s) */
  get dragging(): boolean {
    return this.mode !== "idle";
  }

  private hitsSpecimen(x: number, y: number): boolean {
    this.ndc.set(
      (x / window.innerWidth) * 2 - 1,
      -((y / window.innerHeight) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    return this.raycaster.intersectObject(this.proxy, false).length > 0;
  }

  private pinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.mode = "pinch";
      this.lastPinchDist = this.pinchDist();
      this.onPinchStart?.();
    } else if (
      this.pointers.size === 1 &&
      !this.hitsSpecimen(e.clientX, e.clientY)
    ) {
      this.mode = "drag";
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p || this.mode === "idle") {
      if (p) {
        p.x = e.clientX;
        p.y = e.clientY;
      }
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this.mode === "pinch") {
      // centroid moves the orbit at half weight; spread is zoom
      this.rig.orbitBy(
        (-dx * 1.3) / window.innerWidth,
        (dy * 1.0) / window.innerHeight,
      );
      const dist = this.pinchDist();
      if (this.lastPinchDist > 1) {
        this.rig.zoomBy(this.lastPinchDist / dist);
      }
      this.lastPinchDist = dist;
      return;
    }
    // drag-the-object feel: pull right, the specimen turns right
    this.rig.orbitBy(
      (-dx * 2.6) / window.innerWidth,
      (dy * 2.0) / window.innerHeight,
    );
  }

  private onUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    // a collapsed pinch does not become a drag or a slap — the leftover
    // finger must lift and press again
    if (this.pointers.size === 0 || this.mode === "pinch") {
      this.mode = "idle";
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    this.rig.zoomBy(Math.exp(e.deltaY * 0.0012));
  }
}
