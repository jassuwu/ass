// Launch teaser for ass.jass.gg — the site's audio grammar as a track.
// 84 BPM, 7 bars: resting heartbeat → doubling → racing (the charge) with a
// rising semitone creep → bar 5.5 the heart stops (the room holds its
// breath) → downbeat of bar 6 the slap lands: noise crack + body thump +
// the site's 28Hz sub swell, ringing into the tail. All synthesized — no
// sample banks, no license baggage on a distributed launch video.

export function getPattern(c) {
  const { note, s, stack } = c;

  // the heartbeat: lub on the grid, dub a 16th behind it, softer.
  // one per bar at rest → two → racing → two → gone.
  const heartSeq =
    "<[c1 ~ ~ ~] [c1 ~ ~ ~] [c1 ~ c1 ~] [c1 ~ c1 ~] [c1 c1 c1 c1] [c1 c1 ~ ~] [~ ~ ~ ~]>";
  const lub = note(heartSeq).s("sine").decay(0.18).sustain(0).gain(0.8);
  const dub = note(heartSeq)
    .s("sine")
    .decay(0.14)
    .sustain(0)
    .gain(0.42)
    .late(0.0625);

  // room tone: HVAC-in-another-room rumble. Drops out with the heartbeat.
  const drone = note("c1")
    .s("sawtooth")
    .cutoff(140)
    .attack(0.8)
    .sustain(1)
    .release(0.8)
    .gain(0.11)
    .mask("<1 1 1 1 1 0 0>");
  const air = s("white")
    .cutoff(240)
    .attack(1)
    .sustain(1)
    .release(0.5)
    .gain(0.035)
    .mask("<1 1 1 1 1 0 0>");

  // tension: a faint high sine creeping up in semitones as the charge builds
  const creep = note("<~ ~ g5 ab5 a5 bb5 ~>")
    .s("sine")
    .attack(0.5)
    .sustain(0.8)
    .release(0.6)
    .gain(0.04)
    .room(0.5)
    .size(0.8);

  // riser under the build, bar 4 only — quiet groundwork
  const riser = s("white")
    .hcutoff(500)
    .cutoff(2800)
    .attack(1.6)
    .sustain(0.6)
    .release(0.2)
    .gain(0.05)
    .mask("<0 0 0 0 1 0 0>");

  // the whoosh: swells through the held breath (bar 5) and dies ~0.45s
  // BEFORE the downbeat — the gap of true silence is what loads the hit
  const whoosh = s("white")
    .hcutoff(300)
    .cutoff(6000)
    .attack(1.9)
    .decay(0.5)
    .sustain(0)
    .gain(1.1)
    .mask("<0 0 0 0 0 1 0>");

  // ---- the impact, downbeat of bar 6: a Sniper-Elite stack, not a burst
  const hit = (p) => p.struct("x ~ ~ ~").mask("<0 0 0 0 0 0 1>");
  // 1. instant transient snap — the click your ear reads as "contact"
  const click = hit(s("white").decay(0.045).sustain(0).hcutoff(2500).gain(1.1));
  // 2. mid crack — the skin, bandpassed into the 600-4k pocket
  const crack = hit(
    s("white").decay(0.16).sustain(0).cutoff(4200).hcutoff(600).gain(1.0),
  );
  // 3. low thump — the mass. Two sines an octave-and-fifth apart = weight
  const thump = hit(note("g1,c2").s("sine").decay(0.35).sustain(0).gain(1.1));
  // 4. the slow-mo tail — long, dark, reverb-drowned
  const tail = hit(
    s("white").decay(1.4).sustain(0).cutoff(900).gain(0.5).room(0.7).size(0.9),
  );
  // 5. sub swell — a0 ≈ 27.5Hz (the site's own frequency) with an audible
  // octave riding it, because phone speakers cannot reproduce the fundamental
  const sub = hit(
    note("a0")
      .s("sine")
      .attack(0.25)
      .decay(2.2)
      .sustain(0.3)
      .release(1.5)
      .gain(0.6),
  );
  const subOct = hit(
    note("a1")
      .s("sine")
      .attack(0.2)
      .decay(1.8)
      .sustain(0.2)
      .release(1.2)
      .gain(0.32),
  );

  return stack(
    lub,
    dub,
    drone,
    air,
    creep,
    riser,
    whoosh,
    click,
    crack,
    thump,
    tail,
    sub,
    subOct,
  );
}

// fully synthesized — nothing to preload
export const SAMPLES = [];

export const USE_WORKLETS = true;
