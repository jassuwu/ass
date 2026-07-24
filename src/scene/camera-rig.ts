import * as THREE from "three/webgpu";
import type { Pointer } from "../input/pointer";

/**
 * The authored HOME frame. On top of it the visitor may borrow the camera —
 * drag the void to orbit, wheel/pinch to zoom — but only within clamps, and
 * the composition target never moves. The kill cam is still the one and
 * only thing allowed to actually break the frame.
 */
const FRAME = {
  fovDeg: 20,
  /** world-space width the frame shows at the subject plane */
  frameWidth: 3.0,
  /**
   * minimum world-space height the frame must show — stops the subject
   * bursting the frame on ultrawide monitors. Slightly less than the
   * subject's height so the sketch's top/bottom crop is preserved.
   */
  minFrameHeight: 1.8,
  /** composition center */
  target: new THREE.Vector3(0, 0, 0),
  /** max parallax, radians */
  yawRange: 0.05,
  pitchRange: 0.028,
  /** breathing dolly */
  breatheAmp: 0.045,
  breathePeriodS: 9,
  /** cursor-follow responsiveness, 1/s */
  damping: 3.5,
};

/**
 * Borrowed-camera clamps. PG-13 by construction: the yaw stops well short
 * of the profile, so the front of the specimen simply does not exist —
 * there is no input that reveals it.
 */
const ORBIT = {
  maxYaw: 1.1,
  minPitch: -0.32,
  maxPitch: 0.62,
  minZoom: 0.55,
  maxZoom: 1.4,
  /** orbit-follow responsiveness, 1/s — heavier than the parallax */
  damping: 8,
};

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(FRAME.fovDeg, 1, 0.1, 100);
  /** composition center — where the frame looks */
  readonly target = FRAME.target;
  private yaw = 0;
  private pitch = 0;
  private baseDistance = 7;
  private elapsed = 0;
  // borrowed-camera targets and their smoothed followers
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitZoom = 1;
  private oYaw = 0;
  private oPitch = 0;
  private oZoom = 1;

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // Solve distance from the horizontal FOV so the subject's width coverage
    // is identical on every screen — the composition is authored, not fitted.
    // On very wide screens the height rule wins instead: the subject stays
    // vertically framed and the side voids grow.
    const halfFovY = Math.tan(THREE.MathUtils.degToRad(FRAME.fovDeg) / 2);
    const byWidth = FRAME.frameWidth / (2 * halfFovY * aspect);
    const byHeight = FRAME.minFrameHeight / (2 * halfFovY);
    this.baseDistance = Math.max(byWidth, byHeight);
  }

  /** nudge the borrowed orbit, radians — clamped to the authored range */
  orbitBy(dYaw: number, dPitch: number): void {
    this.orbitYaw = THREE.MathUtils.clamp(
      this.orbitYaw + dYaw,
      -ORBIT.maxYaw,
      ORBIT.maxYaw,
    );
    this.orbitPitch = THREE.MathUtils.clamp(
      this.orbitPitch + dPitch,
      ORBIT.minPitch,
      ORBIT.maxPitch,
    );
  }

  /** multiply the borrowed zoom (1 = the authored distance) */
  zoomBy(factor: number): void {
    this.orbitZoom = THREE.MathUtils.clamp(
      this.orbitZoom * factor,
      ORBIT.minZoom,
      ORBIT.maxZoom,
    );
  }

  update(dt: number, pointer: Pointer): void {
    this.elapsed += dt;
    const k = 1 - Math.exp(-FRAME.damping * dt);
    this.yaw += (pointer.x * FRAME.yawRange - this.yaw) * k;
    this.pitch += (pointer.y * FRAME.pitchRange - this.pitch) * k;
    const ko = 1 - Math.exp(-ORBIT.damping * dt);
    this.oYaw += (this.orbitYaw - this.oYaw) * ko;
    this.oPitch += (this.orbitPitch - this.oPitch) * ko;
    this.oZoom += (this.orbitZoom - this.oZoom) * ko;

    const breathe =
      Math.sin((this.elapsed * Math.PI * 2) / FRAME.breathePeriodS) *
      FRAME.breatheAmp;
    const d = this.baseDistance * this.oZoom + breathe;

    // parallax rides on top of the borrowed orbit; proper spherical so the
    // distance holds at the larger borrowed angles
    const yaw = this.yaw + this.oYaw;
    const pitch = this.pitch + this.oPitch;
    const t = FRAME.target;
    this.camera.position.set(
      t.x + Math.sin(yaw) * Math.cos(pitch) * d,
      t.y + Math.sin(pitch) * d,
      t.z + Math.cos(yaw) * Math.cos(pitch) * d,
    );
    this.camera.lookAt(t);
    // nothing renders through this camera directly anymore (the pipeline
    // uses a mirror), so keep its world matrix fresh for raycasting
    this.camera.updateMatrixWorld();
  }
}
