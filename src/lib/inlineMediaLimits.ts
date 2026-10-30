/**
 * How much media can ride inline in a generate request.
 *
 * Media reaches `/api/generate` as base64 data URLs inside a JSON body that the
 * BROWSER builds with `JSON.stringify`. That is fine for images and fatal for
 * video:
 *
 *   - a data URL is ~1.37x the file's bytes, and a JS string is UTF-16, so a
 *     100 MB clip is ~137 MB of base64 held as ~274 MB of memory;
 *   - `JSON.stringify` then allocates ANOTHER copy of the whole payload;
 *   - past V8's maximum string length the stringify throws
 *     `RangeError: Invalid string length`, and before that the renderer simply
 *     runs out of memory — which is an uncatchable tab crash, not an error the
 *     node can report.
 *
 * The muapi response path already learned this: it refuses to inline a result
 * over 20 MB and hands back a URL instead, with a comment naming the same
 * "Invalid string length" crash. This is the mirror of that rule for the
 * REQUEST side, which had no limit at all.
 *
 * This is a BROWSER threshold, not a size limit. Media over it is not refused:
 * it is sent as a reference to the file already on disk, and the server
 * uploads that file to the provider itself (multipart on the fal CDN for
 * anything over 90 MiB — verified with a 200 MiB file). It only keeps a large
 * clip out of the renderer's JSON.stringify, which is what used to crash the
 * tab. The server imposes no cap of its own; the provider decides.
 */

/** Largest single inline media value, in bytes of the DECODED file. */
export const INLINE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Approximate decoded size of a data URL, from its base64 length. */
export function approxDataUrlBytes(value: string): number {
  if (!value.startsWith("data:")) return 0;
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const b64Len = value.length - comma - 1;
  // 4 base64 chars per 3 bytes; padding is noise at this scale.
  return Math.floor(b64Len * 0.75);
}

export interface OversizedMedia {
  /** Which input carried it — a dynamicInputs key, or "images"/"videos". */
  field: string;
  bytes: number;
}

/**
 * The first inline value too large to send, or null when everything fits.
 *
 * Checks values rather than the serialized payload: the whole point is to
 * decide BEFORE `JSON.stringify` allocates a copy of it.
 */
export function findOversizedInlineMedia(
  buckets: Record<string, unknown>,
  limit: number = INLINE_MEDIA_MAX_BYTES,
): OversizedMedia | null {
  const check = (field: string, v: unknown): OversizedMedia | null => {
    if (typeof v === "string") {
      const bytes = approxDataUrlBytes(v);
      return bytes > limit ? { field, bytes } : null;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = check(field, item);
        if (hit) return hit;
      }
    }
    return null;
  };

  for (const [field, value] of Object.entries(buckets)) {
    const hit = check(field, value);
    if (hit) return hit;
  }
  return null;
}

/** Human-readable refusal naming the field and both sizes. */
export function oversizedMediaMessage(hit: OversizedMedia): string {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
  // Media over the limit normally goes from the project's inputs/ folder, at
  // any size. This only fires when the file is not there yet, so the fix is
  // saving, not shrinking the clip — which the old wording told people to do.
  return (
    `"${hit.field}" is ${mb(hit.bytes)} and is not saved in the project yet. Media over ` +
    `${mb(INLINE_MEDIA_MAX_BYTES)} is sent from the project's inputs folder, so save the ` +
    `workflow and run again.`
  );
}
