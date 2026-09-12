import type { AudioDirector } from "../audio/director";
import type { SlapInteraction } from "../interaction/slap";
import type { RippleField } from "../physics/ripples";
import type { XpbdSolver } from "../physics/solver";
import type { Pipeline } from "../render/pipeline";
import type { FlushField } from "../scene/flush";
import type { KillCam } from "../scene/kill-cam";

/**
 * Tuning bench, dev only: append ?dev to the URL. Dynamically imported so
 * lil-gui never ships in the plain bundle — the site itself has no UI.
 */
export async function maybeAttachDevGui(
  solver: XpbdSolver,
  slap: SlapInteraction,
  ripples: RippleField,
  pipeline: Pipeline | null,
  killCam: KillCam,
  flush: FlushField,
  audio: AudioDirector,
): Promise<void> {
  if (!new URLSearchParams(window.location.search).has("dev")) return;
  const { default: GUI } = await import("lil-gui");
  const gui = new GUI({ title: "tuning" });

  const s = gui.addFolder("tissue");
  s.add(solver.params, "substeps", 2, 16, 1);
  s.add(solver.params, "compliance", 1e-5, 3e-3);
  s.add(solver.params, "tensionRatio", 0.05, 1);
  s.add(solver.params, "volumeCompliance", 0, 1e-7);
  s.add(solver.params, "anchorRate", 5, 150);
  s.add(solver.params, "shapeMemoryRate", 0, 12);
  s.add(solver.params, "damping", 0, 6);
  s.add(solver.params, "viscosity", 0, 150);
  s.add(solver.params, "maxDisplacement", 0.1, 1.2);

  const c = gui.addFolder("hand");
  c.add(solver.hand, "handMass", 2, 60);
  c.add(solver.hand, "arrivalBase", 0, 3);
  c.add(solver.hand, "arrivalSpeed", 0, 2);
  c.add(solver.hand, "armAccel", 0, 80);
  c.add(solver.hand, "driveS", 0.01, 0.15);
  c.add(solver.hand, "dwellS", 0, 0.25);
  c.add(solver.hand, "peelSpeed", 0.3, 6);
  c.add(solver.hand, "friction", 0, 1);
  c.add(solver.hand, "rim", 0.01, 0.2);
  c.add(solver.hand, "elongation", 1, 2.5);
  c.add(solver.hand, "dome", 0, 0.08);
  c.add(solver.hand, "maxDepthCells", 0.5, 2.5);

  const f = gui.addFolder("flush");
  f.add(flush.params, "gain", 0, 1);
  f.add(flush.params, "spread", 0.5, 3);
  f.add(flush.params, "fadeS", 5, 120);

  const i = gui.addFolder("slap");
  i.add(slap.params, "tapPower", 0, 2);
  i.add(slap.params, "chargeBonus", 0, 6);
  i.add(slap.params, "chargeTimeMs", 200, 3000);
  i.add(slap.params, "radius", 0.1, 1.2);
  i.add(slap.params, "chargeRadiusBonus", 0, 1);
  i.add(slap.params, "brushPower", 0, 0.5);
  i.add(slap.params, "brushRadius", 0.05, 0.8);
  i.add(slap.params, "grabRadius", 0.2, 1.2);
  i.add(slap.params, "maxPull", 0.1, 1);
  i.add(slap.params, "swipeInfluence", 0, 1.5);
  i.add(slap.params, "swipeRefSpeed", 300, 3000);
  i.add(slap.params, "swipePowerBonus", 0, 1);
  i.add(slap.params, "flingGain", 0, 2);
  i.add(slap.params, "flingMax", 0, 5);

  const a = gui.addFolder("sound");
  a.add(audio.levels, "crackBank", ["crack", "leg"]);
  a.add(audio.levels, "crack", 0, 2);
  a.add(audio.levels, "body", 0, 2);
  a.add(audio.levels, "pat", 0, 2);
  a.add(audio.levels, "room", 0, 1);
  a.add(audio, "brushLevel", 0, 1);
  a.add(audio, "heartLevel", 0, 1.5);

  if (pipeline) {
    const g = gui.addFolder("grade");
    g.add(pipeline.whiteBalance.value, "x", 0.5, 1.5).name("red");
    g.add(pipeline.whiteBalance.value, "y", 0.5, 1.5).name("green");
    g.add(pipeline.whiteBalance.value, "z", 0.5, 1.5).name("blue");
    g.add(pipeline.bokehScale, "value", 0, 4).name("bokeh");
  }

  const k = gui.addFolder("kill cam");
  k.add(killCam.params, "diveS", 0.2, 1.5);
  k.add(killCam.params, "freezeS", 0, 2);
  k.add(killCam.params, "crawlS", 0.5, 4);
  k.add(killCam.params, "returnS", 0.3, 1.5);
  k.add(killCam.params, "deepSlow", 0.01, 0.3);
  k.add(killCam.params, "crawlEndScale", 0.05, 1);
  k.add(killCam.params, "rakeIntensity", 0, 200);

  const r = gui.addFolder("ripples");
  r.add(ripples.params, "speed", 0.5, 6);
  r.add(ripples.params, "width", 0.05, 0.5);
  r.add(ripples.params, "spatialDecay", 0, 3);
  r.add(ripples.params, "temporalDecay", 0, 6);
  r.add(ripples.params, "maxAmp", 0, 0.12);
}
