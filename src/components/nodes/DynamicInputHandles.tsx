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
import { dynPinId, type DynPinType } from "@/lib/dynamicPinId";

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

/**
 * Build the field descriptors. With a schema, each field maps 1:1 (multi =
 * isArray). Without a schema, fall back to the classic generic inputs so the
 * node still works: a multi primary image + a single prompt.
 */
function buildDescriptors(
  inputSchema: ModelInputDef[] | undefined,
  fallback: Descriptor[]
): Descriptor[] {
  if (inputSchema && inputSchema.length > 0) {
    return inputSchema.map((i) => ({
      type: i.type as DynPinType,
      field: i.name,
      label: i.label || i.name,
      multi: !!i.isArray,
    }));
  }
  return fallback;
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

  const descriptors = buildDescriptors(inputSchema, fallback);

  // Flatten descriptors → concrete pins, growing multi fields by connection count.
  const pins: Array<{ id: string; type: DynPinType; label: string; empty: boolean }> = [];
  for (const d of descriptors) {
    if (!d.multi) {
      pins.push({ id: dynPinId(d.type, d.field, 0), type: d.type, label: d.label, empty: false });
      continue;
    }
    const prefix = `dynpin__${d.type}__${d.field}__`;
    const count = targetHandles.filter((h) => h.startsWith(prefix)).length;
    for (let i = 0; i < count; i++) {
      pins.push({
        id: dynPinId(d.type, d.field, i),
        type: d.type,
        label: `${d.label} ${i + 1}`,
        empty: false,
      });
    }
    pins.push({
      id: dynPinId(d.type, d.field, count),
      type: d.type,
      label: count === 0 ? d.label : `+ ${d.label}`,
      empty: true,
    });
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
