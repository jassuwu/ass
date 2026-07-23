import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { film } from "three/addons/tsl/display/FilmNode.js";
import { Fn, float, pass, screenUV, uniform, vec4 } from "three/tsl";
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
  private readonly pipeline: THREE.RenderPipeline;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.pipeline = new THREE.RenderPipeline(renderer);

    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    const viewZ = scenePass.getViewZNode();

    // bloom on the sharp frame, then defocus the sum — highlights halo
    // before they blur, which is how a lens does it
    const bloomed = color.add(bloom(color, 0.18, 0.3, 0.88));
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
