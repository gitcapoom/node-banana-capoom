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
import { stableRefToken } from "@/lib/refTokens";

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
    return slots.sort((a, b) => a - b);
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
    const slots = connectedSlots(type, fieldPath);
    // One pin per connected slot (rank = position the model sees = @ImageN).
    slots.forEach((slot, rank) => {
      const id = dynPinId(type, fieldPath, slot);
      const slotLabel = refConvention
        ? `${stableRefToken(refConvention, slot)} → @${refConvention}${rank + 1}`
        : `${label} ${rank + 1}`;
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
        // Count items that already have a connection, then render one more
        // empty item so the user can add the next element.
        const groupPrefix = `${input.name}.`;
        let maxItem = -1;
        for (const h of targetHandles) {
          const dyn = parseDynPin(h);
          if (dyn && dyn.field.startsWith(groupPrefix)) {
            const idx = Number(dyn.field.slice(groupPrefix.length).split(".")[0]);
            if (Number.isInteger(idx)) maxItem = Math.max(maxItem, idx);
          }
        }
        const singular = (input.label || input.name).replace(/s$/, "");
        for (let j = 0; j <= maxItem + 1; j++) {
          for (const child of input.children) {
            addField(
              child.type as DynPinType,
              `${input.name}.${j}.${child.name}`,
              `${singular} ${j + 1} · ${child.label || child.name}`,
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
