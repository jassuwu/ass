const FALLBACK_KEY = "ass-renderer-fallback";

/** true when this session has already fallen back to WebGL (or ?webgl in dev) */
export function useWebGL(): boolean {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("webgl"))
    return true;
  try {
    return sessionStorage.getItem(FALLBACK_KEY) === "webgl";
  } catch {
    return false;
  }
}

/**
 * The GPU went away. Retry once with WebGL for the rest of the session;
 * if that is what just died too, leave the poster up — a still of the
 * artwork beats a black page.
 */
export function recoverRenderer(wasWebGPU: boolean): void {
  delete document.documentElement.dataset.ready;
  if (!wasWebGPU) return;
  try {
    if (sessionStorage.getItem(FALLBACK_KEY) === "webgl") return;
    sessionStorage.setItem(FALLBACK_KEY, "webgl");
    location.reload();
  } catch {
    // restricted storage: the static artwork stays visible
  }
}
