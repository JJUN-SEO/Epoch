let cached: boolean | undefined;

/**
 * Whether this computer can draw the 3D view. Checked once, without loading
 * three.js: the 3D code is a separate chunk that 2D users never download.
 */
export function webglAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    cached = gl !== null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}
