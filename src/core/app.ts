import * as THREE from "three/webgpu";
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
  private clock = new THREE.Clock();
  private solver: XpbdSolver;
  private skin: MeshSkin;
  private slap: SlapInteraction;

  constructor() {
    const { specimen } = this.stage;
    specimen.mesh.geometry.computeBoundingBox();
    const bounds = specimen.mesh.geometry.boundingBox ?? new THREE.Box3();
    this.solver = new XpbdSolver(
      buildLattice(specimen.isInside, bounds, LATTICE_SPACING),
    );
    this.skin = new MeshSkin(this.solver.lattice, specimen.mesh);
    this.slap = new SlapInteraction(
      document.body,
      this.rig.camera,
      specimen.proxy,
      this.solver,
    );
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
    const dt = Math.min(this.clock.getDelta(), 1 / 30);
    this.slap.update();
    this.solver.step(dt);
    this.skin.apply(this.solver);
    this.rig.update(dt, this.pointer);
    this.renderer.render(this.stage.scene, this.rig.camera);
  }
}
