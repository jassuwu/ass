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

- `src/core/app.ts` — wiring + frame loop (flesh → camera → render)
- `src/scene/body-sdf.ts` — the body as a pure signed distance field (no
  three.js, so the physics worker evaluates it too). `specimen.ts` meshes
  it with surface nets, builds the skin material, and exposes the
  raycast proxy and the flush field.
- `src/physics/flesh.ts` — what the app talks to. Gestures queue as
  commands; each frame they go to `engine.ts` (lattice + solver + ripples +
  skinning + sleep) which runs in `worker.ts` off the main thread, and the
  deformed positions and normals come back one frame later. Falls back to
  running the same engine inline if the worker fails. The dev bench pushes
  parameter changes across with `syncParams()`.
- `src/scene/camera-rig.ts` — the authored home frame + clamped borrowed
  orbit/zoom. Distance solved from aspect (max of width-fit/height-fit;
  ultrawide letterboxes into side voids).
- `src/physics/` — XPBD: `lattice.ts` (volumetric particle grid + graded
  anchor field: body side, torso, thighs, depth-based core hold; six
  tetrahedra per cell for volume), `solver.ts` (small-substeps XPBD with
  volume conservation, tension-stiffer edges, neighbour viscosity),
  `hand.ts` (the palm as a rigid elliptical collider with a dynamic
  drive/dwell/peel and sticky friction — depth is an outcome of arrival
  speed, arm push and the flesh's reaction; also the sliding fingertip the
  brush drives), `skin.ts` (trilinear embedding on raw arrays).
- `src/interaction/slap.ts` — tap / hold-to-charge / fingertip brush.
  Exposes `charge` and `brushSpeed` for audio. Impacts go through
  `flesh.slap()` (a Hand lands), the brush through `flesh.touch()`, never a
  bare impulse. The flesh reports `onContact` (palm bottomed out: depth,
  area, firmness) and `onRelease` (palm peeling, with the palm's frame);
  the hand-print flush, the ripples and the body of the sound read from
  those, not from power.
- `src/audio/` — recorded foley. `samples.ts` loads the CC0 slices in
  `public/sfx/` (sources in `docs/sfx-sources.md`); `foley.ts` layers a
  recorded crack at contact and a recorded buttock hit when the flesh
  bottoms out, panned by cheek, at quarter speed and closer in the kill
  cam; the brush is a recorded caress gated by speed; the heartbeat is a
  recording. The room is early reflections plus a damped diffuse tail.
- Lifecycle: a poster in `index.html` holds the frame until the first
  presented frame sets `data-ready`; hidden tabs pause everything; WebGPU
  device loss retries once with WebGL (`render/recovery.ts`);
  prefers-reduced-motion stills the camera and skips the kill cam dive.
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
- Everything under `src/physics/` and `src/scene/body-sdf.ts` must stay free
  of three.js imports (types only): it is bundled into the worker.
- Verify motion with `node scripts/screencast.mjs` against the dev server:
  it records every gesture at ~60 fps through Chrome's screencast and
  builds contact sheets under `/tmp/ass-vid/`. A screenshot takes ~200 ms
  and cannot resolve a 60 ms contact; `bun run test` traces the numbers.
- Skinning is a quadratic B-spline over 27 particles (`skin.ts`), not
  trilinear over 8: trilinear shows every lattice cell as a box the moment
  the lattice moves, worst in the first frames of a hit seen obliquely.
- The palm lands along the surface normal at the hit, never the view ray;
  a blow near the silhouette or after orbiting would otherwise plough.
- The skin conforms to the palm at mesh resolution (`skin.ts` refine):
  the lattice carries volume and wobble, the exact print shape is applied
  to vertices along the blow axis with a feathered edge. Skin maps are
  projected in rest space (`skinPosition`/`skinNormal` attributes) so they
  never swim or re-blend under deformation.

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
