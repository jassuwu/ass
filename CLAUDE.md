# ass

An absurdist art website: an extremely photorealistic human ass in a black
void, with obsessively real soft-body physics. That's the entire site. The
comedy engine is the gap between subject and treatment — museum-grade craft
lavished on the dumbest possible subject, presented with total sincerity.

## Iron rules (breaking these breaks the joke)

- **Zero text, zero UI, zero explanation.** No copy, no buttons, no hints,
  no score. All mechanics are discovered. Tab title is `ass`, favicon is a
  near-black dot. The only permitted UI is the dev tuning bench behind `?dev`.
- **Sculptural, never sexual.** Anonymous fragment framing (no face, no
  identity), product-photography lighting, deadpan presentation. The framing
  is the guardrail.
- **One authored home frame, borrowable within clamps.** The composition is
  authored; the visitor may borrow the camera (drag the void to orbit,
  wheel/pinch to zoom) but only inside PG-13 clamps — yaw dies well before
  the profile, so the front of the specimen does not exist. Cursor
  micro-parallax and the breathing dolly ride on top. The kill cam is the
  one and only thing allowed to actually break the frame.
- **Effort is the punchline.** Photorealism is the bar (think RTX-texture-pack
  absurdity); physics must trigger "that's EXACTLY how it happens" recognition,
  not "nice simulation". Never ship a cheap version of anything visible.

## Stack & commands

bun (not npm) · Vite · vanilla TypeScript · three (three/webgpu, WebGPU-first
with automatic WebGL2 fallback) · custom XPBD physics (no physics library) ·
raw WebAudio · Biome.

```bash
bun run dev        # vite dev server
bun run build      # tsc + vite build
bun run typecheck  # tsc --noEmit
bun run check      # biome check --write
```

Git: repo-local identity jassuwu <jass@jass.gg>, commit signing disabled,
commits with --no-verify, no co-author lines. Segmented conventional commits.

## Architecture

- `src/core/app.ts` — wiring + frame loop (physics → skin → camera → render)
- `src/scene/specimen.ts` — parametric body column (`bodyRadius()` is the
  single source of shape truth: render mesh, raycast proxy, physics
  inside-test and depth all derive from it). Will be replaced by a sculpted
  asset in the fidelity phase; keep the interface.
- `src/scene/camera-rig.ts` — the authored home frame + clamped borrowed
  orbit/zoom. Distance solved from aspect (max of width-fit/height-fit;
  ultrawide letterboxes into side voids).
- `src/physics/` — XPBD: `lattice.ts` (volumetric particle grid + graded
  anchor field: body side, torso, thighs, depth-based core hold; six
  tetrahedra per cell for volume), `solver.ts` (small-substeps XPBD with
  volume conservation, tension-stiffer edges, neighbour viscosity),
  `hand.ts` (the palm as a rigid elliptical collider with a dynamic
  drive/dwell/peel and sticky friction — depth is an outcome of arrival
  speed, arm push and the flesh's reaction), `skin.ts` (trilinear embedding).
- `src/interaction/slap.ts` — tap / hold-to-charge / cursor brush. Exposes
  `charge` and `brushSpeed` for audio. Impacts go through `solver.slap()`
  (a Hand lands), never a bare impulse. The solver reports `onContact`
  (palm bottomed out: depth, area, firmness) and `onRelease` (palm peeling);
  ripples, flush and the body of the sound read from those, not from power.
- `src/audio/` — all synthesised. `foley.ts` models the slap as a cavity
  clap (resonant bands pitched by palm size and squeeze) at contact plus a
  damped two-mode body thump when the solver says the flesh bottomed out;
  brush is speed-gated friction noise; the room is early reflections plus
  a damped diffuse tail. No pitch sweeps, no sub outside the kill cam.
- `src/interaction/orbit.ts` — void-drag orbit + wheel/pinch zoom. Shares
  the pointer with slap via `blocked`/`cancel`.
- Tuning: append `?dev` for the lil-gui bench (dynamically imported, never in
  the plain bundle).

## Gotchas

- three r183+ renamed `PostProcessing` → `RenderPipeline`; TSL display nodes
  live in `three/addons/tsl/display/`.
- tsconfig has `erasableSyntaxOnly` — no constructor parameter properties.
- Frame dt must be clamped above zero: dt=0 → substep h=0 → NaN cascade.
- The physics lattice only spans the band around the cheeks (y ∈ [-1.75, 1.5]);
  out-of-frame flesh rides the anchored boundary via clamped skin bindings.

## Roadmap state (July 2026)

Done: authored frame, body-column placeholder, XPBD flesh (layered core hold),
tap/hold/brush interaction, dev bench, audio layer (room tone, foley,
heartbeat), kill cam (full-charge trigger, slow-mo, cinema bars, stretched
audio), impact ripple wavefronts, PMREM environment fill, procedural TSL skin
material, post pipeline (dof with live focus pull, bloom, vignette, grain),
hand-collider slap model (a rigid palm arrives, drives against the flesh's
reaction, dwells, bounces off; volume-conserving tissue bulges at the rim
and wobbles on its own), accumulating spank flush (per-vertex redness,
blotch-modulated, shader-side decay), void-drag orbit + wheel/pinch zoom
within PG-13 clamps, modelled foley (clap + body, friction brush, small
dead room). `bun run test` runs the numeric contact checks.
Next: sculpted asset with UVs + real skin texture maps (pores need textures —
procedural bump was punted, @types lag noted in render/pipeline.ts) → perf
pass / WebGPU compute port of solver+skinning if needed → deploy + domain.
