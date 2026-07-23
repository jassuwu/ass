import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { film } from "three/addons/tsl/display/FilmNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import {
  Fn,
  float,
  mix,
  mrt,
  normalView,
  output,
  pass,
  screenUV,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";

/**
 * Photographic finish: depth of field (focus driven per-frame, so the kill
 * cam racks focus onto the impact), a whisper of bloom off the rim lights,
 * vignette, film grain. All subtle — the goal is "shot on a camera", not
 * "instagram filter".
 */
export class Pipeline {
  /** world-space focus distance, updated per frame */
  readonly focusDistance = uniform(6.5);
  readonly bokehScale = uniform(1.0);
  /** per-channel white balance, dialable from the dev bench. Near-neutral
   * default: the sun-look is MEANT to be warm — don't grade the tan away */
  readonly whiteBalance = uniform(new THREE.Vector3(0.97, 1.0, 1.04));
  private readonly pipeline: THREE.RenderPipeline;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.pipeline = new THREE.RenderPipeline(renderer);

    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const color = scenePass.getTextureNode("output");
    const viewZ = scenePass.getViewZNode();

    // ground-truth ambient occlusion: contact darkening in the crease, the
    // fold, between the legs — the second ray-traced-look ingredient after
    // shadow maps (screen-space, but honest about geometry)
    const aoPass = ao(
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("normal"),
      camera,
    );
    aoPass.radius.value = 0.4;
    // half-res AO is indistinguishable on smooth flesh and halves its cost
    aoPass.resolutionScale = 0.5;
    // skin cavities don't just darken — light surviving multiple subsurface
    // bounces comes back dimmer AND redder. Grading the AO term this way is
    // the film-lookdev trick that makes crevices read as flesh, not concrete.
    const aoT = aoPass.getTextureNode();
    const occluded = color.mul(
      vec4(mix(vec3(0.52, 0.3, 0.26), vec3(1, 1, 1), aoT.x), 1),
    );

    // bloom on the sharp frame, then defocus the sum — highlights halo
    // before they blur, which is how a lens does it. Restrained: only true
    // highlights may glow, and only barely.
    const bloomed = occluded.add(bloom(occluded, 0.06, 0.18, 0.96));
    // @types/three declares dof() as a bare class with no node value type;
    // at runtime it is a vec4-producing TSL node
    const focused = dof(
      bloomed,
      viewZ,
      this.focusDistance,
      float(50),
      this.bokehScale,
    ) as unknown as THREE.Node<"vec4">;

    const vignetted = Fn(() => {
      const c = vec4(focused).toVar();
      // white balance: the warm HDRI x warm key compounds into a salmon
      // cast on everything — pull the frame back to neutral, like a camera
      c.rgb.mulAssign(this.whiteBalance);
      const dist = screenUV.sub(0.5).length();
      const falloff = float(1).sub(dist.mul(dist).mul(0.7)).clamp(0.25, 1);
      c.rgb.mulAssign(falloff);
      return c;
    })();

    this.pipeline.outputNode = film(vignetted, float(0.07));
  }

  render(): void {
    this.pipeline.render();
  }
}
