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
  "router",
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

  // Seed counters past any slots ALREADY used by dyn-pin edges, so converting
  // classic edges doesn't collide with existing dyn-pin slots on the same field
  // (which would otherwise put two edges on one slot → duplicate pins).
  if (toMode === "dynamic") {
    for (const e of edges) {
      const node = nodeById.get(e.target);
      if (!node || !DYNAMIC_PIN_NODE_TYPES.has(node.type as string)) continue;
      const d = parseDynPin(e.targetHandle);
      if (!d) continue;
      const key = `${e.target}|${d.type}|${d.field}`;
      slotCounters.set(key, Math.max(slotCounters.get(key) ?? 0, d.slot + 1));
    }
  }

  return edges.map((e) => {
    const node = nodeById.get(e.target);
    if (!node || !DYNAMIC_PIN_NODE_TYPES.has(node.type as string)) return e;
    const inputSchema = (node.data as { inputSchema?: SchemaInput[] } | undefined)?.inputSchema;
    const handle = e.targetHandle;
    if (!handle) return e;

    // Special static handles that are NOT model inputs and are always rendered
    // by this exact id in every mode — never migrate them. Without this, a
    // loopback feedback wire (image-feedback) resolves to the generic "primary"
    // field and gets rewritten to a plain reference pin on the classic→dynamic
    // pass that runs at load, so the feedback connection is lost after restart.
    if (handle === "image-feedback" || handle === "image-bg") return e;

    // Router: image-first bundle. Only image edges convert; in classic mode they
    // collapse back to the single multi-edge "image" handle (no image-N).
    if (node.type === "router") {
      if (toMode === "dynamic") {
        if (parseDynPin(handle)) return e;
        if (handle !== "image" && !handle.startsWith("image-")) return e;
        const key = `${node.id}|image|primary`;
        const slot = slotCounters.get(key) ?? 0;
        slotCounters.set(key, slot + 1);
        return { ...e, targetHandle: dynPinId("image", "primary", slot) };
      }
      const dyn = parseDynPin(handle);
      if (!dyn || dyn.type !== "image") return e;
      return { ...e, targetHandle: "image" };
    }

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

/**
 * Remap a node's dyn-pin edges after its inputSchema changed (model switch).
 * An edge wired to a field the new schema doesn't have would otherwise go
 * INVISIBLE (its pin no longer renders — React Flow #008) while still feeding
 * the stale field into the request body. Rules:
 *  - edges whose field still exists (same name, same pin type) are untouched
 *    (slots are stable ids — @ImageA prompt tokens key off them);
 *  - edges on a vanished field move to the new schema's FIRST input of the
 *    same type: array fields append after the highest occupied slot, scalar
 *    fields take slot 0 (first remapped candidate wins; the rest drop, as do
 *    candidates whose target scalar already has a surviving edge);
 *  - no same-type input in the new schema → the edge is dropped (an invisible
 *    inert wire is worse than an honest disconnect);
 *  - nested repeatable-group paths ("elements.0.x") are only kept if the
 *    group still exists.
 * Returns the new edges array, or null when nothing needed to change.
 */
export function remapDynEdgesToSchema(
  nodeId: string,
  schema: SchemaInput[] | undefined,
  edges: WorkflowEdge[],
): WorkflowEdge[] | null {
  if (!schema || schema.length === 0) return null;

  const byName = new Map(schema.filter((i) => !i.repeatable).map((i) => [i.name, i]));
  const groups = new Set(schema.filter((i) => i.repeatable).map((i) => i.name));
  const firstOfType = new Map<string, SchemaInput>();
  for (const i of schema) {
    if (!i.repeatable && !firstOfType.has(i.type)) firstOfType.set(i.type, i);
  }

  // Highest occupied slot per surviving field (for stable array appends).
  const maxSlot = new Map<string, number>();
  const candidates: Array<{ edge: WorkflowEdge; dyn: { type: string; field: string; slot: number } }> = [];
  const drop = new Set<string>();

  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const dyn = parseDynPin(e.targetHandle);
    if (!dyn || dyn.field === "primary") continue;
    if (dyn.field.includes(".")) {
      const group = dyn.field.split(".")[0];
      if (!groups.has(group)) drop.add(e.id);
      continue;
    }
    const known = byName.get(dyn.field);
    if (known && known.type === dyn.type) {
      maxSlot.set(dyn.field, Math.max(maxSlot.get(dyn.field) ?? -1, dyn.slot));
      continue; // field survives — edge untouched
    }
    const target = firstOfType.get(dyn.type);
    if (!target) {
      drop.add(e.id);
      continue;
    }
    candidates.push({ edge: e, dyn });
  }

  const retarget = new Map<string, string>(); // edge id → new targetHandle
  const byTargetField = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const field = firstOfType.get(c.dyn.type)!.name;
    const list = byTargetField.get(field) ?? [];
    list.push(c);
    byTargetField.set(field, list);
  }
  for (const [field, list] of byTargetField) {
    const input = byName.get(field)!;
    list.sort((a, b) => a.dyn.slot - b.dyn.slot);
    if (input.isArray) {
      let slot = (maxSlot.get(field) ?? -1) + 1;
      for (const c of list) {
        retarget.set(c.edge.id, dynPinId(c.dyn.type as Parameters<typeof dynPinId>[0], field, slot++));
      }
    } else {
      const taken = maxSlot.has(field);
      list.forEach((c, i) => {
        if (!taken && i === 0) retarget.set(c.edge.id, dynPinId(c.dyn.type as Parameters<typeof dynPinId>[0], field, 0));
        else drop.add(c.edge.id);
      });
    }
  }

  if (drop.size === 0 && retarget.size === 0) return null;
  console.info(`[schema-remap] ${nodeId}: remapped ${retarget.size} edge(s) to new schema fields, dropped ${drop.size} incompatible edge(s)`);
  return edges
    .filter((e) => !drop.has(e.id))
    .map((e) => (retarget.has(e.id) ? { ...e, targetHandle: retarget.get(e.id)! } : e));
}
