/**
 * Which image a node paints into its inline preview.
 *
 * Node previews are ~60-250 CSS px, but the field they were reading is the
 * full-res image — so a 6554x3686 (or 8192x8192) frame was being decoded to
 * fill a 56x53 box. That cost is invisible until something pulls full-res into
 * node data, and `ensureFullResForNodes` does exactly that for a comp/blur
 * node's ENTIRE upstream closure. From then on every one of those nodes paints
 * tens of megapixels, and React Flow's `onlyRenderVisibleElements` re-decodes
 * the lot on each pan/zoom that crosses them. Measured on a real graph: 420
 * megapixels / 650 MB of base64 live in the DOM, and zooming out froze the
 * renderer for >45s. That is the "GPU nodes are slow" symptom — the GPU is idle
 * throughout; it's image decode on the main thread.
 *
 * The thumb is only safe to show if it matches the current pixels, and the
 * `*Ref` field tells us exactly that: every writer that produces a new image
 * clears the ref alongside it (`{ outputImage: x, outputImageRef: undefined }`
 * — see simpleNodeExecutors and the GPU commits). So:
 *
 *   ref present  → on-disk media, and the thumb beside it, are current → thumb
 *   ref cleared  → freshly generated pixels with no matching thumb → full-res
 *
 * which can never show stale content, and costs full-res only until the node
 * next saves and gets a thumb again.
 */

/** Inline-preview source for one image field, given its thumb and file ref. */
export function previewSrc(
  full: string | null | undefined,
  thumb: string | null | undefined,
  ref: string | null | undefined,
): string | null {
  if (thumb && ref) return thumb;
  return full ?? thumb ?? null;
}
