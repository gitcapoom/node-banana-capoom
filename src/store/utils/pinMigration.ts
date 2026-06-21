/**
 * Edge migration between the classic and dynamic-pin handle schemes.
 *
 * Classic handles: "image", "image-1" (2nd image field, or 2nd image on a
 * schemaless node), "text", "image-{name}", etc.
 * Dynamic handles:  "dynpin__{type}__{field}__{slot}".
 *
 * When the dynamic-pins flag flips (or a saved workflow loads while it's on),
 * we rewrite the targetHandle of edges feeding the affected generator nodes so
 * they re-anchor to the active scheme — instead of floating detached. The remap
 * is a round-trip for classic-origin edges; dynamic-only edges (nested element
 * slots) have no classic equivalent and are left untouched.
 *
 * Pure module — easy to test, no store/React deps.
 */

import type { WorkflowNode, WorkflowEdge } from "@/types";
import { parseDynPin, dynPinId, type DynPinType } from "@/lib/dynamicPinId";

/** Node types whose handle rendering changes with the dynamic-pins flag. */
export const DYNAMIC_PIN_NODE_TYPES = new Set<string>([
  "nanoBanana",
  "generateVideo",
  "generate3d",
  "upscaleGrid",
  "generateAudio",
  "llmGenerate",
  "outputGallery",
]);

interface SchemaInput {
  name: string;
  type: string;
  isArray?: boolean;
  repeatable?: boolean;
}

const TYPES: DynPinType[] = ["image", "text", "video", "audio"];

/** Classic handle id → { type, field } for a node's schema (positional + named). */
function buildClassicMap(inputSchema: SchemaInput[]): Record<string, { type: DynPinType; field: string }> {
  const map: Record<string, { type: DynPinType; field: string }> = {};
  for (const t of TYPES) {
    const ins = inputSchema.filter((i) => i.type === t && !i.repeatable);
    ins.forEach((inp, i) => {
      const bare = i === 0 ? t : `${t}-${i}`;
      map[bare] = { type: t, field: inp.name };
      map[`${t}-${inp.name}`] = { type: t, field: inp.name };
    });
  }
  return map;
}

/** Resolve a classic handle to (type, field). Falls back to the generic primary. */
function resolveClassic(
  handle: string,
  inputSchema: SchemaInput[] | undefined
): { type: DynPinType; field: string } | null {
  if (inputSchema && inputSchema.length > 0) {
    const mapped = buildClassicMap(inputSchema)[handle];
    if (mapped) return mapped;
  }
  const type: DynPinType | null =
    handle === "text" || handle === "prompt" || handle.startsWith("text")
      ? "text"
      : handle.startsWith("video")
        ? "video"
        : handle.startsWith("audio")
          ? "audio"
          : handle.startsWith("image") || handle.startsWith("frame")
            ? "image"
            : null;
  if (!type) return null;
  return { type, field: type === "text" ? "prompt" : "primary" };
}

/** Reverse: a dynamic (type, field) back to the classic handle id. */
function fieldToClassic(
  dyn: { type: DynPinType; field: string; slot: number },
  inputSchema: SchemaInput[] | undefined
): string {
  if (dyn.field === "primary") return dyn.slot === 0 ? dyn.type : `${dyn.type}-${dyn.slot}`;
  if (inputSchema) {
    const ins = inputSchema.filter((i) => i.type === dyn.type && !i.repeatable);
    const idx = ins.findIndex((i) => i.name === dyn.field);
    if (idx >= 0) return idx === 0 ? dyn.type : `${dyn.type}-${idx}`;
  }
  if (dyn.field === "prompt") return "text";
  return `${dyn.type}-${dyn.field}`;
}

/**
 * Rewrite edge targetHandles for the given mode. Returns a NEW edges array
 * (unchanged edges are reused by reference). Edges not feeding a dynamic-pin
 * node, or already in the target scheme, are left as-is.
 */
export function migrateEdgeHandles(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  toMode: "dynamic" | "classic"
): WorkflowEdge[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Per (node, type, field) slot counter, so multiple classic edges on one
  // handle (an array input) fan out to slots 0, 1, 2…
  const slotCounters = new Map<string, number>();

  return edges.map((e) => {
    const node = nodeById.get(e.target);
    if (!node || !DYNAMIC_PIN_NODE_TYPES.has(node.type as string)) return e;
    const inputSchema = (node.data as { inputSchema?: SchemaInput[] } | undefined)?.inputSchema;
    const handle = e.targetHandle;
    if (!handle) return e;

    if (toMode === "dynamic") {
      if (parseDynPin(handle)) return e; // already dynamic
      const resolved = resolveClassic(handle, inputSchema);
      if (!resolved) return e;
      const key = `${node.id}|${resolved.type}|${resolved.field}`;
      const slot = slotCounters.get(key) ?? 0;
      slotCounters.set(key, slot + 1);
      return { ...e, targetHandle: dynPinId(resolved.type, resolved.field, slot) };
    }

    // toMode === "classic"
    const dyn = parseDynPin(handle);
    if (!dyn) return e; // already classic
    if (dyn.field.includes(".")) return e; // nested element slot — no classic equivalent
    return { ...e, targetHandle: fieldToClassic(dyn, inputSchema) };
  });
}
