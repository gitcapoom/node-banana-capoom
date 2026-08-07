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
    // llmGenerate's static `video` handle (Gemini video input) is rendered in
    // BOTH pin modes and has no dyn-pin equivalent — migrating it would send
    // the edge to a video dyn-pin that conformance then drops (no schema).
    if (handle === "video" && node.type === "llmGenerate") return e;

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
 * Renderable-pin capabilities per dyn-pin node type when NO schema is present
 * — mirrors each component's DynamicInputHandles fallback. Missing entry =
 * bespoke pin rendering (router) → conformance skips the node.
 */
const FALLBACK_CAPS: Record<string, { image?: boolean; text?: boolean }> = {
  nanoBanana: { image: true, text: true },
  generateVideo: { image: true, text: true },
  generate3d: { image: true, text: true },
  upscaleGrid: { image: true, text: true },
  llmGenerate: { image: true, text: true },
  generateAudio: { text: true },
  outputGallery: { image: true },
};

/**
 * THE pin invariant, in one place: conform a node's dyn-pin edges to the set
 * of pins the node actually renders (DynamicInputHandles). Any edge outside
 * that set is remapped into it or dropped — never left invisible ("ghost"
 * edges: React Flow #008 spam + stale data silently feeding the request).
 *
 * Renderable set:
 *  - schema present: every schema field (scalar = slot 0 only, arrays = any
 *    slot, repeatable groups = their children), PLUS the generic reference
 *    (primary) image pins when the schema has no image-type input;
 *  - no schema: the node type's fallback pins (primary image multi and/or
 *    scalar "prompt").
 *
 * Conformance rules:
 *  - surviving families keep their slots (stable ids — @ImageA tokens);
 *  - scalar families collapse to ONE edge: the highest slot (= newest wiring)
 *    wins and is renumbered to slot 0;
 *  - unmappable image/text edges retarget to the first schema field of their
 *    type, else to the fallback pin, else drop; video/audio without a schema
 *    field drop (no generic sink);
 *  - image-feedback / image-bg / non-dyn handles are untouched.
 *
 * Returns the new edges array, or null when nothing needed to change.
 */
export function conformEdgesToRenderablePins(
  node: WorkflowNode,
  edges: WorkflowEdge[],
): WorkflowEdge[] | null {
  const caps = FALLBACK_CAPS[node.type as string];
  if (!caps) return null;

  const schema = (node.data as { inputSchema?: Array<SchemaInput & { children?: SchemaInput[] }> } | undefined)?.inputSchema;
  const schemaMode = !!schema && schema.length > 0;
  const byName = new Map<string, SchemaInput>();
  const groups = new Set<string>();
  const firstOfType = new Map<string, SchemaInput>();
  let schemaHasImage = false;
  if (schemaMode) {
    for (const i of schema!) {
      if (i.repeatable) {
        groups.add(i.name);
        if (i.children?.some((c) => c.type === "image")) schemaHasImage = true;
        continue;
      }
      byName.set(i.name, i);
      if (!firstOfType.has(i.type)) firstOfType.set(i.type, i);
      if (i.type === "image") schemaHasImage = true;
    }
  }
  const primaryImageRenderable = !!caps.image && (!schemaMode || !schemaHasImage);
  const fallbackPromptRenderable = !!caps.text && !schemaMode;

  // Classify every dyn edge into a target family: { field, scalar } | drop.
  type Fam = { field: string; scalar: boolean; type: DynPinType };
  const famOf = (dyn: { type: DynPinType; field: string }): Fam | null => {
    if (dyn.field === "primary") {
      if (dyn.type === "image" && primaryImageRenderable) return { field: "primary", scalar: false, type: "image" };
      if (dyn.type === "image" && schemaMode) {
        const f = firstOfType.get("image");
        if (f) return { field: f.name, scalar: !f.isArray, type: "image" };
      }
      return null;
    }
    const known = byName.get(dyn.field);
    if (schemaMode && known && known.type === dyn.type) {
      return { field: dyn.field, scalar: !known.isArray, type: dyn.type };
    }
    if (!schemaMode && dyn.field === "prompt" && dyn.type === "text" && fallbackPromptRenderable) {
      return { field: "prompt", scalar: true, type: "text" };
    }
    // Unmappable name for the current mode — find a home by type.
    if (schemaMode) {
      const f = firstOfType.get(dyn.type);
      if (f) return { field: f.name, scalar: !f.isArray, type: dyn.type };
    }
    if (dyn.type === "image" && primaryImageRenderable) return { field: "primary", scalar: false, type: "image" };
    if (dyn.type === "text" && fallbackPromptRenderable) return { field: "prompt", scalar: true, type: "text" };
    return null;
  };

  const drop = new Set<string>();
  const retarget = new Map<string, string>();
  // Per family: incumbents (already on the family) and movers (retargeted in).
  const families = new Map<string, { fam: Fam; incumbents: Array<{ e: WorkflowEdge; slot: number }>; movers: Array<{ e: WorkflowEdge; slot: number }> }>();

  for (const e of edges) {
    if (e.target !== node.id) continue;
    const dyn = parseDynPin(e.targetHandle);
    if (!dyn) continue;
    if (dyn.field.includes(".")) {
      const group = dyn.field.split(".")[0];
      if (!groups.has(group)) drop.add(e.id);
      continue;
    }
    const fam = famOf(dyn);
    if (!fam) {
      drop.add(e.id);
      continue;
    }
    const key = `${fam.type}|${fam.field}`;
    const entry = families.get(key) ?? { fam, incumbents: [], movers: [] };
    if (fam.field === dyn.field && fam.type === dyn.type) entry.incumbents.push({ e, slot: dyn.slot });
    else entry.movers.push({ e, slot: dyn.slot });
    families.set(key, entry);
  }

  for (const { fam, incumbents, movers } of families.values()) {
    incumbents.sort((a, b) => a.slot - b.slot);
    movers.sort((a, b) => a.slot - b.slot);
    if (fam.scalar) {
      // One edge only: the newest incumbent (highest slot) wins, else the
      // first mover. Winner sits at slot 0; everyone else drops.
      const winner = incumbents.length > 0 ? incumbents[incumbents.length - 1] : movers[0];
      for (const c of [...incumbents, ...movers]) {
        if (c === winner) {
          if (c.slot !== 0 || c.e.targetHandle !== dynPinId(fam.type, fam.field, 0)) {
            retarget.set(c.e.id, dynPinId(fam.type, fam.field, 0));
          }
        } else {
          drop.add(c.e.id);
        }
      }
    } else {
      // Multi family: incumbents keep their (stable) slots — dedupe same-slot
      // copies keeping the later edge; movers append after the highest slot.
      const seen = new Map<number, WorkflowEdge>();
      for (const c of incumbents) {
        const prev = seen.get(c.slot);
        if (prev) drop.add(prev.id); // later edge on the same slot wins
        seen.set(c.slot, c.e);
      }
      let next = incumbents.length > 0 ? incumbents[incumbents.length - 1].slot + 1 : 0;
      for (const c of movers) {
        retarget.set(c.e.id, dynPinId(fam.type, fam.field, next++));
      }
    }
  }

  if (drop.size === 0 && retarget.size === 0) return null;
  console.info(
    `[pin-conform] ${node.type} ${node.id}: retargeted ${retarget.size}, dropped ${drop.size} edge(s) to match rendered pins`,
  );
  return edges
    .filter((e) => !drop.has(e.id))
    .map((e) => (retarget.has(e.id) ? { ...e, targetHandle: retarget.get(e.id)! } : e));
}
