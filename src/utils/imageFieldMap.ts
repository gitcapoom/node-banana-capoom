/**
 * Single source of truth for the image fields affected by lazy full-res
 * loading: the fields a node leaves NULL on open (keeping only an inline
 * thumbnail). Two maps derived from the same field layout:
 *
 *  - THUMB_DISPLAY_FIELDS: each node's DISPLAYED image fields + their inline
 *    thumb companion. Used by the one-time backfill migration
 *    (useThumbBackfill) for workflows saved before thumbnails existed.
 *  - RUN_FULLRES_FIELDS: the source + output fields ensureFullResForNodes()
 *    loads from disk before a run, so executors reading connected inputs
 *    (upstream OUTPUT) or falling back to a node's own stored SOURCE see real
 *    pixels. See src/store/execution/hydrateForRun.ts.
 *
 * Keep both in sync with the save-side externalize* calls in
 * src/utils/imageStorage.ts.
 */

import type { NodeType } from "@/types";

/** A DISPLAYED image field with an inline thumbnail companion. */
export interface ThumbDisplayField {
  raw: string;    // inline full-res field (null on open)
  ref: string;    // file-ref companion
  thumb: string;  // inline small-preview field (kept in JSON)
  folder: "inputs" | "generations";
  format?: "jpeg" | "png"; // png for alpha-bearing previews (matte / comp)
}

/** A ref-backed image field the run pre-pass loads full-res. */
export interface RunImageField {
  raw: string;   // inline field (full-res or null on open)
  ref: string;   // file-ref companion
  folder: "inputs" | "generations";
}

export const THUMB_DISPLAY_FIELDS: Partial<Record<NodeType, ThumbDisplayField[]>> = {
  imageInput: [
    { raw: "image", ref: "imageRef", thumb: "imageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  annotation: [
    { raw: "sourceImage", ref: "sourceImageRef", thumb: "sourceImageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  imageCrop: [
    { raw: "sourceImage", ref: "sourceImageRef", thumb: "sourceImageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  mirror: [
    { raw: "sourceImage", ref: "sourceImageRef", thumb: "sourceImageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  reformat: [
    { raw: "sourceImage", ref: "sourceImageRef", thumb: "sourceImageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  cubemapEquirect: [
    { raw: "sourceImage", ref: "sourceImageRef", thumb: "sourceImageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  panoShift: [
    { raw: "sourceImage", ref: "sourceImageRef", thumb: "sourceImageThumb", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" },
  ],
  colorGrade: [{ raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" }],
  hsvCorrect: [{ raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" }],
  contrastAdjust: [{ raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs" }],
  comp: [{ raw: "outputImage", ref: "outputImageRef", thumb: "outputImageThumb", folder: "inputs", format: "png" }],
  maskPainter: [{ raw: "outputMask", ref: "outputMaskRef", thumb: "outputMaskThumb", folder: "inputs", format: "png" }],
  roto: [{ raw: "outputMask", ref: "outputMaskRef", thumb: "outputMaskThumb", folder: "inputs", format: "png" }],
};

/**
 * comp's 5 input mirrors are omitted: the executor re-derives them from upstream
 * (whose outputs are loaded here), so its own mirrors needn't be loaded.
 */
export const RUN_FULLRES_FIELDS: Partial<Record<NodeType, RunImageField[]>> = {
  imageInput: [
    { raw: "image", ref: "imageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  annotation: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  imageCrop: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  mirror: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  reformat: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  cubemapEquirect: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  panoShift: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  colorGrade: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  hsvCorrect: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  contrastAdjust: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputImage", ref: "outputImageRef", folder: "inputs" },
  ],
  comp: [{ raw: "outputImage", ref: "outputImageRef", folder: "inputs" }],
  maskPainter: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputMask", ref: "outputMaskRef", folder: "inputs" },
  ],
  roto: [
    { raw: "sourceImage", ref: "sourceImageRef", folder: "inputs" },
    { raw: "outputMask", ref: "outputMaskRef", folder: "inputs" },
  ],
};
