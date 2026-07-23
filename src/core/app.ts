import * as THREE from 'three/webgpu';

export class App {
  private renderer = new THREE.WebGPURenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(20, 1, 0.1, 100);

  async start(root: HTMLElement): Promise<void> {
    await this.renderer.init();
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene.background = new THREE.Color(0x000000);

    root.appendChild(this.renderer.domElement);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tick(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
