import type { SlapInteraction } from "../interaction/slap";
import type { RippleField } from "../physics/ripples";
import type { XpbdSolver } from "../physics/solver";

/**
 * Tuning bench, dev only: append ?dev to the URL. Dynamically imported so
 * lil-gui never ships in the plain bundle — the site itself has no UI.
 */
export async function maybeAttachDevGui(
  solver: XpbdSolver,
  slap: SlapInteraction,
  ripples: RippleField,
): Promise<void> {
  if (!new URLSearchParams(window.location.search).has("dev")) return;
  const { default: GUI } = await import("lil-gui");
  const gui = new GUI({ title: "tuning" });

  const s = gui.addFolder("solver");
  s.add(solver.params, "substeps", 2, 16, 1);
  s.add(solver.params, "compliance", 1e-5, 3e-3);
  s.add(solver.params, "anchorRate", 5, 150);
  s.add(solver.params, "shapeMemoryRate", 0, 12);
  s.add(solver.params, "damping", 0, 6);
  s.add(solver.params, "maxDisplacement", 0.1, 1.2);

  const i = gui.addFolder("slap");
  i.add(slap.params, "tapPower", 0, 2);
  i.add(slap.params, "chargeBonus", 0, 6);
  i.add(slap.params, "chargeTimeMs", 200, 3000);
  i.add(slap.params, "radius", 0.1, 1.2);
  i.add(slap.params, "chargeRadiusBonus", 0, 1);
  i.add(slap.params, "brushPower", 0, 0.5);
  i.add(slap.params, "brushRadius", 0.05, 0.8);

  const r = gui.addFolder("ripples");
  r.add(ripples.params, "speed", 0.5, 6);
  r.add(ripples.params, "wavelength", 0.1, 1);
  r.add(ripples.params, "width", 0.05, 0.5);
  r.add(ripples.params, "spatialDecay", 0, 3);
  r.add(ripples.params, "temporalDecay", 0, 6);
  r.add(ripples.params, "maxAmp", 0, 0.12);
}
