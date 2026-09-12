import type * as THREE from "three/webgpu";
import {
  type Command,
  type EngineInit,
  FleshEngine,
  type ParamSet,
  type StepInput,
  type StepOutput,
} from "./engine";
import { type ContactReport, defaultHandParams, type HandParams } from "./hand";
import type { Bounds, Vec3Like } from "./lattice";
import { defaultRippleParams, type RippleParams } from "./ripples";
import { defaultSolverParams, type SolverParams } from "./solver";

/** what the gesture layer is allowed to ask of the flesh */
export interface FleshControls {
  slap(
    point: Vec3Like,
    dir: Vec3Like,
    tangential: Vec3Like,
    strength: number,
    radius: number,
  ): void;
  touch(point: Vec3Like, dir: Vec3Like): void;
  lift(): void;
  startGrab(point: Vec3Like, radius: number): void;
  setGrabOffset(offset: Vec3Like): void;
  endGrab(): void;
  impulse(
    point: Vec3Like,
    dir: Vec3Like,
    strength: number,
    radius: number,
  ): void;
}

const copy = (v: Vec3Like): Vec3Like => ({ x: v.x, y: v.y, z: v.z });

/**
 * The flesh as the app sees it. Gestures queue as commands; each frame
 * they go to the physics with the elapsed time, and the deformed mesh
 * comes back. The physics runs in a worker so a slap never stalls the
 * frame or the pointer; where workers are unavailable the same engine
 * runs inline, one frame behind nobody.
 */
export class Flesh implements FleshControls {
  readonly params: SolverParams = { ...defaultSolverParams };
  readonly hand: HandParams = { ...defaultHandParams };
  readonly rippleParams: RippleParams = { ...defaultRippleParams };
  readonly spacing: number;
  onContact: ((report: ContactReport) => void) | null = null;
  onRelease: ((report: ContactReport) => void) | null = null;
  /** a hand is in the flesh, as of the last frame that came back */
  pressing = false;
  /** the physics is asleep: nothing moves, nothing costs */
  sleeping = false;

  private readonly mesh: THREE.Mesh;
  private commands: Command[] = [];
  private inline: FleshEngine | null = null;
  private worker: Worker | null = null;
  private ready = false;
  private inFlight = false;
  private pendingDt = 0;
  private pendingScale = 1;
  private pendingEngaged = false;
  private pendingCinema = false;
  /** two buffer sets ping-pong between here and the worker */
  private pool: { pos: Float32Array; normal: Float32Array }[] = [];

  constructor(mesh: THREE.Mesh, bounds: Bounds, spacing: number) {
    this.mesh = mesh;
    this.spacing = spacing;
    const geometry = mesh.geometry;
    const base = new Float32Array(geometry.attributes.position.array);
    const baseNormal = new Float32Array(geometry.attributes.normal.array);
    const indexAttr = geometry.index;
    if (!indexAttr) throw new Error("Flesh requires indexed geometry");
    const index = indexAttr.array.slice();
    const init: EngineInit = { base, baseNormal, index, bounds, spacing };
    for (let i = 0; i < 2; i++) {
      this.pool.push({
        pos: new Float32Array(base.length),
        normal: new Float32Array(base.length),
      });
    }
    try {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e) => this.onMessage(e.data);
      worker.onerror = () => this.fallBack(init);
      worker.postMessage({ type: "init", init, params: this.paramSet() });
      this.worker = worker;
    } catch {
      this.fallBack(init);
    }
  }

  /** the worker failed to come up: the same engine, here, now */
  private fallBack(init: EngineInit): void {
    if (this.inline) return;
    this.worker?.terminate();
    this.worker = null;
    this.inline = new FleshEngine(init);
    this.inline.setParams(this.paramSet());
    this.ready = true;
    this.inFlight = false;
  }

  private paramSet(): ParamSet {
    return {
      solver: { ...this.params },
      hand: { ...this.hand },
      ripples: { ...this.rippleParams },
    };
  }

  /** the dev bench changed a number: push it to wherever the physics lives */
  syncParams(): void {
    if (this.inline) this.inline.setParams(this.paramSet());
    else this.worker?.postMessage({ type: "params", params: this.paramSet() });
  }

  slap(
    point: Vec3Like,
    dir: Vec3Like,
    tangential: Vec3Like,
    strength: number,
    radius: number,
  ): void {
    this.commands.push({
      op: "slap",
      point: copy(point),
      dir: copy(dir),
      tangential: copy(tangential),
      strength,
      radius,
    });
  }

  touch(point: Vec3Like, dir: Vec3Like): void {
    // only the latest touch of a frame matters
    const last = this.commands[this.commands.length - 1];
    if (last?.op === "touch") this.commands.pop();
    this.commands.push({ op: "touch", point: copy(point), dir: copy(dir) });
  }

  lift(): void {
    this.commands.push({ op: "lift" });
  }

  startGrab(point: Vec3Like, radius: number): void {
    this.commands.push({ op: "grab", point: copy(point), radius });
  }

  setGrabOffset(offset: Vec3Like): void {
    const last = this.commands[this.commands.length - 1];
    if (last?.op === "grabOffset") this.commands.pop();
    this.commands.push({ op: "grabOffset", offset: copy(offset) });
  }

  endGrab(): void {
    this.commands.push({ op: "endGrab" });
  }

  impulse(
    point: Vec3Like,
    dir: Vec3Like,
    strength: number,
    radius: number,
  ): void {
    this.commands.push({
      op: "impulse",
      point: copy(point),
      dir: copy(dir),
      strength,
      radius,
    });
  }

  /**
   * once per frame. With a worker, at most one step is in flight: if the
   * physics is slower than the display, frames accumulate into the next
   * step instead of queueing behind it.
   */
  update(
    dt: number,
    timeScale: number,
    engaged: boolean,
    cinema: boolean,
  ): void {
    this.pendingDt = Math.min(this.pendingDt + dt, 0.1);
    this.pendingScale = timeScale;
    this.pendingEngaged = engaged;
    this.pendingCinema = cinema;
    if (!this.ready) return;
    if (this.inline) {
      const buffers = this.pool[0];
      for (const c of this.commands) this.inline.apply(c);
      this.commands = [];
      const out = this.inline.step(
        this.takeInput(),
        buffers.pos,
        buffers.normal,
      );
      this.receive(out, buffers.pos, buffers.normal);
      return;
    }
    if (this.inFlight || !this.worker) return;
    const buffers = this.pool.pop();
    if (!buffers) return;
    this.inFlight = true;
    const commands = this.commands;
    this.commands = [];
    this.worker.postMessage(
      {
        type: "step",
        input: this.takeInput(),
        commands,
        pos: buffers.pos,
        normal: buffers.normal,
      },
      [buffers.pos.buffer, buffers.normal.buffer],
    );
  }

  private takeInput(): StepInput {
    const input: StepInput = {
      dt: Math.max(this.pendingDt, 1 / 240),
      timeScale: this.pendingScale,
      engaged: this.pendingEngaged,
      cinema: this.pendingCinema,
    };
    this.pendingDt = 0;
    return input;
  }

  private onMessage(data: {
    type: string;
    out?: StepOutput;
    pos?: Float32Array;
    normal?: Float32Array;
  }): void {
    if (data.type === "ready") {
      this.ready = true;
      return;
    }
    if (data.type === "frame" && data.out && data.pos && data.normal) {
      this.inFlight = false;
      this.receive(data.out, data.pos, data.normal);
      this.pool.push({ pos: data.pos, normal: data.normal });
    }
  }

  private receive(
    out: StepOutput,
    pos: Float32Array,
    normal: Float32Array,
  ): void {
    this.pressing = out.pressing;
    this.sleeping = out.sleeping;
    if (out.changed) {
      const g = this.mesh.geometry;
      (g.attributes.position.array as Float32Array).set(pos);
      (g.attributes.normal.array as Float32Array).set(normal);
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
    }
    for (const r of out.contacts) this.onContact?.(r);
    for (const r of out.releases) this.onRelease?.(r);
  }
}
