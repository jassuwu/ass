import * as THREE from "three/webgpu";

/**
 * Procedural stand-in for the sculpted asset: a displaced sphere with the
 * right silhouette for composition and lighting work. Deliberately rendered
 * as neutral clay — skin shading is its own phase. The physics lattice will
 * bind to whatever mesh lives here, so the swap later is contained.
 *
 * Orientation: +z faces the camera (rear elevation), +y up.
 */
export function createPlaceholderSpecimen(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1, 192, 128);
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.copy(v).normalize();

    // side fullness — the two lobes
    const lobe = 0.42 * Math.abs(n.x) ** 1.35;
    // vertical crease on the camera-facing half, deepening toward the bottom
    const valley = Math.exp(-((n.x * 4.2) ** 2));
    const facing = THREE.MathUtils.smoothstep(n.z, 0.05, 0.65);
    const lower = THREE.MathUtils.smoothstep(-n.y, -0.35, 0.75);
    const crease = valley * facing * (0.16 + 0.3 * lower);
    // gentle flattening up toward the lower back
    const backTaper = 1 - 0.18 * THREE.MathUtils.smoothstep(n.y, 0.35, 1);

    const r = (1 + lobe - crease) * backTaper;
    v.copy(n).multiplyScalar(r);
    // proportions: wider than tall, shallower front-to-back
    pos.setXYZ(i, v.x * 1.18, v.y * 0.98, v.z * 0.88);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    color: 0x9c8a7d,
    roughness: 0.55,
    sheen: 0.25,
    sheenRoughness: 0.6,
  });
  return new THREE.Mesh(geometry, material);
}
