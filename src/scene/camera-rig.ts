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
  frameWidth: 4.1,
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
  private yaw = 0;
  private pitch = 0;
  private baseDistance = 7;
  private elapsed = 0;

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // Solve distance from the horizontal FOV so the subject's width coverage
    // is identical on every screen — the composition is authored, not fitted.
    const halfWidth =
      Math.tan(THREE.MathUtils.degToRad(FRAME.fovDeg) / 2) * aspect;
    this.baseDistance = FRAME.frameWidth / (2 * halfWidth);
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
  }
}
