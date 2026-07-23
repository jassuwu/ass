import * as THREE from "three/webgpu";
import type { CameraRig } from "./camera-rig";

/**
 * The one and only permitted break of the authored frame. Triggered by a
 * full-charge slap, never announced: time collapses, the camera dives to a
 * low close angle beside the impact, cinema bars slide in (no text — bars
 * are grammar, not UI), the ripple crawls, then everything snaps back and
 * the site pretends nothing happened.
 */
const DIVE_S = 0.5;
const HOLD_S = 1.9;
const RETURN_S = 0.6;
const SLOW_TIME_SCALE = 0.06;
const COOLDOWN_S = 4;
const CLOSE_FOV = 30;

const ease = (s: number) => s * s * (3 - 2 * s);
const UP = new THREE.Vector3(0, 1, 0);

export class KillCam {
  readonly camera = new THREE.PerspectiveCamera(CLOSE_FOV, 1, 0.05, 100);
  /** physics time multiplier for the app loop */
  timeScale = 1;
  active = false;

  private phase: "idle" | "dive" | "hold" | "return" = "idle";
  private t = 0;
  private cooldownUntil = 0;
  private elapsed = 0;
  private readonly homePos = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly returnStart = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly bars: [HTMLDivElement, HTMLDivElement];

  constructor() {
    const makeBar = (edge: "top" | "bottom"): HTMLDivElement => {
      const bar = document.createElement("div");
      bar.style.cssText =
        `position:fixed;left:0;right:0;${edge}:0;height:0;background:#000;` +
        "pointer-events:none;z-index:5;transition:height 0.45s cubic-bezier(0.4,0,0.2,1);";
      document.body.appendChild(bar);
      return bar;
    };
    this.bars = [makeBar("top"), makeBar("bottom")];
  }

  get idle(): boolean {
    return this.phase === "idle" && this.elapsed >= this.cooldownUntil;
  }

  trigger(rig: CameraRig, point: THREE.Vector3, dir: THREE.Vector3): void {
    if (!this.idle) return;
    this.phase = "dive";
    this.t = 0;
    this.active = true;
    this.point.copy(point);
    this.homePos.copy(rig.camera.position);
    this.camera.aspect = rig.camera.aspect;
    this.camera.fov = rig.camera.fov;

    // viewpoint: out along the impact normal (≈ -dir), swung toward the
    // outer side of whichever cheek was struck, slightly above
    const n = this.tmp.copy(dir).multiplyScalar(-1).normalize();
    const side = new THREE.Vector3().crossVectors(UP, n).normalize();
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.multiplyScalar(Math.sign(point.x) || 1);
    this.offset
      .copy(n)
      .multiplyScalar(0.8)
      .addScaledVector(side, 0.7)
      .addScaledVector(UP, 0.3)
      .setLength(1.15);
    this.setBars(true);
  }

  update(dt: number, rig: CameraRig): void {
    this.elapsed += dt;
    if (this.phase === "idle") return;
    this.t += dt;

    if (this.phase === "dive") {
      const s = ease(Math.min(this.t / DIVE_S, 1));
      this.timeScale = 1 + (SLOW_TIME_SCALE - 1) * s;
      this.camera.position
        .lerpVectors(
          this.homePos,
          this.tmp.copy(this.point).add(this.offset),
          s,
        )
        .addScaledVector(UP, Math.sin(Math.PI * s) * 0.18);
      this.look.lerpVectors(rig.target, this.point, s);
      this.camera.fov = this.camera.fov + (CLOSE_FOV - this.camera.fov) * s;
      if (this.t >= DIVE_S) {
        this.phase = "hold";
        this.t = 0;
      }
    } else if (this.phase === "hold") {
      this.timeScale = SLOW_TIME_SCALE;
      // slow drift around the impact, gentle push-in
      this.offset.applyAxisAngle(UP, dt * 0.14);
      this.offset.multiplyScalar(1 - dt * 0.03);
      this.camera.position.copy(this.point).add(this.offset);
      this.look.copy(this.point);
      if (this.t >= HOLD_S) {
        this.phase = "return";
        this.t = 0;
        this.returnStart.copy(this.camera.position);
        this.setBars(false);
      }
    } else {
      const s = ease(Math.min(this.t / RETURN_S, 1));
      this.timeScale = SLOW_TIME_SCALE + (1 - SLOW_TIME_SCALE) * s;
      this.camera.position.lerpVectors(
        this.returnStart,
        rig.camera.position,
        s,
      );
      this.look.lerpVectors(this.point, rig.target, s);
      this.camera.fov = CLOSE_FOV + (rig.camera.fov - CLOSE_FOV) * s;
      if (this.t >= RETURN_S) {
        this.phase = "idle";
        this.active = false;
        this.timeScale = 1;
        this.cooldownUntil = this.elapsed + COOLDOWN_S;
        return;
      }
    }

    this.camera.lookAt(this.look);
    this.camera.updateProjectionMatrix();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private setBars(on: boolean): void {
    for (const bar of this.bars) bar.style.height = on ? "9vh" : "0";
  }
}
