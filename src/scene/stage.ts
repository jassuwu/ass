import * as THREE from "three/webgpu";
import { createPlaceholderSpecimen, type Specimen } from "./specimen";

export interface Stage {
  scene: THREE.Scene;
  specimen: Specimen;
}

/**
 * Black void, product-photography lighting: one soft warm key from
 * front-left-above, two cool rims from behind carving the silhouette
 * out of the dark, and a whisper of ambient so shadows aren't dead.
 */
export function createStage(): Stage {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const specimen = createPlaceholderSpecimen();
  scene.add(specimen.mesh);

  // sun-look key per reference: high, warm-white, strong — carving real
  // form shadow and a bright specular sweep across each cheek
  const key = new THREE.SpotLight(0xfff3e0, 340);
  key.position.set(2.4, 5.2, 3.8);
  key.angle = Math.PI / 3.5;
  key.penumbra = 0.9;
  key.decay = 2;
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 15;
  key.shadow.bias = -0.0002;
  // normal bias beats depth bias on smooth curved flesh — kills acne
  // without peter-panning the crease contact shadow
  key.shadow.normalBias = 0.03;
  scene.add(key, key.target);

  // cool rims carry the chromatic contrast against the warm key — without
  // them the frame collapses into monochrome
  const rimL = new THREE.DirectionalLight(0xcfdcff, 3.2);
  rimL.position.set(-4.5, 1.4, -3);
  const rimR = new THREE.DirectionalLight(0xbfd0f5, 2.6);
  rimR.position.set(4.5, 0.6, -3);
  scene.add(rimL, rimL.target, rimR, rimR.target);

  // faint cool sky bounce against the warm sun
  scene.add(new THREE.HemisphereLight(0x37414f, 0x0a0806, 0.25));

  return { scene, specimen };
}
