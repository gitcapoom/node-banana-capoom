/**
 * Deep-set a (possibly dotted) key into a target object, creating ARRAYS for
 * numeric path segments and objects otherwise.
 *
 *   "fill_image.fill_image_url"           → { fill_image: { fill_image_url: v } }
 *   "elements.0.frontal_image_url"        → { elements: [ { frontal_image_url: v } ] }
 *   "elements.1.reference_image_urls"     → { elements: [ <hole>, { reference_image_urls: v } ] }
 *
 * Used by the provider payload builders for nested/repeatable dynamic inputs
 * (e.g. Kling `elements`). The caller is responsible for shaping `value`
 * (scalar vs array) per the field's schema.
 */

const isIndex = (seg: string): boolean => /^\d+$/.test(seg);

export function setAtPath(
  target: Record<string, unknown>,
  dottedKey: string,
  value: unknown
): void {
  if (!dottedKey.includes(".")) {
    target[dottedKey] = value;
    return;
  }

  const segments = dottedKey.split(".");
  let cursor: Record<string | number, unknown> = target as Record<string | number, unknown>;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const key: string | number = isIndex(seg) ? Number(seg) : seg;
    const nextIsIndex = isIndex(segments[i + 1]);
    let next = cursor[key];

    if (nextIsIndex) {
      if (!Array.isArray(next)) {
        next = [];
        cursor[key] = next;
      }
    } else if (!next || typeof next !== "object" || Array.isArray(next)) {
      next = {};
      cursor[key] = next;
    }
    cursor = next as Record<string | number, unknown>;
  }

  const last = segments[segments.length - 1];
  cursor[isIndex(last) ? Number(last) : last] = value;
}
