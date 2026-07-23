import { Composition } from "remotion";
// Same file render-audio.mjs uses → audio length and video length are guaranteed equal.
import { DURATION_IN_FRAMES, FPS } from "../sync.mjs";
import { Video } from "./Video";

// 9:16 vertical (Reels / Shorts / TikTok). For 1:1 use 1080×1080; for 16:9 use 1920×1080 — keep the
// focal idea centered so the same composition survives every crop. See MOTION.md → "Format".
export const RemotionRoot: React.FC = () => (
  <Composition
    id="Video"
    component={Video}
    durationInFrames={DURATION_IN_FRAMES}
    fps={FPS}
    width={1080}
    height={1080}
  />
);
