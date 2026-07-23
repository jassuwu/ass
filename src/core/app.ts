import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import * as THREE from "three/webgpu";
import { AudioDirector } from "../audio/director";
import { Pointer } from "../input/pointer";
import { SlapInteraction } from "../interaction/slap";
import { buildLattice } from "../physics/lattice";
import { RippleField } from "../physics/ripples";
import { MeshSkin } from "../physics/skin";
import { XpbdSolver } from "../physics/solver";
import { Pipeline } from "../render/pipeline";
import { CameraRig } from "../scene/camera-rig";
import { KillCam } from "../scene/kill-cam";
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
  private killCam = new KillCam();
  private ripples = new RippleField();
  /** the camera actually rendered — mirrors rig or kill cam each frame,
   * so the post pipeline's pass() can bind a single camera object */
  private renderCam = new THREE.PerspectiveCamera(20, 1, 0.05, 100);
  private pipeline: Pipeline | null = null;

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
    this.slap.onImpact = (power01, point, dir) => {
      this.ripples.spawn(point, power01);
      // a full charge earns the kill cam — unannounced, undocumented
      if (power01 >= 0.95 && this.killCam.idle) {
        this.killCam.trigger(this.rig, point, dir);
        this.audio.impactCinema(power01, 3);
      } else {
        this.audio.impact(power01);
      }
    };
  }

  async start(root: HTMLElement): Promise<void> {
    await this.renderer.init();
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // self-shadowing: the cheek shading its own crease and fold is a
    // realism cue no amount of material work can substitute
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // image-based fill: a real photo studio HDRI (CC0, Poly Haven) gives
    // skin believable soft gradients and specular shapes. Kept dim — the
    // void must stay a void. Falls back to a synthetic room if it 404s.
    try {
      const hdr = await new RGBELoader().loadAsync("/env/studio.hdr");
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.stage.scene.environment = hdr;
      this.stage.scene.environmentIntensity = 0.28;
    } catch {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
      pmrem.dispose();
      this.stage.scene.environment = env.texture;
      this.stage.scene.environmentIntensity = 0.3;
    }

    this.pipeline = new Pipeline(
      this.renderer,
      this.stage.scene,
      this.renderCam,
    );

    root.appendChild(this.renderer.domElement);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
    void maybeAttachDevGui(this.solver, this.slap, this.ripples);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.rig.setAspect(w / h);
    this.killCam.setAspect(w / h);
  }

  private tick(): void {
    // lower bound matters: a first-frame dt of exactly 0 would make the
    // substep h=0 and the velocity update (pos-prev)/h NaN the whole lattice
    this.timer.update();
    const dt = THREE.MathUtils.clamp(this.timer.getDelta(), 1 / 240, 1 / 30);
    this.slap.update();
    this.audio.update(this.slap.charge);
    this.killCam.update(dt, this.rig);
    const simDt = dt * this.killCam.timeScale;
    this.solver.step(simDt);
    this.ripples.update(simDt);
    this.skin.apply(this.solver, this.ripples);
    this.rig.update(dt, this.pointer);

    const source = this.killCam.active ? this.killCam.camera : this.rig.camera;
    this.syncRenderCam(source);
    if (this.pipeline) {
      const focusTarget = this.killCam.active
        ? this.killCam.focusPoint
        : this.rig.target;
      this.pipeline.focusDistance.value =
        this.renderCam.position.distanceTo(focusTarget);
      // shallower depth of field in the close-up, restrained in the frame
      this.pipeline.bokehScale.value = this.killCam.active ? 2.2 : 0.8;
      this.pipeline.render();
    } else {
      this.renderer.render(this.stage.scene, this.renderCam);
    }
  }

  private syncRenderCam(source: THREE.PerspectiveCamera): void {
    this.renderCam.position.copy(source.position);
    this.renderCam.quaternion.copy(source.quaternion);
    if (
      this.renderCam.fov !== source.fov ||
      this.renderCam.aspect !== source.aspect
    ) {
      this.renderCam.fov = source.fov;
      this.renderCam.aspect = source.aspect;
      this.renderCam.updateProjectionMatrix();
    }
    this.renderCam.updateMatrixWorld();
  }
}
