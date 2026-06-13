/**
 * Round a dimension down to the nearest even integer (>= 2).
 *
 * H.264 / mp4 encoders require even width & height. Extracted verbatim from
 * node-banana's src/lib/video-probing.ts so the standalone viewer avoids the
 * mediabunny dependency that the rest of that file pulls in.
 */
export const ensureEvenDimension = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const even = value % 2 === 0 ? value : value - 1;
  return even > 0 ? even : 2;
};
