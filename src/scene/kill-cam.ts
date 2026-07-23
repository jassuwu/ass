import * as THREE from "three/webgpu";
import type { CameraRig } from "./camera-rig";

/**
 * The one and only permitted break of the authored frame. Triggered by a
 * full-charge slap, never announced — and the hit does NOT land on release.
 * Kill-cam grammar: time collapses and the camera travels first; the impulse
 * is delivered only once the lens is seated, so the entire impact — the
 * compression, the splash, the crawling wavefront — happens on camera in
 * deep slow motion. A dedicated raking light grazes the surface while the
 * house lights dim (the app reads `cinema01` for that), because a traveling
 * bulge is only visible as a moving shadow edge. Late in the hold, time is
 * gradually handed back so the wave accelerates across the cheek as the
 * shot ends. Cinema bars are grammar, not UI. Then everything snaps back
 * and the site pretends nothing happened.
 */
export interface KillCamParams {
  /** camera travel time before the hit lands, seconds (real time) */
  diveS: number;
  /** deep-freeze portion of the hold after impact */
  freezeS: number;
  /** portion of the hold where time is handed back */
  crawlS: number;
  returnS: number;
  /** physics time multiplier at the deepest freeze */
  deepSlow: number;
  /** time multiplier reached by the end of the crawl */
  crawlEndScale: number;
  closeFov: number;
  /** raking light intensity at full cinema */
  rakeIntensity: number;
  cooldownS: number;
}

export const defaultKillCamParams: KillCamParams = {
  diveS: 0.55,
  freezeS: 0.85,
  crawlS: 1.9,
  returnS: 0.7,
  deepSlow: 0.05,
  crawlEndScale: 0.3,
  closeFov: 30,
  rakeIntensity: 80,
  cooldownS: 4,
};

const ease = (s: number) => s * s * (3 - 2 * s);
const UP = new THREE.Vector3(0, 1, 0);

export class KillCam {
  readonly params: KillCamParams;
  readonly camera: THREE.PerspectiveCamera;
  /** grazing cinema light — the app adds it (and its target) to the scene */
  readonly rake = new THREE.SpotLight(0xffe9d0, 0);
  /** physics time multiplier for the app loop */
  timeScale = 1;
  active = false;
  /** 0..1 cinema blend — the app dims the house lights against this */
  cinema01 = 0;

  private phase: "idle" | "dive" | "held" | "return" = "idle";
  private t = 0;
  private cooldownUntil = 0;
  private elapsed = 0;
  private deliver: (() => void) | null = null;
  private shake = 0;
  private readonly homePos = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly returnStart = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly bars: [HTMLDivElement, HTMLDivElement];

  constructor(params: Partial<KillCamParams> = {}) {
    this.params = { ...defaultKillCamParams, ...params };
    this.camera = new THREE.PerspectiveCamera(
      this.params.closeFov,
      1,
      0.05,
      100,
    );
    this.rake.angle = Math.PI / 6;
    this.rake.penumbra = 0.7;
    this.rake.decay = 2;
    this.rake.castShadow = true;
    this.rake.shadow.mapSize.set(2048, 2048);
    this.rake.shadow.camera.near = 0.2;
    this.rake.shadow.camera.far = 10;
    this.rake.shadow.bias = -0.0002;
    this.rake.shadow.normalBias = 0.03;

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

  /** where the cinematography is looking — for focus pulling */
  get focusPoint(): THREE.Vector3 {
    return this.point;
  }

  /**
   * Begin the sequence. `deliver` is called exactly once, at the moment the
   * dive lands — that is when the caller must apply the impulse, spawn the
   * ripple and fire the foley. Until then nothing has hit anything.
   */
  trigger(
    rig: CameraRig,
    point: THREE.Vector3,
    dir: THREE.Vector3,
    deliver: () => void,
  ): void {
    if (!this.idle) return;
    this.phase = "dive";
    this.t = 0;
    this.active = true;
    this.deliver = deliver;
    this.shake = 0;
    this.point.copy(point);
    this.homePos.copy(rig.camera.position);
    this.camera.aspect = rig.camera.aspect;
    this.camera.fov = rig.camera.fov;

    // viewpoint: out along the impact normal (≈ -dir), swung toward the
    // outer side of whichever cheek was struck, kept low — displacement
    // reads best near the profile, not from above
    const n = this.tmp.copy(dir).multiplyScalar(-1).normalize();
    const side = new THREE.Vector3().crossVectors(UP, n).normalize();
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.multiplyScalar(Math.sign(point.x) || 1);
    this.offset
      .copy(n)
      .multiplyScalar(1.0)
      .addScaledVector(side, 0.7)
      .addScaledVector(UP, 0.26)
      .setLength(1.7);

    // raking light: across the surface from the side OPPOSITE the camera,
    // grazing low, so the bulge throws its moving shadow toward the lens
    this.rake.position
      .copy(point)
      .addScaledVector(side, -1.9)
      .addScaledVector(n, 0.55)
      .addScaledVector(UP, 0.5);
    this.rake.target.position.copy(point);
    this.rake.target.updateMatrixWorld();

    this.setBars(true);
  }

  update(dt: number, rig: CameraRig): void {
    this.elapsed += dt;
    if (this.phase === "idle") return;
    this.t += dt;
    const p = this.params;

    if (this.phase === "dive") {
      const s = ease(Math.min(this.t / p.diveS, 1));
      // time collapses faster than the camera travels: fully frozen by 60%
      // of the dive, so nothing is wasted before the lens is seated
      const ts = ease(Math.min(this.t / (p.diveS * 0.6), 1));
      this.timeScale = 1 + (p.deepSlow - 1) * ts;
      this.cinema01 = s;
      this.camera.position
        .lerpVectors(
          this.homePos,
          this.tmp.copy(this.point).add(this.offset),
          s,
        )
        .addScaledVector(UP, Math.sin(Math.PI * s) * 0.18);
      this.look.lerpVectors(rig.target, this.point, s);
      this.camera.fov = this.camera.fov + (p.closeFov - this.camera.fov) * s;
      if (this.t >= p.diveS) {
        this.phase = "held";
        this.t = 0;
        // the hit lands NOW, in deep slow motion, on camera
        this.deliver?.();
        this.deliver = null;
        this.shake = 1;
      }
    } else if (this.phase === "held") {
      this.cinema01 = 1;
      if (this.t < p.freezeS) {
        this.timeScale = p.deepSlow;
      } else {
        // hand time back: the wave visibly accelerates across the cheek
        const s = ease(Math.min((this.t - p.freezeS) / p.crawlS, 1));
        this.timeScale = p.deepSlow + (p.crawlEndScale - p.deepSlow) * s;
      }
      // slow drift around the impact, deliberate push-in
      this.offset.applyAxisAngle(UP, dt * 0.12);
      this.offset.multiplyScalar(1 - dt * 0.045);
      this.camera.position.copy(this.point).add(this.offset);
      this.look.copy(this.point);
      if (this.t >= p.freezeS + p.crawlS) {
        this.phase = "return";
        this.t = 0;
        this.returnStart.copy(this.camera.position);
        this.setBars(false);
      }
    } else {
      const s = ease(Math.min(this.t / p.returnS, 1));
      this.timeScale = p.crawlEndScale + (1 - p.crawlEndScale) * s;
      this.cinema01 = 1 - s;
      this.camera.position.lerpVectors(
        this.returnStart,
        rig.camera.position,
        s,
      );
      this.look.lerpVectors(this.point, rig.target, s);
      this.camera.fov = p.closeFov + (rig.camera.fov - p.closeFov) * s;
      if (this.t >= p.returnS) {
        this.phase = "idle";
        this.active = false;
        this.timeScale = 1;
        this.cinema01 = 0;
        this.rake.intensity = 0;
        this.cooldownUntil = this.elapsed + p.cooldownS;
        return;
      }
    }

    // impact kick: a slow hand-held tremble, decaying through the hold
    if (this.shake > 1e-3) {
      this.shake *= Math.exp(-dt * 2.2);
      const a = 0.016 * this.shake;
      this.camera.position.addScaledVector(UP, Math.sin(this.elapsed * 11) * a);
      this.camera.position.x += Math.sin(this.elapsed * 8.3 + 1.7) * a;
    }

    this.rake.intensity = this.params.rakeIntensity * this.cinema01;
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
