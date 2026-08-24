/**
 * Placement metadata for a crop, carried on the Image Crop node's text handle.
 *
 * The workflow this exists for: crop a region out of an image → send the crop to
 * a generator → composite the result back over the original. The generator does
 * not return the resolution it was given, so the patch has to be rescaled and
 * repositioned; this payload is what lets the Comp node do that automatically
 * instead of the user dialling it in by hand every time.
 *
 * Why each field is here (nothing is here "for completeness" — `panoCrop`'s
 * metadata ships an `aspectRatio` that no consumer has ever read, and that is
 * the mistake this module is not repeating):
 *
 *  - `crop` is in INTEGER source px, not derived from `region`, because
 *    `cropImageToDataUrl` rounds each component of the sample rect
 *    independently: `sx = round(x*W)`, `sw = max(1, round(w*W))`. So
 *    `crop.x + crop.width` need not equal `round((x + width) * W)`. A consumer
 *    that recomputes from `region` lands up to a pixel off the pixels that were
 *    actually cut.
 *  - `sourceWidth`/`sourceHeight` give the frame the crop was cut from: the Comp
 *    node works bottom-left/y-up while a crop is top-left/y-down, so placing the
 *    patch needs the source height for the flip (`vPos = srcH - (y + height)`),
 *    and the source width to confirm the BG really is the same picture.
 *  - `region` (relative 0..1) is the fallback when the BG in the comp is a
 *    different-resolution version of the same picture — a proxy, or a reformat.
 *    Integer px cannot survive that; a relative region can.
 *  - `emittedWidth`/`emittedHeight` record the px size that went out on the image
 *    handle, so a consumer can detect that the generator changed the resolution
 *    by comparing the decoded FG against it.
 *  - `origin` is stated in the payload and asserted on parse, so a future
 *    y-up producer cannot silently feed a y-down consumer.
 *
 * `parseCropMetadata` is deliberately paranoid: this arrives over a text pin,
 * and a user can wire a `prompt` node's free text into it just as easily as a
 * crop node. It returns `null` on anything it does not fully recognise.
 */

import type { CropResult, RelativeCropRegion } from "./cropImage";

export interface CropMetadata {
  v: 1;
  kind: "imageCrop";
  /** Documented in the payload and asserted on parse — see module doc. */
  origin: "top-left";
  sourceWidth: number;
  sourceHeight: number;
  /** INTEGER source px — the rect actually sampled, never a recomputation. */
  crop: { x: number; y: number; width: number; height: number };
  /** Relative 0..1, for BGs at a different resolution than the source. */
  region: { x: number; y: number; width: number; height: number };
  /** Px size put on the image handle. */
  emittedWidth: number;
  emittedHeight: number;
}

/**
 * How far past the source edge a crop rect may sit and still be accepted.
 *
 * Not slop — a bound. With `sx ≤ x*W + 0.5` and `sw ≤ w*W + 0.5` and
 * `x + w ≤ 1`, independent rounding can put `sx + sw` at most 1px past `W`
 * (the `max(1, …)` floor on `sw` cannot beat that either). Rejecting at
 * exactly `W` would therefore throw out our own legitimate output; rejecting
 * beyond `W + 1` still catches metadata that belongs to a different image.
 */
const EDGE_SLACK_PX = 1;

/**
 * Build the payload for a completed crop. `result` is what `cropImageToDataUrl`
 * returned, so the integers are the ones `drawImage` was given.
 *
 * `emitted` defaults to the crop's own pixel size; pass it only when the image
 * placed on the handle is not the raw crop.
 */
export function buildCropMetadata(
  result: CropResult,
  region: RelativeCropRegion,
  emitted?: { width: number; height: number }
): CropMetadata {
  return {
    v: 1,
    kind: "imageCrop",
    origin: "top-left",
    sourceWidth: result.srcW,
    sourceHeight: result.srcH,
    crop: { x: result.sx, y: result.sy, width: result.sw, height: result.sh },
    region: { x: region.x, y: region.y, width: region.width, height: region.height },
    emittedWidth: emitted ? emitted.width : result.sw,
    emittedHeight: emitted ? emitted.height : result.sh,
  };
}

/**
 * Metadata for the passthrough path (no region set): the whole frame, in place.
 * Emitted so the downstream contract is the same shape whether or not the user
 * has drawn a crop — a consumer never has to special-case "no metadata yet".
 */
export function identityCropMetadata(srcW: number, srcH: number): CropMetadata {
  return {
    v: 1,
    kind: "imageCrop",
    origin: "top-left",
    sourceWidth: srcW,
    sourceHeight: srcH,
    crop: { x: 0, y: 0, width: srcW, height: srcH },
    region: { x: 0, y: 0, width: 1, height: 1 },
    emittedWidth: srcW,
    emittedHeight: srcH,
  };
}

export function serializeCropMetadata(m: CropMetadata): string {
  return JSON.stringify(m);
}

/** Finite, and an exact pixel count — sizes are never fractional. */
function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

type Rect = { x: number; y: number; width: number; height: number };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Integer px rect, non-negative origin, positive size. */
function parsePixelRect(v: unknown): Rect | null {
  const r = asRecord(v);
  if (!r) return null;
  if (!isNonNegativeInt(r.x) || !isNonNegativeInt(r.y)) return null;
  if (!isPositiveInt(r.width) || !isPositiveInt(r.height)) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Relative rect inside the unit box. */
function parseRelativeRect(v: unknown): Rect | null {
  const r = asRecord(v);
  if (!r) return null;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y)) return null;
  if (!isFiniteNumber(r.width) || !isFiniteNumber(r.height)) return null;
  if (r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0) return null;
  // Floating-point epsilon: a region assembled as e.g. (1-w)/2 + w can land a
  // few ulps past 1 without meaning anything.
  const EPS = 1e-9;
  if (r.x + r.width > 1 + EPS) return null;
  if (r.y + r.height > 1 + EPS) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/**
 * Parse whatever showed up on the text pin. Returns `null` — never throws — for
 * anything that is not a crop payload this build understands.
 */
export function parseCropMetadata(s: unknown): CropMetadata | null {
  if (typeof s !== "string") return null;

  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    return null;
  }

  const o = asRecord(raw);
  if (!o) return null;
  if (o.v !== 1) return null;
  if (o.kind !== "imageCrop") return null;
  if (o.origin !== "top-left") return null;

  if (!isPositiveInt(o.sourceWidth) || !isPositiveInt(o.sourceHeight)) return null;
  if (!isPositiveInt(o.emittedWidth) || !isPositiveInt(o.emittedHeight)) return null;

  const crop = parsePixelRect(o.crop);
  if (!crop) return null;
  const region = parseRelativeRect(o.region);
  if (!region) return null;

  // The crop must belong to this source frame — the main defence against
  // metadata that was captured against a different image.
  if (crop.x + crop.width > o.sourceWidth + EDGE_SLACK_PX) return null;
  if (crop.y + crop.height > o.sourceHeight + EDGE_SLACK_PX) return null;

  return {
    v: 1,
    kind: "imageCrop",
    origin: "top-left",
    sourceWidth: o.sourceWidth,
    sourceHeight: o.sourceHeight,
    crop,
    region,
    emittedWidth: o.emittedWidth,
    emittedHeight: o.emittedHeight,
  };
}
