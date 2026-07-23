import {
  AbsoluteFill,
  Easing,
  Html5Audio,
  interpolate,
  random,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { barFrame, FRAMES_PER_BAR } from "../sync.mjs";

// Launch teaser for ass.jass.gg, played completely straight: a celestial
// body cresting the horizon of the frame (the Rogue One Death-Star-rise
// register). The heartbeat lives in the LIGHT, not in motion — planets
// don't bounce. At the downbeat of bar 6 the sub hits: dawn flares over
// the crest and one slow seismic wave rolls through the mass.
//
// Drawn as SVG with the same architecture the og image settled on: all
// shading clipped inside the union silhouette, light pooled ONLY at the
// apexes — lateral darkness is what hides the circles' descending arcs,
// so the mass reads as one form, not two crossing planets.

const W = 1080;
const H = 1080;
const R = 760;

// heartbeat hits as (bar, position-in-bar) — mirrors heartSeq in music.mjs
const HEART: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 0.5],
  [3, 0],
  [3, 0.5],
  [4, 0],
  [4, 0.25],
  [4, 0.5],
  [4, 0.75],
  [5, 0],
  [5, 0.25],
];

export const Video: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const BREATH = Math.round(5.5 * FRAMES_PER_BAR); // the heart stops
  const EVENT = barFrame(6); // the sub hits

  // ---- the rise: constant, majestic, done exactly when the breath begins
  const rise = interpolate(frame, [0, BREATH], [360, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const cy = 1520 + rise;

  // ---- the heartbeat, carried by light
  let pulse = 0;
  for (const [b, p] of HEART) {
    const hf = Math.round((b + p) * FRAMES_PER_BAR);
    if (frame >= hf && frame - hf < 30) {
      pulse = Math.max(pulse, Math.exp(-(frame - hf) / 8));
    }
  }

  // ---- dawn: gathering through the build, flaring at the event, settling
  const gather = interpolate(frame, [0, BREATH], [0.3, 0.62], {
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  const flare = interpolate(
    frame,
    [EVENT, EVENT + 10, EVENT + 100],
    [0, 1, 0.4],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.quad),
    },
  );
  const rim = Math.min(1.3, gather + 0.16 * pulse + 0.85 * flare);

  // ---- the seismic wave: slow damped swell through each crest, far one late
  const seism = (delayFrames: number): number => {
    const t = (frame - EVENT - delayFrames) / fps;
    if (t < 0) return 0;
    return Math.exp(-t * 0.9) * Math.sin(2 * Math.PI * 0.7 * t);
  };
  const cyL = cy - 14 * seism(0);
  const cyR = cy - 11 * seism(6);
  const apexL = cyL - R;
  const apexR = cyR - R;

  // camera: a barely-there low-frequency tremor after the event
  const tq = (frame - EVENT) / fps;
  const shake = tq >= 0 ? 3.5 * Math.exp(-tq * 1.1) : 0;
  const camX = shake * Math.sin(tq * 2 * Math.PI * 1.3);
  const camY = shake * Math.cos(tq * 2 * Math.PI * 0.9);

  // ---- cinema bars: slide in while the room holds its breath, stay
  const barH = interpolate(frame, [BREATH, BREATH + 26], [0, 0.12 * H], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // ---- the url: after the wave has mostly settled, quietly
  const url = interpolate(frame, [EVENT + 72, EVENT + 100], [0, 0.9], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });

  // intro: the void resolves out of black in the first second
  const intro = interpolate(frame, [0, 24], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <Html5Audio src={staticFile("audio.wav")} />

      <AbsoluteFill
        style={{ opacity: intro, transform: `translate(${camX}px, ${camY}px)` }}
      >
        {/* the void, with the faintest field of stars */}
        {Array.from({ length: 90 }, (_, i) => {
          const sx = random(`sx${i}`) * W;
          const sy = random(`sy${i}`) * H * 0.58;
          const so = 0.04 + random(`so${i}`) * 0.1;
          const ss = 1 + random(`ss${i}`) * 1.4;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: sx,
                top: sy,
                width: ss,
                height: ss,
                borderRadius: "50%",
                background: "#cfd6e4",
                opacity: so,
              }}
            />
          );
        })}

        <svg
          width={W}
          height={H}
          style={{ position: "absolute", inset: 0 }}
          role="img"
          aria-label="horizon"
        >
          <defs>
            <clipPath id="mass">
              <circle cx={380} cy={cyL} r={R} />
              <circle cx={700} cy={cyR} r={R} />
            </clipPath>
            <clipPath id="lobeL">
              <circle cx={380} cy={cyL} r={R} />
            </clipPath>
            <clipPath id="lobeR">
              <circle cx={700} cy={cyR} r={R} />
            </clipPath>
            <filter id="bSoft" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="18" />
            </filter>
            <filter id="bTight" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
            <filter id="bWide" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="30" />
            </filter>
          </defs>

          {/* atmosphere: haze hugging each lit apex, tight and faint */}
          <ellipse
            cx={380}
            cy={apexL - 16}
            rx={330}
            ry={64}
            fill="#7a5234"
            opacity={0.14 * rim}
            filter="url(#bWide)"
          />
          <ellipse
            cx={700}
            cy={apexR - 14}
            rx={280}
            ry={54}
            fill="#5e3e26"
            opacity={0.11 * rim}
            filter="url(#bWide)"
          />

          <g clipPath="url(#mass)">
            {/* the mass itself: barely lighter than the void */}
            <circle cx={380} cy={cyL} r={R} fill="#0d0805" />
            <circle cx={700} cy={cyR} r={R} fill="#0a0603" />
          </g>

          {/* light pools at the apexes only, each clipped to ITS OWN lobe —
              the lateral darkness keeps the descending arcs invisible, and
              no sheen ever bleeds across the saddle onto the other cheek */}
          <g clipPath="url(#lobeL)">
            <ellipse
              cx={380}
              cy={apexL + 34}
              rx={330}
              ry={54}
              fill="#b27c50"
              opacity={0.5 * rim}
              filter="url(#bSoft)"
            />
            <ellipse
              cx={380}
              cy={apexL + 13}
              rx={240}
              ry={20}
              fill="#e2a76c"
              opacity={0.62 * rim}
              filter="url(#bTight)"
            />
          </g>
          <g clipPath="url(#lobeR)">
            <ellipse
              cx={700}
              cy={apexR + 32}
              rx={295}
              ry={48}
              fill="#8f6440"
              opacity={0.42 * rim}
              filter="url(#bSoft)"
            />
            <ellipse
              cx={700}
              cy={apexR + 12}
              rx={215}
              ry={17}
              fill="#c08a58"
              opacity={0.48 * rim}
              filter="url(#bTight)"
            />
          </g>

          {/* the meeting of the two curves: a soft shadow in the saddle */}
          <g clipPath="url(#mass)">
            <ellipse
              cx={540}
              cy={(apexL + apexR) / 2 + 58}
              rx={110}
              ry={52}
              fill="#000"
              opacity={0.6}
              filter="url(#bSoft)"
            />
          </g>
        </svg>

        {/* the url, spoken quietly into the void */}
        <div
          style={{
            position: "absolute",
            width: "100%",
            top: "43%",
            textAlign: "center",
            opacity: url,
            color: "#a99884",
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 42,
            letterSpacing: "0.32em",
          }}
        >
          ass.jass.gg
        </div>
      </AbsoluteFill>

      {/* vignette, outside the camera tremor */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 75% 75% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      {/* cinema bars — grammar, not UI */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: barH,
          background: "#000",
          zIndex: 10,
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: barH,
          background: "#000",
          zIndex: 10,
        }}
      />
    </AbsoluteFill>
  );
};
