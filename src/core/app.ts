import * as THREE from "three/webgpu";
import { AudioDirector } from "../audio/director";
import { Pointer } from "../input/pointer";
import { SlapInteraction } from "../interaction/slap";
import { buildLattice } from "../physics/lattice";
import { MeshSkin } from "../physics/skin";
import { XpbdSolver } from "../physics/solver";
import { CameraRig } from "../scene/camera-rig";
import { createStage, type Stage } from "../scene/stage";
import { maybeAttachDevGui } from "./dev-gui";

const LATTICE_SPACING = 0.18;

export class App {
  private renderer = new THREE.WebGPURenderer({ antialias: true });
  private stage: Stage = createStage();
  private rig = new CameraRig();
  private pointer = new Pointer();
  private timer = new THREE.Timer();
  private solver: XpbdSolver;
  private skin: MeshSkin;
  private slap: SlapInteraction;
  private audio = new AudioDirector();

  constructor() {
    const { specimen } = this.stage;
    specimen.mesh.geometry.computeBoundingBox();
    const bounds = (
      specimen.mesh.geometry.boundingBox ?? new THREE.Box3()
    ).clone();
    // simulate only the band around the cheeks; the distant torso and legs
    // are out of frame and ride the anchored lattice boundary
    bounds.min.y = Math.max(bounds.min.y, -1.75);
    bounds.max.y = Math.min(bounds.max.y, 1.5);
    this.solver = new XpbdSolver(
      buildLattice(
        specimen.isInside,
        specimen.depth01,
        bounds,
        LATTICE_SPACING,
      ),
    );
    this.skin = new MeshSkin(this.solver.lattice, specimen.mesh);
    this.slap = new SlapInteraction(
      document.body,
      this.rig.camera,
      specimen.proxy,
      this.solver,
    );
    this.slap.onImpact = (power01) => this.audio.impact(power01);
  }

  async start(root: HTMLElement): Promise<void> {
    await this.renderer.init();
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    root.appendChild(this.renderer.domElement);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
    void maybeAttachDevGui(this.solver, this.slap);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.rig.setAspect(w / h);
  }

  private tick(): void {
    // lower bound matters: a first-frame dt of exactly 0 would make the
    // substep h=0 and the velocity update (pos-prev)/h NaN the whole lattice
    this.timer.update();
    const dt = THREE.MathUtils.clamp(this.timer.getDelta(), 1 / 240, 1 / 30);
    this.slap.update();
    this.audio.update(this.slap.charge);
    this.solver.step(dt);
    this.skin.apply(this.solver);
    this.rig.update(dt, this.pointer);
    this.renderer.render(this.stage.scene, this.rig.camera);
  }
}
