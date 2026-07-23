import * as THREE from "three/webgpu";
import type { Pointer } from "../input/pointer";

/**
 * The single authored frame. There is no user navigation — only cursor
 * micro-parallax and a slow breathing dolly. The kill cam (later) is the
 * one and only thing allowed to break this frame.
 */
const FRAME = {
  fovDeg: 20,
  /** world-space width the frame shows at the subject plane */
  frameWidth: 3.7,
  /**
   * minimum world-space height the frame must show — stops the subject
   * bursting the frame on ultrawide monitors. Slightly less than the
   * subject's height so the sketch's top/bottom crop is preserved.
   */
  minFrameHeight: 1.95,
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

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(FRAME.fovDeg, 1, 0.1, 100);
  /** composition center — where the frame looks */
  readonly target = FRAME.target;
  private yaw = 0;
  private pitch = 0;
  private baseDistance = 7;
  private elapsed = 0;

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

  update(dt: number, pointer: Pointer): void {
    this.elapsed += dt;
    const k = 1 - Math.exp(-FRAME.damping * dt);
    this.yaw += (pointer.x * FRAME.yawRange - this.yaw) * k;
    this.pitch += (pointer.y * FRAME.pitchRange - this.pitch) * k;

    const breathe =
      Math.sin((this.elapsed * Math.PI * 2) / FRAME.breathePeriodS) *
      FRAME.breatheAmp;
    const d = this.baseDistance + breathe;

    const t = FRAME.target;
    this.camera.position.set(
      t.x + Math.sin(this.yaw) * d,
      t.y + Math.sin(this.pitch) * d,
      t.z + Math.cos(this.yaw) * Math.cos(this.pitch) * d,
    );
    this.camera.lookAt(t);
    // nothing renders through this camera directly anymore (the pipeline
    // uses a mirror), so keep its world matrix fresh for raycasting
    this.camera.updateMatrixWorld();
  }
}
