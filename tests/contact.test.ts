import { describe, expect, test } from "bun:test";
import * as THREE from "three/webgpu";
import { buildLattice } from "../src/physics/lattice";
import { XpbdSolver } from "../src/physics/solver";
import { bodySdf } from "../src/scene/specimen";

/** the production lattice: same bounds and spacing as the app */
function body() {
  return buildLattice(
    (p) => bodySdf(p.x, p.y, p.z) < 0,
    (p) => Math.min(1, Math.max(0, -bodySdf(p.x, p.y, p.z) / 0.5)),
    new THREE.Box3(
      new THREE.Vector3(-1.25, -1.75, -1.1),
      new THREE.Vector3(1.25, 1.5, 1.1),
    ),
    0.17,
  );
}

/** surface point on the +z face at (x, y): march the sdf back to zero */
function surface(x: number, y: number): THREE.Vector3 {
  let z = 1.1;
  while (bodySdf(x, y, z) > 0 && z > -1) z -= 0.005;
  return new THREE.Vector3(x, y, z);
}

function volumeRatios(solver: XpbdSolver) {
  const { tetrahedra, restVolume6 } = solver.lattice;
  const p = solver.pos;
  let minRatio = Number.POSITIVE_INFINITY;
  for (let t = 0; t < tetrahedra.length; t += 4) {
    const a = tetrahedra[t] * 3;
    const b = tetrahedra[t + 1] * 3;
    const c = tetrahedra[t + 2] * 3;
    const d = tetrahedra[t + 3] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const wx = p[d] - p[a],
      wy = p[d + 1] - p[a + 1],
      wz = p[d + 2] - p[a + 2];
    const v6 =
      ux * (vy * wz - vz * wy) +
      uy * (vz * wx - vx * wz) +
      uz * (vx * wy - vy * wx);
    minRatio = Math.min(minRatio, v6 / restVolume6);
  }
  return minRatio;
}

function maxDisplacement(solver: XpbdSolver): number {
  const { rest } = solver.lattice;
  let m = 0;
  for (let i = 0; i < solver.pos.length; i += 3) {
    const d = Math.hypot(
      solver.pos[i] - rest[i],
      solver.pos[i + 1] - rest[i + 1],
      solver.pos[i + 2] - rest[i + 2],
    );
    if (d > m) m = d;
  }
  return m;
}

interface Trace {
  depth: number;
  area: number;
  firmness: number;
  driveTime: number;
  peakDisp: number;
  residual: number;
  minVolume: number;
  finite: boolean;
  /** rim rise: the largest outward (+z) displacement seen near the contact */
  rimRise: number;
}

function run(
  strength: number,
  at: THREE.Vector3,
  dir = new THREE.Vector3(0, 0, -1),
  tangential = new THREE.Vector3(),
  seconds = 1.2,
): Trace {
  const solver = new XpbdSolver(body());
  let report: Trace = {
    depth: 0,
    area: 0,
    firmness: 0,
    driveTime: 0,
    peakDisp: 0,
    residual: 0,
    minVolume: 1,
    finite: true,
    rimRise: 0,
  };
  solver.onContact = (r) => {
    report.depth = r.depth;
    report.area = r.area;
    report.firmness = r.firmness;
    report.driveTime = r.driveTime;
  };
  solver.slap(at, dir, tangential, strength, 0.45);
  const { rest } = solver.lattice;
  const steps = Math.round(seconds * 60);
  for (let s = 0; s < steps; s++) {
    solver.step(1 / 60);
    report.peakDisp = Math.max(report.peakDisp, maxDisplacement(solver));
    report.minVolume = Math.min(report.minVolume, volumeRatios(solver));
    // rim: particles within 0.9 of the contact laterally, outward +z motion
    for (let i = 0; i < solver.pos.length; i += 3) {
      const lx = rest[i] - at.x,
        ly = rest[i + 1] - at.y;
      if (lx * lx + ly * ly > 0.8) continue;
      report.rimRise = Math.max(
        report.rimRise,
        solver.pos[i + 2] - rest[i + 2],
      );
    }
  }
  report.residual = maxDisplacement(solver);
  report.finite = solver.pos.every(Number.isFinite);
  return report;
}

const cheek = surface(0.5, -0.15);
const sacrum = surface(0.0, 0.55);
const TAP = 0.7;
const FULL = 3.9;

describe("fingertip", () => {
  test("a fingertip drawn across the cheek drags it, then lets go", () => {
    const solver = new XpbdSolver(body());
    const { rest } = solver.lattice;
    const dir = new THREE.Vector3(0, 0, -1);
    let dragged = 0;
    for (let s = 0; s < 30; s++) {
      // 0.5 units across the cheek in half a second
      const at = surface(0.3 + s * (0.5 / 30), -0.15);
      solver.touch(at, dir);
      solver.step(1 / 60);
      // how far flesh under the finger has travelled sideways with it
      for (let i = 0; i < solver.pos.length; i += 3) {
        const lx = rest[i] - at.x;
        const ly = rest[i + 1] - at.y;
        if (lx * lx + ly * ly > 0.04 || rest[i + 2] < at.z - 0.2) continue;
        dragged = Math.max(dragged, solver.pos[i] - rest[i]);
      }
    }
    expect(dragged).toBeGreaterThan(0.01);
    expect(solver.pressing).toBe(true);
    solver.lift();
    for (let s = 0; s < 60; s++) solver.step(1 / 60);
    expect(solver.pos.every(Number.isFinite)).toBe(true);
    expect(solver.pressing).toBe(false);
    expect(maxDisplacement(solver)).toBeLessThan(0.02);
  });
});

describe("hand contact", () => {
  const tap = run(TAP, cheek);
  const full = run(FULL, cheek);
  const bone = run(FULL, sacrum);
  const swiped = run(
    2.0,
    cheek,
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(2.5, 0, 0),
  );
  console.log({ tap, full, bone, swiped });

  test("stays finite and recovers", () => {
    for (const r of [tap, full, bone, swiped]) {
      expect(r.finite).toBe(true);
      expect(r.residual).toBeLessThan(0.02);
    }
  });
  test("a tap marks, a full swing sinks, and bone resists", () => {
    expect(tap.depth).toBeGreaterThan(0.03);
    expect(tap.depth).toBeLessThan(0.12);
    expect(full.depth).toBeGreaterThan(tap.depth * 2);
    expect(bone.depth).toBeLessThan(full.depth * 0.8);
  });
  test("displaced tissue rises at the rim and cells never invert", () => {
    expect(full.rimRise).toBeGreaterThan(0.008);
    expect(full.minVolume).toBeGreaterThan(0.2);
  });
});
