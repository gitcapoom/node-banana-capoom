/**
 * Dynamic input-pin renderer (feature-flagged — see @/lib/dynamicPins).
 *
 * Renders one labeled target Handle per input value-slot:
 *   - scalar fields  → a single labeled pin
 *   - multi fields   → one pin per existing connection + a trailing empty pin
 *     to add the next (so N images = N labeled pins + 1 "add" pin)
 *
 * The underlying edges still resolve back into the same images[] /
 * dynamicInputs[field] arrays in getConnectedInputs, so executors/API are
 * unchanged. Only the on-canvas representation differs.
 *
 * This component renders ONLY input (target) handles. The node keeps rendering
 * its own output handle.
 */

"use client";

import React, { useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import { useShallow } from "zustand/shallow";
import { useWorkflowStore } from "@/store/workflowStore";
import type { ModelInputDef } from "@/types";
import { dynPinId, parseDynPin, type DynPinType } from "@/lib/dynamicPinId";
import { stableRefToken, slotToLetter } from "@/lib/refTokens";

const HANDLE_COLORS: Record<DynPinType, string> = {
  image: "var(--handle-color-image, #3b82f6)",
  video: "var(--handle-color-video, #0d9488)",
  audio: "var(--handle-color-audio, #8b5cf6)",
  text: "var(--handle-color-text, #f59e0b)",
  "3d": "var(--handle-color-3d, #ec4899)",
};

interface Descriptor {
  type: DynPinType;
  field: string;
  label: string;
  multi: boolean;
}

export const DEFAULT_GENERATOR_FALLBACK: Descriptor[] = [
  { type: "image", field: "primary", label: "Image", multi: true },
  { type: "text", field: "prompt", label: "Prompt", multi: false },
];

/** Prompt-only fallback for text-to-X generators with no image input (e.g. audio). */
export const PROMPT_ONLY_FALLBACK: Descriptor[] = [
  { type: "text", field: "prompt", label: "Prompt", multi: false },
];

/** Image-only fallback for sinks that collect images (e.g. outputGallery). */
export const IMAGE_ONLY_FALLBACK: Descriptor[] = [
  { type: "image", field: "primary", label: "Image", multi: true },
];

export function DynamicInputHandles({
  nodeId,
  inputSchema,
  fallback = DEFAULT_GENERATOR_FALLBACK,
}: {
  nodeId: string;
  inputSchema?: ModelInputDef[];
  fallback?: Descriptor[];
}) {
  const updateNodeInternals = useUpdateNodeInternals();

  // Target handle ids currently connected to this node (shallow-compared so we
  // only re-render when the set actually changes).
  const targetHandles = useWorkflowStore(
    useShallow((s) =>
      s.edges.filter((e) => e.target === nodeId).map((e) => e.targetHandle ?? "")
    )
  );

  // Fields on THIS node fed by a loopback references passthrough — a single
  // edge from a loopback LLM's `images` output that fills the WHOLE array field
  // at once. For such a field we collapse to just that one pin (below), hiding
  // the other slots and the trailing "add" pin so no conflicting per-slot image
  // can be wired on top of the array. Maps field path → the passthrough's
  // target handle id.
  const passthroughByField = useWorkflowStore(
    useShallow((s) => {
      const map: Record<string, string> = {};
      for (const e of s.edges) {
        if (e.target !== nodeId || e.sourceHandle !== "images" || !e.targetHandle) continue;
        const src = s.nodes.find((n) => n.id === e.source);
        if (src?.type === "llmGenerate" && (src.data as { loopbackMode?: boolean }).loopbackMode) {
          const dyn = parseDynPin(e.targetHandle);
          if (dyn) map[dyn.field] = e.targetHandle;
        }
      }
      return map;
    })
  );

  // Build the concrete pin list. Scalar fields get one pin; multi/array fields
  // grow one pin per connection plus a trailing empty pin; repeatable groups
  // (e.g. Kling `elements`) render per-item sub-groups that grow by item.
  const pins: Array<{ id: string; type: DynPinType; label: string; empty: boolean }> = [];
  const isEmpty = (id: string) => !targetHandles.includes(id);

  // Slots currently connected to a field, ascending. Slot ids are stable (a
  // deletion leaves a gap rather than renumbering), which is what makes the
  // @-reference tokens stable.
  const connectedSlots = (type: DynPinType, fieldPath: string): number[] => {
    const slots: number[] = [];
    for (const h of targetHandles) {
      const d = parseDynPin(h);
      if (d && d.type === type && d.field === fieldPath) slots.push(d.slot);
    }
    // Dedupe so a slot renders one pin even if two edges share it (stale data).
    return [...new Set(slots)].sort((a, b) => a - b);
  };

  const addField = (
    type: DynPinType,
    fieldPath: string,
    label: string,
    multi: boolean,
    refConvention?: string
  ) => {
    if (!multi) {
      const id = dynPinId(type, fieldPath, 0);
      pins.push({ id, type, label, empty: isEmpty(id) });
      return;
    }
    // A loopback references passthrough occupies this whole array field via one
    // edge — render ONLY that pin (no other slots, no trailing "add" pin) so the
    // array can't be mixed with conflicting per-slot images.
    const passthroughHandle = passthroughByField[fieldPath];
    if (passthroughHandle) {
      pins.push({ id: passthroughHandle, type, label: `${label} · loopback array`, empty: false });
      return;
    }
    const slots = connectedSlots(type, fieldPath);
    // One pin per connected slot. Each pin gets a STABLE letter from its (stable)
    // slot index so deleting a middle pin never renumbers the survivors. For
    // @-convention fields we also show the live model position (→ @Image1).
    slots.forEach((slot, rank) => {
      const id = dynPinId(type, fieldPath, slot);
      const slotLabel = refConvention
        ? `${stableRefToken(refConvention, slot)} → @${refConvention}${rank + 1}`
        : `${label} ${slotToLetter(slot)}`;
      pins.push({ id, type, label: slotLabel, empty: false });
    });
    // Trailing empty pin at the next stable slot index (monotonic, never reused).
    const nextSlot = slots.length ? slots[slots.length - 1] + 1 : 0;
    const emptyId = dynPinId(type, fieldPath, nextSlot);
    const emptyLabel = refConvention
      ? slots.length === 0
        ? `@${refConvention}…`
        : `+ @${refConvention}`
      : slots.length === 0
        ? label
        : `+ ${label}`;
    pins.push({ id: emptyId, type, label: emptyLabel, empty: true });
  };

  if (inputSchema && inputSchema.length > 0) {
    for (const input of inputSchema) {
      if (input.repeatable && input.children && input.children.length > 0) {
        // Connected item indices (stable) → dense rank; plus one trailing empty
        // item so the user can add the next element.
        const groupPrefix = `${input.name}.`;
        const connectedItems: number[] = [];
        const seenItems = new Set<number>();
        let maxItem = -1;
        for (const h of targetHandles) {
          const dyn = parseDynPin(h);
          if (dyn && dyn.field.startsWith(groupPrefix)) {
            const idx = Number(dyn.field.slice(groupPrefix.length).split(".")[0]);
            if (Number.isInteger(idx)) {
              maxItem = Math.max(maxItem, idx);
              if (!seenItems.has(idx)) {
                seenItems.add(idx);
                connectedItems.push(idx);
              }
            }
          }
        }
        connectedItems.sort((a, b) => a - b);
        const conv = input.refConvention;
        const singular = (input.label || input.name).replace(/s$/, "");
        for (let j = 0; j <= maxItem + 1; j++) {
          const rank = connectedItems.indexOf(j);
          // The whole item is referenced (@Element1), so the stable token lives
          // on the item and is echoed on each of its child pins.
          const itemPrefix = conv
            ? rank >= 0
              ? `${stableRefToken(conv, j)} → @${conv}${rank + 1}`
              : `+ @${conv}`
            : `${singular} ${j + 1}`;
          for (const child of input.children) {
            addField(
              child.type as DynPinType,
              `${input.name}.${j}.${child.name}`,
              `${itemPrefix} · ${child.label || child.name}`,
              !!child.isArray
            );
          }
        }
      } else {
        addField(input.type as DynPinType, input.name, input.label || input.name, !!input.isArray, input.refConvention);
      }
    }
  } else {
    for (const d of fallback) addField(d.type, d.field, d.label, d.multi);
  }

  // Recompute handle geometry whenever the pin set changes.
  const pinCount = pins.length;
  useEffect(() => {
    updateNodeInternals(nodeId);
  }, [nodeId, pinCount, updateNodeInternals]);

  return (
    <>
      {pins.map((pin, idx) => {
        const topPercent = ((idx + 1) / (pinCount + 1)) * 100;
        return (
          <React.Fragment key={pin.id}>
            <Handle
              type="target"
              position={Position.Left}
              id={pin.id}
              style={{ top: `${topPercent}%`, opacity: pin.empty ? 0.4 : 1, zIndex: 10 }}
              data-handletype={pin.type}
              isConnectable={true}
              title={pin.label}
            />
            <div
              className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
              style={{
                right: `calc(100% + 8px)`,
                top: `calc(${topPercent}% - 18px)`,
                color: HANDLE_COLORS[pin.type],
                opacity: pin.empty ? 0.55 : 1,
                zIndex: 10,
              }}
            >
              {pin.label}
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
}
