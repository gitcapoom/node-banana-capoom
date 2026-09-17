import type { NodeType, WorkflowNode } from "@/types";

/**
 * Sending media by DISK REFERENCE instead of inline base64.
 *
 * Media normally travels to `/api/generate` as a base64 data URL inside a JSON
 * body the browser builds with `JSON.stringify`. For a video that is fatal: the
 * data URL is ~1.37x the file, JS strings are UTF-16, and stringify allocates
 * another copy — so a large clip runs the renderer out of memory, which is a
 * tab crash rather than an error anyone can read.
 *
 * But the file is ALREADY on disk. Every media node that saves writes its bytes
 * into the project's `inputs/` folder and keeps the id in a `*Ref` field. So
 * instead of shipping the bytes through the browser, ship the id and let the
 * server read the file it already has and upload it to the provider directly.
 *
 * The wire form is a sentinel string in place of the data URL, so it travels
 * through the existing `dynamicInputs` plumbing untouched — nothing between
 * here and the route needs to know about it.
 */

export const MEDIA_REF_PREFIX = "nbfile:";

export function makeMediaRef(id: string): string {
  return `${MEDIA_REF_PREFIX}${id}`;
}

/** The media id inside a sentinel, or null if this is not one. */
export function parseMediaRef(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(MEDIA_REF_PREFIX)) return null;
  const id = value.slice(MEDIA_REF_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Which field holds the on-disk ref for a node's MEDIA output.
 *
 * Deliberately separate from compSignature's OUTPUT_REF_FIELD: that table
 * describes image pins for comp signatures and has no video or audio entries.
 * Mirrors the branches in `getSourceOutput` so the ref always describes the
 * same field the value came from — a ref pointing at a different field would
 * upload the wrong file, which is worse than not having one.
 */
const MEDIA_REF_FIELD: Partial<Record<NodeType, string>> = {
  videoInput: "videoFileRef",
  generateVideo: "outputVideoRef",
  videoStitch: "outputVideoRef",
  easeCurve: "outputVideoRef",
  videoTrim: "outputVideoRef",
  audioInput: "audioFileRef",
  generateAudio: "outputAudioRef",
  imageInput: "imageRef",
  nanoBanana: "outputImageRef",
};

/** The on-disk id for this node's media output, when it has one. */
export function mediaRefOf(node: WorkflowNode | null | undefined): string | null {
  if (!node) return null;
  const field = MEDIA_REF_FIELD[node.type as NodeType];
  if (!field) return null;
  const v = (node.data as Record<string, unknown>)[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const __MEDIA_REF_FIELD = MEDIA_REF_FIELD;

// ---------------------------------------------------------------------------
// Swapping oversized inline media for references, client-side.
// ---------------------------------------------------------------------------

import { approxDataUrlBytes, INLINE_MEDIA_MAX_BYTES, type OversizedMedia } from "./inlineMediaLimits";

export interface RefSwapResult<D> {
  dynamicInputs: D;
  images: string[];
  /** Oversized, and no on-disk file to point at. Nothing can send this. */
  unresolved: OversizedMedia | null;
}

/**
 * Replace every inline value over the limit with an `nbfile:` reference.
 *
 * Values that fit are left exactly as they were: small media keeps travelling
 * inline, which needs no project directory and no upload round trip, so the
 * common path is untouched.
 *
 * `resolveRef` maps a value back to the id of the file it was loaded from.
 * When it returns null the value is oversized AND unsaved, which nothing can
 * send — reported rather than silently dropped.
 */
export function swapOversizedForRefs<D extends Record<string, unknown>>(
  dynamicInputs: D,
  images: string[],
  resolveRef: (value: string) => string | null,
  limit: number = INLINE_MEDIA_MAX_BYTES,
): RefSwapResult<D> {
  let unresolved: OversizedMedia | null = null;

  const swapValue = (field: string, v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const bytes = approxDataUrlBytes(v);
    if (bytes <= limit) return v;
    const id = resolveRef(v);
    if (!id) {
      unresolved = unresolved ?? { field, bytes };
      return v;
    }
    return makeMediaRef(id);
  };

  const swapField = (field: string, v: unknown): unknown =>
    Array.isArray(v) ? v.map((item) => swapValue(field, item)) : swapValue(field, v);

  const nextDynamic = {} as Record<string, unknown>;
  for (const [field, value] of Object.entries(dynamicInputs ?? {})) {
    nextDynamic[field] = swapField(field, value);
  }
  const nextImages = images.map((img) => swapValue("images", img) as string);

  return { dynamicInputs: nextDynamic as D, images: nextImages, unresolved };
}
