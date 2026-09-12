import { BOUNDS, depth01, isInside } from "../scene/body-sdf";
import type { ContactReport, HandParams } from "./hand";
import {
  type Bounds,
  buildLattice,
  type Lattice,
  type Vec3Like,
} from "./lattice";
import { RippleField, type RippleParams } from "./ripples";
import { MeshSkin } from "./skin";
import { type SolverParams, XpbdSolver } from "./solver";

/**
 * Everything the flesh needs to move, and nothing that needs a GPU: the
 * lattice, the solver, the ripple layer and the skinning, with the sleep
 * logic. Runs identically on the main thread or inside a worker; the app
 * only ever sees positions and normals coming out.
 */
export interface EngineInit {
  /** rest positions and (smooth) normals of the render mesh */
  base: Float32Array;
  baseNormal: Float32Array;
  index: ArrayLike<number>;
  bounds: Bounds;
  spacing: number;
}

export interface StepInput {
  dt: number;
  /** the kill cam's slow motion */
  timeScale: number;
  /** a press or grab is in flight: the sim must not sleep */
  engaged: boolean;
  /** the kill cam is running: bigger waves, no sleep */
  cinema: boolean;
}

export interface StepOutput {
  /** positions and normals were written this step */
  changed: boolean;
  sleeping: boolean;
  pressing: boolean;
  contacts: ContactReport[];
  releases: ContactReport[];
}

export type Command =
  | {
      op: "slap";
      point: Vec3Like;
      dir: Vec3Like;
      tangential: Vec3Like;
      strength: number;
      radius: number;
    }
  | { op: "touch"; point: Vec3Like; dir: Vec3Like }
  | { op: "lift" }
  | { op: "grab"; point: Vec3Like; radius: number }
  | { op: "grabOffset"; offset: Vec3Like }
  | { op: "endGrab" }
  | {
      op: "impulse";
      point: Vec3Like;
      dir: Vec3Like;
      strength: number;
      radius: number;
    };

export interface ParamSet {
  solver: Partial<SolverParams>;
  hand: Partial<HandParams>;
  ripples: Partial<RippleParams>;
}

export class FleshEngine {
  readonly lattice: Lattice;
  readonly solver: XpbdSolver;
  readonly ripples = new RippleField();
  readonly skin: MeshSkin;
  private sleeping = false;
  private contacts: ContactReport[] = [];
  private releases: ContactReport[] = [];
  private cinema = false;

  constructor(init: EngineInit) {
    this.lattice = buildLattice(isInside, depth01, init.bounds, init.spacing);
    this.solver = new XpbdSolver(this.lattice);
    this.skin = new MeshSkin(
      this.lattice,
      init.base,
      init.baseNormal,
      init.index,
    );
    this.solver.onContact = (r) => this.contacts.push(r);
    // the wavefront departs from the rim of the patch the moment the palm
    // peels away, sized by the depth the palm actually reached
    this.solver.onRelease = (r) => {
      const depthRef = this.lattice.spacing * this.solver.hand.maxDepthCells;
      this.ripples.spawn(
        r,
        Math.min(1, r.depth / depthRef),
        this.cinema ? 1.35 : 1,
        0,
        r.radius * 0.8,
      );
      this.releases.push(r);
    };
  }

  /** the authored bounds of the simulated band, for whoever builds one */
  static defaultBounds(): Bounds {
    // simulate only the band around the cheeks; the distant torso and legs
    // are out of frame and ride the anchored lattice boundary
    return {
      min: {
        x: BOUNDS.min.x,
        y: Math.max(BOUNDS.min.y, -1.75),
        z: BOUNDS.min.z,
      },
      max: { x: BOUNDS.max.x, y: Math.min(BOUNDS.max.y, 1.5), z: BOUNDS.max.z },
    };
  }

  apply(command: Command): void {
    const s = this.solver;
    switch (command.op) {
      case "slap":
        s.slap(
          command.point,
          command.dir,
          command.tangential,
          command.strength,
          command.radius,
        );
        break;
      case "touch":
        s.touch(command.point, command.dir);
        break;
      case "lift":
        s.lift();
        break;
      case "grab":
        s.startGrab(command.point, command.radius);
        break;
      case "grabOffset":
        s.setGrabOffset(command.offset);
        break;
      case "endGrab":
        s.endGrab();
        break;
      case "impulse":
        s.impulse(command.point, command.dir, command.strength, command.radius);
        break;
    }
  }

  setParams(p: ParamSet): void {
    Object.assign(this.solver.params, p.solver);
    Object.assign(this.solver.hand, p.hand);
    Object.assign(this.ripples.params, p.ripples);
  }

  step(
    input: StepInput,
    outPos: Float32Array,
    outNormal: Float32Array,
  ): StepOutput {
    this.cinema = input.cinema;
    const s = this.solver;
    if (s.stirred) {
      this.sleeping = false;
      s.stirred = false;
    }
    const busy =
      input.engaged || s.pressing || this.ripples.active || input.cinema;
    if (busy) this.sleeping = false;
    let changed = false;
    if (!this.sleeping) {
      const simDt = input.dt * input.timeScale;
      s.step(simDt);
      this.ripples.update(simDt);
      this.skin.apply(
        s.pos,
        this.lattice.rest,
        this.ripples,
        outPos,
        outNormal,
      );
      changed = true;
      if (!busy && s.settled) {
        // snap home (<1px away by construction), skin once, go to sleep:
        // at rest the sim and the skinning cost exactly nothing
        s.reset();
        this.skin.apply(s.pos, this.lattice.rest, null, outPos, outNormal);
        this.sleeping = true;
      }
    }
    const out: StepOutput = {
      changed,
      sleeping: this.sleeping,
      pressing: s.pressing,
      contacts: this.contacts,
      releases: this.releases,
    };
    this.contacts = [];
    this.releases = [];
    return out;
  }
}
