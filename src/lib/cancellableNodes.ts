import type { NodeType } from "@/types";

/**
 * Node types whose execution can be cancelled from the node itself.
 *
 * These are the nodes that hand work to a remote API and then wait — the ones
 * where "it's been going for eight minutes, stop" is a real thing to want. Local
 * processors (crop, blur, comp, grade) finish in milliseconds and have nothing
 * worth interrupting, so they get no button.
 *
 * Deliberately NOT reusing GENERATION_NODE_TYPES from ControlPanel: that list
 * means "can show inline parameters". The two happen to overlap today, and
 * folding them into one constant would silently couple a UI affordance to an
 * execution capability — so the next model that gains parameters would also
 * gain a Cancel button that does nothing.
 */
export const CANCELLABLE_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "nanoBanana",
  "upscaleGrid",
  "generateVideo",
  "generate3d",
  "generateAudio",
  "llmGenerate",
  "worldLabsPano",
  "worldLabsWorld",
  "image2GS",
]);

export function isCancellableNodeType(type: string | undefined): boolean {
  return !!type && CANCELLABLE_NODE_TYPES.has(type as NodeType);
}
