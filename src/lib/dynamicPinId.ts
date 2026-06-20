/**
 * Handle-id scheme for the dynamic input-pin model (gated by the dynamic-pins
 * feature flag — see ./dynamicPins).
 *
 * A "dyn pin" is one value-slot of an input field. Multi-value fields render
 * several slots (one per connection + a trailing empty one); scalar fields
 * render a single slot. The id encodes everything needed to route the edge
 * back to the right field/array in getConnectedInputs:
 *
 *   dynpin__{type}__{field}__{slot}
 *     type  = image | text | video | audio | 3d
 *     field = schema field name (snake_case / dotted path), or "primary"
 *             for the generic primary input on schemaless models
 *     slot  = 0-based value index
 *
 * Separator is "__" (double underscore): field names use single underscores
 * and nested paths use dots, so neither collides with the separator.
 *
 * Pure module (no React) so the Zustand store and WorkflowCanvas can import it.
 */

export type DynPinType = "image" | "text" | "video" | "audio" | "3d";

const PREFIX = "dynpin__";

export function dynPinId(type: DynPinType, field: string, slot: number): string {
  return `${PREFIX}${type}__${field}__${slot}`;
}

export function isDynPin(handleId: string | null | undefined): boolean {
  return !!handleId && handleId.startsWith(PREFIX);
}

export function parseDynPin(
  handleId: string | null | undefined
): { type: DynPinType; field: string; slot: number } | null {
  if (!handleId || !handleId.startsWith(PREFIX)) return null;
  const parts = handleId.split("__"); // ["dynpin", type, field, slot]
  if (parts.length < 4) return null;
  const type = parts[1] as DynPinType;
  const slot = Number.parseInt(parts[parts.length - 1], 10);
  const field = parts.slice(2, -1).join("__");
  if (!field || Number.isNaN(slot)) return null;
  return { type, field, slot };
}
