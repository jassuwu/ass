import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import * as THREE from "three/webgpu";
import { AudioDirector } from "../audio/director";
import { Pointer } from "../input/pointer";
import { OrbitControl } from "../interaction/orbit";
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

const LATTICE_SPACING = 0.17;

export class App {
  private renderer = new THREE.WebGPURenderer({ antialias: true });
  private stage: Stage = createStage();
  private rig = new CameraRig();
  private pointer = new Pointer();
  private timer = new THREE.Timer();
  private solver: XpbdSolver;
  private skin: MeshSkin;
  private slap: SlapInteraction;
  private orbit: OrbitControl;
  private audio = new AudioDirector();
  private killCam = new KillCam();
  private ripples = new RippleField();
  /** the camera actually rendered — mirrors rig or kill cam each frame,
   * so the post pipeline's pass() can bind a single camera object */
  private renderCam = new THREE.PerspectiveCamera(20, 1, 0.05, 100);
  private pipeline: Pipeline | null = null;
  /** physics sleep: at rest the sim and skinning cost exactly nothing */
  private simSleeping = false;
  private stats: { update: () => void } | null = null;
  private baseEnvIntensity = 0.22;
  private readonly baseLightIntensity = {
    key: this.stage.lights.key.intensity,
    rimL: this.stage.lights.rimL.intensity,
    rimR: this.stage.lights.rimR.intensity,
    hemi: this.stage.lights.hemi.intensity,
  };

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
    // press the void and drag to orbit; wheel/pinch to zoom. The two
    // pointer layers coordinate: orbit-drag suppresses brushing, a pinch
    // cancels a press in flight.
    this.orbit = new OrbitControl(document.body, this.rig, specimen.proxy);
    this.slap.blocked = () => this.orbit.dragging;
    this.orbit.onPinchStart = () => this.slap.cancel();
    // the contact is the physics' to report: the wavefront departs from the
    // rim of the patch the moment the palm peels away, sized by the depth
    // the palm actually reached; the flush blooms where it pressed
    const depthRef =
      this.solver.lattice.spacing * this.solver.hand.maxDepthCells;
    const point = new THREE.Vector3();
    this.solver.onRelease = (r) => {
      const depth01 = Math.min(1, r.depth / depthRef);
      point.set(r.x, r.y, r.z);
      this.ripples.spawn(
        point,
        depth01,
        this.killCam.active ? 1.35 : 1,
        0,
        r.radius * 0.8,
      );
      specimen.flush.splat(point, r.radius * (1 + 0.15 * depth01), depth01);
    };
    this.solver.onContact = (r) =>
      this.audio.contact(
        Math.min(1, r.depth / depthRef),
        r.area,
        r.firmness,
        this.killCam.active ? 4 : 1,
      );
    this.slap.onImpact = (power01, _point, _dir, radius, swipe01) => {
      this.audio.impact(power01, radius, swipe01);
    };
    this.slap.onFling = (power01) => this.audio.fling(power01);
    // a full charge earns the kill cam — unannounced, undocumented. The
    // release is intercepted BEFORE the impulse: the camera travels first,
    // and the hit lands on camera once the lens is seated.
    this.slap.onIntercept = (
      power01,
      point,
      dir,
      power,
      radius,
      tangential,
    ) => {
      if (power01 < 0.95 || !this.killCam.idle) return false;
      const kp = this.killCam.params;
      this.audio.holdBreath();
      this.killCam.trigger(this.rig, point, dir, () => {
        this.solver.slap(point, dir, tangential, power, radius);
        this.audio.impactCinema(power01, kp.freezeS + kp.crawlS + kp.returnS);
      });
      return true;
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
      // low fill: the sun-key look wants contrast, not softbox mush
      this.stage.scene.environmentIntensity = 0.22;
    } catch {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
      pmrem.dispose();
      this.stage.scene.environment = env.texture;
      this.stage.scene.environmentIntensity = 0.3;
    }
    this.baseEnvIntensity = this.stage.scene.environmentIntensity;
    this.stage.scene.add(this.killCam.rake, this.killCam.rake.target);

    this.pipeline = new Pipeline(
      this.renderer,
      this.stage.scene,
      this.renderCam,
    );

    root.appendChild(this.renderer.domElement);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
    void maybeAttachDevGui(
      this.solver,
      this.slap,
      this.ripples,
      this.pipeline,
      this.killCam,
      this.stage.specimen.flush,
      this.audio,
    );
    if (new URLSearchParams(window.location.search).has("dev")) {
      const { default: Stats } = await import("stats-gl");
      const stats = new Stats({ trackGPU: true, horizontal: true });
      await stats.init(this.renderer);
      document.body.appendChild(stats.dom);
      this.stats = stats;
    }
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
    this.slap.enabled = !this.killCam.active;
    this.orbit.enabled = !this.killCam.active;
    this.slap.update();
    this.stage.specimen.flush.update();
    this.audio.update(this.slap.charge, this.slap.brushSpeed);
    this.killCam.update(dt, this.rig);

    // cinema grade: house lights bow out so the raking light can carve the
    // wavefront; rims push slightly to keep the silhouette alive in the dark
    const k = this.killCam.cinema01;
    const L = this.stage.lights;
    const base = this.baseLightIntensity;
    L.key.intensity = base.key * (1 - 0.8 * k);
    L.rimL.intensity = base.rimL * (1 + 0.25 * k);
    L.rimR.intensity = base.rimR * (1 + 0.25 * k);
    L.hemi.intensity = base.hemi * (1 - 0.85 * k);
    this.stage.scene.environmentIntensity =
      this.baseEnvIntensity * (1 - 0.85 * k);

    if (this.solver.stirred) {
      this.simSleeping = false;
      this.solver.stirred = false;
    }
    const busy =
      this.slap.engaged ||
      this.solver.pressing ||
      this.ripples.active ||
      this.killCam.active;
    if (busy) this.simSleeping = false;
    if (!this.simSleeping) {
      const simDt = dt * this.killCam.timeScale;
      this.solver.step(simDt);
      this.ripples.update(simDt);
      this.skin.apply(this.solver, this.ripples);
      if (!busy && this.solver.settled) {
        // snap home (<1px away by construction), skin once, go to sleep
        this.solver.reset();
        this.skin.apply(this.solver, this.ripples);
        this.simSleeping = true;
      }
    }
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
    this.stats?.update();
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
