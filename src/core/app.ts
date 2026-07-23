import * as THREE from "three/webgpu";
import { Pointer } from "../input/pointer";
import { CameraRig } from "../scene/camera-rig";
import { createStage, type Stage } from "../scene/stage";

export class App {
  private renderer = new THREE.WebGPURenderer({ antialias: true });
  private stage: Stage = createStage();
  private rig = new CameraRig();
  private pointer = new Pointer();
  private clock = new THREE.Clock();

  async start(root: HTMLElement): Promise<void> {
    await this.renderer.init();
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    root.appendChild(this.renderer.domElement);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.rig.setAspect(w / h);
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 1 / 30);
    this.rig.update(dt, this.pointer);
    this.renderer.render(this.stage.scene, this.rig.camera);
  }
}
